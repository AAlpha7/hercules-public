/**
 * Domain — platform remediation causal chains + bootstrap escalation (pure).
 *
 * Narrow class: a normal task cannot continue because *Hercules itself* has a
 * bug, capability gap, or platform limitation, and a Hercules code change is
 * required before the original can resume. Distinct from ordinary retries,
 * model-level rework, and required human review/merge (those are process
 * events and must not be counted as platform remediation).
 *
 * No IO / git / fs / network.
 */
import { isValidIdentifier, type Task, type TaskState } from './task.js';

/** Valid remediation kinds (durable front-matter values). */
export const PLATFORM_REMEDIATION_KINDS = [
  'bug',
  'capability_gap',
  'platform_limit',
] as const;
export type PlatformRemediationKind = (typeof PLATFORM_REMEDIATION_KINDS)[number];

/**
 * Auditable resumed outcome stamped on the *original* blocked task.
 * `pending` while the linked remediation task is still open.
 * `bootstrap_escalation` when the remediation itself hits the same platform
 * issue and recursive self-remediation is refused.
 */
export const PLATFORM_REMEDIATION_RESUMED_OUTCOMES = [
  'pending',
  'remediation_done',
  'remediation_cancelled',
  'remediation_failed',
  'bootstrap_escalation',
] as const;
export type PlatformRemediationResumedOutcome =
  (typeof PLATFORM_REMEDIATION_RESUMED_OUTCOMES)[number];

/** Operator input bounds (fail closed on junk). */
export const PLATFORM_REMEDIATION_TITLE_MAX = 500;
export const PLATFORM_REMEDIATION_BODY_MAX = 100_000;
export const PLATFORM_REMEDIATION_ACTION_MAX = 500;
export const PLATFORM_REMEDIATION_AGGREGATE_CHAIN_CAP = 32;

export function isPlatformRemediationKind(
  value: unknown,
): value is PlatformRemediationKind {
  return (
    typeof value === 'string' &&
    (PLATFORM_REMEDIATION_KINDS as readonly string[]).includes(value)
  );
}

export function isPlatformRemediationResumedOutcome(
  value: unknown,
): value is PlatformRemediationResumedOutcome {
  return (
    typeof value === 'string' &&
    (PLATFORM_REMEDIATION_RESUMED_OUTCOMES as readonly string[]).includes(value)
  );
}

/** True when the task is the *original* side of an open/closed remediation chain. */
export function isPlatformRemediationOriginal(task: {
  readonly platformRemediationTask?: string | null;
  readonly platformRemediationKind?: PlatformRemediationKind | null;
}): boolean {
  const id = task.platformRemediationTask;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    isPlatformRemediationKind(task.platformRemediationKind ?? null)
  );
}

/** True when the task *is* a Hercules remediation task for some original. */
export function isPlatformRemediationTask(task: {
  readonly platformRemediationOf?: string | null;
  readonly platformRemediationKind?: PlatformRemediationKind | null;
}): boolean {
  const id = task.platformRemediationOf;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    isPlatformRemediationKind(task.platformRemediationKind ?? null)
  );
}

/** True when bootstrap escalation was recorded on this task. */
export function hasBootstrapEscalation(task: {
  readonly bootstrapEscalation?: boolean | null;
}): boolean {
  return task.bootstrapEscalation === true;
}

/** Map a remediation task terminal state to the original's resumed outcome. */
export function resumedOutcomeForRemediationState(
  state: TaskState,
): PlatformRemediationResumedOutcome | null {
  if (state === 'done') return 'remediation_done';
  if (state === 'cancelled') return 'remediation_cancelled';
  if (state === 'failed') return 'remediation_failed';
  // deleted is operator cleanup — treat like cancel for telemetry honesty.
  if (state === 'deleted') return 'remediation_cancelled';
  return null; // still open (todo/in_progress/review/retrying)
}

// ── Request parse ──────────────────────────────────────────────────────

export interface PlatformRemediationRequestInput {
  readonly kind: PlatformRemediationKind;
  readonly id?: string;
  readonly title?: string;
  readonly body?: string;
  /** Target repo for the remediation task; default resolved by action layer. */
  readonly repo?: string;
  /** Bounded external-maintenance action (bootstrap path). */
  readonly externalAction?: string;
}

export type PlatformRemediationParseResult =
  | { readonly ok: true; readonly value: PlatformRemediationRequestInput }
  | { readonly ok: false; readonly reason: string };

/**
 * Strict JSON body parse for POST …/platform-remediation.
 * `kind` is required; other fields optional with hard length caps.
 */
export function parsePlatformRemediationInput(
  raw: unknown,
): PlatformRemediationParseResult {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'body must be a JSON object with kind' };
  }
  const obj = raw as Record<string, unknown>;
  if (!('kind' in obj) || obj['kind'] === undefined) {
    return { ok: false, reason: 'kind is required (bug|capability_gap|platform_limit)' };
  }
  if (!isPlatformRemediationKind(obj['kind'])) {
    return {
      ok: false,
      reason: `unknown kind '${String(obj['kind'])}' (want bug|capability_gap|platform_limit)`,
    };
  }
  const out: {
    kind: PlatformRemediationKind;
    id?: string;
    title?: string;
    body?: string;
    repo?: string;
    externalAction?: string;
  } = { kind: obj['kind'] };

  if ('id' in obj && obj['id'] !== undefined) {
    if (typeof obj['id'] !== 'string') {
      return { ok: false, reason: 'id must be a string' };
    }
    if (!isValidIdentifier(obj['id'])) {
      return { ok: false, reason: `unsafe remediation task id '${obj['id']}'` };
    }
    out.id = obj['id'];
  }

  if ('title' in obj && obj['title'] !== undefined) {
    if (typeof obj['title'] !== 'string') {
      return { ok: false, reason: 'title must be a string' };
    }
    if (obj['title'].length > PLATFORM_REMEDIATION_TITLE_MAX) {
      return {
        ok: false,
        reason: `title too long (max ${PLATFORM_REMEDIATION_TITLE_MAX} chars)`,
      };
    }
    out.title = obj['title'];
  }

  if ('body' in obj && obj['body'] !== undefined) {
    if (typeof obj['body'] !== 'string') {
      return { ok: false, reason: 'body must be a string' };
    }
    if (obj['body'].length > PLATFORM_REMEDIATION_BODY_MAX) {
      return {
        ok: false,
        reason: `body too long (max ${PLATFORM_REMEDIATION_BODY_MAX} chars)`,
      };
    }
    out.body = obj['body'];
  }

  if ('repo' in obj && obj['repo'] !== undefined) {
    if (typeof obj['repo'] !== 'string') {
      return { ok: false, reason: 'repo must be a string' };
    }
    if (!isValidIdentifier(obj['repo'])) {
      return { ok: false, reason: `unsafe repo key '${obj['repo']}'` };
    }
    out.repo = obj['repo'];
  }

  if ('externalAction' in obj && obj['externalAction'] !== undefined) {
    if (typeof obj['externalAction'] !== 'string') {
      return { ok: false, reason: 'externalAction must be a string' };
    }
    if (obj['externalAction'].length > PLATFORM_REMEDIATION_ACTION_MAX) {
      return {
        ok: false,
        reason: `externalAction too long (max ${PLATFORM_REMEDIATION_ACTION_MAX} chars)`,
      };
    }
    out.externalAction = obj['externalAction'];
  }

  return { ok: true, value: out };
}

// ── Validation ─────────────────────────────────────────────────────────

export interface PlatformRemediationValidationInput {
  readonly sourceId: string;
  readonly remediationId: string;
  readonly kind: PlatformRemediationKind;
  readonly sourceState: TaskState;
  readonly remediationExists: boolean;
  /** Source already has a platform-remediation chain link. */
  readonly sourceAlreadyLinked: boolean;
  /** Source is itself a remediation task (has platformRemediationOf). */
  readonly sourceIsRemediation: boolean;
  /** Source already escalated. */
  readonly sourceAlreadyEscalated: boolean;
  /** Target remediation repo key is known in repos.yaml. */
  readonly remediationRepoKnown: boolean;
}

export type PlatformRemediationValidationResult =
  | { readonly ok: true; readonly mode: 'open_chain' }
  | { readonly ok: true; readonly mode: 'bootstrap_escalation' }
  | { readonly ok: false; readonly reason: string };

/**
 * Pure fail-closed checks for opening a platform-remediation chain or
 * escalating to bootstrap (when the source is already a remediation task).
 *
 * Does **not** mutate blocked_by — the causal link is separate from dependency
 * gates and must never bypass them.
 */
export function validatePlatformRemediationRequest(
  input: PlatformRemediationValidationInput,
): PlatformRemediationValidationResult {
  if (!isValidIdentifier(input.sourceId)) {
    return { ok: false, reason: `unsafe source task id '${input.sourceId}'` };
  }
  if (!isPlatformRemediationKind(input.kind)) {
    return { ok: false, reason: `unknown kind '${String(input.kind)}'` };
  }
  if (input.sourceAlreadyEscalated) {
    return {
      ok: false,
      reason: `task '${input.sourceId}' already has bootstrap escalation recorded`,
    };
  }

  // Remediation-of-remediation → bootstrap escalation (no recursive chain).
  if (input.sourceIsRemediation) {
    return { ok: true, mode: 'bootstrap_escalation' };
  }

  if (!isValidIdentifier(input.remediationId)) {
    return { ok: false, reason: `unsafe remediation task id '${input.remediationId}'` };
  }
  if (input.sourceId === input.remediationId) {
    return { ok: false, reason: 'source and remediation task ids must be different' };
  }
  if (input.sourceState !== 'failed') {
    return {
      ok: false,
      reason: `source task must be terminal failed (got '${input.sourceState}') — ordinary retries/review are not platform remediation`,
    };
  }
  if (input.sourceAlreadyLinked) {
    return {
      ok: false,
      reason: `task '${input.sourceId}' already has a platform remediation link`,
    };
  }
  if (input.remediationExists) {
    return {
      ok: false,
      reason: `remediation task '${input.remediationId}' already exists (collision)`,
    };
  }
  if (!input.remediationRepoKnown) {
    return {
      ok: false,
      reason: 'remediation repo is not configured in repos.yaml',
    };
  }
  return { ok: true, mode: 'open_chain' };
}

// ── Stamping ───────────────────────────────────────────────────────────

export interface OpenChainStamp {
  readonly original: {
    readonly platformRemediationKind: PlatformRemediationKind;
    readonly platformRemediationTask: string;
    readonly platformRemediationResumedOutcome: 'pending';
    readonly platformRemediationRecordedAt: string;
  };
  readonly remediation: {
    readonly platformRemediationOf: string;
    readonly platformRemediationKind: PlatformRemediationKind;
  };
}

export function stampOpenChain(input: {
  readonly originalId: string;
  readonly remediationId: string;
  readonly kind: PlatformRemediationKind;
  readonly recordedAt: string;
}): OpenChainStamp {
  return {
    original: {
      platformRemediationKind: input.kind,
      platformRemediationTask: input.remediationId,
      platformRemediationResumedOutcome: 'pending',
      platformRemediationRecordedAt: input.recordedAt,
    },
    remediation: {
      platformRemediationOf: input.originalId,
      platformRemediationKind: input.kind,
    },
  };
}

export interface BootstrapEscalationStamp {
  readonly remediation: {
    readonly bootstrapEscalation: true;
    readonly bootstrapEscalationAction: string;
    readonly bootstrapEscalationRecordedAt: string;
  };
  readonly original: {
    readonly platformRemediationResumedOutcome: 'bootstrap_escalation';
  };
}

export function stampBootstrapEscalation(input: {
  readonly externalAction: string;
  readonly recordedAt: string;
}): BootstrapEscalationStamp {
  const action =
    input.externalAction.trim().length > 0
      ? input.externalAction.trim().slice(0, PLATFORM_REMEDIATION_ACTION_MAX)
      : 'External operator must repair Hercules outside this control plane before either task can resume.';
  return {
    remediation: {
      bootstrapEscalation: true,
      bootstrapEscalationAction: action,
      bootstrapEscalationRecordedAt: input.recordedAt,
    },
    original: {
      platformRemediationResumedOutcome: 'bootstrap_escalation',
    },
  };
}

/**
 * When a remediation task reaches a terminal state, compute the original's
 * next resumed-outcome fields. Returns null when no update is needed
 * (not a remediator, still open, or already stamped terminal).
 */
export function planResumedOutcomeUpdate(input: {
  readonly remediation: {
    readonly id: string;
    readonly state: TaskState;
    readonly platformRemediationOf?: string | null;
    readonly platformRemediationKind?: PlatformRemediationKind | null;
    readonly bootstrapEscalation?: boolean | null;
  };
  readonly original: {
    readonly id: string;
    readonly platformRemediationTask?: string | null;
    readonly platformRemediationResumedOutcome?: PlatformRemediationResumedOutcome | null;
  } | null;
}): {
  readonly originalId: string;
  readonly resumedOutcome: PlatformRemediationResumedOutcome;
} | null {
  if (!isPlatformRemediationTask(input.remediation)) return null;
  const originalId = input.remediation.platformRemediationOf!;
  if (input.remediation.bootstrapEscalation === true) {
    // Bootstrap already owns the outcome; do not overwrite with remediator terminal.
    return null;
  }
  const outcome = resumedOutcomeForRemediationState(input.remediation.state);
  if (outcome === null) return null;
  if (!input.original) return null;
  if (input.original.platformRemediationTask !== input.remediation.id) {
    // Causal link integrity: refuse to stamp an unrelated original.
    return null;
  }
  if (input.original.id !== originalId) return null;
  const current = input.original.platformRemediationResumedOutcome ?? null;
  // Do not downgrade bootstrap_escalation or clobber an already-matching stamp.
  if (current === 'bootstrap_escalation') return null;
  if (current === outcome) return null;
  return { originalId, resumedOutcome: outcome };
}

// ── Body sections (bounded, no secrets/paths) ──────────────────────────

export function buildPlatformRemediationSection(input: {
  readonly kind: PlatformRemediationKind;
  readonly remediationTaskId: string;
  readonly recordedAt: string;
  readonly role: 'original' | 'remediation';
  readonly peerTaskId: string;
}): string {
  const lines = [
    '## Platform remediation',
    '',
    'Hercules **platform** remediation (not an ordinary retry, rework, or human review/merge).',
    '',
    `- **Kind:** \`${input.kind}\``,
    `- **Role:** ${input.role}`,
    `- **Peer task:** \`${input.peerTaskId}\``,
    input.role === 'original'
      ? `- **Remediation task:** \`${input.remediationTaskId}\``
      : `- **Original task:** \`${input.peerTaskId}\``,
    `- **Stamped at:** ${input.recordedAt}`,
    '',
  ];
  return lines.join('\n');
}

export function buildBootstrapEscalationSection(input: {
  readonly originalTaskId: string;
  readonly remediationTaskId: string;
  readonly kind: PlatformRemediationKind;
  readonly externalAction: string;
  readonly recordedAt: string;
}): string {
  return [
    '## Bootstrap escalation (platform-external rescue)',
    '',
    'The remediation task itself is blocked by the same Hercules platform issue.',
    'Recursive self-remediation is **refused**. An external operator must repair',
    'Hercules outside this control plane before either task can resume.',
    '',
    `- **Original task:** \`${input.originalTaskId}\``,
    `- **Remediation task:** \`${input.remediationTaskId}\``,
    `- **Kind:** \`${input.kind}\``,
    `- **Required external action:** ${input.externalAction}`,
    `- **Stamped at:** ${input.recordedAt}`,
    '',
  ].join('\n');
}

export function buildDefaultRemediationBody(input: {
  readonly originalId: string;
  readonly originalTitle: string;
  readonly kind: PlatformRemediationKind;
}): string {
  return [
    '## Goal',
    '',
    `Fix Hercules platform issue (\`${input.kind}\`) that blocks task \`${input.originalId}\` (${input.originalTitle}).`,
    '',
    '## Context',
    '',
    'This is a **platform remediation** task: the original work cannot continue',
    'until Hercules itself is repaired (bug fix, new capability, or platform limit).',
    'Ordinary retries and human review/merge are **not** substitutes.',
    '',
    '## Acceptance criteria',
    '',
    `- [ ] (mechanical) Hercules change addresses the \`${input.kind}\` that blocked \`${input.originalId}\``,
    '- [ ] (mechanical) Trusted gates pass on the remediation branch',
    '- [ ] (reviewer) Change is scoped to the platform gap; no silent weakening of fail-closed behavior',
    '- [ ] (human) Operator confirms the original task can be retried after this lands',
    '',
  ].join('\n');
}

// ── Aggregates (dashboard-ready, no secrets/paths) ─────────────────────

export interface PlatformRemediationChainSummary {
  readonly originalTaskId: string;
  readonly remediationTaskId: string;
  readonly kind: PlatformRemediationKind;
  readonly resumedOutcome: PlatformRemediationResumedOutcome;
  readonly bootstrapEscalation: boolean;
  readonly recordedAt: string | null;
}

export interface PlatformRemediationAggregates {
  readonly openChains: number;
  readonly resolvedDone: number;
  readonly resolvedCancelled: number;
  readonly resolvedFailed: number;
  readonly bootstrapEscalations: number;
  readonly byKind: Readonly<Record<PlatformRemediationKind, number>>;
  /** Bounded recent/open chain rows (ids + kinds only — never bodies/paths). */
  readonly chains: readonly PlatformRemediationChainSummary[];
}

function emptyByKind(): Record<PlatformRemediationKind, number> {
  return { bug: 0, capability_gap: 0, platform_limit: 0 };
}

/**
 * Dashboard aggregates from durable task fields only.
 * Historical tasks without the fields contribute nothing (remain valid).
 * Ordinary retries / review / merge leave these fields unset → not counted.
 */
export function aggregatePlatformRemediation(
  tasks: readonly Task[],
  opts?: { readonly chainCap?: number },
): PlatformRemediationAggregates {
  const cap = opts?.chainCap ?? PLATFORM_REMEDIATION_AGGREGATE_CHAIN_CAP;
  const byKind = emptyByKind();
  let openChains = 0;
  let resolvedDone = 0;
  let resolvedCancelled = 0;
  let resolvedFailed = 0;
  let bootstrapEscalations = 0;
  const chains: PlatformRemediationChainSummary[] = [];

  // Index remediator bootstrap flags by id for chain rows.
  const remediatorBootstrap = new Map<string, boolean>();
  for (const t of tasks) {
    if (isPlatformRemediationTask(t)) {
      remediatorBootstrap.set(t.id, t.bootstrapEscalation === true);
    }
  }

  for (const t of tasks) {
    if (!isPlatformRemediationOriginal(t)) continue;
    const kind = t.platformRemediationKind!;
    const outcome = t.platformRemediationResumedOutcome ?? 'pending';
    byKind[kind] += 1;
    if (outcome === 'pending') openChains += 1;
    else if (outcome === 'remediation_done') resolvedDone += 1;
    else if (outcome === 'remediation_cancelled') resolvedCancelled += 1;
    else if (outcome === 'remediation_failed') resolvedFailed += 1;
    else if (outcome === 'bootstrap_escalation') bootstrapEscalations += 1;

    if (chains.length < cap) {
      const remId = t.platformRemediationTask!;
      chains.push({
        originalTaskId: t.id,
        remediationTaskId: remId,
        kind,
        resumedOutcome: outcome,
        bootstrapEscalation:
          outcome === 'bootstrap_escalation' ||
          remediatorBootstrap.get(remId) === true,
        recordedAt: t.platformRemediationRecordedAt ?? null,
      });
    }
  }

  // Remediator-only bootstrap (original missing or not yet stamped) still counts once.
  for (const t of tasks) {
    if (t.bootstrapEscalation !== true || !isPlatformRemediationTask(t)) continue;
    const original = tasks.find((x) => x.id === t.platformRemediationOf);
    if (!original) {
      bootstrapEscalations += 1;
      continue;
    }
    if (original.platformRemediationResumedOutcome !== 'bootstrap_escalation') {
      bootstrapEscalations += 1;
    }
  }

  return {
    openChains,
    resolvedDone,
    resolvedCancelled,
    resolvedFailed,
    bootstrapEscalations,
    byKind,
    chains,
  };
}

/**
 * Scan all tasks and produce original-task updates needed to sync resumed
 * outcomes from terminal remediators (lifecycle/recovery). Pure — caller writes.
 */
export interface PlatformRemediationReconcilePlan {
  readonly originalId: string;
  readonly resumedOutcome: PlatformRemediationResumedOutcome;
  readonly remediationId: string;
}

export function planPlatformRemediationReconcile(
  tasks: readonly Task[],
): readonly PlatformRemediationReconcilePlan[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const plans: PlatformRemediationReconcilePlan[] = [];
  for (const rem of tasks) {
    if (!isPlatformRemediationTask(rem)) continue;
    const originalId = rem.platformRemediationOf!;
    const original = byId.get(originalId) ?? null;
    if (rem.bootstrapEscalation === true) {
      if (
        original &&
        original.platformRemediationTask === rem.id &&
        original.platformRemediationResumedOutcome !== 'bootstrap_escalation'
      ) {
        plans.push({
          originalId: original.id,
          resumedOutcome: 'bootstrap_escalation',
          remediationId: rem.id,
        });
      }
      continue;
    }
    const update = planResumedOutcomeUpdate({ remediation: rem, original });
    if (update) {
      plans.push({
        originalId: update.originalId,
        resumedOutcome: update.resumedOutcome,
        remediationId: rem.id,
      });
    }
  }
  return plans;
}
