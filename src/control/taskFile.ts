/**
 * Control layer — task file parse/serialize (SPEC §3.2).
 *
 * "The file is the task." A task is a markdown file: YAML front matter (config)
 * + a free-form body. Front matter keys are snake_case on disk; we map them to
 * the camelCase {@link Task} domain type. Serialization is deterministic (fixed
 * key order) so that round-tripping a task produces a clean, minimal git diff.
 */
import matter from 'gray-matter';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { isAdapterKind, type AdapterKind } from '../domain/agents.js';
import {
  isFakeBehaviorScript,
  type FakeBehaviorScript,
} from '../domain/fakeBehavior.js';
import {
  DEFAULT_EXECUTION_CLASS,
  isExecutionClass,
  isHostMutatingClass,
  isIsoTimestamp,
  validateHostCommandScope,
  type ExecutionClass,
} from '../domain/executionClass.js';
import { isPrStatus, isTaskState, isValidIdentifier, type Task } from '../domain/task.js';
import {
  isProjectStateClosureStatus,
  type ProjectStateClosureStatus,
} from '../domain/projectStateClosure.js';
import {
  isDependencyMode,
  type DependencyMode,
} from '../domain/dependencyGate.js';
import {
  normalizeAffectedPaths,
  normalizeProtectedPathsSnapshot,
} from '../domain/taskPathLease.js';
import {
  isPlatformRemediationKind,
  isPlatformRemediationResumedOutcome,
  type PlatformRemediationKind,
  type PlatformRemediationResumedOutcome,
} from '../domain/platformRemediation.js';

export class TaskFileError extends Error {
  override readonly name = 'TaskFileError';
  constructor(
    message: string,
    readonly stem: string,
  ) {
    super(`task '${stem}': ${message}`);
  }
}

// YAML auto-parses unquoted ISO timestamps into Date objects; coerce them back
// to ISO strings so an externally-authored or round-tripped file still validates.
const isoTimestamp = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.string().nullable().default(null),
);

const adapterField = z
  .string()
  .optional()
  .nullable()
  .transform((v, ctx): AdapterKind | null => {
    if (v === undefined || v === null || v.trim() === '') return null;
    const k = v.trim().toLowerCase();
    if (!isAdapterKind(k)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown adapter '${v}'` });
      return z.NEVER;
    }
    return k;
  });

/** snake_case front-matter schema, with daemon-owned fields defaulted. */
const frontMatterSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  repo: z.string().min(1),
  state: z.string().refine(isTaskState, { message: 'unknown state' }),
  priority: z.number().int().default(100),
  blocked_by: z.array(z.string()).default([]),
  /**
   * How blocked_by edges are satisfied (`gate_merge` | `completion_only`).
   * Absent on legacy tasks — domain infers fail-closed for same-repo code.
   */
  dependency_mode: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx): DependencyMode | null => {
      if (v === undefined || v === null || v.trim() === '') return null;
      const k = v.trim().toLowerCase();
      if (!isDependencyMode(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown dependency_mode '${v}' (want gate_merge|completion_only)`,
        });
        return z.NEVER;
      }
      return k;
    }),
  labels: z.array(z.string()).default([]),
  /** Per-task agent override; omit/null → repo then daemon default. */
  adapter: adapterField,
  /**
   * Isolation-only fake adapter fault script. Unknown values rejected.
   * Real adapters never read this — only FakeAdapter under fault injection.
   */
  fake_behavior: z
    .string()
    .optional()
    .nullable()
    .transform((v, ctx): FakeBehaviorScript | null => {
      if (v === undefined || v === null || v.trim() === '') return null;
      const k = v.trim().toLowerCase();
      if (!isFakeBehaviorScript(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown fake_behavior '${v}' (want die-immediately|die-mid-turn|succeed)`,
        });
        return z.NEVER;
      }
      return k;
    }),
  agent_session: z.string().nullable().default(null),
  /** Provider ownership for agent_session; legacy absence fails closed at dispatch. */
  agent_session_adapter: adapterField,
  /** Human follow-up for session resume (comment-to-steer); omit/null = none. */
  pending_steer: z.string().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
  last_event_at: isoTimestamp,
  created_at: isoTimestamp,
  started_at: isoTimestamp,
  ended_at: isoTimestamp,
  cost_run_id: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/).nullable().optional(),
  /** GitHub PR URL after Open PR / Approve&PR. */
  pr_url: z.string().nullable().default(null),
  /** open | merged | closed — last known lifecycle. */
  pr_status: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx): Task['prStatus'] => {
      if (v === undefined || v === null || v.trim() === '') return null;
      if (!isPrStatus(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown pr_status '${v}'` });
        return z.NEVER;
      }
      return v;
    }),
  /** Plan draft awaiting human approve before dispatch (G5). */
  plan_pending: z.boolean().optional().default(false),
  /** Worktree HEAD of the last verification (approve tip invariant). */
  verified_sha: z.string().nullable().optional(),
  /** C3.57: L1 gates green on verified_sha (emitted only when true). */
  verified_gates_green: z.literal(true).optional(),
  /** Hercules-owned review-packet provenance nonce (32 hex). */
  packet_nonce: z.string().nullable().optional(),
  /** Merge-commit SHA after human-authorized batch Merge (design §1). */
  merged_sha: z.string().nullable().optional(),
  /**
   * How merged_sha was recorded (`gate` | `operator`). Absent on legacy
   * stamps — promote briefing treats absent as operator.
   */
  merged_via: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx): 'gate' | 'operator' | null => {
      if (v === undefined || v === null || v.trim() === '') return null;
      if (v === 'gate' || v === 'operator') return v;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown merged_via '${v}'` });
      return z.NEVER;
    }),
  /**
   * Execution class (P0 host-op safety). Omit on legacy tasks → implement.
   */
  execution_class: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx): ExecutionClass | null => {
      if (v === undefined || v === null || v.trim() === '') return null;
      const k = v.trim().toLowerCase();
      if (!isExecutionClass(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown execution_class '${v}' (want explore|implement|verify|host_operation|deploy)`,
        });
        return z.NEVER;
      }
      return k;
    }),
  /** Bounded named host commands (host_operation / deploy approval). */
  host_command_scope: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((v): string[] | null => {
      if (v === undefined || v === null) return null;
      return v.map((s) => s.trim());
    }),
  /** ISO timestamp of human host-op approval. */
  host_approved_at: isoTimestamp.optional(),
  /**
   * Durable marker: deterministic host executor started this approval's scope.
   * Replay-blocked on daemon restart while in_progress.
   */
  host_execution_started_at: isoTimestamp.optional(),
  /**
   * Explicit clean-salvage fork: source failed or cancelled task id
   * (audited action only).
   */
  salvage_source_task: z.string().nullable().optional(),
  /**
   * Exact source tip SHA the target branch was seeded from.
   */
  salvage_source_sha: z.string().nullable().optional(),
  /** Verify-from-ref (C3.43): exact origin commit the branch is seeded from; omitted when absent. */
  seed_from_sha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  expected_base_revision: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  expected_remote_tip: z.string().regex(/^[0-9a-f]{40}$/i).nullable().optional(),
  planned_base_revision: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  /**
   * Declared affected paths (exact file or directory subtree with trailing
   * slash or trailing double-star). Validated for canonical form after zod
   * list check.
   */
  affected_paths: z.array(z.string()).optional(),
  /**
   * WORKFLOW protected_paths snapshot at plan time (drift detection).
   * Empty list is allowed; omit when unset (legacy).
   */
  protected_paths_snapshot: z.array(z.string()).optional(),
  verified_path_lease_digest: z.string().regex(/^[0-9a-f]{64}$/i).nullable().optional(),
  /**
   * Project-state closure lane status (opt-in). Absent on legacy / non-contract repos.
   */
  project_state_closure_status: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx): ProjectStateClosureStatus | null => {
      if (v === undefined || v === null || v.trim() === '') return null;
      if (!isProjectStateClosureStatus(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown project_state_closure_status '${v}'`,
        });
        return z.NEVER;
      }
      return v;
    }),
  /** Policy digest of last closure evaluation (64-hex). */
  project_state_closure_digest: z.string().regex(/^[0-9a-f]{64}$/i).nullable().optional(),
  reviewer_infrastructure: z.object({
    version: z.literal(1),
    provider: z.enum(['grok', 'codex', 'claude', 'fake']),
    state: z.enum(['blocked', 'ready']),
    failure_kind: z.enum(['authentication', 'transient']),
    observed_at: z.preprocess(
      (value) => value instanceof Date ? value.toISOString() : value,
      z.string().datetime(),
    ),
    detail: z.string().min(1).max(320),
    next_action: z.string().min(1).max(160),
    candidate_sha: z.string().regex(/^[0-9a-f]{40}$/i),
    branch: z.string().min(1).max(200),
    worktree: z.string().min(1).max(500),
    green_evidence: z.array(z.string().min(1).max(80)).max(24),
  }).nullable().optional(),
  /**
   * Platform remediation causal chain (bug / capability_gap / platform_limit).
   * Causal only — not blocked_by.
   */
  platform_remediation_kind: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx): PlatformRemediationKind | null => {
      if (v === undefined || v === null || v.trim() === '') return null;
      const k = v.trim();
      if (!isPlatformRemediationKind(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown platform_remediation_kind '${v}' (want bug|capability_gap|platform_limit)`,
        });
        return z.NEVER;
      }
      return k;
    }),
  platform_remediation_task: z.string().nullable().optional(),
  platform_remediation_of: z.string().nullable().optional(),
  platform_remediation_resumed_outcome: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx): PlatformRemediationResumedOutcome | null => {
      if (v === undefined || v === null || v.trim() === '') return null;
      const k = v.trim();
      if (!isPlatformRemediationResumedOutcome(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown platform_remediation_resumed_outcome '${v}'`,
        });
        return z.NEVER;
      }
      return k;
    }),
  platform_remediation_recorded_at: isoTimestamp.optional(),
  bootstrap_escalation: z.boolean().nullable().optional(),
  bootstrap_escalation_action: z.string().nullable().optional(),
  bootstrap_escalation_recorded_at: isoTimestamp.optional(),
});

export function parseTaskFile(content: string, stem: string): Task {
  if (!isValidIdentifier(stem)) {
    throw new TaskFileError(`file stem is not a safe identifier`, stem);
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    throw new TaskFileError(`could not parse front matter: ${(err as Error).message}`, stem);
  }

  if (Object.keys(parsed.data).length === 0) {
    throw new TaskFileError('missing YAML front matter', stem);
  }

  const result = frontMatterSchema.safeParse(parsed.data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new TaskFileError(`invalid front matter: ${issues}`, stem);
  }

  const fm = result.data;
  if (fm.id !== undefined && fm.id !== stem) {
    throw new TaskFileError(`front matter id '${fm.id}' must match file stem`, stem);
  }

  const executionClass = fm.execution_class ?? DEFAULT_EXECUTION_CLASS;
  const hostCommandScope = fm.host_command_scope ?? null;
  const hostApprovedAt = fm.host_approved_at ?? null;
  const hostExecutionStartedAt = fm.host_execution_started_at ?? null;
  const salvageSourceTask = fm.salvage_source_task ?? null;
  const salvageSourceSha = fm.salvage_source_sha ?? null;
  if (salvageSourceTask !== null) {
    if (!isValidIdentifier(salvageSourceTask)) {
      throw new TaskFileError(
        `salvage_source_task '${salvageSourceTask}' is not a safe identifier`,
        stem,
      );
    }
    if (salvageSourceTask === stem) {
      throw new TaskFileError('salvage_source_task must differ from this task id', stem);
    }
  }
  if (salvageSourceSha !== null && !/^[0-9a-f]{40}$/i.test(salvageSourceSha)) {
    throw new TaskFileError(
      `salvage_source_sha must be a 40-char hex commit (got '${salvageSourceSha}')`,
      stem,
    );
  }
  if ((salvageSourceTask === null) !== (salvageSourceSha === null)) {
    throw new TaskFileError(
      'salvage_source_task and salvage_source_sha must either both be set or both be absent',
      stem,
    );
  }

  let affectedPathsField: { readonly affectedPaths: readonly string[] } | Record<string, never> =
    {};
  if (fm.affected_paths !== undefined) {
    const normalized = normalizeAffectedPaths(fm.affected_paths);
    if (!normalized.ok) {
      throw new TaskFileError(`invalid affected_paths: ${normalized.reason}`, stem);
    }
    // Persist canonical declarations (subtree as trailing slash).
    affectedPathsField = {
      affectedPaths: normalized.scopes.map((s) =>
        s.kind === 'subtree' ? `${s.path}/` : s.path,
      ),
    };
  }
  const pathLeaseDeclarationCount = [
    fm.planned_base_revision,
    fm.affected_paths,
    fm.protected_paths_snapshot,
  ].filter((value) => value !== undefined).length;
  if (pathLeaseDeclarationCount !== 0 && pathLeaseDeclarationCount !== 3) {
    throw new TaskFileError(
      'planned_base_revision, affected_paths, and protected_paths_snapshot must all be set or all be absent',
      stem,
    );
  }

  let protectedPathsSnapshotField:
    | { readonly protectedPathsSnapshot: readonly string[] }
    | Record<string, never> = {};
  if (fm.protected_paths_snapshot !== undefined) {
    const normalized = normalizeProtectedPathsSnapshot(fm.protected_paths_snapshot);
    if (!normalized.ok) {
      throw new TaskFileError(`invalid protected_paths_snapshot: ${normalized.reason}`, stem);
    }
    protectedPathsSnapshotField = {
      protectedPathsSnapshot: normalized.paths,
    };
  }

  if (isHostMutatingClass(executionClass)) {
    const hasScope = hostCommandScope !== null;
    const hasApproval = hostApprovedAt !== null;
    if (hasScope !== hasApproval) {
      throw new TaskFileError(
        'host_command_scope and host_approved_at must either both be set or both be absent',
        stem,
      );
    }
    if (hostCommandScope) {
      const validated = validateHostCommandScope(hostCommandScope);
      if (!validated.ok) {
        throw new TaskFileError(`invalid host_command_scope: ${validated.reason}`, stem);
      }
      if (!isIsoTimestamp(hostApprovedAt ?? '')) {
        throw new TaskFileError('host_approved_at must be an ISO UTC timestamp', stem);
      }
    }
    if (
      hostExecutionStartedAt !== null &&
      hostExecutionStartedAt !== undefined &&
      !isIsoTimestamp(hostExecutionStartedAt)
    ) {
      throw new TaskFileError(
        'host_execution_started_at must be an ISO UTC timestamp',
        stem,
      );
    }
  } else if (
    hostCommandScope !== null ||
    hostApprovedAt !== null ||
    hostExecutionStartedAt !== null
  ) {
    throw new TaskFileError(
      'host approval fields are only valid for host_operation or deploy tasks',
      stem,
    );
  }

  if (
    fm.reviewer_infrastructure &&
    fm.reviewer_infrastructure.branch !== `hercules/${stem}`
  ) {
    throw new TaskFileError(
      `reviewer_infrastructure.branch must equal 'hercules/${stem}'`,
      stem,
    );
  }

  const platformRemediationKind = fm.platform_remediation_kind ?? null;
  const platformRemediationTask = fm.platform_remediation_task ?? null;
  const platformRemediationOf = fm.platform_remediation_of ?? null;
  const platformRemediationResumedOutcome = fm.platform_remediation_resumed_outcome ?? null;
  const platformRemediationRecordedAt = fm.platform_remediation_recorded_at ?? null;
  const bootstrapEscalation = fm.bootstrap_escalation === true ? true : null;
  const bootstrapEscalationAction = fm.bootstrap_escalation_action ?? null;
  const bootstrapEscalationRecordedAt = fm.bootstrap_escalation_recorded_at ?? null;

  if (platformRemediationTask !== null) {
    if (!isValidIdentifier(platformRemediationTask)) {
      throw new TaskFileError(
        `platform_remediation_task '${platformRemediationTask}' is not a safe identifier`,
        stem,
      );
    }
    if (platformRemediationTask === stem) {
      throw new TaskFileError(
        'platform_remediation_task must differ from this task id',
        stem,
      );
    }
  }
  if (platformRemediationOf !== null) {
    if (!isValidIdentifier(platformRemediationOf)) {
      throw new TaskFileError(
        `platform_remediation_of '${platformRemediationOf}' is not a safe identifier`,
        stem,
      );
    }
    if (platformRemediationOf === stem) {
      throw new TaskFileError(
        'platform_remediation_of must differ from this task id',
        stem,
      );
    }
  }
  const hasOriginalLink = platformRemediationTask !== null;
  const hasRemediatorLink = platformRemediationOf !== null;
  if (hasOriginalLink && platformRemediationKind === null) {
    throw new TaskFileError(
      'platform_remediation_kind is required when platform_remediation_task is set',
      stem,
    );
  }
  if (hasRemediatorLink && platformRemediationKind === null) {
    throw new TaskFileError(
      'platform_remediation_kind is required when platform_remediation_of is set',
      stem,
    );
  }
  if (hasOriginalLink && hasRemediatorLink) {
    throw new TaskFileError(
      'a task cannot be both original and remediation (platform_remediation_task and platform_remediation_of)',
      stem,
    );
  }
  if (platformRemediationKind !== null && !hasOriginalLink && !hasRemediatorLink) {
    throw new TaskFileError(
      'platform_remediation_kind requires platform_remediation_task or platform_remediation_of',
      stem,
    );
  }
  if (
    bootstrapEscalation === true &&
    bootstrapEscalationAction !== null &&
    bootstrapEscalationAction.length > 500
  ) {
    throw new TaskFileError(
      'bootstrap_escalation_action too long (max 500 chars)',
      stem,
    );
  }

  return {
    id: stem,
    title: fm.title,
    repo: fm.repo,
    // Safe: schema refined state with isTaskState.
    state: fm.state as Task['state'],
    priority: fm.priority,
    blockedBy: fm.blocked_by,
    dependencyMode: fm.dependency_mode ?? null,
    labels: fm.labels,
    adapter: fm.adapter ?? null,
    fakeBehavior: fm.fake_behavior ?? null,
    agentSession: fm.agent_session,
    agentSessionAdapter: fm.agent_session_adapter,
    pendingSteer: fm.pending_steer,
    attempts: fm.attempts,
    lastEventAt: fm.last_event_at,
    createdAt: fm.created_at,
    startedAt: fm.started_at,
    endedAt: fm.ended_at,
    ...(fm.cost_run_id ? { costRunId: fm.cost_run_id } : {}),
    prUrl: fm.pr_url,
    prStatus: fm.pr_status ?? null,
    planPending: fm.plan_pending === true,
    verifiedSha: fm.verified_sha ?? null,
    // OMIT the key when absent (never `null`): the shadow reconciler binds
    // historical envelopes by the canonical hash of the parsed Task, so a new
    // optional field that appears as `null` on legacy tasks changes every hash
    // and fails production boot closed (2026-09-06 promote rollback).
    ...(typeof fm.packet_nonce === 'string' && fm.packet_nonce.length > 0
      ? { packetNonce: fm.packet_nonce }
      : {}),
    ...(fm.verified_gates_green === true ? { verifiedGatesGreen: true } : {}),
    mergedSha: fm.merged_sha ?? null,
    mergedVia: fm.merged_via ?? null,
    // Legacy omit → implement (conservative coding default).
    executionClass,
    hostCommandScope,
    hostApprovedAt,
    hostExecutionStartedAt,
    salvageSourceTask,
    salvageSourceSha,
    ...(fm.seed_from_sha !== undefined ? { seedFromSha: fm.seed_from_sha.toLowerCase() } : {}),
    ...(fm.expected_base_revision !== undefined
      ? { expectedBaseRevision: fm.expected_base_revision.toLowerCase() }
      : {}),
    ...(fm.expected_remote_tip !== undefined
      ? { expectedRemoteTip: fm.expected_remote_tip?.toLowerCase() ?? null }
      : {}),
    ...(fm.planned_base_revision !== undefined
      ? { plannedBaseRevision: fm.planned_base_revision.toLowerCase() }
      : {}),
    ...affectedPathsField,
    ...protectedPathsSnapshotField,
    ...(fm.verified_path_lease_digest !== undefined
      ? { verifiedPathLeaseDigest: fm.verified_path_lease_digest?.toLowerCase() ?? null }
      : {}),
    ...(fm.project_state_closure_status != null
      ? { projectStateClosureStatus: fm.project_state_closure_status }
      : {}),
    ...(fm.project_state_closure_digest != null && fm.project_state_closure_digest !== ''
      ? {
          projectStateClosureDigest: fm.project_state_closure_digest.toLowerCase(),
        }
      : {}),
    ...(fm.reviewer_infrastructure
      ? {
          reviewerInfrastructure: {
            version: 1 as const,
            provider: fm.reviewer_infrastructure.provider,
            state: fm.reviewer_infrastructure.state,
            failureKind: fm.reviewer_infrastructure.failure_kind,
            observedAt: fm.reviewer_infrastructure.observed_at,
            detail: fm.reviewer_infrastructure.detail,
            nextAction: fm.reviewer_infrastructure.next_action,
            candidateSha: fm.reviewer_infrastructure.candidate_sha.toLowerCase(),
            branch: fm.reviewer_infrastructure.branch,
            worktree: fm.reviewer_infrastructure.worktree,
            greenEvidence: fm.reviewer_infrastructure.green_evidence,
          },
        }
      : {}),
    ...(platformRemediationKind !== null ? { platformRemediationKind } : {}),
    ...(platformRemediationTask !== null ? { platformRemediationTask } : {}),
    ...(platformRemediationOf !== null ? { platformRemediationOf } : {}),
    ...(platformRemediationResumedOutcome !== null
      ? { platformRemediationResumedOutcome }
      : {}),
    ...(platformRemediationRecordedAt
      ? { platformRemediationRecordedAt }
      : {}),
    ...(bootstrapEscalation === true ? { bootstrapEscalation: true } : {}),
    ...(bootstrapEscalationAction !== null && bootstrapEscalationAction !== undefined
      ? { bootstrapEscalationAction }
      : {}),
    ...(bootstrapEscalationRecordedAt
      ? { bootstrapEscalationRecordedAt }
      : {}),
    body: parsed.content.trim(),
  };
}

/**
 * Serialize a task to its on-disk form. Keys are emitted in a fixed order so
 * the diff is stable across writes.
 */
export function serializeTask(task: Task): string {
  const frontMatter: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    repo: task.repo,
    state: task.state,
    priority: task.priority,
    blocked_by: [...task.blockedBy],
  };
  // Only emit dependency_mode when explicitly set (legacy stays inferred).
  if (task.dependencyMode === 'gate_merge' || task.dependencyMode === 'completion_only') {
    frontMatter['dependency_mode'] = task.dependencyMode;
  }
  frontMatter['labels'] = [...task.labels];
  // Only emit adapter when overridden — keeps diffs small.
  if (task.adapter !== null) frontMatter['adapter'] = task.adapter;
  // Isolation-only; omit when unset so production tasks never carry the key.
  if (task.fakeBehavior != null) frontMatter['fake_behavior'] = task.fakeBehavior;
  frontMatter['agent_session'] = task.agentSession;
  if (task.agentSession !== null && task.agentSessionAdapter != null) {
    frontMatter['agent_session_adapter'] = task.agentSessionAdapter;
  }
  // Only emit pending_steer when set — most tasks never have one.
  if (task.pendingSteer !== null) frontMatter['pending_steer'] = task.pendingSteer;
  frontMatter['attempts'] = task.attempts;
  frontMatter['last_event_at'] = task.lastEventAt;
  frontMatter['created_at'] = task.createdAt;
  frontMatter['started_at'] = task.startedAt;
  frontMatter['ended_at'] = task.endedAt;
  if (task.costRunId) frontMatter['cost_run_id'] = task.costRunId;
  // Only emit PR fields when set — most tasks never open a PR.
  if (task.prUrl !== null) frontMatter['pr_url'] = task.prUrl;
  if (task.prStatus !== null) frontMatter['pr_status'] = task.prStatus;
  // Only emit plan_pending when true — most tasks dispatch immediately.
  if (task.planPending) frontMatter['plan_pending'] = true;
  // Only emit verified_sha when a verification recorded one.
  if (task.verifiedSha) frontMatter['verified_sha'] = task.verifiedSha;
  // Only emit verified_gates_green when true (C3.57); legacy hashes unchanged.
  if (task.verifiedGatesGreen === true && task.verifiedSha) {
    frontMatter['verified_gates_green'] = true;
  }
  // Only emit packet_nonce when a verification recorded one.
  if (task.packetNonce) frontMatter['packet_nonce'] = task.packetNonce;
  // Only emit merged_sha after a successful human-authorized Merge.
  if (task.mergedSha) frontMatter['merged_sha'] = task.mergedSha;
  // Only emit merged_via when set (gate stamp from Merge service).
  if (task.mergedVia === 'gate' || task.mergedVia === 'operator') {
    frontMatter['merged_via'] = task.mergedVia;
  }
  // Only emit execution_class when non-default (legacy tasks stay clean).
  const execClass = task.executionClass ?? DEFAULT_EXECUTION_CLASS;
  if (execClass !== DEFAULT_EXECUTION_CLASS) {
    frontMatter['execution_class'] = execClass;
  }
  // Only emit host approval fields when set (host_operation / deploy).
  if (task.hostCommandScope && task.hostCommandScope.length > 0) {
    frontMatter['host_command_scope'] = [...task.hostCommandScope];
  }
  if (task.hostApprovedAt) {
    frontMatter['host_approved_at'] = task.hostApprovedAt;
  }
  if (task.hostExecutionStartedAt) {
    frontMatter['host_execution_started_at'] = task.hostExecutionStartedAt;
  }
  // Only emit clean-salvage provenance when set (ordinary tasks stay clean).
  if (task.salvageSourceTask) {
    frontMatter['salvage_source_task'] = task.salvageSourceTask;
  }
  if (task.salvageSourceSha) {
    frontMatter['salvage_source_sha'] = task.salvageSourceSha;
  }
  if (task.seedFromSha !== undefined) {
    frontMatter['seed_from_sha'] = task.seedFromSha;
  }
  if (task.expectedBaseRevision !== undefined) {
    frontMatter['expected_base_revision'] = task.expectedBaseRevision;
  }
  if (task.expectedRemoteTip !== undefined) {
    frontMatter['expected_remote_tip'] = task.expectedRemoteTip;
  }
  if (task.plannedBaseRevision !== undefined) {
    frontMatter['planned_base_revision'] = task.plannedBaseRevision;
  }
  if (task.affectedPaths !== undefined) {
    frontMatter['affected_paths'] = [...task.affectedPaths];
  }
  if (task.protectedPathsSnapshot !== undefined) {
    frontMatter['protected_paths_snapshot'] = [...task.protectedPathsSnapshot];
  }
  if (task.verifiedPathLeaseDigest !== undefined) {
    frontMatter['verified_path_lease_digest'] = task.verifiedPathLeaseDigest;
  }
  if (
    task.projectStateClosureStatus !== undefined &&
    task.projectStateClosureStatus !== null
  ) {
    frontMatter['project_state_closure_status'] = task.projectStateClosureStatus;
  }
  if (task.projectStateClosureDigest !== undefined && task.projectStateClosureDigest !== null) {
    frontMatter['project_state_closure_digest'] = task.projectStateClosureDigest;
  }
  if (task.reviewerInfrastructure) {
    const receipt = task.reviewerInfrastructure;
    frontMatter['reviewer_infrastructure'] = {
      version: receipt.version,
      provider: receipt.provider,
      state: receipt.state,
      failure_kind: receipt.failureKind,
      observed_at: receipt.observedAt,
      detail: receipt.detail,
      next_action: receipt.nextAction,
      candidate_sha: receipt.candidateSha,
      branch: receipt.branch,
      worktree: receipt.worktree,
      green_evidence: [...receipt.greenEvidence],
    };
  }
  if (task.platformRemediationKind) {
    frontMatter['platform_remediation_kind'] = task.platformRemediationKind;
  }
  if (task.platformRemediationTask) {
    frontMatter['platform_remediation_task'] = task.platformRemediationTask;
  }
  if (task.platformRemediationOf) {
    frontMatter['platform_remediation_of'] = task.platformRemediationOf;
  }
  if (task.platformRemediationResumedOutcome) {
    frontMatter['platform_remediation_resumed_outcome'] =
      task.platformRemediationResumedOutcome;
  }
  if (task.platformRemediationRecordedAt) {
    frontMatter['platform_remediation_recorded_at'] =
      task.platformRemediationRecordedAt;
  }
  if (task.bootstrapEscalation === true) {
    frontMatter['bootstrap_escalation'] = true;
  }
  if (task.bootstrapEscalationAction) {
    frontMatter['bootstrap_escalation_action'] = task.bootstrapEscalationAction;
  }
  if (task.bootstrapEscalationRecordedAt) {
    frontMatter['bootstrap_escalation_recorded_at'] =
      task.bootstrapEscalationRecordedAt;
  }
  const yaml = stringifyYaml(frontMatter, { lineWidth: 0 });
  const body = task.body.trim();
  return `---\n${yaml}---\n\n${body}\n`;
}
