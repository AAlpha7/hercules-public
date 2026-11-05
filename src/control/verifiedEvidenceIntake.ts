/**
 * Durable staging for verified-evidence intake (cutover C3.1a).
 *
 * Writes gate outputs / diff / screenshots / final report under
 * `<root>/<taskId>/<verifiedSha>/` then `bundle.json` (atomic rename).
 * Per-file sha256 digests cover the bytes actually written (truncated marker
 * when truncated) and are part of `bundleHash`. No archive access.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

import { hashCanonicalJson } from '../domain/canonicalJson.js';
import { isValidIdentifier } from '../domain/task.js';
import type { ReviewPacket } from '../domain/verification.js';

export const STAGED_VERIFICATION_BUNDLE_SCHEMA =
  'hercules-staged-verification-bundle/v1' as const;

export const DEFAULT_STAGED_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

const EXACT_GIT_REVISION_RE = /^[0-9a-f]{40}$/;
const TRUNCATED_MARKER =
  'TRUNCATED: file exceeded the staged verification bundle byte budget\n';
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export class VerifiedEvidenceIntakeError extends Error {
  override readonly name = 'VerifiedEvidenceIntakeError';

  constructor(message: string) {
    super(message);
  }
}

export interface StagedGateEntryV1 {
  readonly name: string;
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly outcome: 'skipped' | 'info' | null;
  readonly outputFile: string;
  readonly truncated: boolean;
  /** Digest of the bytes actually written (marker when truncated). */
  readonly sha256: string;
}

/** Allowed media types recorded on staged screenshot / CLI artifact entries. */
export const STAGED_SCREENSHOT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/webm',
  'video/mp4',
] as const;

export type StagedScreenshotMediaType = (typeof STAGED_SCREENSHOT_MEDIA_TYPES)[number];

const SCREENSHOT_EXT_TO_MEDIA: Readonly<Record<string, StagedScreenshotMediaType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  webm: 'video/webm',
  mp4: 'video/mp4',
};

export interface StagedScreenshotEntryV1 {
  readonly name: string;
  readonly file: string;
  readonly truncated: boolean;
  /** Digest of the bytes actually written (marker when truncated). */
  readonly sha256: string;
  /**
   * Media type of the staged bytes. Optional for legacy manifests written
   * before media-type preservation; readers default missing values to
   * `image/png`.
   */
  readonly mediaType?: StagedScreenshotMediaType;
}

export interface StagedVerificationBundleV1 {
  readonly schema: typeof STAGED_VERIFICATION_BUNDLE_SCHEMA;
  readonly taskId: string;
  readonly repository: string;
  readonly verifiedSha: string;
  readonly branch: string;
  readonly capturedAt: string;
  readonly gates: readonly StagedGateEntryV1[];
  readonly screenshots: readonly StagedScreenshotEntryV1[];
  readonly evidenceRun: {
    readonly source: string;
    readonly ok: boolean;
    readonly steps: readonly {
      readonly kind: string;
      readonly ok: boolean;
      readonly detail: string;
      readonly optional: boolean;
      readonly screenshot: string | null;
    }[];
  } | null;
  readonly dod: {
    readonly criteria: readonly {
      readonly text: string;
      readonly kind: 'mechanical' | 'reviewer' | 'human' | 'checkpoint';
      readonly status: 'pass' | 'fail' | 'pending' | 'n/a' | 'skipped' | 'unverified';
      readonly proof: string;
    }[];
  };
  readonly diffFile: string;
  readonly diffSha256: string;
  readonly diffSummary: string;
  readonly filesTouched: readonly string[];
  readonly finalReportFile: string | null;
  readonly finalReportSha256: string | null;
  readonly bundleHash: string;
}

export interface VerifiedEvidenceIntake {
  /**
   * Writes gate outputs / diff / final report as files and copies screenshots
   * into `<root>/<taskId>/<verifiedSha>/`, then `bundle.json`. Idempotent
   * (same inputs → same bundleHash; an existing different bundle for the same
   * key is an error).
   */
  stage(input: {
    readonly task: { readonly id: string; readonly repo: string };
    readonly packet: ReviewPacket;
    readonly verifiedSha: string;
    readonly branch: string;
    readonly capturedAt: string;
    /**
     * Absolute directory that relative packet screenshot names resolve
     * against (the task's `<screenshotsRoot>/<taskId>` — the heavy-worker and
     * live-behavioral paths record basenames). Absolute packet paths are used
     * as-is; a relative name without this directory fails closed.
     */
    readonly screenshotDir?: string;
  }): Promise<StagedVerificationBundleV1>;
  read(taskId: string, verifiedSha: string): Promise<StagedVerificationBundleV1 | null>;
  readFile(taskId: string, verifiedSha: string, relativeName: string): Promise<Uint8Array>;
  discard(taskId: string, verifiedSha: string): Promise<void>;
}

export interface VerifiedEvidenceIntakeOptions {
  readonly root: string;
  readonly readScreenshot?: (absolutePath: string) => Promise<Uint8Array>;
  readonly maxBundleBytes?: number;
}

function fail(message: string): never {
  throw new VerifiedEvidenceIntakeError(message);
}

function assertTaskId(taskId: string): void {
  if (!isValidIdentifier(taskId)) {
    fail(`taskId must be a safe identifier: ${taskId}`);
  }
}

function assertVerifiedSha(verifiedSha: string): void {
  if (!EXACT_GIT_REVISION_RE.test(verifiedSha)) {
    fail('verifiedSha must be an exact lowercase 40-hex Git revision');
  }
}

function assertRelativeName(relativeName: string): void {
  if (
    relativeName.length === 0 ||
    relativeName.includes('\0') ||
    relativeName.includes('/') ||
    relativeName.includes('\\') ||
    relativeName.includes('..') ||
    relativeName === '.' ||
    relativeName === 'bundle.json'
  ) {
    fail(`unsafe staged relative name: ${relativeName}`);
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : 'item';
}

function bundleDir(root: string, taskId: string, verifiedSha: string): string {
  return join(root, taskId, verifiedSha);
}

async function readRegularFileBytes(absolutePath: string): Promise<Uint8Array> {
  const resolved = resolve(absolutePath);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    fail(
      `screenshot path is unreadable: ${resolved}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (info.isSymbolicLink()) {
    fail(`refusing to follow symlink screenshot path: ${resolved}`);
  }
  if (!info.isFile()) {
    fail(`screenshot path is not a regular file: ${resolved}`);
  }
  const bytes = await readFile(resolved);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function writeBoundedFile(
  absolutePath: string,
  bytes: Uint8Array,
  remainingBudget: { value: number },
): Promise<boolean> {
  if (bytes.byteLength <= remainingBudget.value) {
    remainingBudget.value -= bytes.byteLength;
    await writeFile(absolutePath, bytes, { mode: 0o600 });
    return false;
  }
  const marker = new TextEncoder().encode(TRUNCATED_MARKER);
  // Oversized inputs are replaced by a truncated marker even when the marker
  // itself would exceed the remaining budget — the bundle is still written.
  remainingBudget.value = Math.max(0, remainingBudget.value - marker.byteLength);
  await writeFile(absolutePath, marker, { mode: 0o600 });
  return true;
}

function evidenceRunFromPacket(
  packet: ReviewPacket,
): StagedVerificationBundleV1['evidenceRun'] {
  const run = packet.evidenceRun;
  if (run === undefined) return null;
  return {
    source: run.source,
    ok: run.ok,
    steps: run.steps.map((step) => ({
      kind: step.kind,
      ok: step.ok,
      detail: step.detail,
      optional: step.optional === true,
      screenshot: step.screenshot ?? null,
    })),
  };
}

function dodFromPacket(packet: ReviewPacket): StagedVerificationBundleV1['dod'] {
  return {
    criteria: packet.dod.criteria.map((criterion) => ({
      text: criterion.text,
      kind: criterion.kind,
      status: criterion.status,
      proof: criterion.proof,
    })),
  };
}

function computeBundleHash(
  bundle: Omit<StagedVerificationBundleV1, 'bundleHash'>,
): string {
  return hashCanonicalJson(bundle);
}

function contentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function loudIntake(detail: string): void {
  console.error(`[hercules] verifiedEvidenceIntake: ${detail}`);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function expectedDigestForRelative(
  bundle: StagedVerificationBundleV1,
  relativeName: string,
): string | null {
  for (const gate of bundle.gates) {
    if (gate.outputFile === relativeName) return gate.sha256;
  }
  for (const screenshot of bundle.screenshots) {
    if (screenshot.file === relativeName) return screenshot.sha256;
  }
  if (bundle.diffFile === relativeName) return bundle.diffSha256;
  if (bundle.finalReportFile === relativeName) return bundle.finalReportSha256;
  return null;
}

function bundleSchemaLooksValid(parsed: unknown): parsed is StagedVerificationBundleV1 {
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  if (record['schema'] !== STAGED_VERIFICATION_BUNDLE_SCHEMA) return false;
  if (!Array.isArray(record['gates']) || !Array.isArray(record['screenshots'])) {
    return false;
  }
  if (typeof record['diffFile'] !== 'string' || !isSha256Digest(record['diffSha256'])) {
    return false;
  }
  if (
    !(
      record['finalReportFile'] === null ||
      typeof record['finalReportFile'] === 'string'
    ) ||
    !(
      record['finalReportSha256'] === null ||
      isSha256Digest(record['finalReportSha256'])
    )
  ) {
    return false;
  }
  for (const gate of record['gates'] as unknown[]) {
    if (
      gate === null ||
      typeof gate !== 'object' ||
      Array.isArray(gate) ||
      !isSha256Digest((gate as { sha256?: unknown }).sha256) ||
      typeof (gate as { outputFile?: unknown }).outputFile !== 'string'
    ) {
      return false;
    }
  }
  for (const screenshot of record['screenshots'] as unknown[]) {
    if (
      screenshot === null ||
      typeof screenshot !== 'object' ||
      Array.isArray(screenshot) ||
      !isSha256Digest((screenshot as { sha256?: unknown }).sha256) ||
      typeof (screenshot as { file?: unknown }).file !== 'string'
    ) {
      return false;
    }
    const mediaType = (screenshot as { mediaType?: unknown }).mediaType;
    if (
      mediaType !== undefined &&
      (typeof mediaType !== 'string' ||
        !(STAGED_SCREENSHOT_MEDIA_TYPES as readonly string[]).includes(mediaType))
    ) {
      return false;
    }
  }
  return true;
}

export function createVerifiedEvidenceIntake(
  options: VerifiedEvidenceIntakeOptions,
): VerifiedEvidenceIntake {
  const root = resolve(options.root);
  const maxBundleBytes = options.maxBundleBytes ?? DEFAULT_STAGED_BUNDLE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBundleBytes) || maxBundleBytes < 1) {
    fail('maxBundleBytes must be a positive safe integer');
  }
  const readScreenshot = options.readScreenshot ?? readRegularFileBytes;
  const markerBytes = new TextEncoder().encode(TRUNCATED_MARKER);

  async function readBundleMetadata(
    taskId: string,
    verifiedSha: string,
  ): Promise<StagedVerificationBundleV1 | null> {
    assertTaskId(taskId);
    assertVerifiedSha(verifiedSha);
    const path = join(bundleDir(root, taskId, verifiedSha), 'bundle.json');
    let raw: Buffer;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        loudIntake(`bundle.json absent or not a regular file at ${path}`);
        return null;
      }
      raw = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      loudIntake(
        `failed to read staged bundle.json: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch (error) {
      loudIntake(
        `staged bundle.json is not valid JSON (treating as absent): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    if (!bundleSchemaLooksValid(parsed)) {
      loudIntake('staged bundle.json has an invalid schema (treating as absent)');
      return null;
    }
    return parsed;
  }

  async function verifyStagedFileDigest(
    dir: string,
    relativeName: string,
    expectedSha256: string,
  ): Promise<boolean> {
    const absolute = join(dir, relativeName);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      loudIntake(
        `staged file missing for digest check ${relativeName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      loudIntake(`staged path is not a regular file for digest check: ${relativeName}`);
      return false;
    }
    const bytes = await readFile(absolute);
    const actual = contentDigest(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    if (actual !== expectedSha256) {
      loudIntake(
        `staged file digest mismatch for ${relativeName}: expected ${expectedSha256} got ${actual}`,
      );
      return false;
    }
    return true;
  }

  async function readAndVerifyBundle(
    taskId: string,
    verifiedSha: string,
  ): Promise<StagedVerificationBundleV1 | null> {
    const bundle = await readBundleMetadata(taskId, verifiedSha);
    if (bundle === null) return null;
    const dir = bundleDir(root, taskId, verifiedSha);
    for (const gate of bundle.gates) {
      if (!(await verifyStagedFileDigest(dir, gate.outputFile, gate.sha256))) {
        return null;
      }
    }
    for (const screenshot of bundle.screenshots) {
      if (!(await verifyStagedFileDigest(dir, screenshot.file, screenshot.sha256))) {
        return null;
      }
    }
    if (!(await verifyStagedFileDigest(dir, bundle.diffFile, bundle.diffSha256))) {
      return null;
    }
    if (bundle.finalReportFile !== null && bundle.finalReportSha256 !== null) {
      if (
        !(await verifyStagedFileDigest(
          dir,
          bundle.finalReportFile,
          bundle.finalReportSha256,
        ))
      ) {
        return null;
      }
    }
    const { bundleHash: _ignored, ...withoutHash } = bundle;
    if (computeBundleHash(withoutHash) !== bundle.bundleHash) {
      loudIntake(
        `staged bundleHash mismatch for ${taskId}/${verifiedSha} (treating as absent)`,
      );
      return null;
    }
    return bundle;
  }

  return {
    async stage(input) {
      const taskId = input.task.id;
      const verifiedSha = input.verifiedSha;
      assertTaskId(taskId);
      assertVerifiedSha(verifiedSha);
      if (input.task.repo.includes('\0')) {
        fail('task.repo must not contain NUL');
      }

      const existing = await readAndVerifyBundle(taskId, verifiedSha);
      const dir = bundleDir(root, taskId, verifiedSha);

      // Collect bytes first (screenshots may fail before any write).
      const gatePlans: Array<{
        readonly entryBase: Omit<StagedGateEntryV1, 'truncated' | 'sha256'>;
        readonly bytes: Uint8Array;
      }> = [];
      for (let index = 0; index < input.packet.gates.length; index += 1) {
        const gate = input.packet.gates[index]!;
        const outputFile = `gate-${index}-${slugify(gate.name)}.txt`;
        assertRelativeName(outputFile);
        gatePlans.push({
          entryBase: {
            name: gate.name,
            command: gate.command,
            passed: gate.passed,
            exitCode: gate.exitCode ?? null,
            outcome: gate.outcome ?? null,
            outputFile,
          },
          bytes: new TextEncoder().encode(gate.output),
        });
      }

      const diffBytes = new TextEncoder().encode(input.packet.diff);
      const diffFile = 'diff.patch';
      assertRelativeName(diffFile);

      const screenshotPlans: Array<{
        readonly name: string;
        readonly file: string;
        readonly bytes: Uint8Array;
        readonly mediaType: StagedScreenshotMediaType;
      }> = [];
      for (let index = 0; index < input.packet.screenshots.length; index += 1) {
        const reference = input.packet.screenshots[index]!;
        let absoluteScreenshot: string;
        if (isAbsolute(reference)) {
          // Absolute entries are honoured only outside a screenshotDir; with a
          // directory given they must resolve (symlinks included) inside it.
          if (input.screenshotDir !== undefined) {
            const dirReal = await realpath(input.screenshotDir);
            let refReal: string;
            try {
              refReal = await realpath(reference);
            } catch (error) {
              fail(
                `screenshot ${reference} cannot be resolved inside screenshotDir: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
            if (refReal !== dirReal && !refReal.startsWith(dirReal + sep)) {
              fail(`screenshot ${reference} resolves outside screenshotDir ${input.screenshotDir}`);
            }
            // Read exactly the path that was validated (canonical), never the
            // lexical one — `/dir/link/../x` must not validate as one file and
            // read another (Codex round-7 B1).
            absoluteScreenshot = refReal;
          } else {
            absoluteScreenshot = reference;
          }
        } else {
          // Basename recorded by the verification path: confine to screenshotDir.
          assertRelativeName(reference);
          if (input.screenshotDir === undefined || !isAbsolute(input.screenshotDir)) {
            fail(
              `screenshot ${reference} is a relative name but no absolute screenshotDir was provided`,
            );
          }
          absoluteScreenshot = join(input.screenshotDir, reference);
        }
        const base = basename(absoluteScreenshot);
        const dot = base.lastIndexOf('.');
        const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
        const mediaType = SCREENSHOT_EXT_TO_MEDIA[ext];
        if (mediaType === undefined) {
          fail(`screenshot ${base} has an unsupported media extension`);
        }
        const stem = base.slice(0, dot);
        const file = `screenshot-${index}-${slugify(stem)}.${ext}`;
        assertRelativeName(file);
        screenshotPlans.push({
          name: base,
          file,
          bytes: await readScreenshot(absoluteScreenshot),
          mediaType,
        });
      }

      let finalReportFile: string | null = null;
      let finalReportBytes: Uint8Array | null = null;
      if (input.packet.finalReport.length > 0) {
        finalReportFile = 'final-report.md';
        assertRelativeName(finalReportFile);
        finalReportBytes = new TextEncoder().encode(input.packet.finalReport);
      }

      // Deterministic truncated flags + digests of the bytes that will be written
      // (original content, or the truncated marker when the budget is exceeded).
      const budget = { value: maxBundleBytes };
      const markerLen = markerBytes.byteLength;
      const markerDigest = contentDigest(markerBytes);
      function planWrite(sourceBytes: Uint8Array): {
        readonly truncated: boolean;
        readonly sha256: string;
      } {
        if (sourceBytes.byteLength <= budget.value) {
          budget.value -= sourceBytes.byteLength;
          return { truncated: false, sha256: contentDigest(sourceBytes) };
        }
        budget.value = Math.max(0, budget.value - markerLen);
        return { truncated: true, sha256: markerDigest };
      }

      const gatePlansResolved: StagedGateEntryV1[] = gatePlans.map((plan) => {
        const planned = planWrite(plan.bytes);
        return { ...plan.entryBase, truncated: planned.truncated, sha256: planned.sha256 };
      });
      const diffPlan = planWrite(diffBytes);
      const diffSha256 = diffPlan.sha256;
      const screenshots: StagedScreenshotEntryV1[] = screenshotPlans.map((plan) => {
        const planned = planWrite(plan.bytes);
        return {
          name: plan.name,
          file: plan.file,
          truncated: planned.truncated,
          sha256: planned.sha256,
          mediaType: plan.mediaType,
        };
      });
      let finalReportSha256: string | null = null;
      if (finalReportBytes !== null) {
        finalReportSha256 = planWrite(finalReportBytes).sha256;
      }

      const withoutHash: Omit<StagedVerificationBundleV1, 'bundleHash'> = {
        schema: STAGED_VERIFICATION_BUNDLE_SCHEMA,
        taskId,
        repository: input.task.repo,
        verifiedSha,
        branch: input.branch,
        capturedAt: input.capturedAt,
        gates: gatePlansResolved,
        screenshots,
        evidenceRun: evidenceRunFromPacket(input.packet),
        dod: dodFromPacket(input.packet),
        diffFile,
        diffSha256,
        diffSummary: input.packet.diffSummary,
        filesTouched: [...input.packet.filesTouched],
        finalReportFile,
        finalReportSha256,
      };
      const bundleHash = computeBundleHash(withoutHash);
      const bundle: StagedVerificationBundleV1 = { ...withoutHash, bundleHash };

      if (existing !== null) {
        if (existing.bundleHash === bundle.bundleHash) {
          return existing;
        }
        fail(
          `staged bundle already exists for ${taskId}/${verifiedSha} with a different bundleHash`,
        );
      }

      await mkdir(dir, { recursive: true, mode: 0o700 });
      const writeBudget = { value: maxBundleBytes };
      for (let index = 0; index < gatePlans.length; index += 1) {
        const plan = gatePlans[index]!;
        const truncated = await writeBoundedFile(
          join(dir, plan.entryBase.outputFile),
          plan.bytes,
          writeBudget,
        );
        if (truncated !== gatePlansResolved[index]!.truncated) {
          fail('internal staging budget mismatch for gate output');
        }
      }
      const diffTruncated = await writeBoundedFile(
        join(dir, diffFile),
        diffBytes,
        writeBudget,
      );
      if (diffTruncated !== diffPlan.truncated) {
        fail('internal staging budget mismatch for diff output');
      }
      for (let index = 0; index < screenshotPlans.length; index += 1) {
        const plan = screenshotPlans[index]!;
        const truncated = await writeBoundedFile(join(dir, plan.file), plan.bytes, writeBudget);
        if (truncated !== screenshots[index]!.truncated) {
          fail('internal staging budget mismatch for screenshot');
        }
      }
      if (finalReportFile !== null && finalReportBytes !== null) {
        await writeBoundedFile(join(dir, finalReportFile), finalReportBytes, writeBudget);
      }

      const raced = await readAndVerifyBundle(taskId, verifiedSha);
      if (raced !== null) {
        if (raced.bundleHash === bundle.bundleHash) return raced;
        fail(
          `staged bundle already exists for ${taskId}/${verifiedSha} with a different bundleHash`,
        );
      }

      const bundleJsonPath = join(dir, 'bundle.json');
      const bundleJsonTmp = join(dir, `.bundle.json.${process.pid}.tmp`);
      await writeFile(
        bundleJsonTmp,
        `${JSON.stringify(bundle, null, 2)}\n`,
        { mode: 0o600 },
      );
      await rename(bundleJsonTmp, bundleJsonPath);
      return bundle;
    },

    async read(taskId, verifiedSha) {
      return readAndVerifyBundle(taskId, verifiedSha);
    },

    async readFile(taskId, verifiedSha, relativeName) {
      assertTaskId(taskId);
      assertVerifiedSha(verifiedSha);
      assertRelativeName(relativeName);
      const dir = bundleDir(root, taskId, verifiedSha);
      const absolute = join(dir, relativeName);
      if (!absolute.startsWith(dir + sep) && absolute !== join(dir, relativeName)) {
        fail(`path escapes staged bundle root: ${relativeName}`);
      }
      // join(dir, relativeName) with a safe relativeName cannot escape, but keep the check.
      if (resolve(absolute) !== absolute || !resolve(absolute).startsWith(resolve(dir) + sep)) {
        fail(`path escapes staged bundle root: ${relativeName}`);
      }
      const bundle = await readBundleMetadata(taskId, verifiedSha);
      if (bundle === null) {
        fail(`staged bundle metadata unavailable for digest check of ${relativeName}`);
      }
      const expected = expectedDigestForRelative(bundle, relativeName);
      if (expected === null) {
        fail(`staged relative name is not declared in bundle metadata: ${relativeName}`);
      }
      let info;
      try {
        info = await lstat(absolute);
      } catch (error) {
        fail(
          `staged file is unreadable: ${relativeName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (info.isSymbolicLink()) {
        fail(`refusing to follow symlink staged file: ${relativeName}`);
      }
      if (!info.isFile()) {
        fail(`staged path is not a regular file: ${relativeName}`);
      }
      const bytes = await readFile(absolute);
      const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const actual = contentDigest(view);
      if (actual !== expected) {
        fail(
          `staged file digest mismatch for ${relativeName}: expected ${expected} got ${actual}`,
        );
      }
      return view;
    },

    async discard(taskId, verifiedSha) {
      assertTaskId(taskId);
      assertVerifiedSha(verifiedSha);
      const dir = bundleDir(root, taskId, verifiedSha);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
