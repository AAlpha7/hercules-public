/**
 * Domain layer — Release as a first-class control-repo citizen.
 *
 * Pure: no IO, git, fs, or network. The control layer maps
 * `releases/<repoKey>.md` front matter ↔ these types; the orchestrator
 * (later stages) drives transitions.
 */

import { listAfterDeployCriteriaTexts } from './acceptance.js';

/** Staging lifecycle: deploy → health → evidence verify → ready | failed. */
export const STAGING_STATUSES = ['deploying', 'verifying', 'ready', 'failed'] as const;
export type StagingStatus = (typeof STAGING_STATUSES)[number];

export function isStagingStatus(value: unknown): value is StagingStatus {
  return typeof value === 'string' && (STAGING_STATUSES as readonly string[]).includes(value);
}

/** Outcome of a production promote attempt. */
export const PROMOTE_OUTCOMES = ['ok', 'rolled_back'] as const;
export type PromoteOutcome = (typeof PROMOTE_OUTCOMES)[number];

export function isPromoteOutcome(value: unknown): value is PromoteOutcome {
  return typeof value === 'string' && (PROMOTE_OUTCOMES as readonly string[]).includes(value);
}

/** One entry in the promote audit history (recent promotes). */
export interface ReleaseHistoryEntry {
  readonly sha: string;
  /** ISO timestamp. */
  readonly at: string;
  readonly outcome: PromoteOutcome;
  /**
   * When `outcome === 'rolled_back'`, the sha that was abandoned (the
   * failed/aborted promote). `sha` is the known-good target restored.
   */
  readonly rollbackOf?: string;
}

/**
 * Boot-finalization failure note when the running daemon is not the
 * promoting tip (operator restored an older tree, dirty/unknown build).
 * Optional on-disk field — absent on legacy release files.
 */
export interface LastPromoteFailure {
  /** Promoting tip that failed to finalize. */
  readonly sha: string;
  /** Daemon build sha when known; null when dirty/undetectable. */
  readonly bootedSha: string | null;
  /** Machine reason, e.g. `booted_build_mismatch` / `booted_build_unknown`. */
  readonly reason: string;
  /** ISO timestamp. */
  readonly at: string;
}

/**
 * Per-repo release record. Field names are camelCase here; on-disk front
 * matter uses snake_case (same convention as Task).
 */
export interface Release {
  /** MUST equal the file stem (`releases/<repoKey>.md`); safe identifier. */
  readonly repoKey: string;
  readonly productionSha: string | null;
  readonly productionDeployedAt: string | null;
  readonly stagingSha: string | null;
  /** null = never deployed / unknown (bootstrap / legacy empty file). */
  readonly stagingStatus: StagingStatus | null;
  readonly stagingVerifiedAt: string | null;
  /**
   * ISO timestamp when the current staging deploy/verify cycle began.
   * Set on deploy start; refreshed when evidence verify starts; cleared on
   * ready|failed. Powers stuck-timeout recovery + UI elapsed duration.
   */
  readonly stagingStartedAt: string | null;
  /**
   * Set *before* production deploy begins so a self-restarting deploy
   * (Hercules deploying itself) survives and can finalize on boot.
   */
  readonly promotingSha: string | null;
  /**
   * Last boot-finalization failure (build mismatch / unknown). Cleared on
   * a successful promote finalize. Optional for legacy files.
   */
  readonly lastPromoteFailure?: LastPromoteFailure | null;
  readonly history: readonly ReleaseHistoryEntry[];
  /** Latest Release packet (markdown body after front matter). */
  readonly body: string;
}

/** Bootstrap a blank release for a repo that has never been released. */
export function emptyRelease(repoKey: string): Release {
  return {
    repoKey,
    productionSha: null,
    productionDeployedAt: null,
    stagingSha: null,
    stagingStatus: null,
    stagingVerifiedAt: null,
    stagingStartedAt: null,
    promotingSha: null,
    lastPromoteFailure: null,
    history: [],
    body: '',
  };
}

// ── Drift / preconditions / rollback target ─────────────────────────────

/**
 * Staging is stale relative to main when the tip differs from what is
 * deployed/verified on staging (or staging has no sha yet).
 */
export function hasStagingDrift(release: Release, mainSha: string): boolean {
  if (release.stagingSha === null || release.stagingSha === '') return true;
  return release.stagingSha !== mainSha;
}

/**
 * Promote preconditions (design §3): staging_status ready AND
 * staging_sha == mirror main (no drift).
 */
export function canPromote(release: Release, mainSha: string): boolean {
  if (release.stagingStatus !== 'ready') return false;
  if (release.stagingSha === null || release.stagingSha === '') return false;
  // Nothing to ship: production already runs this exact SHA. Re-promoting
  // would be a no-op that still restarts production (first promote 2026-07-17).
  if (release.productionSha === release.stagingSha) return false;
  return !hasStagingDrift(release, mainSha);
}

export class PromoteError extends Error {
  override readonly name = 'PromoteError';
  constructor(message: string) {
    super(message);
  }
}

export function assertCanPromote(release: Release, mainSha: string): void {
  if (release.stagingStatus !== 'ready') {
    throw new PromoteError(
      `promote blocked: staging_status is ${release.stagingStatus ?? 'null'}, need ready`,
    );
  }
  if (release.productionSha === release.stagingSha) {
    throw new PromoteError(
      `promote blocked: production already runs ${release.stagingSha ?? '(none)'} — nothing to ship`,
    );
  }
  if (hasStagingDrift(release, mainSha)) {
    throw new PromoteError(
      `promote blocked: staging_sha ${release.stagingSha ?? '(none)'} drifts from main ${mainSha}`,
    );
  }
}

/**
 * Rollback target selection: last history entry with outcome `ok` that is
 * **not** the in-flight `promoting_sha` (the tip being abandoned), else
 * `production_sha` when it differs from `promoting_sha`. null when neither
 * a distinct known-good tip exists.
 *
 * Auto-rollback during promote: `promoting_sha` is the failed tip and
 * production/history still point at the prior known-good.
 * Manual rollback: caller sets `promoting_sha` to the current production tip
 * first so this skips it and returns the previous ok entry.
 */
export function rollbackTarget(release: Release): string | null {
  const abandoning =
    release.promotingSha !== null && release.promotingSha !== ''
      ? release.promotingSha
      : null;
  for (let i = release.history.length - 1; i >= 0; i--) {
    const entry = release.history[i];
    if (entry === undefined || entry.outcome !== 'ok') continue;
    if (abandoning !== null && entry.sha === abandoning) continue;
    return entry.sha;
  }
  if (
    release.productionSha !== null &&
    release.productionSha !== '' &&
    release.productionSha !== abandoning
  ) {
    return release.productionSha;
  }
  return null;
}

/** One `(human, after deploy)` check from a task in the last promoted range. */
export interface AfterDeployCheck {
  readonly taskId: string;
  readonly title: string;
  readonly text: string;
}

/**
 * Production tip that the current one replaced: the latest `ok` history
 * entry whose sha differs from `productionSha`. null when production is
 * unknown, when the newest history entry is not `ok` at `productionSha`
 * (e.g. a rollback is the latest event), or when no earlier ok entry exists
 * (first ever promote).
 */
export function previousProductionSha(release: Release): string | null {
  const last = release.history[release.history.length - 1];
  if (last === undefined) return null;
  if (last.outcome !== 'ok') return null;
  if (release.productionSha === null || release.productionSha === '') return null;
  if (last.sha !== release.productionSha) return null;
  for (let i = release.history.length - 2; i >= 0; i--) {
    const entry = release.history[i];
    if (entry === undefined || entry.outcome !== 'ok') continue;
    if (entry.sha !== release.productionSha) return entry.sha;
  }
  return null;
}

// ── Transitions (immutable) ─────────────────────────────────────────────

/**
 * Main advanced (merge landed). Staging is now stale relative to the new
 * tip — expressed via {@link hasStagingDrift}, not a separate status.
 * Bookkeeping hook: returns the release unchanged (staging_sha still
 * describes what is running until the next staging deploy).
 */
export function mergeAdvancesMain(release: Release): Release {
  return release;
}

/** Staging deploy began for `sha` (reconciler / Deploy-now). */
export function stagingDeployStarted(
  release: Release,
  sha: string,
  startedAt?: string,
): Release {
  return {
    ...release,
    stagingSha: sha,
    stagingStatus: 'deploying',
    stagingVerifiedAt: null,
    stagingStartedAt: startedAt ?? release.stagingStartedAt ?? null,
  };
}

/**
 * Health passed; evidence verification in progress.
 * Optionally refreshes {@link Release.stagingStartedAt} so UI elapsed tracks
 * the verify phase when the caller passes a new ISO timestamp.
 */
export function stagingVerifyStarted(release: Release, startedAt?: string): Release {
  return {
    ...release,
    stagingStatus: 'verifying',
    ...(startedAt !== undefined ? { stagingStartedAt: startedAt } : {}),
  };
}

/** Staging evidence/health succeeded — open the promote path. */
export function stagingDeployVerified(release: Release, verifiedAt: string): Release {
  return {
    ...release,
    stagingStatus: 'ready',
    stagingVerifiedAt: verifiedAt,
    stagingStartedAt: null,
  };
}

/** Staging deploy or verify failed — production path stays closed. */
export function stagingDeployFailed(release: Release): Release {
  return {
    ...release,
    stagingStatus: 'failed',
    stagingVerifiedAt: null,
    stagingStartedAt: null,
  };
}

/**
 * Human Promote: record `promoting_sha` before the production deploy so a
 * self-restart can finalize on boot.
 */
export function promoteStarted(release: Release): Release {
  return {
    ...release,
    promotingSha: release.stagingSha,
  };
}

/** Production health+smoke succeeded — record production tip + ok history. */
export function promoteFinalized(release: Release, at: string): Release {
  const sha = release.promotingSha ?? release.stagingSha;
  if (sha === null || sha === '') {
    return {
      ...release,
      promotingSha: null,
      lastPromoteFailure: null,
    };
  }
  return {
    ...release,
    productionSha: sha,
    productionDeployedAt: at,
    promotingSha: null,
    lastPromoteFailure: null,
    history: [...release.history, { sha, at, outcome: 'ok' }],
  };
}

/**
 * Boot finalization found the running daemon is not the promoting tip (or
 * the build sha is unknown). Clear `promoting_sha`, leave `production_sha`
 * unchanged, and record {@link LastPromoteFailure}. Does not deploy.
 */
export function promoteFailedBootMismatch(
  release: Release,
  failure: LastPromoteFailure,
): Release {
  return {
    ...release,
    promotingSha: null,
    lastPromoteFailure: failure,
  };
}

/**
 * Production deploy failed (or manual rollback): restore last known-good
 * sha and append a `rolled_back` history entry.
 */
export function promoteRolledBack(release: Release, at: string): Release {
  const failedSha = release.promotingSha;
  const target = rollbackTarget(release);
  const entry: ReleaseHistoryEntry =
    failedSha !== null && failedSha !== ''
      ? {
          sha: target ?? failedSha,
          at,
          outcome: 'rolled_back',
          rollbackOf: failedSha,
        }
      : {
          sha: target ?? '',
          at,
          outcome: 'rolled_back',
        };

  // Prefer a concrete target; if none, leave production_sha as-is.
  const productionSha = target ?? release.productionSha;

  return {
    ...release,
    productionSha,
    productionDeployedAt: productionSha !== null ? at : release.productionDeployedAt,
    promotingSha: null,
    history: entry.sha === '' ? [...release.history] : [...release.history, entry],
  };
}

// ── Staging deploy debounce + release packet (reconciler, pure) ─────────

/** Default quiet period after main advances before auto staging deploy (5 min). */
export const DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS = 5 * 60 * 1000;

/**
 * Decide whether the release reconciler should start a staging deploy.
 * Pure: no IO. Callers supply clock + last-main-advance bookkeeping.
 */
export function shouldStartStagingDeploy(input: {
  readonly hasDrift: boolean;
  /** Promote in flight — always blocks (design §3). */
  readonly promotingSha: string | null;
  /** Human "Deploy staging now" bypasses the quiet period. */
  readonly deployNow: boolean;
  /** ms since epoch when mirror main last changed (null = unknown / first see). */
  readonly lastMainAdvanceAtMs: number | null;
  readonly nowMs: number;
  readonly debounceMs: number;
  /** Already deploying/verifying this tip — skip re-entry. */
  readonly inFlight: boolean;
}): boolean {
  if (!input.hasDrift) return false;
  if (input.promotingSha !== null && input.promotingSha !== '') return false;
  if (input.inFlight) return false;
  if (input.deployNow) return true;
  if (input.lastMainAdvanceAtMs === null) return false;
  return input.nowMs - input.lastMainAdvanceAtMs >= input.debounceMs;
}


/**
 * Phone-reachable staging URL for the Releases panel.
 *
 * WORKFLOW's `deploy.staging.url` is repo policy and often localhost (useless
 * off-box). Operators expose staging via a tunnel whose URL may rotate, so the
 * daemon resolves at request time: URL file (env STAGING_PUBLIC_URL_FILE,
 * refreshed by the tunnel unit) → STAGING_PUBLIC_URL env → WORKFLOW url.
 * Pure: file IO is injected.
 */
export function resolveStagingPublicUrl(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => string;
  readonly workflowUrl: string | null;
}): string | null {
  const file = input.env['STAGING_PUBLIC_URL_FILE'];
  if (file !== undefined && file.trim() !== '') {
    try {
      const url = input.readFile(file).trim();
      if (url.length > 0) return url;
    } catch {
      // fall through — rotating tunnel may not have written yet
    }
  }
  const direct = input.env['STAGING_PUBLIC_URL'];
  if (direct !== undefined && direct.trim() !== '') return direct.trim();
  return input.workflowUrl;
}

/** One task line in the Release packet (id + title + merge stamp). */
export interface ReleasePacketTask {
  readonly id: string;
  readonly title: string;
  readonly mergedSha: string;
}

/**
 * Tasks included in a staging release: same repo, stamped `merged_sha` that
 * lands in `(production_sha, staging_sha]` (exclusive of production).
 *
 * When `rangeShas` is provided (git log production..staging), a task is
 * included only if its `merged_sha` is in that set. Without git, all
 * non-production merged stamps for the repo are included (caller still
 * filters by staging tip identity when needed).
 */
export function selectTasksForRelease(
  tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly repo: string;
    readonly mergedSha?: string | null;
  }[],
  opts: {
    readonly repoKey: string;
    readonly productionSha: string | null;
    readonly stagingSha: string;
    /** Commit SHAs in production..staging (inclusive of staging). */
    readonly rangeShas?: ReadonlySet<string>;
  },
): ReleasePacketTask[] {
  const out: ReleasePacketTask[] = [];
  for (const t of tasks) {
    if (t.repo !== opts.repoKey) continue;
    const m = t.mergedSha;
    if (m === undefined || m === null || m === '') continue;
    if (opts.productionSha !== null && m === opts.productionSha) continue;
    if (opts.rangeShas !== undefined && !opts.rangeShas.has(m)) continue;
    out.push({ id: t.id, title: t.title, mergedSha: m });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Inputs for the Release packet markdown body (design §1). */
export interface ReleasePacketParts {
  readonly repoKey: string;
  readonly stagingSha: string;
  readonly productionSha: string | null;
  readonly tasks: readonly ReleasePacketTask[];
  readonly deployOutput: string;
  readonly healthOutput: string;
  readonly healthOk: boolean;
  /** Rendered evidence summary lines (pre-formatted by orchestrator). */
  readonly evidenceLines: readonly string[];
  readonly evidenceOk: boolean | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'ready' | 'failed';
  readonly failureReason?: string;
}

/**
 * Assemble the Release packet markdown (same family as the review packet).
 * Pure string builder — no IO.
 */
export function renderReleasePacket(parts: ReleasePacketParts): string {
  const lines: string[] = [];
  lines.push('## Release packet');
  lines.push('');
  lines.push(`- **repo:** \`${parts.repoKey}\``);
  lines.push(`- **staging_sha:** \`${parts.stagingSha}\``);
  lines.push(
    `- **production_sha:** ${parts.productionSha !== null ? `\`${parts.productionSha}\`` : '_(none)_'}`,
  );
  lines.push(`- **outcome:** \`${parts.outcome}\``);
  lines.push(`- **started_at:** ${parts.startedAt}`);
  lines.push(`- **finished_at:** ${parts.finishedAt}`);
  if (parts.failureReason !== undefined && parts.failureReason !== '') {
    lines.push(`- **failure:** ${parts.failureReason}`);
  }
  lines.push('');
  lines.push('### Tasks included since production');
  lines.push('');
  if (parts.tasks.length === 0) {
    lines.push('_No merged tasks stamped between production and staging._');
  } else {
    for (const t of parts.tasks) {
      lines.push(`- \`${t.id}\`: ${t.title} (merged_sha \`${t.mergedSha}\`)`);
    }
  }
  lines.push('');
  lines.push('### Staging deploy');
  lines.push('');
  lines.push('```');
  lines.push(parts.deployOutput.trim() || '(no output)');
  lines.push('```');
  lines.push('');
  lines.push('### Health');
  lines.push('');
  lines.push(`- **ok:** ${parts.healthOk ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('```');
  lines.push(parts.healthOutput.trim() || '(no output)');
  lines.push('```');
  lines.push('');
  lines.push('### Evidence');
  lines.push('');
  if (parts.evidenceOk === null) {
    lines.push('_Evidence not run._');
  } else {
    lines.push(`- **ok:** ${parts.evidenceOk ? 'yes' : 'no'}`);
    if (parts.evidenceLines.length === 0) {
      lines.push('_No evidence steps._');
    } else {
      for (const el of parts.evidenceLines) {
        lines.push(`- ${el}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Format one evidence step result for the packet. */
export function formatEvidenceStepLine(input: {
  readonly kind: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly raw?: string;
}): string {
  const label = input.raw?.trim() || input.kind;
  const mark = input.ok ? '✓' : '✗';
  return `${mark} ${label}: ${input.detail}`;
}

// ── Promote briefing: trust chain, risk aggregates, size/area (pure) ───

/**
 * How `merged_sha` was recorded. Machine Merge stamps `gate`; operator
 * cherry-picks / backfills are `operator` (or absent → treated as operator).
 */
export type MergedVia = 'gate' | 'operator';

/** Merge-service commit subjects (mergeService: `hercules: merge …`). */
const MERGE_SERVICE_SUBJECT_RE = /^hercules:\s*merge\b/i;

export function isMergeServiceCommitSubject(subject: string | null | undefined): boolean {
  if (subject === undefined || subject === null) return false;
  return MERGE_SERVICE_SUBJECT_RE.test(subject.trim());
}

/**
 * Classify production..staging range commits into task-covered vs direct.
 *
 * Covered when:
 * - SHA equals a packet task's stamped `merged_sha`, or
 * - subject is an H merge-service commit, or
 * - SHA is in `gateCoveredShas` (caller-proved ancestors of gate-merged
 *   `verified_sha` / candidate tips — never "any ancestor of main").
 *
 * Fail-closed: missing coverage ⇒ direct (visible to the operator).
 */
export function classifyReleaseRangeCommits(input: {
  readonly rangeCommits: readonly { readonly sha: string; readonly subject: string }[];
  readonly taskMergedShas: ReadonlySet<string>;
  /** Proven on gate-merged candidate ancestry paths (optional). */
  readonly gateCoveredShas?: ReadonlySet<string>;
}): {
  readonly covered: readonly { readonly sha: string; readonly subject: string }[];
  readonly direct: readonly { readonly sha: string; readonly subject: string }[];
} {
  const gate = input.gateCoveredShas ?? new Set<string>();
  const covered: { sha: string; subject: string }[] = [];
  const direct: { sha: string; subject: string }[] = [];
  for (const c of input.rangeCommits) {
    const sha = c.sha.toLowerCase();
    const taskHit = [...input.taskMergedShas].some((s) => s.toLowerCase() === sha);
    if (taskHit || isMergeServiceCommitSubject(c.subject) || gate.has(sha) || gate.has(c.sha)) {
      covered.push(c);
    } else {
      direct.push(c);
    }
  }
  return { covered, direct };
}

/**
 * Resolve whether a stamped merge used the machine Merge gate.
 * Explicit `merged_via` wins; absent stamp falls back to commit subject,
 * then honestly defaults to `operator` (legacy / backfill).
 */
export function resolveMergedVia(input: {
  readonly mergedVia?: string | null;
  readonly commitSubject?: string | null;
}): MergedVia {
  if (input.mergedVia === 'gate') return 'gate';
  if (input.mergedVia === 'operator') return 'operator';
  if (isMergeServiceCommitSubject(input.commitSubject)) return 'gate';
  return 'operator';
}

/**
 * Trust-chain line for a release card. Exceptions (operator-merged) are
 * named so the operator never has to re-open every task.
 */
export function formatTrustChainStatement(input: {
  readonly changeCount: number;
  readonly operatorMergedIds: readonly string[];
  /** Tasks aboard without a verified SHA — the strong claim must not cover them. */
  readonly unverifiedIds?: readonly string[];
  /** Range commits with no task provenance (operator pushes). */
  readonly directCommitCount?: number;
}): string {
  const n = input.changeCount;
  const direct = input.directCommitCount ?? 0;
  const directSentence =
    direct > 0
      ? ` ${direct} direct commit${direct === 1 ? '' : 's'} landed outside the ` +
        `task pipeline (operator push) — review the commit list before promoting.`
      : '';
  if (n === 0 && direct > 0) {
    return (
      `No task-tracked changes aboard.${directSentence}`
    );
  }
  const noun = n === 1 ? 'change' : 'changes';
  const unverified = input.unverifiedIds ?? [];
  const base =
    unverified.length === 0
      ? `${n} ${noun} — every one passed L1–L5 verification, human Approve ` +
        `(verified-SHA checked), and the merge gate`
      : `${n} ${noun} — ${n - unverified.length} passed L1–L5 verification, ` +
        `human Approve (verified-SHA checked), and the merge gate; ` +
        `${unverified.length} with no recorded machine verification ` +
        `(verified-SHA missing — pre-pipeline or operator-salvaged): ` +
        `${unverified.join(', ')}`;
  if (input.operatorMergedIds.length === 0) return `${base}.${directSentence}`;
  const ids = input.operatorMergedIds.join(', ');
  return `${base}. Exceptions (operator-merged — merge gate not recorded): ${ids}.${directSentence}`;
}

/** Diff size chip thresholds (insertions + deletions). */
export type DiffSizeClass = 'S' | 'M' | 'L';

export function classifyDiffSize(linesChanged: number): DiffSizeClass {
  if (linesChanged <= 50) return 'S';
  if (linesChanged <= 250) return 'M';
  return 'L';
}

/** Top-level areas surfaced on the Releases panel risk line. */
export const RELEASE_AREA_PREFIXES = [
  'src/orchestrator',
  'src/isolation',
  'src/web',
  'scripts/',
  'docs/',
  'test/',
] as const;

export type ReleaseAreaPrefix = (typeof RELEASE_AREA_PREFIXES)[number];

export interface AreaCount {
  readonly area: ReleaseAreaPrefix;
  readonly count: number;
}

function normalizeRepoPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchArea(file: string): ReleaseAreaPrefix | null {
  const n = normalizeRepoPath(file);
  for (const prefix of RELEASE_AREA_PREFIXES) {
    if (prefix.endsWith('/')) {
      if (n.startsWith(prefix) || n === prefix.slice(0, -1)) return prefix;
    } else if (n === prefix || n.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }
  return null;
}

/** Count files per known top-level area (phone chips, not tables). */
export function classifyTopLevelAreas(files: readonly string[]): AreaCount[] {
  const counts = new Map<ReleaseAreaPrefix, number>();
  for (const f of files) {
    const area = matchArea(f);
    if (area === null) continue;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  const out: AreaCount[] = [];
  for (const area of RELEASE_AREA_PREFIXES) {
    const count = counts.get(area);
    if (count !== undefined && count > 0) out.push({ area, count });
  }
  return out;
}

/** Dominant area for a single-task chip; null when no known area. */
export function primaryAreaChip(files: readonly string[]): ReleaseAreaPrefix | null {
  const areas = classifyTopLevelAreas(files);
  if (areas.length === 0) return null;
  // Business preference: a feature usually lands with more test files than
  // source files — the chip should still say what the change is (src/scripts),
  // with tests/docs as supporting material. Only when nothing else changed is
  // the change itself a test/docs change (digest skew 2026-07-17).
  const supporting = new Set<ReleaseAreaPrefix>(['test/', 'docs/']);
  const pickMax = (list: typeof areas) => {
    let best = list[0]!;
    for (let i = 1; i < list.length; i++) {
      const a = list[i]!;
      if (a.count > best.count || (a.count === best.count && a.area < best.area)) {
        best = a;
      }
    }
    return best.area;
  };
  const primary = areas.filter((a) => !supporting.has(a.area));
  return primary.length > 0 ? pickMax(primary) : pickMax(areas);
}

/**
 * Sensitive paths that elevate promote risk. Matched from **git name-only**
 * only — never from task body text (anti-spoof).
 */
export function isSensitivePath(file: string): boolean {
  const n = normalizeRepoPath(file);
  if (/^scripts\/deploy-/.test(n)) return true;
  if (n === 'WORKFLOW.md' || n.endsWith('/WORKFLOW.md')) return true;
  if (/(^|\/)protected_paths(\/|$)/.test(n)) return true;
  if (/^src\/server\/selfUpdate/.test(n)) return true;
  return false;
}

export function findSensitivePaths(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (isSensitivePath(f)) out.push(normalizeRepoPath(f));
  }
  return out;
}

/** Parsed `git diff --numstat A..B` (pure). */
export interface GitNumstat {
  readonly files: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  readonly filesChanged: number;
}

export function parseGitNumstat(raw: string): GitNumstat {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;
    // numstat: <adds>\t<dels>\t<path>  (binary: -\t-\t<path>)
    const tab1 = trimmed.indexOf('\t');
    if (tab1 < 0) continue;
    const tab2 = trimmed.indexOf('\t', tab1 + 1);
    if (tab2 < 0) continue;
    const addsRaw = trimmed.slice(0, tab1);
    const delsRaw = trimmed.slice(tab1 + 1, tab2);
    const path = trimmed.slice(tab2 + 1).trim().replace(/^"(.*)"$/, '$1');
    if (path.length === 0) continue;
    files.push(path);
    if (addsRaw !== '-') {
      const n = Number(addsRaw);
      if (Number.isFinite(n)) insertions += n;
    }
    if (delsRaw !== '-') {
      const n = Number(delsRaw);
      if (Number.isFinite(n)) deletions += n;
    }
  }
  return { files, insertions, deletions, filesChanged: files.length };
}

/** Parsed `git diff --shortstat A..B` (pure). */
export function parseGitShortstat(raw: string): {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
} {
  const text = raw.trim();
  if (text.length === 0) {
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
  const filesM = /(\d+)\s+files?\s+changed/.exec(text);
  const insM = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const delM = /(\d+)\s+deletions?\(-\)/.exec(text);
  return {
    filesChanged: filesM ? Number(filesM[1]) : 0,
    insertions: insM ? Number(insM[1]) : 0,
    deletions: delM ? Number(delM[1]) : 0,
  };
}

/** Staging-vs-production risk aggregates for the promote card. */
export interface ReleaseRangeRisk {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly size: DiffSizeClass;
  readonly areas: readonly AreaCount[];
  readonly sensitivePaths: readonly string[];
}

export function aggregateRangeRisk(input: {
  readonly files: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
}): ReleaseRangeRisk {
  const filesChanged = input.files.length;
  const lines = input.insertions + input.deletions;
  return {
    filesChanged,
    insertions: input.insertions,
    deletions: input.deletions,
    size: classifyDiffSize(lines),
    areas: classifyTopLevelAreas(input.files),
    sensitivePaths: findSensitivePaths(input.files),
  };
}

/** Evidence step coverage parsed from the Release packet body. */
export interface EvidenceCoverage {
  readonly passed: number;
  readonly total: number;
  readonly label: string;
  readonly evidenceOk: boolean | null;
}

/**
 * Parse `### Evidence` section: ✓/✗ step lines + optional **ok:** flag.
 * Returns null when the section is missing (bootstrap / empty packet).
 */
export function parseEvidenceCoverageFromPacket(body: string): EvidenceCoverage | null {
  const section = /###\s*Evidence\b([\s\S]*?)(?=\n###\s|\n##\s|$)/i.exec(body);
  if (!section) return null;
  const block = section[1] ?? '';
  let passed = 0;
  let total = 0;
  for (const line of block.split('\n')) {
    const t = line.trim().replace(/^[-*]\s+/, '');
    if (/^[✓✔]/.test(t)) {
      passed += 1;
      total += 1;
    } else if (/^[✗✘×x]\s/i.test(t) || /^✗/.test(t)) {
      total += 1;
    }
  }
  let evidenceOk: boolean | null = null;
  const okLine = /\*\*ok:\*\*\s*(yes|no|true|false)/i.exec(block);
  if (okLine?.[1]) {
    const v = okLine[1].toLowerCase();
    evidenceOk = v === 'yes' || v === 'true';
  }
  if (total === 0 && evidenceOk === null && !/Evidence not run/i.test(block)) {
    // Section present but empty / "not run"
    if (/_Evidence not run/i.test(block)) {
      return { passed: 0, total: 0, label: '0/0 steps', evidenceOk: null };
    }
    return null;
  }
  return {
    passed,
    total,
    label: `${passed}/${total} steps`,
    evidenceOk,
  };
}

/** Rollback preview next to Promote (pure). */
export interface RollbackPreview {
  readonly hasTarget: boolean;
  readonly targetSha: string | null;
  readonly deployedAt: string | null;
}

/**
 * Preview auto-rollback target for a promote. Uses current production tip
 * (what would be restored on first failure) — not mid-promote state.
 */
export function buildRollbackPreview(release: Release): RollbackPreview {
  if (release.productionSha !== null && release.productionSha !== '') {
    return {
      hasTarget: true,
      targetSha: release.productionSha,
      deployedAt: release.productionDeployedAt,
    };
  }
  return { hasTarget: false, targetSha: null, deployedAt: null };
}

/** Per-task row on the release card (area/size/trust chips). */
export interface AheadTaskBrief {
  readonly id: string;
  readonly title: string;
  readonly mergedSha: string;
  /** Dominant top-level area, or null. */
  readonly area: ReleaseAreaPrefix | null;
  readonly size: DiffSizeClass;
  readonly mergedVia: MergedVia;
  /**
   * True when the task passed machine verification (has a verified SHA).
   * Operator-salvaged failures land in main — and thus in the release — with
   * this false, and the row must say so (phone question 2026-07-17).
   */
  readonly verified: boolean;
}

/** Attach area/size/mergedVia chips to a packet task from git-derived inputs. */
export function enrichAheadTask(input: {
  readonly id: string;
  readonly title: string;
  readonly mergedSha: string;
  readonly files: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  readonly mergedViaStamp?: string | null;
  readonly commitSubject?: string | null;
  readonly verifiedSha?: string | null;
}): AheadTaskBrief {
  return {
    id: input.id,
    title: input.title,
    mergedSha: input.mergedSha,
    area: primaryAreaChip(input.files),
    size: classifyDiffSize(input.insertions + input.deletions),
    verified:
      input.verifiedSha !== undefined &&
      input.verifiedSha !== null &&
      input.verifiedSha !== '',
    mergedVia: resolveMergedVia({
      ...(input.mergedViaStamp !== undefined ? { mergedVia: input.mergedViaStamp } : {}),
      ...(input.commitSubject !== undefined ? { commitSubject: input.commitSubject } : {}),
    }),
  };
}

/**
 * Top-of-card digest: what this release contains, at a glance — per-area
 * change counts plus the largest changes' titles as headlines (task titles
 * are the closest business-level description on record). Operator request
 * 2026-07-17: judge a release without reading all 24 rows.
 */
export interface ReleaseDigest {
  readonly areaCounts: readonly { area: ReleaseAreaPrefix | null; count: number }[];
  readonly headlines: readonly string[];
}

const SIZE_RANK: Record<DiffSizeClass, number> = { L: 2, M: 1, S: 0 };

export function buildReleaseDigest(
  tasks: readonly AheadTaskBrief[],
  opts?: { readonly maxHeadlines?: number },
): ReleaseDigest {
  const max = opts?.maxHeadlines ?? 4;
  const counts = new Map<ReleaseAreaPrefix | null, number>();
  for (const t of tasks) counts.set(t.area, (counts.get(t.area) ?? 0) + 1);
  const areaCounts = [...counts.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count);
  const headlines = [...tasks]
    .sort((a, b) => SIZE_RANK[b.size] - SIZE_RANK[a.size])
    .slice(0, max)
    .map((t) => t.title);
  return { areaCounts, headlines };
}

// ── Phone Releases panel (pure assembly) ────────────────────────────────

/** Done-but-not-yet-merged task eligible for batch Merge. */
export interface MergeableTask {
  readonly id: string;
  readonly title: string;
  readonly verifiedSha: string | null;
  /**
   * Distinct delivery lanes for phone UI (verification / merge / closure /
   * deployment). Never equates a merged SHA with project-state closure.
   */
  readonly deliveryPipeline?: {
    readonly verification: string;
    readonly mergeEligibility: string;
    readonly projectStateClosure: string;
    readonly deployment: string;
  };
}

/**
 * Fields the static merge-eligibility contract reads. Shared by the Releases
 * UI selector and the server MergeService so the two cannot drift.
 */
export interface StaticMergeEligibilityInput {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly state: string;
  readonly mergedSha?: string | null;
  readonly verifiedSha?: string | null;
  /** When already merged on GitHub, never offer Merge selected. */
  readonly prStatus?: string | null;
}

/**
 * Static (metadata-only) merge eligibility — no Git IO.
 *
 * A task is eligible only when it belongs to `repoKey`, is `done`, has a
 * non-empty `verified_sha`, has no `merged_sha`, and `pr_status` is not
 * `merged`. Dynamic tip checks stay server-side in MergeService.
 *
 * @returns `null` when eligible; otherwise a human-readable refusal reason.
 */
export function staticMergeBlockReason(
  task: StaticMergeEligibilityInput,
  repoKey: string,
): string | null {
  if (task.repo !== repoKey) {
    return `merge refused: task belongs to repo '${task.repo}', not '${repoKey}'`;
  }
  if (task.state !== 'done') {
    return `merge refused: task is '${task.state}', need done (approved)`;
  }
  // External PR merge may stamp pr_status without merged_sha yet — still block.
  if (task.prStatus === 'merged') {
    return 'merge refused: PR already merged externally (pr_status=merged)';
  }
  const m = task.mergedSha;
  if (m !== undefined && m !== null && m !== '') {
    return `merge refused: already merged at ${m.slice(0, 12)}`;
  }
  // Only the modern verified flow is machine-mergeable: without the
  // verified-SHA anchor the merge service cannot prove the branch tip is
  // what verification saw, and legacy branches may carry stale/foreign
  // work (phone Releases incident 2026-07-17: logout & co. were offered).
  const v = task.verifiedSha;
  if (v === undefined || v === null || v === '') {
    return 'merge refused: missing verified_sha — cannot prove branch tip matches verification';
  }
  return null;
}

/** True when {@link staticMergeBlockReason} returns null. */
export function isStaticallyMergeable(
  task: StaticMergeEligibilityInput,
  repoKey: string,
): boolean {
  return staticMergeBlockReason(task, repoKey) === null;
}

/**
 * Approved (done) tasks for a repo that still lack `merged_sha` — the batch
 * Merge selection list on the Releases panel. Uses the shared static contract.
 */
export function selectMergeableTasks(
  tasks: readonly StaticMergeEligibilityInput[],
  repoKey: string,
): MergeableTask[] {
  const out: MergeableTask[] = [];
  for (const t of tasks) {
    if (!isStaticallyMergeable(t, repoKey)) continue;
    out.push({
      id: t.id,
      title: t.title,
      verifiedSha: t.verifiedSha ?? null,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Enrich mergeable rows with separate delivery-lane states for the phone UI.
 * Pure: callers inject whether the repo opted into project-state closure and
 * deploy policy. Never leaks host paths.
 */
export function enrichMergeableWithPipeline(
  tasks: readonly MergeableTask[],
  opts: {
    readonly hasClosureContract: boolean;
    readonly hasDeployPolicy: boolean;
    readonly stagingStatus?: string | null;
    readonly productionSha?: string | null;
    readonly taskMeta?: ReadonlyMap<
      string,
      {
        readonly state: string;
        readonly mergedSha?: string | null;
        readonly prStatus?: string | null;
        readonly projectStateClosureStatus?: string | null;
      }
    >;
  },
): readonly MergeableTask[] {
  // Local import-free derivation to avoid circular deps at module init.
  // Mirrors domain/projectStateClosure.deriveDeliveryPipelineStages.
  type DeliveryPipeline = NonNullable<MergeableTask['deliveryPipeline']>;
  const derive = (input: {
    verifiedSha: string | null;
    state: string;
    mergedSha?: string | null;
    prStatus?: string | null;
    projectStateClosureStatus?: string | null;
  }): DeliveryPipeline => {
    const verified = input.verifiedSha !== null && input.verifiedSha !== '';
    const merged =
      input.mergedSha !== undefined &&
      input.mergedSha !== null &&
      input.mergedSha !== '';
    let verification = verified ? 'passed' : 'missing';
    if (input.state === 'failed' && !verified) verification = 'failed';
    let mergeEligibility: string;
    if (merged || input.prStatus === 'merged') mergeEligibility = 'merged';
    else if (input.state === 'done' && verified) mergeEligibility = 'eligible';
    else if (input.state === 'done' && !verified) mergeEligibility = 'blocked';
    else if (input.state === 'review') mergeEligibility = 'pending';
    else mergeEligibility = 'not_applicable';
    let projectStateClosure: string;
    if (!opts.hasClosureContract) projectStateClosure = 'not_applicable';
    else if (input.projectStateClosureStatus === 'passed') projectStateClosure = 'passed';
    else if (input.projectStateClosureStatus === 'failed') projectStateClosure = 'failed';
    else if (input.projectStateClosureStatus === 'not_applicable') {
      projectStateClosure = 'not_applicable';
    } else projectStateClosure = 'pending';
    let deployment = 'not_applicable';
    if (opts.hasDeployPolicy) {
      if (opts.productionSha) deployment = 'production';
      else if (opts.stagingStatus === 'ready') deployment = 'ready';
      else if (
        opts.stagingStatus === 'deploying' ||
        opts.stagingStatus === 'verifying'
      ) {
        deployment = 'deploying';
      } else if (opts.stagingStatus === 'failed') deployment = 'failed';
      else deployment = 'pending';
    }
    return {
      verification,
      mergeEligibility,
      projectStateClosure,
      deployment,
    };
  };

  return tasks.map((t): MergeableTask => {
    const meta = opts.taskMeta?.get(t.id);
    return {
      id: t.id,
      title: t.title,
      verifiedSha: t.verifiedSha,
      deliveryPipeline: derive({
        verifiedSha: t.verifiedSha,
        state: meta?.state ?? 'done',
        mergedSha: meta?.mergedSha ?? null,
        prStatus: meta?.prStatus ?? null,
        projectStateClosureStatus: meta?.projectStateClosureStatus ?? null,
      }),
    };
  });
}

/**
 * Extract a human-visible failure reason from the Release packet body
 * (or a generic message when staging_status is failed).
 */
export function extractReleaseFailureReason(
  body: string,
  stagingStatus: StagingStatus | null,
): string | null {
  const failureLine = /-\s*\*\*failure:\*\*\s*(.+)/i.exec(body);
  if (failureLine?.[1]) {
    const text = failureLine[1].trim();
    if (text.length > 0) return text;
  }
  const alertLine = /^ALERT:\s*(.+)$/m.exec(body);
  if (alertLine?.[1]) {
    const text = alertLine[1].trim();
    if (text.length > 0) return text;
  }
  if (stagingStatus === 'failed') {
    return 'Staging deploy or verify failed';
  }
  return null;
}

/**
 * Manual Rollback is offered when promote is in flight, or when production
 * has a distinct earlier known-good tip (history or prior production).
 */
export function canManualRollback(release: Release): boolean {
  if (release.promotingSha !== null && release.promotingSha !== '') {
    return true;
  }
  if (release.productionSha === null || release.productionSha === '') {
    return false;
  }
  return (
    rollbackTarget({
      ...release,
      promotingSha: release.productionSha,
    }) !== null
  );
}

/** Phone Releases panel row for one repo that declares deploy.staging. */
export interface ReleasePanelEntry {
  readonly repoKey: string;
  readonly productionSha: string | null;
  readonly productionDeployedAt: string | null;
  readonly stagingSha: string | null;
  readonly stagingStatus: StagingStatus | null;
  readonly stagingVerifiedAt: string | null;
  /** When current deploying/verifying cycle began (ISO); null when idle. */
  readonly stagingStartedAt: string | null;
  /**
   * Overall staging verify budget (ms) for UI abnormal threshold.
   * Daemon default; panel uses this client-side for elapsed > timeout.
   */
  readonly stagingVerifyTimeoutMs: number;
  readonly promotingSha: string | null;
  /**
   * Last boot-finalization failure (sha + reason + at) when present.
   * View field for the SPA; optional on older daemons / legacy records.
   */
  readonly lastPromoteFailure: {
    readonly sha: string;
    readonly reason: string;
    readonly at: string;
    readonly bootedSha?: string | null;
  } | null;
  /** Mirror main tip (null when unknown). */
  readonly mainSha: string | null;
  /** True when staging_sha ≠ main (or staging never deployed). */
  readonly stagingDrift: boolean;
  readonly canPromote: boolean;
  readonly canRollback: boolean;
  readonly rollbackTargetSha: string | null;
  /** WORKFLOW deploy.staging.url (opened from the phone). */
  readonly stagingUrl: string | null;
  readonly hasProductionDeploy: boolean;
  /** Tasks on staging since production (staging ahead) — enriched chips. */
  readonly aheadTasks: readonly AheadTaskBrief[];
  /** Range commits with no task provenance (operator pushes), newest first. */
  readonly directCommits: readonly { readonly sha: string; readonly subject: string }[];
  /** Business-level top-of-card digest of what this release contains. */
  readonly digest: ReleaseDigest;
  readonly aheadCount: number;
  /** done + unmerged tasks for batch Merge. */
  readonly mergeableTasks: readonly MergeableTask[];
  /**
   * True when trusted WORKFLOW declares project_state_closure (opt-in).
   * Ordinary repos without the contract stay false — no global churn.
   */
  readonly hasProjectStateClosure: boolean;
  /** Latest Release packet markdown. */
  readonly packetBody: string;
  /** Visible failure (staging failed / promote alert). */
  readonly failureReason: string | null;
  readonly history: readonly ReleaseHistoryEntry[];
  /** Trust-chain statement for the promote card. */
  readonly trustChain: string;
  /** Count of operator-merged exceptions in ahead tasks. */
  readonly operatorMergedCount: number;
  /** Staging-vs-production risk aggregates (null when range unknown / empty). */
  readonly rangeRisk: ReleaseRangeRisk | null;
  /** Evidence step coverage from the Release packet. */
  readonly evidenceCoverage: EvidenceCoverage | null;
  /** Staging screenshots basenames under screenshots/releases/<repo>/. */
  readonly stagingScreenshots: readonly string[];
  /** Rollback preview next to Promote. */
  readonly rollbackPreview: RollbackPreview;
  /**
   * Staging UI token for copy-to-clipboard (only when daemon has the env
   * configured). Never placed in URLs. null when unset.
   */
  readonly stagingUiToken: string | null;
  /**
   * `(human, after deploy)` checks from tasks shipped by the last promote
   * (previousProductionSha..productionSha). Optional for the owner; never
   * blocks; replaced by the next promote. Empty when the range is unknown.
   */
  readonly afterDeployChecks: readonly AfterDeployCheck[];
}

/** Optional per-task git facts for enriching ahead rows (server-side only). */
export interface AheadTaskGitFacts {
  readonly files: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  readonly commitSubject: string | null;
}

/** Re-export overall default so panel wiring need not import stagingVerify. */
export { DEFAULT_STAGING_VERIFY_TIMEOUT_MS } from './stagingVerify.js';

/** Pure assembly of one Releases panel row from already-loaded inputs. */
export function buildReleasePanelEntry(input: {
  readonly release: Release;
  readonly mainSha: string | null;
  readonly stagingUrl: string | null;
  readonly hasProductionDeploy: boolean;
  /** Overall staging verify budget for UI abnormal threshold (default 15m). */
  readonly stagingVerifyTimeoutMs?: number;
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly repo: string;
    readonly state: string;
    readonly mergedSha?: string | null;
    readonly verifiedSha?: string | null;
    readonly mergedVia?: string | null;
    readonly prStatus?: string | null;
    readonly projectStateClosureStatus?: string | null;
    readonly body?: string;
  }[];
  readonly rangeShas?: ReadonlySet<string>;
  /** Commit SHAs in previousProduction..production (what the last promote shipped). */
  readonly liveRangeShas?: ReadonlySet<string>;
  /**
   * Ordered commits in production..staging (newest first) — used to surface
   * operator pushes that have no task provenance (2026-07-17: two direct
   * commits shipped as an invisible "0 changes" release).
   */
  readonly rangeCommits?: readonly { readonly sha: string; readonly subject: string }[];
  /**
   * SHAs proven on the ancestry path of gate-merged task verified tips
   * (including the verified tip itself). Used so intermediate candidate
   * commits are not false-flagged as direct operator pushes.
   */
  readonly gateCoveredShas?: ReadonlySet<string>;
  /** Mirror range risk (production..staging); null when unavailable. */
  readonly rangeRisk?: ReleaseRangeRisk | null;
  /** Per-task git facts keyed by task id (from trusted mirror). */
  readonly taskGitFacts?: ReadonlyMap<string, AheadTaskGitFacts>;
  readonly stagingScreenshots?: readonly string[];
  readonly stagingUiToken?: string | null;
  /** Trusted WORKFLOW declared project_state_closure (opt-in). */
  readonly hasProjectStateClosure?: boolean;
}): ReleasePanelEntry {
  const { release } = input;
  const mainSha = input.mainSha;
  const stagingDrift =
    mainSha !== null && mainSha !== ''
      ? hasStagingDrift(release, mainSha)
      : release.stagingSha === null || release.stagingSha === '';
  const canPromoteNow =
    mainSha !== null && mainSha !== '' ? canPromote(release, mainSha) : false;

  const stagingSha = release.stagingSha;
  const packetTasks =
    stagingSha !== null && stagingSha !== ''
      ? selectTasksForRelease(input.tasks, {
          repoKey: release.repoKey,
          productionSha: release.productionSha,
          stagingSha,
          ...(input.rangeShas !== undefined ? { rangeShas: input.rangeShas } : {}),
        })
      : [];

  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const aheadTasks: AheadTaskBrief[] = packetTasks.map((pt) => {
    const facts = input.taskGitFacts?.get(pt.id);
    const task = taskById.get(pt.id);
    return enrichAheadTask({
      id: pt.id,
      title: pt.title,
      mergedSha: pt.mergedSha,
      files: facts?.files ?? [],
      insertions: facts?.insertions ?? 0,
      deletions: facts?.deletions ?? 0,
      mergedViaStamp: task?.mergedVia ?? null,
      commitSubject: facts !== undefined ? facts.commitSubject : null,
      verifiedSha: task?.verifiedSha ?? null,
    });
  });

  const operatorMergedIds = aheadTasks
    .filter((t) => t.mergedVia === 'operator')
    .map((t) => t.id);

  // Commits in the range that no task accounts for: not a task's stamped
  // merge SHA, not a merge-service commit, and not on a gate-merged candidate
  // ancestry path (when caller provided gateCoveredShas). Operator pushes
  // remain visible — a release is main as-is, not just its tasked subset.
  const taskShas = new Set(packetTasks.map((pt) => pt.mergedSha));
  const directCommits = classifyReleaseRangeCommits({
    rangeCommits: input.rangeCommits ?? [],
    taskMergedShas: taskShas,
    ...(input.gateCoveredShas !== undefined ? { gateCoveredShas: input.gateCoveredShas } : {}),
  }).direct;

  const rollbackSha =
    release.promotingSha !== null && release.promotingSha !== ''
      ? rollbackTarget(release)
      : release.productionSha !== null && release.productionSha !== ''
        ? rollbackTarget({ ...release, promotingSha: release.productionSha })
        : null;

  // Lazy default keeps stagingVerify import side-effect free for callers that
  // only need transitions; re-export DEFAULT_STAGING_VERIFY_TIMEOUT_MS above.
  const verifyTimeoutMs = input.stagingVerifyTimeoutMs ?? 15 * 60 * 1000;

  const prevProd = previousProductionSha(release);
  const afterDeployChecks: AfterDeployCheck[] = [];
  if (
    prevProd !== null &&
    input.liveRangeShas !== undefined &&
    release.productionSha !== null &&
    release.productionSha !== ''
  ) {
    const liveTasks = selectTasksForRelease(input.tasks, {
      repoKey: release.repoKey,
      productionSha: prevProd,
      stagingSha: release.productionSha,
      rangeShas: input.liveRangeShas,
    });
    for (const pt of liveTasks) {
      const task = taskById.get(pt.id);
      const texts = listAfterDeployCriteriaTexts(task?.body ?? '');
      for (const text of texts) {
        afterDeployChecks.push({ taskId: pt.id, title: pt.title, text });
      }
    }
  }

  return {
    repoKey: release.repoKey,
    productionSha: release.productionSha,
    productionDeployedAt: release.productionDeployedAt,
    stagingSha: release.stagingSha,
    stagingStatus: release.stagingStatus,
    stagingVerifiedAt: release.stagingVerifiedAt,
    stagingStartedAt: release.stagingStartedAt,
    stagingVerifyTimeoutMs: verifyTimeoutMs,
    promotingSha: release.promotingSha,
    lastPromoteFailure: release.lastPromoteFailure
      ? {
          sha: release.lastPromoteFailure.sha,
          reason: release.lastPromoteFailure.reason,
          at: release.lastPromoteFailure.at,
          bootedSha: release.lastPromoteFailure.bootedSha,
        }
      : null,
    mainSha,
    stagingDrift,
    canPromote: canPromoteNow,
    canRollback: canManualRollback(release),
    rollbackTargetSha: rollbackSha,
    stagingUrl: input.stagingUrl,
    hasProductionDeploy: input.hasProductionDeploy,
    aheadTasks,
    directCommits,
    digest: buildReleaseDigest(aheadTasks),
    aheadCount: aheadTasks.length,
    mergeableTasks: (() => {
      const base = selectMergeableTasks(input.tasks, release.repoKey);
      const hasClosure = input.hasProjectStateClosure === true;
      const meta = new Map(
        input.tasks.map((t) => [
          t.id,
          {
            state: t.state,
            mergedSha: t.mergedSha ?? null,
            prStatus: t.prStatus ?? null,
            projectStateClosureStatus: t.projectStateClosureStatus ?? null,
          },
        ]),
      );
      return enrichMergeableWithPipeline(base, {
        hasClosureContract: hasClosure,
        // Release panel rows only exist for repos with deploy.staging.
        hasDeployPolicy: true,
        stagingStatus: release.stagingStatus,
        productionSha: release.productionSha,
        taskMeta: meta,
      });
    })(),
    hasProjectStateClosure: input.hasProjectStateClosure === true,
    packetBody: release.body,
    failureReason: extractReleaseFailureReason(release.body, release.stagingStatus),
    history: release.history,
    trustChain: formatTrustChainStatement({
      changeCount: aheadTasks.length,
      operatorMergedIds,
      unverifiedIds: aheadTasks.filter((t) => !t.verified).map((t) => t.id),
      directCommitCount: directCommits.length,
    }),
    operatorMergedCount: operatorMergedIds.length,
    rangeRisk: input.rangeRisk ?? null,
    evidenceCoverage: parseEvidenceCoverageFromPacket(release.body),
    stagingScreenshots: input.stagingScreenshots ?? [],
    rollbackPreview: buildRollbackPreview(release),
    stagingUiToken: input.stagingUiToken ?? null,
    afterDeployChecks,
  };
}
