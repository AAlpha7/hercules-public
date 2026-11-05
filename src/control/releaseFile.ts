/**
 * Control layer — release file parse/serialize
 * (`releases/<repoKey>.md`, design §1).
 *
 * Same conventions as {@link ./taskFile.ts}: YAML front matter (snake_case)
 * + free-form markdown body (Release packet); deterministic key order for
 * minimal git diffs; tolerant defaults for legacy/missing fields.
 */
import matter from 'gray-matter';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  emptyRelease,
  isPromoteOutcome,
  isStagingStatus,
  type LastPromoteFailure,
  type Release,
  type ReleaseHistoryEntry,
  type StagingStatus,
} from '../domain/release.js';
import { isValidIdentifier } from '../domain/task.js';

export class ReleaseFileError extends Error {
  override readonly name = 'ReleaseFileError';
  constructor(
    message: string,
    readonly stem: string,
  ) {
    super(`release '${stem}': ${message}`);
  }
}

// YAML auto-parses unquoted ISO timestamps into Date objects; coerce them back.
const isoTimestamp = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.string().nullable().optional().default(null),
);

const nullableSha = z
  .string()
  .nullable()
  .optional()
  .transform((v) => {
    if (v === undefined || v === null || v.trim() === '') return null;
    return v;
  });

const historyEntrySchema = z.object({
  sha: z.string().min(1),
  at: z.preprocess((v) => (v instanceof Date ? v.toISOString() : v), z.string().min(1)),
  outcome: z.string().refine(isPromoteOutcome, { message: 'unknown promote outcome' }),
  rollback_of: z.string().optional(),
});

const lastPromoteFailureSchema = z
  .object({
    sha: z.string().min(1),
    reason: z.string().min(1),
    at: z.preprocess((v) => (v instanceof Date ? v.toISOString() : v), z.string().min(1)),
    booted_sha: nullableSha,
  })
  .nullable()
  .optional()
  .transform((v): LastPromoteFailure | null => {
    if (v === undefined || v === null) return null;
    return {
      sha: v.sha,
      reason: v.reason,
      at: v.at,
      bootedSha: v.booted_sha ?? null,
    };
  });

const frontMatterSchema = z.object({
  production_sha: nullableSha,
  production_deployed_at: isoTimestamp,
  staging_sha: nullableSha,
  staging_status: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx): StagingStatus | null => {
      if (v === undefined || v === null || v.trim() === '') return null;
      if (!isStagingStatus(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown staging_status '${v}'` });
        return z.NEVER;
      }
      return v;
    }),
  staging_verified_at: isoTimestamp,
  staging_started_at: isoTimestamp,
  promoting_sha: nullableSha,
  last_promote_failure: lastPromoteFailureSchema,
  history: z.array(historyEntrySchema).optional().default([]),
});

export function parseReleaseFile(content: string, stem: string): Release {
  if (!isValidIdentifier(stem)) {
    throw new ReleaseFileError(`file stem is not a safe identifier`, stem);
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    throw new ReleaseFileError(`could not parse front matter: ${(err as Error).message}`, stem);
  }

  // gray-matter yields empty data for "---\n---\n" or body-only; body-only is an error,
  // but an empty front-matter block is a valid bootstrap (tolerant parse).
  const hasFence = content.trimStart().startsWith('---');
  if (!hasFence) {
    throw new ReleaseFileError('missing YAML front matter', stem);
  }

  const result = frontMatterSchema.safeParse(parsed.data ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ReleaseFileError(`invalid front matter: ${issues}`, stem);
  }

  const fm = result.data;
  const history: ReleaseHistoryEntry[] = fm.history.map((h) => {
    const entry: ReleaseHistoryEntry = {
      sha: h.sha,
      at: h.at,
      // Safe: schema refined with isPromoteOutcome.
      outcome: h.outcome as ReleaseHistoryEntry['outcome'],
    };
    if (h.rollback_of !== undefined && h.rollback_of !== '') {
      return { ...entry, rollbackOf: h.rollback_of };
    }
    return entry;
  });

  return {
    repoKey: stem,
    productionSha: fm.production_sha ?? null,
    productionDeployedAt: fm.production_deployed_at ?? null,
    stagingSha: fm.staging_sha ?? null,
    stagingStatus: fm.staging_status ?? null,
    stagingVerifiedAt: fm.staging_verified_at ?? null,
    stagingStartedAt: fm.staging_started_at ?? null,
    promotingSha: fm.promoting_sha ?? null,
    lastPromoteFailure: fm.last_promote_failure ?? null,
    history,
    body: parsed.content.trim(),
  };
}

/**
 * Serialize a release to its on-disk form. Keys are emitted in a fixed order
 * so the diff is stable across writes. Null optionals are omitted (except we
 * always emit a coherent minimal shape for an empty bootstrap).
 */
export function serializeRelease(release: Release): string {
  const frontMatter: Record<string, unknown> = {};

  if (release.productionSha !== null) frontMatter['production_sha'] = release.productionSha;
  if (release.productionDeployedAt !== null) {
    frontMatter['production_deployed_at'] = release.productionDeployedAt;
  }
  if (release.stagingSha !== null) frontMatter['staging_sha'] = release.stagingSha;
  if (release.stagingStatus !== null) frontMatter['staging_status'] = release.stagingStatus;
  if (release.stagingVerifiedAt !== null) {
    frontMatter['staging_verified_at'] = release.stagingVerifiedAt;
  }
  if (release.stagingStartedAt !== null) {
    frontMatter['staging_started_at'] = release.stagingStartedAt;
  }
  if (release.promotingSha !== null) frontMatter['promoting_sha'] = release.promotingSha;
  if (release.lastPromoteFailure != null) {
    const failure: Record<string, unknown> = {
      sha: release.lastPromoteFailure.sha,
      reason: release.lastPromoteFailure.reason,
      at: release.lastPromoteFailure.at,
    };
    if (release.lastPromoteFailure.bootedSha !== null) {
      failure['booted_sha'] = release.lastPromoteFailure.bootedSha;
    }
    frontMatter['last_promote_failure'] = failure;
  }

  if (release.history.length > 0) {
    frontMatter['history'] = release.history.map((h) => {
      const entry: Record<string, unknown> = {
        sha: h.sha,
        at: h.at,
        outcome: h.outcome,
      };
      if (h.rollbackOf !== undefined) entry['rollback_of'] = h.rollbackOf;
      return entry;
    });
  }

  // Bootstrap / empty: emit a minimal empty document with fences so parse is tolerant.
  if (Object.keys(frontMatter).length === 0) {
    const body = release.body.trim();
    return body === '' ? `---\n---\n` : `---\n---\n\n${body}\n`;
  }

  const yaml = stringifyYaml(frontMatter, { lineWidth: 0 });
  const body = release.body.trim();
  return body === '' ? `---\n${yaml}---\n` : `---\n${yaml}---\n\n${body}\n`;
}

/** Convenience: blank release serialized for first write. */
export function serializeEmptyRelease(repoKey: string): string {
  return serializeRelease(emptyRelease(repoKey));
}
