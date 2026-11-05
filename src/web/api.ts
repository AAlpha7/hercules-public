// Client-side API helpers. The token is entered once in the TokenGate and kept
// in localStorage; it is sent ONLY in the Authorization header, never in a URL.

import {
  decodeReviewExperienceCapabilitiesV1,
  decodeReviewPackageV2,
  ReviewDtoDecodeError,
  type ReviewExperienceCapabilitiesV1,
  type ReviewPackageV2Dto,
} from './review/reviewTypes.js';
import {
  assertReviewPackageProjectionIntegrity,
  reviewCanonicalHash,
} from './review/reviewIntegrity.js';
import {
  decodeReviewEvidenceContentV1,
  type ReviewEvidenceContentDto,
} from './review/reviewEvidenceTypes.js';
import {
  decodeLearningProposalViewsV1,
  type LearningProposalViewDto,
} from './review/learningProposalTypes.js';
import type { EvidenceSummaryDto } from './review/reviewTypes.js';
import {
  decodeReviewDecisionResponseV1,
  type ReviewDecisionRequestDto,
  type ReviewDecisionResponseDto,
} from './review/reviewDecisionTypes.js';
import {
  ControlApiV2BrowserError,
  createControlApiV2BrowserClient,
  type ControlApiV2BrowserClient,
  type ControlApiV2BrowserFetch,
} from './controlApiV2Client.js';

const TOKEN_KEY = 'hercules_token';

/** Declared web actor identity carried in the Control API V2 idempotency key; the server-side authority roster (C3) binds it to the bearer principal. */
export const CONTROL_API_V2_WEB_ACTOR_ISSUER = 'hercules-web';
export const CONTROL_API_V2_WEB_ACTOR_ID = 'operator';

export type TaskState =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled'
  | 'retrying'
  | 'failed'
  | 'deleted';

export type AdapterKind = 'grok' | 'codex' | 'claude' | 'cursor' | 'fake';

/** Task front-matter execution_class (P0 host-op safety). */
export type ExecutionClass =
  | 'explore'
  | 'implement'
  | 'verify'
  | 'host_operation'
  | 'deploy';

export interface Task {
  id: string;
  title: string;
  repo: string;
  state: TaskState;
  priority: number;
  blockedBy: string[];
  /**
   * How blocked_by edges are satisfied. Null/absent = legacy inference
   * (same-repo implement → gate_merge; explore/cross-repo → completion_only).
   */
  dependencyMode?: 'gate_merge' | 'completion_only' | null;
  labels: string[];
  /** Per-task override; null = repo then daemon default. */
  adapter: AdapterKind | null;
  /** Merge-commit SHA after human-authorized Merge Selected. */
  mergedSha?: string | null;
  /** How mergedSha was recorded (`gate` | `operator`). */
  mergedVia?: 'gate' | 'operator' | null;
  agentSession: string | null;
  /** Follow-up queued for session resume (comment-to-steer). */
  pendingSteer: string | null;
  attempts: number;
  lastEventAt: string | null;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** GitHub PR after Approve&PR / Open PR. */
  prUrl: string | null;
  /** open = still active; merged/closed = terminal. */
  prStatus: 'open' | 'merged' | 'closed' | null;
  /** Plan draft awaiting human approve before dispatch. */
  planPending: boolean;
  /** API/view-only bilingual reason when planPending (not persisted). */
  planPendingReason?: { en: string; zh: string } | null;
  /** Worktree HEAD at verification time (browse-files anchor). */
  verifiedSha?: string | null;
  /**
   * Hercules-owned provenance nonce for the latest review packet
   * (`packet_nonce` front matter). SPA parsers prefer this over scanning
   * for the last header fence. Legacy tasks have none.
   */
  packetNonce?: string | null;
  /**
   * Project-state closure lane (opt-in repos). Distinct from verifiedSha and
   * mergedSha — never claims a milestone complete merely because a SHA merged.
   */
  projectStateClosureStatus?: 'not_applicable' | 'pending' | 'passed' | 'failed' | null;
  /** Policy digest of the last closure evaluation (restart-safe). */
  projectStateClosureDigest?: string | null;
  /**
   * Execution class. Absent/legacy → treat as implement.
   * host_operation / deploy need human command-scope approval.
   */
  executionClass?: ExecutionClass | null;
  /** Bounded named host commands (after approve-host-operation). */
  hostCommandScope?: string[] | null;
  /** ISO timestamp of human host-op approval. */
  hostApprovedAt?: string | null;
  /** Durable marker: deterministic host executor started this approval's scope. */
  hostExecutionStartedAt?: string | null;
  /** Explicit clean-salvage fork: source failed or cancelled task id. */
  salvageSourceTask?: string | null;
  /** Exact source tip SHA the target branch was seeded from. */
  salvageSourceSha?: string | null;
  /** Trusted default-branch tip for an exact candidate lease. */
  expectedBaseRevision?: string;
  /** Exact existing remote task-branch tip. */
  expectedRemoteTip?: string | null;
  /** Immutable reviewed base for the affected-path declaration. */
  plannedBaseRevision?: string;
  /** Canonical exact files or directory subtrees declared for this task. */
  affectedPaths?: string[];
  /** WORKFLOW protected-path snapshot captured at planning time. */
  protectedPathsSnapshot?: string[];
  body: string;
}

export interface RepoDto {
  key: string;
  url: string;
  defaultBranch: string;
  workflow: string;
  maxConcurrent: number;
  /** Explicit override, or null to inherit daemon default. */
  adapter: AdapterKind | null;
  /** What would actually run. */
  effectiveAdapter: AdapterKind;
  readiness: 'ready' | 'incomplete';
  /** Effective execution policy (names only — never secret values). */
  executionPolicy?: {
    explicit: boolean;
    profile: string;
    sandbox: string;
    network: string;
    envAllowlist: string[];
    forbidProductionSecrets: boolean;
    forbidConnectorCredentials: boolean;
    forbidLivePersonalData: boolean;
    workspaceWrite: boolean;
  };
  /** Auto-merge pilot policy; null/absent = off. */
  autoMerge?: { enabled: boolean; dwellMinutes: number; maxSize: 'S' | 'M' | 'L' } | null;
}

export type AcLintSeverity = 'error' | 'warn' | 'info';

export type AcLintCode =
  | 'no-criteria'
  | 'unbound-mechanical'
  | 'all-gate-bound'
  | 'test-path-no-title'
  | 'probe-no-verifier'
  | 'stacked-bindings'
  | 'checkpoint-missing-step'
  | 'untyped-criterion'
  | 'duplicate-criterion'
  | 'evidence-hook-in-prose';

export interface AcLintFinding {
  severity: AcLintSeverity;
  code: AcLintCode;
  message: string;
  line?: number;
  criterion?: string;
}

export interface AcLintReport {
  ok: boolean;
  findings: AcLintFinding[];
  counts: { error: number; warn: number; info: number };
}

export type IntentSlot = 'where' | 'what' | 'done_when';

export interface IntentQuestionDto {
  slot: IntentSlot;
  text: string;
  options?: string[];
}

export interface IntentDraftDto {
  title: string;
  slug?: string;
  body: string;
  priority: number;
  labels: string[];
  vague: boolean;
  warnings: string[];
  /** Open clarification questions (optional for older servers). */
  questions?: IntentQuestionDto[];
  /** Zh one-liners of what the drafter filled (optional for older servers). */
  filled?: string[];
  lint: AcLintReport;
  source: 'analyst' | 'heuristic';
  notes: string[];
  repairRounds: number;
}

export type DraftJobStatus = 'running' | 'ready' | 'failed';
export type DraftJobPhase = 'context' | 'draft' | 'retry' | 'repair' | 'done';

export interface DraftJobActivityDto {
  at: string;
  kind: 'phase' | 'tool';
  text: string;
}

export interface DraftJobDto {
  id: string;
  repo: string;
  intent: string;
  status: DraftJobStatus;
  phase: DraftJobPhase;
  startedAt: string;
  finishedAt: string | null;
  activity: DraftJobActivityDto[];
  thinking: string;
  narration: string;
  draft: IntentDraftDto | null;
  error: string | null;
}

export interface IntentDraftResponse {
  draft: IntentDraftDto;
  jobId: string | null;
}

export type DraftJobEvent = { job: DraftJobDto } | { removed: string };

export interface AgentsDto {
  default: string;
  available: string[];
  providerPolicy?: ProviderPolicyDto;
}

export interface ProviderPolicyDto {
  codex: { model: string; reasoningEffort: string };
  claudeEnabled: boolean;
}

export type SessionStatus = 'idle' | 'running' | 'failed' | 'closed';
export type SessionKind = 'free' | 'task';
export type PermissionMode = 'default' | 'acceptEdits' | 'bypass';

export interface ChatAttachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  relPath: string;
  mime: string;
  bytes: number;
}

export interface MessageRef {
  kind: 'task' | 'file' | 'pr';
  target: string;
  label?: string;
}

export interface MessageAction {
  kind: 'open_task' | 'open_session';
  target: string;
  label?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
  attachments?: ChatAttachment[];
  refs?: MessageRef[];
  /** In-chat jump buttons (task review, session). */
  actions?: MessageAction[];
}

export interface SessionDiff {
  available: boolean;
  summary: string;
  files: string[];
  diff: string;
  reason?: string;
}

export interface PendingPermission {
  id: string;
  title: string;
  toolKind: string;
  toolCallId: string | null;
  detail: string | null;
  options: { optionId: string; name: string; kind: string }[];
  deadlineAt: string;
  createdAt: string;
}

export interface RemoteSession {
  id: string;
  kind: SessionKind;
  taskId: string | null;
  repo: string;
  title: string;
  status: SessionStatus;
  adapter: AdapterKind | null;
  agentSession: string | null;
  permissionMode: PermissionMode;
  pendingPermissions: PendingPermission[];
  pendingProposals?: TaskProposal[];
  messages: ChatMessage[];
  queued: string[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
  linkedTaskId?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

export interface TaskProposal {
  id: string;
  title: string;
  repo: string | null;
  body: string;
  priority: number | null;
  raw: string;
  createdAt: string;
  sourceMessageId: string | null;
}

export interface BuildInfo {
  /** Canonical: vYYYYMMDD.<dayPush> e.g. v20260713.3 */
  version: string;
  gitSha: string;
  dirty: boolean;
  dayPush?: number;
  dateYmd?: string;
  resolvedAt: string;
}

export interface LiveRunMeta {
  taskId: string;
  sessionId: string | null;
  lastEventAt: string;
  branchTip: string | null;
  runKind: 'implementer' | 'steer';
  activityLines: number;
  /** True when agent child is alive (stream may be silent — not a hang). */
  processAlive?: boolean;
  /** ms since last stream event. */
  silenceMs?: number;
  /** ms since this dispatch started. */
  runMs?: number;
  /** Hard wall-clock kill limit. */
  maxRunMs?: number;
  /** Best-effort child worker (cargo / rustc / pnpm). */
  aliveHint?: string | null;
  /** Worker-tree CPU% between polls (quiet-period liveness). */
  procCpuPct?: number | null;
  /** Worker-tree RSS in MB. */
  procRssMb?: number | null;
  /** Deterministic host executor: 1-based current command index. */
  hostCommandIndex?: number;
  hostCommandTotal?: number;
  /** Bounded redacted command label (never env / secrets). */
  hostCommandName?: string | null;
  hostCommandTimeoutMs?: number;
}

/** Bounded live verification overlay (no command secrets / gate output). */
export interface VerificationRunMeta {
  taskId: string;
  phase: 'setup' | 'l1' | 'held-out' | 'l2' | 'l3' | 'packet';
  stage: string;
  startedAt: string;
  elapsedMs: number;
  processAlive: boolean;
  cancelRequested: boolean;
  lastCompletedStage: string | null;
}

export interface CostCapThresholdsDto {
  softUsd: number | null;
  hardUsd: number | null;
  /** null means token telemetry is advisory; a number is an explicit owner override. */
  softTokens: number | null;
  hardTokens: number | null;
}

export interface CostLedgerDiagnosticsDto {
  status: 'ok' | 'migrated' | 'partial' | 'corrupt' | 'unavailable' | 'memory';
  receiptCount: number;
  retainedDays: number;
  lastPersistedAtMs: number | null;
  recoveredAtMs: number | null;
  note: string | null;
  failClosed: boolean;
}

export interface CostCapSummaryDto {
  enabled: boolean;
  level: 'ok' | 'soft' | 'hard';
  day: { inputTokens: number; outputTokens: number; costUsd: number };
  reasons: string[];
  /** Effective billing profile (subscription | metered). Optional for older daemons. */
  billingMode?: 'subscription' | 'metered';
  /** Operator diagnostic when mode was missing/invalid. */
  billingModeNote?: string | null;
  /** Phone-facing meaning of USD (estimate vs metered spend). */
  costMeaning?: string;
  /**
   * Effective policy thresholds. USD values follow billing defaults/overrides;
   * null token values are advisory telemetry and numeric token values are
   * explicit owner enforcement overrides.
   */
  policy?: {
    perTask: CostCapThresholdsDto;
    daily: CostCapThresholdsDto;
  };
  /** Bounded accounting diagnostics; no prompts, payloads, or provider ids. */
  ledger?: CostLedgerDiagnosticsDto;
}

/** Why the daemon is not dispatching new agents. */
export interface DispatchHoldDto {
  reason: 'disk' | 'configured';
  /** Operator-facing one-liner. */
  detail: string;
}

/** Why a single todo/retrying task was not admitted this tick. */
export type SchedulingHoldReasonDto =
  | { code: 'plan_pending' }
  | { code: 'host_approval_pending' }
  | { code: 'already_running' }
  | { code: 'excluded' }
  | { code: 'unknown_repo' }
  | { code: 'repo_readiness_incomplete'; repo: string }
  | { code: 'dependency_gate_merge'; waitingOn: readonly string[] }
  | { code: 'dependency_completion'; waitingOn: readonly string[] }
  | { code: 'retry_backoff'; untilMs: number }
  | { code: 'provision_failed'; untilMs: number; detail: string }
  | { code: 'adapter_crashing'; adapter: string; untilMs: number; detail: string }
  | { code: 'capacity'; scope: 'global' | 'repo'; repo?: string };

export interface DiskPressureDto {
  level: 'ok' | 'warn' | 'critical';
  usedPct: number;
  freeBytes: number;
}

export interface StateDto {
  /** Server snapshot order — client drops full snapshots older than applied. */
  seq?: number;
  ready: boolean;
  running: string[];
  stopping: string[];
  repos: RepoDto[];
  problems: { stem: string; error: string }[];
  byState: Record<TaskState, Task[]>;
  activity: Record<string, string[]>;
  /** Human chat queued while a task is running. */
  pendingChat?: Record<string, string[]>;
  /** Mid-run honesty overlay (session / tip / last event). */
  liveRuns?: Record<string, LiveRunMeta>;
  /** Live verification phase (after agent exits). */
  verificationRuns?: Record<string, VerificationRunMeta>;
  lastReport: {
    dispatched: string[];
    completed: string[];
    failed: string[];
    thrashParked?: string[];
    quietLong?: string[];
    sessionMetrics?: { thrashParks: number; quietLongSightings: number };
  } | null;
  agents: AgentsDto;
  /** Free Remote Control sessions. */
  sessions?: RemoteSession[];
  sessionActivity?: Record<string, string[]>;
  /** Daemon deploy stamp — compare with SPA-baked version. */
  build?: BuildInfo;
  /** Token/cost caps (Settings). Optional for older daemons. */
  costSummary?: CostCapSummaryDto;
  /**
   * Dispatch paused (disk ≥95%). Red banner on tasks home.
   * Optional for older daemons.
   */
  dispatchHold?: DispatchHoldDto | null;
  /**
   * Per-task scheduling holds for todo/retrying not admitted.
   * Optional for older daemons; treat missing as {}.
   * May briefly retain entries after cancel/done until the next tick — ignore
   * unless the task's current state is `todo` or `retrying`.
   */
  holds?: Record<string, SchedulingHoldReasonDto>;
  /** Amber hint when disk is warn-only (85–94%). Optional for older daemons. */
  diskWarn?: string | null;
  /** Latest disk reading. Optional for older daemons. */
  diskPressure?: DiskPressureDto | null;
  /**
   * Provider failover while an adapter is unhealthy. Decision-inbox system item.
   * Optional for older daemons.
   */
  adapterFailover?: AdapterFailoverDto | null;
  /** Bounded reviewer-provider health; internal candidate/worktree fields are omitted. */
  reviewerHealth?: ReviewerProviderHealthDto[];
}

/** Active adapter failover notice (daemon → phone). */
export interface AdapterFailoverDto {
  unhealthy: string[];
  detail: string;
  substitute?: string;
}

export interface ReviewerProviderHealthDto {
  provider: string;
  state: 'blocked' | 'recovering';
  failureKind: 'authentication' | 'transient';
  observedAt: string;
  blockedCandidates: number;
  detail: string;
  nextAction: string;
}

export const recoverReviewerProvider = (
  provider: string,
  mode: 'health_check' | 'operator',
): Promise<{ recovered: number }> =>
  request(`/api/reviewer-health/${encodeURIComponent(provider)}/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });

/** An API request that failed; `status` carries the HTTP code so callers can
 * distinguish 401 (stale/rejected token → drop back to the gate) from the rest. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY) ?? '';
  return { authorization: `Bearer ${token}` };
}

/**
 * Safari/WebKit reports failed fetch as TypeError "Load failed" (Chrome: "Failed
 * to fetch"). Map those opaque strings so the task list toast is actionable.
 */
export function humanizeNetworkError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'Request cancelled';
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/^load failed$/i.test(msg.trim()) || /failed to fetch|networkerror|network request failed|fetch failed/i.test(msg)) {
    return 'Network error — check connection, then pull to refresh';
  }
  return msg;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...authHeaders(), 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(0, humanizeNetworkError(err));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function fetchReviewExperienceCapabilities(
  options: { readonly signal?: AbortSignal } = {},
): Promise<ReviewExperienceCapabilitiesV1> {
  const value = await request<unknown>(
    '/api/v2/review-experience/capabilities',
    { signal: options.signal },
  );
  return decodeReviewExperienceCapabilitiesV1(value);
}

export async function fetchReviewPackageV2(
  taskId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ReviewPackageV2Dto> {
  const value = await request<unknown>(
    `/api/v2/tasks/${encodeURIComponent(taskId)}/review-package`,
    { signal: options.signal },
  );
  const decoded = decodeReviewPackageV2(value);
  await assertReviewPackageProjectionIntegrity(decoded);
  if (decoded.task.id !== taskId) {
    throw new ReviewDtoDecodeError('review package task does not match the request');
  }
  return decoded;
}

/** Browser client bound to the stored bearer token and window.fetch; throws ApiError(401) when no token is stored. */
export function controlApiV2BrowserClient(): ControlApiV2BrowserClient {
  const token = getToken();
  if (token === null || token.length === 0) {
    throw new ApiError(401, 'unauthorized');
  }
  const fetchSeam: ControlApiV2BrowserFetch = async (path, init) => {
    let res: Response;
    try {
      const fetchInit: RequestInit = {
        method: init.method,
        headers: init.headers,
      };
      if (init.body !== undefined) fetchInit.body = init.body;
      if (init.signal !== undefined) fetchInit.signal = init.signal;
      res = await fetch(path, fetchInit);
    } catch (err) {
      throw new ApiError(0, humanizeNetworkError(err));
    }
    if (res.status === 401) {
      throw new ApiError(401, 'unauthorized');
    }
    if (res.status === 503) {
      throw new ApiError(503, 'provider_unavailable');
    }
    if (res.status >= 500) {
      const body = (await res.json().catch(() => ({}))) as {
        reason?: string;
        error?: string;
      };
      throw new ApiError(
        res.status,
        body.reason ?? body.error ?? `${res.status} ${res.statusText}`,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(res.status, 'invalid response');
    }
    return {
      status: res.status,
      json: async () => json,
    };
  };
  return createControlApiV2BrowserClient({ token, fetch: fetchSeam });
}

export interface ControlApiV2ReviewRead {
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly package: ReviewPackageV2Dto;
}

/** GET /api/v2/control/tasks/:id/review through the browser client. 200 review view → unwrap (package task id must equal taskId, else ReviewDtoDecodeError). 404 unknown_aggregate → throw ApiError(404, 'unknown_aggregate'). 503 → ApiError(503, 'provider_unavailable'). 401 → ApiError(401). Any other refusal → ApiError(status, reason). Client parse errors → ApiError(0, message) for webcrypto_unavailable, otherwise rethrow. */
export async function fetchControlApiV2Review(
  taskId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ControlApiV2ReviewRead> {
  try {
    const client = controlApiV2BrowserClient();
    const callOptions =
      options.signal !== undefined ? { signal: options.signal } : undefined;
    const result = await client.readReview(
      { aggregateId: taskId, issuedAt: new Date().toISOString() },
      callOptions,
    );
    if (
      result.status === 200 &&
      result.body.schema === 'hercules-control-api-review-view/v2'
    ) {
      if (result.body.reviewPackage.task.id !== taskId) {
        throw new ReviewDtoDecodeError(
          'review package task does not match the request',
        );
      }
      return {
        aggregateId: result.body.aggregateId,
        stateVersion: result.body.stateVersion,
        package: result.body.reviewPackage,
      };
    }
    const reason =
      result.body.schema === 'hercules-control-api-refusal/v2' ||
      result.body.schema === 'hercules-control-api-receipt/v2'
        ? result.body.reason
        : null;
    if (result.status === 404 || reason === 'unknown_aggregate') {
      throw new ApiError(404, 'unknown_aggregate');
    }
    throw new ApiError(
      result.status,
      typeof reason === 'string' ? reason : 'invalid_response',
    );
  } catch (error) {
    if (error instanceof ApiError || error instanceof ReviewDtoDecodeError) {
      throw error;
    }
    if (error instanceof ControlApiV2BrowserError) {
      if (error.code === 'webcrypto_unavailable') {
        throw new ApiError(0, error.message);
      }
      throw error;
    }
    throw error;
  }
}

export async function fetchReviewEvidence(
  taskId: string,
  projectionHash: string,
  evidence: EvidenceSummaryDto,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ReviewEvidenceContentDto> {
  const value = await request<unknown>(
    `/api/v2/tasks/${encodeURIComponent(taskId)}/review-evidence`,
    {
      method: 'POST',
      body: JSON.stringify({
        schema: 'hercules-review-evidence-read/v1',
        taskId,
        projectionHash,
        artifactRefId: evidence.artifactRefId,
      }),
      signal: options.signal,
    },
  );
  return decodeReviewEvidenceContentV1(value, { evidence, taskId, projectionHash });
}

export async function fetchLearningProposals(
  taskId: string,
  projectionHash: string,
  evidenceArtifactIds: ReadonlySet<string>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<readonly LearningProposalViewDto[]> {
  const value = await request<unknown>(
    `/api/v2/tasks/${encodeURIComponent(taskId)}/learning-proposals?projectionHash=${encodeURIComponent(projectionHash)}`,
    { signal: options.signal },
  );
  return decodeLearningProposalViewsV1(value, {
    taskId,
    projectionHash,
    evidenceArtifactIds,
  });
}

export async function fetchReviewEvidenceImage(
  path: string,
  mediaType: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<string> {
  const parsed = new URL(path, 'https://hercules.invalid');
  const segments = path.split('/');
  if (
    !/^\/api\/v2\/tasks\/[A-Za-z0-9._-]+\/review-evidence\/[A-Za-z0-9._-]+\/content\/sha256%3A[0-9a-f]{64}$/.test(path) ||
    path.includes('\\') ||
    segments.includes('.') ||
    segments.includes('..') ||
    parsed.origin !== 'https://hercules.invalid' ||
    parsed.pathname !== path ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new ReviewDtoDecodeError('review evidence image path is invalid');
  }
  let response: Response;
  try {
    response = await fetch(path, { headers: authHeaders(), signal: options.signal });
  } catch (error) {
    throw new ApiError(0, humanizeNetworkError(error));
  }
  if (!response.ok) {
    throw new ApiError(response.status, `Failed to load evidence image (${response.status})`);
  }
  if (response.headers.get('content-type')?.split(';', 1)[0] !== mediaType) {
    throw new ReviewDtoDecodeError('review evidence image media type is invalid');
  }
  return URL.createObjectURL(await response.blob());
}

export function newReviewDecisionRequestId(): string | null {
  try {
    return typeof globalThis.crypto?.randomUUID === 'function'
      ? `review-${globalThis.crypto.randomUUID()}`
      : null;
  } catch {
    return null;
  }
}

export async function submitReviewDecision(
  decisionRequest: ReviewDecisionRequestDto,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ReviewDecisionResponseDto> {
  const value = await request<unknown>(
    `/api/v2/tasks/${encodeURIComponent(decisionRequest.taskId)}/review-decisions`,
    {
      method: 'POST',
      body: JSON.stringify(decisionRequest),
      signal: options.signal,
    },
  );
  const response = decodeReviewDecisionResponseV1(value);
  const receipt = response.receipt;
  const { receiptHash: _receiptHash, ...receiptBody } = receipt;
  const [requestHash, bindingHash, receiptHash] = await Promise.all([
    reviewCanonicalHash(decisionRequest),
    reviewCanonicalHash(decisionRequest.decisionBinding),
    reviewCanonicalHash(receiptBody),
  ]);
  const priorIterationId = decisionRequest.decisionBinding.iterationId;
  if (
    priorIterationId === null ||
    receipt.clientRequestId !== decisionRequest.clientRequestId ||
    receipt.requestHash !== requestHash ||
    receipt.taskId !== decisionRequest.taskId ||
    receipt.acceptedProjectionHash !== decisionRequest.projectionHash ||
    receipt.acceptedDecisionBindingHash !== bindingHash ||
    receipt.action !== decisionRequest.action ||
    receipt.priorIterationId !== priorIterationId ||
    receipt.receiptHash !== receiptHash ||
    (decisionRequest.action === 'request_changes'
      ? receipt.resultingIterationId === priorIterationId
      : receipt.resultingIterationId !== priorIterationId)
  ) throw new ReviewDtoDecodeError('review decision receipt does not match the request');
  return response;
}

export const fetchState = (): Promise<StateDto> => request<StateDto>('/api/state');

export type SelfUpdatePhase = 'idle' | 'running' | 'ok' | 'failed';
export type SelfUpdateStep = 'pull' | 'install' | 'build' | 'restart' | null;

export interface SelfUpdateStatus {
  phase: SelfUpdatePhase;
  enabled: boolean;
  step: SelfUpdateStep;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  log: string[];
}

/** Current self-update pipeline status (Settings deploy). */
export const fetchSelfUpdateStatus = (): Promise<SelfUpdateStatus> =>
  request<SelfUpdateStatus>('/api/system/update');

/**
 * Start pull → install → build → restart. Requires confirm:true on the wire.
 * Returns 202 Accepted while the job runs (daemon may die on restart).
 */
export const startSelfUpdate = (): Promise<SelfUpdateStatus> =>
  request<SelfUpdateStatus>('/api/system/update', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });

/** Fetch an authenticated binary resource (e.g. a screenshot) as an object URL. */
export async function fetchBlobUrl(path: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(path, { headers: authHeaders() });
  } catch (err) {
    throw new ApiError(0, humanizeNetworkError(err));
  }
  if (!res.ok) throw new ApiError(res.status, `Failed to load ${path} (${res.status})`);
  // A partial body would render as a truncated image / unseekable video —
  // fail closed instead of showing incomplete evidence (Codex R11 B1).
  if (res.status === 206) {
    throw new ApiError(206, `Failed to load ${path} (partial content refused)`);
  }
  return URL.createObjectURL(await res.blob());
}

export const draftFromIntent = (
  intent: string,
  repo: string,
): Promise<IntentDraftResponse> =>
  request<IntentDraftResponse>('/api/tasks/draft-from-intent', {
    method: 'POST',
    body: JSON.stringify({ intent, repo }),
  });

export const fetchDraftJob = (id: string): Promise<{ job: DraftJobDto }> =>
  request<{ job: DraftJobDto }>(`/api/draft-jobs/${encodeURIComponent(id)}`);

export const ackDraftJob = (id: string): Promise<{ ok: true }> =>
  request<{ ok: true }>(`/api/draft-jobs/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

/** Pure AC lint of a task body (creation-time advisory). */
export const lintAcceptance = (body: string): Promise<AcLintReport> =>
  request<AcLintReport>('/api/tasks/lint-acceptance', {
    method: 'POST',
    body: JSON.stringify({ body }),
  });

export const approvePlan = (id: string): Promise<Task> =>
  request<Task>(`/api/tasks/${encodeURIComponent(id)}/approve-plan`, { method: 'POST' });

/** Human authorizes host_operation / deploy with bounded named command scope. */
export const approveHostOperation = (
  id: string,
  commandScope: readonly string[],
): Promise<Task> =>
  request<Task>(`/api/tasks/${encodeURIComponent(id)}/approve-host-operation`, {
    method: 'POST',
    body: JSON.stringify({ commandScope }),
  });

/** Files a task changed at its verified sha (phone review browse list). */
export const fetchTaskFiles = (id: string): Promise<{ sha: string; files: string[] }> =>
  request<{ sha: string; files: string[] }>(`/api/tasks/${encodeURIComponent(id)}/files`);

/** One produced file's content at the verified sha (trusted mirror, read-only). */
export const fetchTaskFile = (
  id: string,
  path: string,
): Promise<{ path: string; sha: string; content: string; truncated: boolean }> =>
  request<{ path: string; sha: string; content: string; truncated: boolean }>(
    `/api/tasks/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
  );

/** Documentation paths on a repo's trusted mirror default branch. */
export const fetchRepoDocs = (
  key: string,
): Promise<{ branch: string; files: string[] }> =>
  request<{ branch: string; files: string[] }>(
    `/api/repos/${encodeURIComponent(key)}/docs`,
  );

/** One documentation file at the mirror default branch (read-only). */
export const fetchRepoDoc = (
  key: string,
  path: string,
): Promise<{ path: string; branch: string; content: string; truncated: boolean }> =>
  request<{ path: string; branch: string; content: string; truncated: boolean }>(
    `/api/repos/${encodeURIComponent(key)}/doc?path=${encodeURIComponent(path)}`,
  );

export const reverifyTask = (id: string): Promise<Task> =>
  request<Task>(`/api/tasks/${encodeURIComponent(id)}/reverify`, { method: 'POST' });

/** Push a queued task to the front of the dispatch queue. */
export const moveTaskToQueueFront = (id: string): Promise<Task> =>
  request<Task>(`/api/tasks/${encodeURIComponent(id)}/queue-front`, {
    method: 'POST',
  });

/**
 * Explicit clean-salvage fork from a terminal failed or cancelled task.
 * Creates a new task stamped at the preserved source tip (branch on provision).
 */
export const salvageForkTask = (
  sourceId: string,
  input?: {
    id?: string;
    title?: string;
    body?: string;
    priority?: number;
    labels?: readonly string[];
    adapter?: AdapterKind | null;
  },
): Promise<Task> =>
  request<Task>(`/api/tasks/${encodeURIComponent(sourceId)}/salvage-fork`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  });

export const createTask = (input: {
  title: string;
  repo: string;
  body?: string;
  slug?: string;
  priority?: number;
  adapter?: AdapterKind | null;
  executionClass?: ExecutionClass | null;
  planPending?: boolean;
  labels?: string[];
  /** Operator override when body names a protected path (audit-stamped). */
  force?: boolean;
  /** Exact candidate ownership and reviewed path scope are sent atomically. */
  expectedBaseRevision?: string;
  expectedRemoteTip?: string;
  plannedBaseRevision?: string;
  affectedPaths?: readonly string[];
  protectedPathsSnapshot?: readonly string[];
}): Promise<Task> => request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(input) });

/** Linear multi-agent pipeline → N tasks with blocked_by + per-stage adapter. */
export const createPipeline = (input: {
  title: string;
  repo: string;
  stages: readonly {
    title: string;
    body?: string;
    adapter?: AdapterKind | null;
    labels?: readonly string[];
  }[];
  priority?: number;
  idPrefix?: string;
}): Promise<Task[]> =>
  request<Task[]>('/api/pipelines', { method: 'POST', body: JSON.stringify(input) });

/**
 * Set or clear per-task agent (null = inherit).
 * Default: applies on next dispatch. `switchNow: true` stops a live run and
 * re-queues as retrying with the new agent (session cleared).
 */
export const setTaskAdapter = (
  id: string,
  adapter: AdapterKind | null,
  opts?: { switchNow?: boolean },
): Promise<Task> =>
  request<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      adapter,
      ...(opts?.switchNow ? { switchNow: true } : {}),
    }),
  });

export interface DependencyRewireChange {
  id: string;
  expectedBlockedBy: string[];
  blockedBy: string[];
  dependencyMode: 'gate_merge' | 'completion_only';
}

export const rewireDependencies = (
  changes: readonly DependencyRewireChange[],
): Promise<{ committed: boolean; hash?: string; taskIds: string[] }> =>
  request('/api/tasks/dependencies/rewire', {
    method: 'POST',
    body: JSON.stringify({ changes }),
  });

export const act = (
  id: string,
  action: 'approve' | 'reject' | 'cancel' | 'retry',
  opts?: { humanAcknowledged?: readonly string[]; overrideNote?: string },
): Promise<Task> =>
  request<Task>(`/api/tasks/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    ...(action === 'approve'
      ? {
          body: JSON.stringify({
            humanAcknowledged: opts?.humanAcknowledged ?? [],
            ...(opts?.overrideNote ? { overrideNote: opts.overrideNote } : {}),
          }),
        }
      : {}),
  });

/** Comment-to-steer: re-queue review/failed/done with a follow-up (session resume). */
export const steerTask = (id: string, comment: string): Promise<Task> =>
  request<Task>(`/api/tasks/${encodeURIComponent(id)}/steer`, {
    method: 'POST',
    body: JSON.stringify({ comment }),
  });

/** Preview PR comments as a steer draft (no mutation). */
export const previewPrComments = (
  id: string,
): Promise<{ draft: string; commentCount: number }> =>
  request(`/api/tasks/${encodeURIComponent(id)}/pr-comments`);

/** Pull PR comments and queue a steer turn (updates same open PR after push). */
export const steerFromPr = (
  id: string,
): Promise<{ task: Task; commentCount: number; draft: string }> =>
  request(`/api/tasks/${encodeURIComponent(id)}/steer-from-pr`, { method: 'POST' });

/**
 * Remote Control chat on a task (steer / pending / live queue / duplicate).
 * Response shape varies by mode. Pass a stable clientMessageId per user
 * submission so network retries do not double-deliver.
 */
export const chatTask = (
  id: string,
  message: string,
  opts?: { readonly clientMessageId?: string },
): Promise<
  | { mode: 'steer' | 'pending'; task: Task }
  | { mode: 'queued'; queued: string[]; task: Task }
  | {
      mode: 'duplicate';
      task: Task;
      reason?: string;
      priorMode?: string;
      queued?: string[];
    }
> =>
  request(`/api/tasks/${encodeURIComponent(id)}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      ...(opts?.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
    }),
  });

/** Stable per-submission id for chat idempotency (phone retry / double-tap). */
export function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cmsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const startSession = (input: {
  repo: string;
  message: string;
  title?: string;
  adapter?: AdapterKind | null;
  permissionMode?: PermissionMode;
}): Promise<RemoteSession> =>
  request<RemoteSession>('/api/sessions', { method: 'POST', body: JSON.stringify(input) });

export const fetchSession = (id: string): Promise<RemoteSession> =>
  request<RemoteSession>(`/api/sessions/${encodeURIComponent(id)}`);

/**
 * ACP free sessions return from POST while the agent is still prompting
 * (fire-and-forget runAcpPrompt). Poll until idle/failed so the client can
 * read the assistant reply and run phone tool follow-ups.
 */
export async function waitForSessionSettled(
  id: string,
  opts?: { readonly timeoutMs?: number; readonly intervalMs?: number },
): Promise<RemoteSession> {
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const intervalMs = opts?.intervalMs ?? 700;
  const started = Date.now();
  let last = await fetchSession(id);
  while (last.status === 'running' && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fetchSession(id);
  }
  return last;
}

export const sendSessionMessage = (
  id: string,
  message: string,
  opts?: {
    interrupt?: boolean;
    attachments?: readonly ChatAttachment[];
    refs?: readonly MessageRef[];
  },
): Promise<RemoteSession> =>
  request<RemoteSession>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      ...(opts?.interrupt ? { interrupt: true } : {}),
      ...(opts?.attachments && opts.attachments.length > 0
        ? { attachments: opts.attachments }
        : {}),
      ...(opts?.refs && opts.refs.length > 0 ? { refs: opts.refs } : {}),
    }),
  });

/** Open/reuse Session UI bound to a control-repo task. */
export const openTaskLiveSession = (taskId: string): Promise<RemoteSession> =>
  request<RemoteSession>(`/api/tasks/${encodeURIComponent(taskId)}/live-session`, {
    method: 'POST',
  });

export const uploadSessionAttachment = async (
  sessionId: string,
  file: File,
): Promise<ChatAttachment> => {
  const token = getToken();
  if (!token) throw new ApiError(401, 'not authenticated');
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as ChatAttachment;
};

export interface SttStatus {
  configured: boolean;
  provider: string;
  hint: string;
}

export interface SttResult {
  text: string;
  duration?: number;
  language?: string;
}

/** Whether server Grok STT is configured (XAI_API_KEY). */
export const fetchSttStatus = (): Promise<SttStatus> => request<SttStatus>('/api/stt');

export interface VoiceSessionMint {
  success: boolean;
  clientSecret: string;
  expiresInSeconds: number;
  model: string;
  wsUrl: string;
  maxSessionSeconds: number;
  error?: string;
}

export interface VoiceStatus {
  configured: boolean;
  provider: string;
  hint: string;
}

export const fetchVoiceStatus = (): Promise<VoiceStatus> => request<VoiceStatus>('/api/voice/session');

export interface VoiceAvatarInfo {
  ready: boolean;
  weekKey: string;
  name: string;
  generatedAt?: string;
  model?: string;
  cached?: boolean;
  /** Prefer this path — includes cache-bust query when available. */
  imagePath?: string;
  error?: string;
  fallback?: string;
}

/** Ensure/fetch this week's AI avatar metadata (triggers Grok Imagine if missing). */
export const fetchVoiceAvatarInfo = (opts?: { force?: boolean }): Promise<VoiceAvatarInfo> =>
  request<VoiceAvatarInfo>(`/api/voice/avatar${opts?.force ? '?force=1' : ''}`);

/**
 * Authenticated PNG/JPEG for the voice avatar as an object URL.
 * Pass `imagePath` from meta (includes ?t= cache bust) when available.
 * Call revokeObjectURL when done (component unmount).
 */
export async function fetchVoiceAvatarObjectUrl(opts?: {
  weekKey?: string;
  imagePath?: string;
  generatedAt?: string;
}): Promise<string> {
  if (opts?.imagePath && opts.imagePath.startsWith('/api/')) {
    return fetchBlobUrl(opts.imagePath);
  }
  const params = new URLSearchParams();
  if (opts?.weekKey) params.set('w', opts.weekKey);
  if (opts?.generatedAt) params.set('t', opts.generatedAt);
  const q = params.toString() ? `?${params.toString()}` : '';
  return fetchBlobUrl(`/api/voice/avatar/image${q}`);
}

/** Mint ephemeral Grok Realtime client secret (server holds the real key). */
export const mintVoiceSession = async (): Promise<VoiceSessionMint> => {
  const token = getToken();
  if (!token) throw new ApiError(401, 'not authenticated');
  let res: Response;
  try {
    res = await fetch('/api/voice/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
  } catch (err) {
    throw new ApiError(0, humanizeNetworkError(err));
  }
  const data = (await res.json().catch(() => ({}))) as VoiceSessionMint & { error?: string };
  if (!res.ok || !data.success || !data.clientSecret) {
    throw new ApiError(res.status, data.error ?? 'Voice session mint failed');
  }
  return data;
};

/**
 * Transcribe a short voice clip via Grok STT (server-proxied).
 * Prefer audio/wav from voiceCapture.
 */
export const transcribeVoice = async (
  file: Blob,
  opts?: { language?: string; filename?: string },
): Promise<SttResult> => {
  const token = getToken();
  if (!token) throw new ApiError(401, 'not authenticated');
  const form = new FormData();
  if (opts?.language) form.append('language', opts.language);
  form.append('file', file, opts?.filename ?? 'voice.wav');
  const res = await fetch('/api/stt', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as SttResult;
};

export const fetchSessionDiff = (id: string): Promise<SessionDiff> =>
  request<SessionDiff>(`/api/sessions/${encodeURIComponent(id)}/diff`);

export const setSessionPermissionMode = (
  id: string,
  permissionMode: PermissionMode,
): Promise<RemoteSession> =>
  request<RemoteSession>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ permissionMode }),
  });

export const resolveSessionPermission = (
  id: string,
  permissionId: string,
  optionId: string,
): Promise<RemoteSession> =>
  request<RemoteSession>(
    `/api/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`,
    { method: 'POST', body: JSON.stringify({ optionId }) },
  );

export const stopSession = (id: string): Promise<RemoteSession> =>
  request<RemoteSession>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' });

export const closeSession = (id: string): Promise<{ closed: string }> =>
  request<{ closed: string }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const fetchSessionTaskDraft = (
  id: string,
): Promise<{ title: string; body: string; repo: string }> =>
  request(`/api/sessions/${encodeURIComponent(id)}/task-draft`);

/** Human-confirmed: create a control-repo task from this chat. */
export const createTaskFromSession = (
  id: string,
  input: {
    title: string;
    repo: string;
    body: string;
    adapter?: AdapterKind | null;
    confirm: true;
  },
): Promise<{ task: Task; session: RemoteSession }> =>
  request(`/api/sessions/${encodeURIComponent(id)}/tasks`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

/** Approve agent-suggested task proposal. */
export const approveSessionProposal = (
  sessionId: string,
  proposalId: string,
  patch?: { title?: string; repo?: string; body?: string; priority?: number },
): Promise<{ task: Task; session: RemoteSession }> =>
  request(
    `/api/sessions/${encodeURIComponent(sessionId)}/proposals/${encodeURIComponent(proposalId)}/approve`,
    { method: 'POST', body: JSON.stringify(patch ?? {}) },
  );

export const dismissSessionProposal = (
  sessionId: string,
  proposalId: string,
): Promise<RemoteSession> =>
  request(
    `/api/sessions/${encodeURIComponent(sessionId)}/proposals/${encodeURIComponent(proposalId)}/dismiss`,
    { method: 'POST', body: '{}' },
  );

export interface OpenPrResult {
  url: string;
  /** Prefer for phone: login?return_to=… (private-repo safe). */
  openUrl?: string;
  mode: 'created' | 'existing' | 'compare';
  branch: string;
  base: string;
  repo: string;
}

export interface PrSummary {
  prUrl: string;
  state: string;
  mergeable: string | null;
  reviewDecision: string | null;
  ciStatus: 'success' | 'failure' | 'pending' | 'neutral' | 'unknown';
  ciSummary: string;
  commentCount: number;
  reviewCount: number;
  title: string | null;
}

/** Live CI + comments/reviews for a task's GitHub PR. */
export const fetchPrSummary = (id: string): Promise<PrSummary> =>
  request<PrSummary>(`/api/tasks/${encodeURIComponent(id)}/pr-summary`);

/** Open or create a GitHub PR for the task branch. */
export const openPr = (id: string): Promise<OpenPrResult> =>
  request<OpenPrResult>(`/api/tasks/${encodeURIComponent(id)}/pr`, { method: 'POST' });

/** Approve then open/create a PR (one phone tap). */
export const approveAndOpenPr = (
  id: string,
  opts?: { humanAcknowledged?: readonly string[] },
): Promise<{ task: Task; pr: OpenPrResult }> =>
  request<{ task: Task; pr: OpenPrResult }>(`/api/tasks/${encodeURIComponent(id)}/approve-pr`, {
    method: 'POST',
    body: JSON.stringify({
      humanAcknowledged: opts?.humanAcknowledged ?? [],
    }),
  });

export const forceAbort = (id: string): Promise<{ aborting: string }> =>
  request<{ aborting: string }>(`/api/tasks/${encodeURIComponent(id)}/force-abort`, { method: 'POST' });

/** Delete task. cleanup defaults true (close PR, purge branch/worktree/screenshots). */
export const deleteTask = (
  id: string,
  opts?: { cleanup?: boolean },
): Promise<{ deleted: string; cleanup: boolean; notes: string[] }> =>
  request<{ deleted: string; cleanup: boolean; notes: string[] }>(
    `/api/tasks/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ cleanup: opts?.cleanup !== false }),
    },
  );

export const patchSession = (
  id: string,
  patch: { pinned?: boolean; archived?: boolean },
): Promise<RemoteSession> =>
  request<RemoteSession>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const addRepo = (input: {
  key: string;
  url: string;
  defaultBranch: string;
  workflow?: string;
  maxConcurrent?: number;
  adapter?: AdapterKind | null;
  readiness?: 'ready' | 'incomplete';
  executionPolicy?: { profile: 'compatible' | 'guardian' } | null;
  autoMerge?: { enabled: boolean; dwellMinutes: number; maxSize: 'S' | 'M' | 'L' } | null;
}): Promise<RepoDto> => request<RepoDto>('/api/repos', { method: 'POST', body: JSON.stringify(input) });

export const editRepo = (
  key: string,
  patch: {
    url?: string;
    defaultBranch?: string;
    workflow?: string;
    maxConcurrent?: number;
    adapter?: AdapterKind | null;
    /** ready | incomplete — incomplete only runs onboarding/readiness tasks. */
    readiness?: 'ready' | 'incomplete';
    /** Skip soft WORKFLOW/AGENTS check when marking ready. */
    forceReady?: boolean;
    executionPolicy?: { profile: 'compatible' | 'guardian' } | null;
    autoMerge?: { enabled: boolean; dwellMinutes: number; maxSize: 'S' | 'M' | 'L' } | null;
  },
): Promise<RepoDto> =>
  request<RepoDto>(`/api/repos/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(patch) });

export interface ReadinessCheckDto {
  ok: boolean;
  softOk?: boolean;
  summary: string;
  /** Checklist score — does not flip repos.yaml readiness. */
  score: {
    passed: number;
    total: number;
    requiredPassed: number;
    requiredTotal: number;
  };
  checks: readonly {
    id: string;
    ok: boolean;
    label: string;
    detail: string;
    /** Optional items (e.g. boot) do not fail overall ok when false. */
    required: boolean;
  }[];
  /** Guardian B-022 hard-gate receipt (applicable:false for non-guardian). */
  guardian?: {
    version: number;
    applicable: boolean;
    ok: boolean;
    profile: string;
    summary: string;
    failedCodes: readonly string[];
    grantsOnly: 'harness_readiness';
    provenance: {
      defaultRevision: string | null;
      workflowSha256: string | null;
      policySha256: string;
    };
    controls: readonly {
      id: string;
      ok: boolean;
      code: string;
      label: string;
      detail: string;
      remediation: string | null;
    }[];
  };
}

export type ReadinessJobStatus = 'idle' | 'running' | 'done' | 'error';

/** GET /api/repos/:key/readiness-check — immediate job poll (never blocks). */
export interface ReadinessJobDto {
  key: string;
  status: ReadinessJobStatus;
  startedAt?: string;
  finishedAt?: string;
  result?: ReadinessCheckDto;
  error?: string;
}

/** POST /api/repos/:key/readiness-check → 202. */
export interface ReadinessJobStartDto {
  key: string;
  status: 'running';
  startedAt: string;
}

/** Start (or attach to) a background readiness check. */
export const startRepoReadinessCheck = (
  key: string,
  opts: { retryCliEvidence?: boolean } = {},
): Promise<ReadinessJobStartDto> => {
  const q = opts.retryCliEvidence ? '?retry_cli=1' : '';
  return request<ReadinessJobStartDto>(
    `/api/repos/${encodeURIComponent(key)}/readiness-check${q}`,
    {
      method: 'POST',
      body: JSON.stringify(
        opts.retryCliEvidence ? { retryCliEvidence: true } : {},
      ),
    },
  );
};

/** Poll readiness job status + last completed result. */
export const fetchRepoReadinessCheck = (
  key: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<ReadinessJobDto> =>
  request<ReadinessJobDto>(
    `/api/repos/${encodeURIComponent(key)}/readiness-check`,
    options.signal !== undefined ? { signal: options.signal } : {},
  );

/**
 * Soft readiness checklist against default branch (WORKFLOW + AGENTS).
 * Starts a background job and polls until done/error (or timeout).
 */
export const checkRepoReadiness = async (
  key: string,
  opts: {
    retryCliEvidence?: boolean;
    /** Max wait ms (default 15 min). Polling continues via fetchRepoReadinessCheck. */
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ReadinessCheckDto> => {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pollMs = opts.pollMs ?? 3_000;
  await startRepoReadinessCheck(key, {
    ...(opts.retryCliEvidence ? { retryCliEvidence: true } : {}),
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) {
      throw new ApiError(0, 'Request cancelled');
    }
    const job = await fetchRepoReadinessCheck(key);
    if (job.status === 'done' && job.result) return job.result;
    if (job.status === 'error') {
      throw new ApiError(0, job.error ?? 'Readiness check failed');
    }
    if (Date.now() >= deadline) {
      throw new ApiError(
        0,
        'Readiness check still running after 15 minutes — see status under the repo',
      );
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, pollMs);
      if (!opts.signal) return;
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new ApiError(0, 'Request cancelled'));
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
};

export const removeRepo = (key: string): Promise<{ removed: string }> =>
  request<{ removed: string }>(`/api/repos/${encodeURIComponent(key)}`, { method: 'DELETE' });

/** Phone Releases panel row (GET /api/releases). */
export interface ReleasePanelEntryDto {
  repoKey: string;
  productionSha: string | null;
  productionDeployedAt: string | null;
  stagingSha: string | null;
  stagingStatus: 'deploying' | 'verifying' | 'ready' | 'failed' | null;
  stagingVerifiedAt: string | null;
  /** ISO when current deploying/verifying cycle began; null when idle. */
  stagingStartedAt?: string | null;
  /** Overall staging verify budget (ms) for abnormal elapsed UI. */
  stagingVerifyTimeoutMs?: number;
  promotingSha: string | null;
  /** Boot-finalization failure (sha + reason + at) when present. */
  lastPromoteFailure?: {
    sha: string;
    reason: string;
    at: string;
    bootedSha?: string | null;
  } | null;
  mainSha: string | null;
  stagingDrift: boolean;
  canPromote: boolean;
  canRollback: boolean;
  rollbackTargetSha: string | null;
  stagingUrl: string | null;
  hasProductionDeploy: boolean;
  aheadTasks: {
    id: string;
    title: string;
    mergedSha: string;
    area: string | null;
    size: 'S' | 'M' | 'L';
    mergedVia: 'gate' | 'operator';
    /** False for operator-salvaged tasks that never passed machine verification. */
    verified?: boolean;
  }[];
  aheadCount: number;
  /** Range commits with no task provenance (operator pushes), newest first. */
  directCommits?: { sha: string; subject: string }[];
  /** Top-of-card digest: per-area counts + largest changes' titles. */
  digest?: {
    areaCounts: { area: string | null; count: number }[];
    headlines: string[];
  };
  mergeableTasks: {
    id: string;
    title: string;
    verifiedSha: string | null;
    deliveryPipeline?: {
      verification: string;
      mergeEligibility: string;
      projectStateClosure: string;
      deployment: string;
    };
  }[];
  /** Trusted WORKFLOW declared project_state_closure (opt-in). */
  hasProjectStateClosure?: boolean;
  packetBody: string;
  failureReason: string | null;
  history: {
    sha: string;
    at: string;
    outcome: 'ok' | 'rolled_back';
    rollbackOf?: string;
  }[];
  /** Trust-chain statement for the promote card. */
  trustChain: string;
  operatorMergedCount: number;
  rangeRisk: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    size: 'S' | 'M' | 'L';
    areas: { area: string; count: number }[];
    sensitivePaths: string[];
  } | null;
  evidenceCoverage: {
    passed: number;
    total: number;
    label: string;
    evidenceOk: boolean | null;
  } | null;
  stagingScreenshots: string[];
  rollbackPreview: {
    hasTarget: boolean;
    targetSha: string | null;
    deployedAt: string | null;
  };
  /** Staging UI token when daemon has STAGING_UI_TOKEN (Bearer-only; never in URL). */
  stagingUiToken: string | null;
  /** `(human, after deploy)` checks from the last promote; optional on older daemons. */
  afterDeployChecks?: { taskId: string; title: string; text: string }[];
}

/** Authenticated URL for a staging release screenshot (Bearer via img fetch is hard —
 *  use blob load with auth headers from the panel). */
export function releaseScreenshotPath(repoKey: string, name: string): string {
  return `/api/releases/${encodeURIComponent(repoKey)}/screenshots/${encodeURIComponent(name)}`;
}

export const fetchReleases = (): Promise<ReleasePanelEntryDto[]> =>
  request<{ releases: ReleasePanelEntryDto[] }>('/api/releases').then((r) => r.releases);

export interface WorkspaceSuccessionDto {
  id: string;
  repoKey: string;
  createdAt: string;
  priorDefaultRevision: string;
  gateMergeSha: string;
  canonicalDefaultRevision: string;
  classifications: {
    registrationId: string;
    classification: string;
    concurrentChange: boolean;
    guidance: { code: string; text: string; destructive: false }[];
  }[];
  managed: { taskId: string; disposition: string }[];
  supersedesReceiptId: string | null;
  receiptCount: number;
  offersDestructiveAction: false;
}

export const fetchWorkspaceSuccession = (
  repoKey: string,
): Promise<WorkspaceSuccessionDto | null> =>
  request<{ succession: WorkspaceSuccessionDto | null }>(
    `/api/repos/${encodeURIComponent(repoKey)}/succession`,
  ).then((response) => response.succession);

export type MergeOperationStatusDto =
  | 'accepted' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export const mergeRepo = (
  key: string,
  taskIds: readonly string[],
  idempotencyKey?: string,
): Promise<{
  operationId: string;
  status: MergeOperationStatusDto;
  phase: string;
  mergedSha: string | null;
  taskIds: string[];
  failures: { taskId: string; reason: string; kind?: string }[];
  failureKind: string | null;
  operationStatus?: string;
  mergeGateReceipt?: {
    operationStatus: string;
    failedGate: string;
    exitStatus: number | null;
    failureSummary: string;
    remoteDefaultBranchChanged: boolean;
    nextAction: string;
  };
}> =>
  request(`/api/repos/${encodeURIComponent(key)}/merge`, {
    method: 'POST',
    body: JSON.stringify({
      taskIds,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
  });

export const fetchMergeOperation = (operationId: string) =>
  request<{
    operationId: string;
    status: MergeOperationStatusDto;
    phase: string;
    mergedSha: string | null;
    taskIds: string[];
    failures: { taskId: string; reason: string; kind?: string }[];
    failureKind: string | null;
  }>(`/api/merge-operations/${encodeURIComponent(operationId)}`);

export const deployStagingNow = (key: string): Promise<{ accepted: true }> =>
  request(`/api/repos/${encodeURIComponent(key)}/deploy-staging`, { method: 'POST' });

/**
 * Staging auto-unlock: mint a one-time code (production, Bearer-authed). The
 * panel appends it to the staging link as a `#hsc=` fragment — the staging
 * SPA redeems it for its token, so the operator never pastes anything. The
 * real token never rides in a URL; fragments never reach servers or logs.
 */
export const mintStagingHandoff = (): Promise<{ code: string }> =>
  request('/api/staging-handoff/mint', { method: 'POST' });

/** Redeem side (staging origin, pre-auth — deliberately no Bearer header). */
export async function redeemStagingHandoff(code: string): Promise<string | null> {
  try {
    const res = await fetch('/api/staging-handoff/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return typeof body.token === 'string' && body.token !== '' ? body.token : null;
  } catch {
    return null;
  }
}

/** Extract a handoff code from a `#hsc=<code>` fragment, if present. */
export function handoffCodeFromHash(hash: string): string | null {
  const m = /[#&]hsc=([a-f0-9]{64})\b/.exec(hash);
  return m ? m[1]! : null;
}

export const promoteRepo = (
  key: string,
): Promise<{
  outcome: 'ok' | 'rolled_back';
  productionSha: string | null;
  alert: string | null;
}> => request(`/api/repos/${encodeURIComponent(key)}/promote`, { method: 'POST' });

export const rollbackRepo = (
  key: string,
): Promise<{
  outcome: 'ok' | 'rolled_back';
  productionSha: string | null;
  alert: string | null;
}> => request(`/api/repos/${encodeURIComponent(key)}/rollback`, { method: 'POST' });

/**
 * Subscribe to live state over SSE using fetch + a readable stream (not
 * EventSource), so the token travels in the Authorization header rather than the
 * URL. Reconnects with a short backoff until unsubscribed.
 * Optional `onDraft` receives `event: draft` frames (live analyst jobs).
 */
export function subscribeState(
  onState: (s: StateDto) => void,
  onUnauthorized?: () => void,
  onDraft?: (ev: DraftJobEvent) => void,
): () => void {
  const controller = new AbortController();
  let stopped = false;

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const res = await fetch('/api/events', {
          headers: authHeaders(),
          signal: controller.signal,
        });
        // A rejected token won't fix itself by reconnecting — surface it so the
        // app can drop back to the gate instead of looping on 401 forever.
        if (res.status === 401) {
          onUnauthorized?.();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        await readEventStream(res.body, onState, onDraft);
      } catch {
        if (stopped) return;
      }
      await new Promise((r) => setTimeout(r, 2000)); // backoff before reconnect
    }
  };

  void run();
  return () => {
    stopped = true;
    controller.abort();
  };
}

/**
 * Minimal SSE frame parser: dispatch JSON payloads of `event: state` and
 * `event: draft` frames. Malformed draft frames are ignored.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onState: (s: StateDto) => void,
  onDraft?: (ev: DraftJobEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        event = 'message';
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:') && event === 'state') {
        onState(JSON.parse(line.slice(5).trim()) as StateDto);
      } else if (line.startsWith('data:') && event === 'draft') {
        if (!onDraft) continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim()) as DraftJobEvent;
          onDraft(parsed);
        } catch {
          /* malformed draft frame — keep the stream alive */
        }
      }
    }
  }
}
