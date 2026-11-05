/** Trusted CLI behavioral evidence runner: argv-only, sandboxed and bounded. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  realpath,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { basename, delimiter, extname, join, resolve as pathResolve } from 'node:path';
import { verificationChildEnv } from '../adapters/policyEnv.js';
import {
  assembleCliEvidenceReceipt,
  cliEvidenceArtifactKindForName,
  evaluateCliEvidenceAssertions,
  isCliEvidenceArtifactExtension,
  isPathInsideWorkspace,
  MAX_CLI_EVIDENCE_ARTIFACT_BYTES,
  MAX_CLI_EVIDENCE_ARTIFACTS_PER_STEP,
  MAX_CLI_EVIDENCE_ARTIFACTS_TOTAL_BYTES,
  redactCliEvidenceOutput,
  type CliEvidenceArtifact,
  type CliEvidencePlan,
  type CliEvidenceReceipt,
  type CliEvidenceStep,
  type CliEvidenceStepReceipt,
  type CliEvidenceStepStatus,
} from '../domain/cliEvidence.js';
import {
  effectiveRepoExecutionPolicy,
  type EffectiveRepoExecutionPolicy,
} from '../domain/repoExecutionPolicy.js';
import {
  isForceVerificationCancel,
  throwIfVerificationAborted,
  VerificationAbortedError,
} from '../domain/verificationRun.js';
import {
  buildCliEvidenceInvocation,
  CliEvidenceSandboxError,
  PRIVATE_CLI_TMP,
} from './cliEvidenceSandbox.js';
import { killProcessGroup } from './processGroup.js';

export interface CliEvidenceRunInput {
  readonly plan: CliEvidencePlan;
  readonly workspaceDir: string;
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
  readonly signal?: AbortSignal;
  /** Additional in-memory values to redact. They are never copied to a receipt. */
  readonly secretValues?: readonly string[];
  /** Testable pre-filter source. Production defaults to the daemon environment. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly bubblewrapPath?: string | null;
  /** Trusted build-only Rust toolchain home; mounts exclude Cargo credentials. */
  readonly rustToolchainHome?: string | null;
  /**
   * Overflow handling for a step's combined stdout+stderr above its
   * `max_output_bytes`. Default `truncate` (2026-09-09): the capture is cut
   * (receipt tails carry the truncation note; the receipt is fitted per step)
   * and the command keeps running — a verbose gate must never burn the
   * attempt. `terminate` kills the step as `oversized_output` (opt-in).
   */
  readonly overflowMode?: 'terminate' | 'truncate';
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
  readonly killGroup?: typeof killProcessGroup;
  /**
   * Task evidence directory (`<screenshotsRoot>/<taskId>`). When set, steps
   * that declare `artifacts_dir` copy collected media here.
   */
  readonly evidenceDir?: string;
  /** Task id used in served artifact names (`cli-<stepId>-…`). */
  readonly taskId?: string;
}

function skippedStep(step: CliEvidenceStep, reason: string): CliEvidenceStepReceipt {
  return {
    id: step.id,
    argv: step.argv,
    cwd: step.cwd,
    status: 'not_run',
    exitCode: null,
    durationMs: 0,
    stdoutTail: '',
    stderrTail: '',
    assertions: [],
    ok: false,
    optional: step.optional,
    omissionReason: reason,
  };
}

function secretValuesFromEnvironment(input: {
  readonly source: NodeJS.ProcessEnv;
  readonly droppedNames: readonly string[];
  readonly explicit: readonly string[];
}): readonly string[] {
  const dropped = new Set(input.droppedNames);
  const values = new Set<string>();
  for (const value of input.explicit) if (value.length >= 4) values.add(value);
  for (const [name, value] of Object.entries(input.source)) {
    if (!value || value.length < 4) continue;
    if (dropped.has(name) || /token|secret|password|credential|api[_-]?key|auth/i.test(name)) {
      values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redactPersistent(
  text: string,
  secrets: readonly string[],
  maxBytes: number,
  paths: readonly string[],
): string {
  if (maxBytes <= 0) return '';
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
  for (const path of paths.filter((p) => p.length > 1).sort((a, b) => b.length - a.length)) {
    out = out.split(path).join('[WORKSPACE]');
  }
  const redacted = redactCliEvidenceOutput(out, maxBytes);
  const bytes = Buffer.from(redacted, 'utf8');
  return bytes.length <= maxBytes
    ? redacted
    : decodeUtf8Prefix(bytes.subarray(0, maxBytes));
}

async function resolveStepCwd(
  workspaceRoot: string,
  stepCwd: string,
): Promise<{ ok: true; root: string; cwd: string } | { ok: false; reason: string }> {
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch {
    return { ok: false, reason: 'workspace root unreadable' };
  }
  const candidate = stepCwd === '.' ? rootReal : pathResolve(rootReal, stepCwd);
  let candReal: string;
  try {
    candReal = await realpath(candidate);
  } catch {
    return { ok: false, reason: 'cwd unreadable' };
  }
  if (!isPathInsideWorkspace(rootReal, candReal)) {
    return { ok: false, reason: 'cwd escapes workspace' };
  }
  return { ok: true, root: rootReal, cwd: candReal };
}

export async function runCliEvidence(input: CliEvidenceRunInput): Promise<CliEvidenceReceipt> {
  throwIfVerificationAborted(input.signal);
  const started = Date.now();
  const steps: CliEvidenceStepReceipt[] = [];
  for (let i = 0; i < input.plan.steps.length; i += 1) {
    throwIfVerificationAborted(input.signal);
    const step = input.plan.steps[i]!;
    const result = await runOneStep(input, step);
    steps.push(await attachStepArtifacts(input, step, result));
    if (!result.ok && !step.optional) {
      for (const remaining of input.plan.steps.slice(i + 1)) {
        steps.push(skippedStep(remaining, 'prior required CLI evidence step failed'));
      }
      break;
    }
  }
  return assembleCliEvidenceReceipt({
    plan: input.plan,
    steps,
    durationMs: Math.max(0, Date.now() - started),
  });
}

function sanitizeArtifactBasename(name: string): string {
  const base = basename(name);
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'artifact';
}

async function uniqueServedName(evidenceDir: string, preferred: string): Promise<string> {
  const ext = extname(preferred);
  const stem = ext.length > 0 ? preferred.slice(0, -ext.length) : preferred;
  let candidate = preferred;
  let n = 0;
  while (true) {
    try {
      await lstat(join(evidenceDir, candidate));
      n += 1;
      candidate = stem + '-' + String(n) + ext;
    } catch {
      return candidate;
    }
  }
}

/** Cap on directory entries scanned under artifacts_dir (B3). */
const MAX_ARTIFACT_DIR_ENTRIES = 256;
/** Cap on individual skip notes before collapsing (B3). */
const MAX_ARTIFACT_SKIP_NOTES = 8;
/** Hard byte bound for the persisted artifactsSkipped string (B3). */
const MAX_ARTIFACTS_SKIPPED_BYTES = 1024;

export interface CollectCliEvidenceArtifactsDeps {
  /**
   * Injectable directory listing (defaults to `fs.promises.readdir`).
   * Tests inject a wrapper that races a rename/symlink swap after listing
   * to prove the collector pins identity via `/proc/self/fd`.
   */
  readonly readdir?: (path: string) => Promise<string[]>;
}

function formatArtifactsSkipped(notes: readonly string[]): string | undefined {
  if (notes.length === 0) return undefined;
  const kept = notes.slice(0, MAX_ARTIFACT_SKIP_NOTES);
  const extra = notes.length - kept.length;
  let text = kept.join('; ');
  if (extra > 0) {
    text += '; +' + String(extra) + ' more skipped';
  }
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= MAX_ARTIFACTS_SKIPPED_BYTES) return text;
  return decodeUtf8Prefix(buf.subarray(0, MAX_ARTIFACTS_SKIPPED_BYTES - 3)) + '…';
}

/**
 * Read at most `maxBytes + 1` through the handle. Returns the bytes when the
 * file fits the cap, or `'exceeds'` when more than `maxBytes` arrive (N2).
 * Never uses `readFile` on a candidate (growing files must not be slurped).
 */
async function readHandleCapped(
  fh: FileHandle,
  maxBytes: number,
): Promise<Buffer | 'exceeds'> {
  const limit = maxBytes + 1;
  const chunks: Buffer[] = [];
  let total = 0;
  const scratch = Buffer.alloc(Math.min(64 * 1024, limit));
  while (total < limit) {
    const toRead = Math.min(scratch.byteLength, limit - total);
    const { bytesRead } = await fh.read(scratch, 0, toRead, total);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    total += bytesRead;
  }
  if (total > maxBytes) return 'exceeds';
  return Buffer.concat(chunks, total);
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * After a step finishes (any status), collect media from artifacts_dir when
 * declared. Fail-closed on path escape; pins directory/file identity via
 * `/proc/self/fd` + `O_NOFOLLOW` (never re-opens by pathname after listing).
 */
export async function collectCliEvidenceArtifacts(
  input: {
    readonly workspaceRoot: string;
    readonly artifactsDir: string;
    readonly stepId: string;
    readonly evidenceDir: string;
  },
  deps: CollectCliEvidenceArtifactsDeps = {},
): Promise<{
  readonly artifacts: readonly CliEvidenceArtifact[];
  readonly artifactsSkipped?: string;
}> {
  const listDir = deps.readdir ?? readdir;
  const skipNotes: string[] = [];
  let rootReal: string;
  try {
    rootReal = await realpath(input.workspaceRoot);
  } catch {
    return { artifacts: [], artifactsSkipped: 'workspace root unreadable' };
  }
  const candidate = pathResolve(rootReal, input.artifactsDir);
  let dirReal: string;
  try {
    const linkProbe = await lstat(candidate);
    if (linkProbe.isSymbolicLink()) {
      return { artifacts: [], artifactsSkipped: 'artifacts_dir is a symlink (refused)' };
    }
    dirReal = await realpath(candidate);
  } catch {
    return { artifacts: [], artifactsSkipped: 'artifacts_dir missing' };
  }
  if (!isPathInsideWorkspace(rootReal, dirReal) || dirReal === rootReal) {
    return { artifacts: [], artifactsSkipped: 'artifacts_dir escapes workspace or is root' };
  }

  // Fail closed without Linux openat emulation via /proc/self/fd.
  try {
    await access('/proc/self/fd');
  } catch {
    return {
      artifacts: [],
      artifactsSkipped: 'artifact collection requires /proc/self/fd (fail closed)',
    };
  }

  let dirFh: FileHandle | undefined;
  try {
    dirFh = await openFile(
      dirReal,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    return { artifacts: [], artifactsSkipped: 'artifacts_dir unreadable' };
  }

  try {
    const pathStat = await stat(dirReal);
    const fdStat = await dirFh.stat();
    if (!fdStat.isDirectory() || !sameIdentity(pathStat, fdStat)) {
      return { artifacts: [], artifactsSkipped: 'artifacts_dir identity mismatch' };
    }
    const fdPath = '/proc/self/fd/' + String(dirFh.fd);
    let fdReal: string;
    try {
      fdReal = await realpath(fdPath);
    } catch {
      return { artifacts: [], artifactsSkipped: 'artifacts_dir fd unreadable' };
    }
    if (fdReal !== dirReal || !isPathInsideWorkspace(rootReal, fdReal)) {
      return { artifacts: [], artifactsSkipped: 'artifacts_dir fd escaped workspace' };
    }

    let entries: string[];
    try {
      entries = await listDir(fdPath);
    } catch {
      return { artifacts: [], artifactsSkipped: 'artifacts_dir unreadable' };
    }
    // Byte-order of names (UTF-8 code units / JS string compare).
    entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length > MAX_ARTIFACT_DIR_ENTRIES) {
      entries = entries.slice(0, MAX_ARTIFACT_DIR_ENTRIES);
      skipNotes.push('directory has more than 256 entries; scanning stopped');
    }

    await mkdir(input.evidenceDir, { recursive: true });
    const artifacts: CliEvidenceArtifact[] = [];
    let totalBytes = 0;
    for (const entry of entries) {
      if (artifacts.length >= MAX_CLI_EVIDENCE_ARTIFACTS_PER_STEP) {
        skipNotes.push(
          'file cap ' + String(MAX_CLI_EVIDENCE_ARTIFACTS_PER_STEP) + ' reached; skipped remaining',
        );
        break;
      }
      const ext = extname(entry).replace(/^\./, '');
      if (!isCliEvidenceArtifactExtension(ext)) {
        // Disallowed extensions are silently ignored (not counted as skips).
        continue;
      }
      const kind = cliEvidenceArtifactKindForName(entry);
      if (!kind) continue;
      const servedBase = 'cli-' + input.stepId + '-' + sanitizeArtifactBasename(entry);
      const servedName = await uniqueServedName(input.evidenceDir, servedBase);
      if (servedName.includes('/') || servedName.includes('\\') || servedName.includes('..')) {
        skipNotes.push(entry + ' unsafe served name');
        continue;
      }
      const evidenceRoot = pathResolve(input.evidenceDir);
      const dest = pathResolve(evidenceRoot, servedName);
      if (!isPathInsideWorkspace(evidenceRoot, dest) || dest === evidenceRoot) {
        skipNotes.push(entry + ' dest escape refused');
        continue;
      }

      // Open through the pinned directory fd — never join(dirReal, entry).
      const entryViaFd = fdPath + '/' + entry;
      let fh: FileHandle | undefined;
      try {
        // O_NONBLOCK: opening a FIFO without a writer must not hang the
        // verifier (Codex R11 B3); fstat then rejects anything non-regular.
        fh = await openFile(
          entryViaFd,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
        const fst = await fh.stat();
        if (!fst.isFile()) {
          skipNotes.push(entry + ' not a regular file');
          continue;
        }
        if (fst.size > MAX_CLI_EVIDENCE_ARTIFACT_BYTES) {
          skipNotes.push(
            entry + ' exceeds ' + String(MAX_CLI_EVIDENCE_ARTIFACT_BYTES) + ' bytes',
          );
          continue;
        }
        if (totalBytes + fst.size > MAX_CLI_EVIDENCE_ARTIFACTS_TOTAL_BYTES) {
          skipNotes.push(entry + ' would exceed total byte cap');
          continue;
        }
        const read = await readHandleCapped(fh, MAX_CLI_EVIDENCE_ARTIFACT_BYTES);
        if (read === 'exceeds') {
          skipNotes.push(
            entry + ' exceeds ' + String(MAX_CLI_EVIDENCE_ARTIFACT_BYTES) + ' bytes',
          );
          continue;
        }
        if (totalBytes + read.byteLength > MAX_CLI_EVIDENCE_ARTIFACTS_TOTAL_BYTES) {
          skipNotes.push(entry + ' would exceed total byte cap');
          continue;
        }
        await writeFile(dest, read, { flag: 'wx' });
        const sha256 = createHash('sha256').update(read).digest('hex');
        artifacts.push({
          name: servedName,
          kind,
          bytes: read.byteLength,
          sha256,
        });
        totalBytes += read.byteLength;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ELOOP') {
          skipNotes.push(entry + ' symlink skipped');
        } else {
          const msg = err instanceof Error ? err.message : 'copy failed';
          skipNotes.push(entry + ' ' + msg);
        }
      } finally {
        if (fh !== undefined) {
          await fh.close().catch(() => undefined);
        }
      }
    }
    const artifactsSkipped = formatArtifactsSkipped(skipNotes);
    return {
      artifacts,
      ...(artifactsSkipped !== undefined ? { artifactsSkipped } : {}),
    };
  } finally {
    await dirFh.close().catch(() => undefined);
  }
}

async function attachStepArtifacts(
  input: CliEvidenceRunInput,
  step: CliEvidenceStep,
  receipt: CliEvidenceStepReceipt,
): Promise<CliEvidenceStepReceipt> {
  if (!step.artifactsDir) return receipt;
  if (!input.evidenceDir) {
    return {
      ...receipt,
      artifactsSkipped: 'no evidence directory configured',
    };
  }
  let rootReal: string;
  try {
    rootReal = await realpath(input.workspaceDir);
  } catch {
    return { ...receipt, artifactsSkipped: 'workspace root unreadable' };
  }
  const collected = await collectCliEvidenceArtifacts({
    workspaceRoot: rootReal,
    artifactsDir: step.artifactsDir,
    stepId: step.id,
    evidenceDir: input.evidenceDir,
  });
  return {
    ...receipt,
    ...(collected.artifacts.length > 0 ? { artifacts: collected.artifacts } : {}),
    ...(collected.artifactsSkipped !== undefined
      ? { artifactsSkipped: collected.artifactsSkipped }
      : {}),
  };
}

function failStep(
  step: CliEvidenceStep,
  status: CliEvidenceStepStatus,
  durationMs: number,
  exitCode: number | null,
  stdoutTail: string,
  stderrTail: string,
  argv = step.argv,
): CliEvidenceStepReceipt {
  return {
    id: step.id,
    argv,
    cwd: step.cwd,
    status,
    exitCode,
    durationMs,
    stdoutTail,
    stderrTail,
    assertions: [],
    ok: step.optional,
    optional: step.optional,
  };
}

function decodeUtf8Prefix(buffer: Buffer): string {
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const decoded = buffer.subarray(0, buffer.length - trim).toString('utf8');
    if (!decoded.endsWith('\uFFFD')) return decoded;
  }
  return '';
}

async function runOneStep(
  input: CliEvidenceRunInput,
  step: CliEvidenceStep,
): Promise<CliEvidenceStepReceipt> {
  const cwdRes = await resolveStepCwd(input.workspaceDir, step.cwd);
  if (!cwdRes.ok) {
    return failStep(step, 'workspace_escape', 0, null, '', cwdRes.reason);
  }
  const policy = input.executionPolicy ?? effectiveRepoExecutionPolicy(null);
  const sourceEnv = input.sourceEnv ?? process.env;
  const filtered = verificationChildEnv({ policy, source: sourceEnv });
  const secrets = secretValuesFromEnvironment({
    source: sourceEnv,
    droppedNames: filtered.decision.dropped.map((item) => item.name),
    explicit: input.secretValues ?? [],
  });
  const paths = [cwdRes.cwd, cwdRes.root];
  const safeArgv = step.argv.map((arg) => redactPersistent(arg, secrets, 1024, paths));
  let invocation;
  try {
    invocation = await buildCliEvidenceInvocation({
      policy,
      workspaceRoot: cwdRes.root,
      cwd: cwdRes.cwd,
      argv: step.argv,
      ...(input.bubblewrapPath !== undefined ? { bubblewrapPath: input.bubblewrapPath } : {}),
      ...(input.rustToolchainHome !== undefined
        ? { rustToolchainHome: input.rustToolchainHome }
        : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
    });
  } catch (err) {
    const message = err instanceof CliEvidenceSandboxError ? err.message : 'sandbox setup failed';
    return failStep(
      step,
      'sandbox_error',
      0,
      null,
      '',
      redactPersistent(message, secrets, step.maxOutputBytes, paths),
      safeArgv,
    );
  }
  const spawnEnv = { ...filtered.env };
  if (invocation.boundary === 'bubblewrap') spawnEnv['TMPDIR'] = PRIVATE_CLI_TMP;
  if (input.rustToolchainHome) {
    const cargoBin = join(input.rustToolchainHome, '.cargo', 'bin');
    spawnEnv['PATH'] = spawnEnv['PATH']
      ? `${cargoBin}${delimiter}${spawnEnv['PATH']}`
      : cargoBin;
  }

  const started = Date.now();
  const spawnFn = input.spawnProcess ?? spawn;
  const killGroup = input.killGroup ?? killProcessGroup;
  const max = step.maxOutputBytes;
  return new Promise((resolvePromise, rejectPromise) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let oversized = false;
    let outputTruncated = false;
    let stdoutDropped = false;
    let stderrDropped = false;
    let settled = false;
    let timedOut = false;
    let cancelRequested = false;
    let onAbort: (() => void) | undefined;
    const timer: { current: NodeJS.Timeout | null } = { current: null };
    const settlementTimer: { current: NodeJS.Timeout | null } = { current: null };

    const detach = (): void => {
      if (timer.current) clearTimeout(timer.current);
      if (settlementTimer.current) clearTimeout(settlementTimer.current);
      if (onAbort && input.signal) input.signal.removeEventListener('abort', onAbort);
      onAbort = undefined;
    };
    const captured = (): { stdout: string; stderr: string } => ({
      stdout: decodeUtf8Prefix(Buffer.concat(stdoutChunks)),
      stderr: decodeUtf8Prefix(Buffer.concat(stderrChunks)),
    });
    const finish = (status: CliEvidenceStepStatus, exitCode: number | null, extra: string): void => {
      if (settled) return;
      settled = true;
      detach();
      const durationMs = Math.max(0, Date.now() - started);
      const raw = captured();
      // Reserve room for the finish note (e.g. the truncation marker) inside
      // the per-step budget — the note is the receipt's only signal that output
      // was cut, and the combined tails must stay ≤ max.
      const noteBytes = extra ? Buffer.byteLength(extra) + 1 : 0;
      const out = redactPersistent(raw.stdout, secrets, Math.max(0, max - noteBytes), paths);
      const remainingReceiptBytes = Math.max(0, max - Buffer.byteLength(out));
      const err = redactPersistent(
        (raw.stderr + (extra ? '\n' + extra : '')).trim(),
        secrets,
        remainingReceiptBytes,
        paths,
      );
      if (status !== 'passed' && status !== 'failed') {
        resolvePromise(failStep(step, status, durationMs, exitCode, out, err, safeArgv));
        return;
      }
      const assertions = evaluateCliEvidenceAssertions({
        expect: step.expect,
        exitCode,
        stdout: raw.stdout,
        stderr: raw.stderr,
        truncated: { stdout: stdoutDropped, stderr: stderrDropped },
      });
      const assertionOk = assertions.every((assertion) => assertion.ok);
      resolvePromise({
        id: step.id,
        argv: safeArgv,
        cwd: step.cwd,
        status: assertionOk ? 'passed' : 'failed',
        exitCode,
        durationMs,
        stdoutTail: out,
        stderrTail: err,
        assertions,
        ok: assertionOk || step.optional,
        optional: step.optional,
      });
    };
    const abortWithKill = (): void => {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      const error = new VerificationAbortedError(
        'verification aborted during CLI evidence',
        isForceVerificationCancel(input.signal?.reason),
      );
      if (typeof childPid !== 'number') {
        settled = true;
        detach();
        rejectPromise(error);
        return;
      }
      settlementTimer.current = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* reject below regardless */ }
        if (settled) return;
        settled = true;
        detach();
        rejectPromise(error);
      }, 1_000);
      void killGroup(childPid, {
        label: 'cli-evidence process-group',
        force: isForceVerificationCancel(input.signal?.reason),
        ...(input.signal?.reason && typeof input.signal.reason === 'object'
          ? { cancelReason: input.signal.reason as { force: boolean } }
          : {}),
      }).then(
        () => {
          if (settled) return;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          settled = true;
          detach();
          rejectPromise(error);
        },
        () => {
          if (settled) return;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          settled = true;
          detach();
          rejectPromise(error);
        },
      );
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(invocation.file, [...invocation.args], {
        cwd: invocation.cwd,
        env: spawnEnv,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'spawn failed';
      finish(invocation.boundary === 'bubblewrap' ? 'sandbox_error' : 'spawn_error', null, message);
      return;
    }
    const childPid = child.pid;
    const forceTermination = (
      status: 'timeout' | 'oversized_output',
      extra: string,
      label: string,
    ): void => {
      if (typeof childPid === 'number') {
        void killGroup(childPid, { force: true, graceMs: 0, label }).catch(() => {
          try { child.kill('SIGKILL'); } catch { /* settlement watchdog still applies */ }
        });
      }
      // A broken/custom kill implementation or missing close event must not
      // hold the verifier forever. Guardian's bwrap PID namespace tears down
      // descendants when its command process is killed.
      settlementTimer.current = setTimeout(() => {
        finish(status, null, extra + '; process close unconfirmed');
      }, 1_000);
    };
    const capture = (target: Buffer[], chunk: Buffer | string): void => {
      if (oversized || settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = max - capturedBytes;
      if (remaining > 0) {
        const take = Math.min(remaining, bytes.length);
        target.push(Buffer.from(bytes.subarray(0, take)));
        capturedBytes += take;
      }
      if (bytes.length > remaining) {
        if (input.overflowMode !== 'terminate') {
          outputTruncated = true;
          // Per-stream honesty for the assertions: a stream that lost bytes
          // can never prove a negative (stderr_empty, missing stdout_contains).
          if (target === stdoutChunks) stdoutDropped = true;
          else stderrDropped = true;
        } else {
          oversized = true;
          child.stdout?.pause();
          child.stderr?.pause();
          forceTermination(
            'oversized_output',
            'output exceeded combined max_output_bytes',
            'cli-evidence overflow',
          );
        }
      }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => capture(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => capture(stderrChunks, chunk));
    child.on('error', (err) => {
      if (cancelRequested) return;
      finish(invocation.boundary === 'bubblewrap' ? 'sandbox_error' : 'spawn_error', null, err.message);
    });
    child.on('close', (code, closeSignal) => {
      if (cancelRequested) return;
      if (timedOut) {
        finish('timeout', code, 'timed out after ' + String(step.timeoutMs) + 'ms');
      } else if (oversized) {
        finish('oversized_output', code, 'output exceeded combined max_output_bytes');
      } else if (
        invocation.boundary === 'bubblewrap' &&
        captured().stderr.trimStart().startsWith('bwrap:')
      ) {
        finish('sandbox_error', code, 'sandbox boundary failed closed');
      } else if (closeSignal) {
        finish('failed', code, 'terminated by ' + closeSignal);
      } else {
        finish('passed', code, outputTruncated ? 'output truncated at configured byte limit' : '');
      }
    });
    timer.current = setTimeout(() => {
      timedOut = true;
      forceTermination(
        'timeout',
        'timed out after ' + String(step.timeoutMs) + 'ms',
        'cli-evidence timeout',
      );
    }, step.timeoutMs);
    if (input.signal) {
      onAbort = abortWithKill;
      if (input.signal.aborted) abortWithKill();
      else input.signal.addEventListener('abort', abortWithKill, { once: true });
    }
  });
}
