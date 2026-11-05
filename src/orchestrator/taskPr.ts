/**
 * Sole IO entrypoint for PR operations derived from task metadata.
 *
 * Every read or mutation first binds the task URL to repos.yaml, then validates
 * identity fields returned by GitHub. Callers never trust `task.prUrl` alone.
 */
import {
  assertPrIdentityPayload,
  bindTaskPrUrl,
  PR_IDENTITY_JSON_FIELDS,
  PrIdentityError,
  type BoundTaskPr,
  type PrIdentityRejectReason,
} from '../domain/prIdentity.js';
import type { RepoConfig } from '../domain/repos.js';
import {
  defaultGhRunner,
  OpenPrError,
  parsePrLifecyclePayload,
  type GhRunner,
  type PrLifecycleStatus,
} from './openPr.js';
import { neutralizeUntrustedPacketText } from '../domain/packetNeutralize.js';

export interface TaskPrInput {
  readonly prUrl: string;
  readonly taskId: string;
  readonly repo: RepoConfig;
  readonly gh?: GhRunner;
  /** Cursor Cloud factory: accept a remote feature head instead of hercules/<id>. */
  readonly remoteFactoryPr?: boolean;
}

export class TaskPrIdentityError extends OpenPrError {
  override readonly name = 'TaskPrIdentityError';

  constructor(
    message: string,
    readonly reason: PrIdentityRejectReason,
  ) {
    super(message);
  }
}

export interface PrCommentItem {
  readonly author: string;
  readonly body: string;
  readonly kind: 'issue' | 'review' | 'inline';
  readonly createdAt: string;
}

export interface PrSummary {
  readonly prUrl: string;
  readonly state: string;
  readonly mergeable: string | null;
  readonly reviewDecision: string | null;
  readonly ciStatus: 'success' | 'failure' | 'pending' | 'neutral' | 'unknown';
  readonly ciSummary: string;
  readonly commentCount: number;
  readonly reviewCount: number;
  readonly title: string | null;
  /** Strictly validated merge commit when state is MERGED; otherwise null. */
  readonly mergeCommitSha: string | null;
}

/** Internal CONFLICTING probe — not the /api pr-summary shape. */
export interface PrConflictProbe {
  readonly mergeable: string | null;
  readonly headRefName: string;
}

/** Internal factory CI probe — not the /api pr-summary shape. */
export interface PrCiProbe {
  readonly ciStatus: PrSummary['ciStatus'];
  readonly ciSummary: string;
  readonly failingChecks: readonly string[];
  readonly headRefName: string;
}

/** Internal factory BEHIND probe — not the /api pr-summary shape. */
export interface PrBehindProbe {
  readonly mergeStateStatus: string | null;
  readonly ciStatus: PrSummary['ciStatus'];
  readonly headRefName: string;
}

/** Internal factory draft probe — not the /api pr-summary shape. */
export interface PrDraftProbe {
  readonly isDraft: boolean;
  readonly mergeStateStatus: string | null;
}

/** Internal factory CLEAN merge probe — not the /api pr-summary shape. */
export interface PrMergeProbe {
  readonly isDraft: boolean;
  readonly mergeable: string | null;
  readonly mergeStateStatus: string | null;
  readonly ciStatus: PrSummary['ciStatus'];
}

/** Internal factory head probe — identity + Cloud Agent branch only. */
export interface PrHeadProbe {
  readonly headRefName: string;
}

/**
 * Best-effort lifecycle for periodic reconciliation.
 *
 * Identity and transport failures are logged and return null, so callers cannot
 * clobber a known status or merge provenance.
 */
export async function fetchBoundPrLifecycle(
  input: TaskPrInput,
): Promise<PrLifecycleStatus | null> {
  try {
    const bound = bindOrThrow(input);
    const record = await viewBoundPr(input, bound, ['state', 'mergeCommit']);
    return parsePrLifecyclePayload(record);
  } catch (err) {
    console.error(
      `[hercules] PR lifecycle skipped for ${input.taskId}: ${errorMessage(err)}`,
    );
    return null;
  }
}

/**
 * Validated Cloud Agent head for fail-retry dispatch.
 * Conflict / CI / BEHIND already store this; a failed agent does not.
 */
export async function fetchBoundPrHeadProbe(input: TaskPrInput): Promise<PrHeadProbe> {
  const bound = bindOrThrow(input);
  const record = await viewBoundPr(input, bound, []);
  return {
    headRefName: String(record['headRefName'] ?? '').trim(),
  };
}

/**
 * Mergeability + validated head for CONFLICTING requeue.
 * Factory rework needs the Cloud Agent head; this is not an API DTO.
 */
export async function fetchBoundPrConflictProbe(
  input: TaskPrInput,
): Promise<PrConflictProbe> {
  const bound = bindOrThrow(input);
  const record = await viewBoundPr(input, bound, ['mergeable']);
  return {
    mergeable: record['mergeable'] != null ? String(record['mergeable']) : null,
    headRefName: String(record['headRefName'] ?? '').trim(),
  };
}

/**
 * Check rollup + validated head for factory CI requeue.
 * Factory never ran local L1/L2; a red rollup is the mechanical gate.
 */
export async function fetchBoundPrCiProbe(input: TaskPrInput): Promise<PrCiProbe> {
  const bound = bindOrThrow(input);
  const record = await viewBoundPr(input, bound, ['statusCheckRollup']);
  const rollup = Array.isArray(record['statusCheckRollup'])
    ? (record['statusCheckRollup'] as Array<Record<string, unknown>>)
    : [];
  const checks = summarizeChecks(rollup);
  return {
    ciStatus: checks.ciStatus,
    ciSummary: checks.ciSummary,
    failingChecks: checks.failingChecks,
    headRefName: String(record['headRefName'] ?? '').trim(),
  };
}

/**
 * mergeStateStatus + check rollup + validated head for factory BEHIND requeue.
 * Pending/red checks stay on the existing observe paths (ring 8).
 */
export async function fetchBoundPrBehindProbe(input: TaskPrInput): Promise<PrBehindProbe> {
  const bound = bindOrThrow(input);
  const record = await viewBoundPr(input, bound, ['mergeStateStatus', 'statusCheckRollup']);
  const rollup = Array.isArray(record['statusCheckRollup'])
    ? (record['statusCheckRollup'] as Array<Record<string, unknown>>)
    : [];
  const checks = summarizeChecks(rollup);
  return {
    mergeStateStatus:
      record['mergeStateStatus'] != null ? String(record['mergeStateStatus']) : null,
    ciStatus: checks.ciStatus,
    headRefName: String(record['headRefName'] ?? '').trim(),
  };
}

/**
 * Draft bit + mergeStateStatus for factory ready conversion.
 * Missing isDraft is false; mergeStateStatus DRAFT is the fallback.
 */
export async function fetchBoundPrDraftProbe(input: TaskPrInput): Promise<PrDraftProbe> {
  const bound = bindOrThrow(input);
  const record = await viewBoundPr(input, bound, ['isDraft', 'mergeStateStatus']);
  return {
    isDraft: record['isDraft'] === true,
    mergeStateStatus:
      record['mergeStateStatus'] != null ? String(record['mergeStateStatus']) : null,
  };
}

/**
 * Convert a draft factory PR to ready for review. Identity-bound.
 * Already-ready is a success (race with the Cloud Agent).
 */
export async function markBoundPrReady(input: TaskPrInput): Promise<void> {
  const bound = bindOrThrow(input);
  await viewBoundPr(input, bound, ['isDraft']);
  const gh = input.gh ?? defaultGhRunner;
  const n = String(bound.number);
  const ready = await gh(['pr', 'ready', n, '--repo', bound.slug]);
  if (ready.exitCode === 0) return;
  const detail = `${ready.stderr} ${ready.stdout}`.toLowerCase();
  if (
    detail.includes('not a draft') ||
    detail.includes('is not a draft') ||
    detail.includes('already ready')
  ) {
    return;
  }
  throw new OpenPrError(ready.stderr.trim() || `gh pr ready #${n} failed`);
}

/**
 * Draft + mergeable + mergeStateStatus + check rollup for factory squash-merge.
 * CONFLICTING / red / BEHIND / draft stay on earlier observe paths.
 */
export async function fetchBoundPrMergeProbe(input: TaskPrInput): Promise<PrMergeProbe> {
  const bound = bindOrThrow(input);
  const record = await viewBoundPr(input, bound, [
    'isDraft',
    'mergeable',
    'mergeStateStatus',
    'statusCheckRollup',
  ]);
  const rollup = Array.isArray(record['statusCheckRollup'])
    ? (record['statusCheckRollup'] as Array<Record<string, unknown>>)
    : [];
  const checks = summarizeChecks(rollup);
  return {
    isDraft: record['isDraft'] === true,
    mergeable: record['mergeable'] != null ? String(record['mergeable']) : null,
    mergeStateStatus:
      record['mergeStateStatus'] != null ? String(record['mergeStateStatus']) : null,
    ciStatus: checks.ciStatus,
  };
}

/**
 * Rebase a BEHIND factory PR onto its base. Identity-bound.
 * Already-up-to-date is a success (race with a human or a sibling observe).
 */
export async function rebaseBoundFactoryPr(input: TaskPrInput): Promise<void> {
  const bound = bindOrThrow(input);
  await viewBoundPr(input, bound, ['mergeable', 'mergeStateStatus']);
  const gh = input.gh ?? defaultGhRunner;
  const n = String(bound.number);
  const rebased = await gh(['pr', 'rebase', n, '--repo', bound.slug]);
  if (rebased.exitCode === 0) return;
  const detail = `${rebased.stderr} ${rebased.stdout}`.toLowerCase();
  if (
    detail.includes('already up-to-date') ||
    detail.includes('already up to date') ||
    detail.includes('is not behind') ||
    detail.includes('not behind')
  ) {
    return;
  }
  throw new OpenPrError(rebased.stderr.trim() || `gh pr rebase #${n} failed`);
}

/**
 * Squash-merge a ready factory PR. Identity-bound.
 * Already-merged is a success (race with GitHub / a human click).
 */
export async function mergeBoundFactoryPr(input: TaskPrInput): Promise<void> {
  const bound = bindOrThrow(input);
  await viewBoundPr(input, bound, ['isDraft', 'mergeable']);
  const gh = input.gh ?? defaultGhRunner;
  const n = String(bound.number);
  const merged = await gh(['pr', 'merge', n, '--repo', bound.slug, '--squash']);
  if (merged.exitCode === 0) return;
  const detail = `${merged.stderr} ${merged.stdout}`.toLowerCase();
  if (
    detail.includes('already merged') ||
    detail.includes('was already merged') ||
    detail.includes('is already merged')
  ) {
    return;
  }
  throw new OpenPrError(merged.stderr.trim() || `gh pr merge --squash #${n} failed`);
}

/** Explicit phone/API summary. Identity failures remain typed and actionable. */
export async function fetchBoundPrSummary(input: TaskPrInput): Promise<PrSummary> {
  const bound = bindOrThrow(input);
  const record = await viewBoundPr(input, bound, [
    'state',
    'mergeable',
    'reviewDecision',
    'title',
    'comments',
    'reviews',
    'statusCheckRollup',
    'mergeCommit',
  ]);
  const comments = Array.isArray(record['comments']) ? record['comments'] : [];
  const reviews = Array.isArray(record['reviews']) ? record['reviews'] : [];
  const rollup = Array.isArray(record['statusCheckRollup'])
    ? (record['statusCheckRollup'] as Array<Record<string, unknown>>)
    : [];
  const checks = summarizeChecks(rollup);
  const lifecycle = parsePrLifecyclePayload(record);
  return {
    prUrl: bound.canonicalUrl,
    state: String(record['state'] ?? 'unknown'),
    mergeable: record['mergeable'] != null ? String(record['mergeable']) : null,
    reviewDecision:
      record['reviewDecision'] != null ? String(record['reviewDecision']) : null,
    ciStatus: checks.ciStatus,
    ciSummary: checks.ciSummary,
    commentCount: comments.length,
    reviewCount: reviews.length,
    title: record['title'] != null ? String(record['title']) : null,
    mergeCommitSha: lifecycle?.mergeCommitSha ?? null,
  };
}

/**
 * Read comments only after a read-only identity preflight. This proves a stale
 * same-repository PR number cannot expose another task's review conversation.
 */
export async function fetchBoundPrComments(
  input: TaskPrInput & { readonly maxChars?: number },
): Promise<{
  readonly draft: string;
  readonly commentCount: number;
  readonly items: readonly PrCommentItem[];
}> {
  const bound = bindOrThrow(input);
  await viewBoundPr(input, bound, []);
  const gh = input.gh ?? defaultGhRunner;
  const n = String(bound.number);
  const items: PrCommentItem[] = [];

  const issue = await gh(['api', `repos/${bound.slug}/issues/${n}/comments`]);
  if (issue.exitCode === 0) {
    collectComments(items, asObjectArray(issue.stdout), 'issue');
  }
  const reviews = await gh(['api', `repos/${bound.slug}/pulls/${n}/reviews`]);
  if (reviews.exitCode === 0) {
    collectComments(items, asObjectArray(reviews.stdout), 'review');
  }
  const inline = await gh(['api', `repos/${bound.slug}/pulls/${n}/comments`]);
  if (inline.exitCode === 0) {
    collectComments(items, asObjectArray(inline.stdout), 'inline');
  }

  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (items.length === 0) {
    return { draft: '', commentCount: 0, items: [] };
  }
  const lines = [
    `Address the following GitHub PR feedback on ${bound.canonicalUrl}.`,
    'Apply the requested changes on this branch; the open PR will update when you finish.',
    '',
  ];
  for (const item of items) {
    const tag = item.kind === 'issue' ? 'comment' : item.kind;
    // PR comment bodies are anyone-who-can-comment controlled and become a
    // Human steer — neutralize fence/heading look-alikes at the write site.
    lines.push(
      `### @${item.author} (${tag})`,
      '',
      neutralizeUntrustedPacketText(item.body, { taskId: input.taskId }),
      '',
    );
  }
  const maxChars = input.maxChars ?? 3800;
  let draft = lines.join('\n').trim();
  if (draft.length > maxChars) {
    draft = `${draft.slice(0, Math.max(0, maxChars - 20))}\n\n…(truncated)`;
  }
  return { draft, commentCount: items.length, items };
}

/**
 * Close a PR only after a read-only identity preflight. Wrong repository URLs
 * fail during binding before the first gh invocation.
 */
export async function closeBoundGithubPr(input: TaskPrInput): Promise<string> {
  const bound = bindOrThrow(input);
  await viewBoundPr(input, bound, []);
  const gh = input.gh ?? defaultGhRunner;
  const n = String(bound.number);
  const closeArgs = [
    'pr',
    'close',
    n,
    '--repo',
    bound.slug,
    '--comment',
    'Closed by Hercules task delete (cleanup).',
  ] as const;
  const closed = await gh([
    'pr',
    'close',
    n,
    '--repo',
    bound.slug,
    '--delete-branch',
    '--comment',
    'Closed by Hercules task delete (cleanup).',
  ]);
  if (closed.exitCode === 0) {
    return `PR #${n} closed (+ branch delete attempted)`;
  }
  const soft = await gh(closeArgs);
  if (soft.exitCode === 0) {
    const detail = closed.stderr.trim().slice(0, 80) || 'delete-branch failed';
    return `PR #${n} closed (branch kept: ${detail})`;
  }
  throw new OpenPrError(
    soft.stderr.trim() || closed.stderr.trim() || `gh pr close #${n} failed`,
  );
}

function bindOrThrow(input: TaskPrInput): BoundTaskPr {
  try {
    return bindTaskPrUrl({
      prUrl: input.prUrl,
      taskId: input.taskId,
      repoUrl: input.repo.url,
      defaultBranch: input.repo.defaultBranch,
      ...(input.remoteFactoryPr === true ? { remoteFactoryPr: true } : {}),
    });
  } catch (err) {
    if (err instanceof PrIdentityError) {
      throw new TaskPrIdentityError(err.message, err.reason);
    }
    throw err;
  }
}

async function viewBoundPr(
  input: TaskPrInput,
  bound: BoundTaskPr,
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  const gh = input.gh ?? defaultGhRunner;
  const fieldList = [PR_IDENTITY_JSON_FIELDS, ...fields].join(',');
  const view = await gh([
    'pr',
    'view',
    String(bound.number),
    '--repo',
    bound.slug,
    '--json',
    fieldList,
  ]);
  if (view.exitCode !== 0) {
    throw new OpenPrError(
      view.stderr.trim() || `gh pr view #${bound.number} failed`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(view.stdout);
  } catch {
    throw new OpenPrError(`gh pr view #${bound.number} returned invalid JSON`);
  }
  try {
    assertPrIdentityPayload(payload, bound);
  } catch (err) {
    if (err instanceof PrIdentityError) {
      throw new TaskPrIdentityError(err.message, err.reason);
    }
    throw err;
  }
  return payload;
}

function collectComments(
  out: PrCommentItem[],
  rows: readonly Record<string, unknown>[],
  kind: PrCommentItem['kind'],
): void {
  for (const row of rows) {
    const rawBody = String(row['body'] ?? '').trim();
    if (!rawBody) continue;
    const user = row['user'] as { login?: string } | undefined;
    const path =
      kind === 'inline' && row['path'] ? ` (${String(row['path'])})` : '';
    const createdAt =
      kind === 'review'
        ? String(row['submitted_at'] ?? row['created_at'] ?? '')
        : String(row['created_at'] ?? '');
    out.push({
      author: user?.login ?? 'unknown',
      body: `${rawBody}${path}`,
      kind,
      createdAt,
    });
  }
}

function asObjectArray(stdout: string): Array<Record<string, unknown>> {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      );
    }
    if (value !== null && typeof value === 'object') {
      return [value as Record<string, unknown>];
    }
  } catch {
    // A malformed optional comment endpoint contributes no items.
  }
  return [];
}

function checkDisplayName(check: Record<string, unknown>): string {
  const name = String(check['name'] ?? '').trim();
  if (name) return name;
  const context = String(check['context'] ?? '').trim();
  if (context) return context;
  return String(check['workflowName'] ?? '').trim();
}

function summarizeChecks(
  rollup: readonly Record<string, unknown>[],
): Pick<PrSummary, 'ciStatus' | 'ciSummary'> & { readonly failingChecks: readonly string[] } {
  if (rollup.length === 0) {
    return { ciStatus: 'neutral', ciSummary: 'no checks reported', failingChecks: [] };
  }
  let success = 0;
  let failure = 0;
  let pending = 0;
  const failingChecks: string[] = [];
  for (const check of rollup) {
    const conclusion = String(check['conclusion'] ?? '').toLowerCase();
    const state = String(check['state'] ?? '').toLowerCase();
    const status = String(check['status'] ?? '').toLowerCase();
    if (
      ['failure', 'timed_out', 'cancelled'].includes(conclusion) ||
      ['failure', 'error'].includes(state)
    ) {
      failure += 1;
      const label = checkDisplayName(check);
      if (label) failingChecks.push(label);
    } else if (
      ['success', 'neutral', 'skipped'].includes(conclusion) ||
      state === 'success' ||
      (status === 'completed' && conclusion !== 'failure')
    ) {
      success += 1;
    } else {
      pending += 1;
    }
  }
  const ciSummary =
    `${success} ok · ${failure} fail · ${pending} pending (${rollup.length} checks)`;
  if (failure > 0) return { ciStatus: 'failure', ciSummary, failingChecks };
  if (pending > 0) return { ciStatus: 'pending', ciSummary, failingChecks };
  if (success > 0) return { ciStatus: 'success', ciSummary, failingChecks };
  return { ciStatus: 'unknown', ciSummary, failingChecks };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
