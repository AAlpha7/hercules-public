/**
 * Presentation layer — the HTTP/JSON + SSE API (SPEC §14).
 *
 * Mounted under /api. Authenticated (SPEC §10): every request needs the shared
 * token, presented ONLY via `Authorization: Bearer` — never a query param or
 * cookie (they leak to logs/history/Referer and are CSRF-exposed; the SSE
 * client uses fetch+stream, not EventSource, precisely so it can send the
 * header). See `presentedToken`. Do NOT re-add query/cookie auth. The UI MUST
 * NOT be exposed on the open internet — sit behind a private network / an authenticated
 * Tunnel (`HERCULES_BIND_HOST` can additionally pin the listen address).
 *
 * Transport is SSE for server→client live updates (simpler than WebSocket,
 * auto-reconnects, well-suited to mobile networks).
 */
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { constants as fsConstants } from 'node:fs';
import { open as openFile, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import {
  redactRemoteSessionProviderSession,
  redactTaskProviderSession,
  serializeState,
} from './view.js';
import { isValidIdentifier, type Task } from '../domain/task.js';
import { parseClientMessageIdInput } from '../domain/chatDelivery.js';
import { parseMergeIdempotencyKeyInput } from '../domain/mergeOperation.js';
import type { RepoConfig } from '../domain/repos.js';
import {
  ActionConflictError,
  ActionError,
  type ActionService,
  type CreateTaskInput,
  type AddRepoInput,
  type EditRepoPatch,
  type AmendPathLeaseInput,
} from '../orchestrator/actions.js';
import type { RuntimeView } from '../orchestrator/orchestrator.js';
import type { SessionManager } from '../sessions/manager.js';
import { SessionError } from '../sessions/manager.js';
import { isPermissionMode, isValidSessionId } from '../domain/session.js';
import { isAdapterKind } from '../domain/agents.js';
import { isSttConfigured, SttError, transcribeAudio } from './stt.js';
import { isVoiceConfigured, mintVoiceClientSecret, VoiceError } from './voice.js';
import {
  ensureWeeklyAvatar,
  isoWeekKey,
  readCachedAvatar,
  weekPersona,
} from './voiceAvatar.js';
import { SelfUpdateError, type SelfUpdateService } from './selfUpdate.js';
import { mintHandoffCode, redeemHandoffCode } from './stagingHandoff.js';
import { makeLatestWinsPump, type LatestWinsPump } from './ssePump.js';
import { createDraftJobs, type DraftJobs, type DraftJobEvent } from './draftJobs.js';
import type { AnalystActivityListener } from '../domain/analystActivity.js';
import { draftTaskFromIntent } from '../domain/intentDraft.js';
import { lintAcceptance } from '../domain/acceptanceLint.js';
import type { AnalystDraft } from '../orchestrator/analyst.js';
import {
  CLI_EVIDENCE_PACKET_AUTHORITY,
  extractCliEvidenceReceipt,
} from '../domain/cliEvidence.js';
import { cutReviewPacketInterior } from '../domain/runFinalize.js';
import type { RewireDependenciesInput } from '../orchestrator/actions.js';
import { ControlMutationConflictError } from '../orchestrator/gitControlPort.js';
import { openM7L2ReviewProvider } from '../isolation/m7L2ReviewProvider.js';
import {
  projectAndAssertReviewPackageV2,
  type ReviewPackageV2,
  type ReviewPackageV2Source,
  type SourceProjectedReviewPackageV2,
} from '../domain/reviewPackageV2.js';
import {
  parseReviewEvidenceReadRequestV1,
  snapshotReviewActorV1,
  snapshotReviewEvidencePortResultV1,
  REVIEW_EVIDENCE_MAX_TEXT_BYTES,
  type ReviewActorV1,
  type ReviewEvidencePortRequestV1,
  type ReviewEvidencePortResultV1,
} from '../domain/reviewEvidence.js';
import {
  snapshotLearningProposalViewsV1,
  type LearningProposalViewV1,
} from '../domain/learningProposalView.js';
import {
  assertReviewDecisionReceiptMatches,
  parseReviewDecisionRequestV1,
  reviewDecisionBindingHash,
  reviewDecisionIdempotencyKey,
  reviewDecisionRequestHash,
  snapshotReviewDecisionReceiptV1,
  type ReviewActorResolverV1,
  type ReviewDecisionApplyResultV1,
  type ReviewDecisionCommandV1,
  type ReviewDecisionPortV1,
  type ReviewDecisionReceiptV1,
  type ReviewDecisionRequestV1,
} from '../domain/reviewDecision.js';
import {
  assertControlApiV2RequestV1,
  buildControlApiV2EventReadRequest,
  buildControlApiV2ReadRequest,
  controlApiV2HttpStatusForResponse,
  ControlApiV2Error,
  type AdmissionVerdictV1,
  type ControlApiV2DecisionV1,
  type ControlApiV2MutatorPortV1,
  type ControlApiV2ReadsV1,
  type ControlApiV2ReaderPortV1,
  type ControlApiV2RequestV1,
  type ControlApiV2ResponseV1,
  type ControlEventReadPortV1,
} from '../domain/controlApiV2.js';
import { decideControlApiV2 } from '../controlapi/requestPolicy.js';
import type { DecisionEffectDriver } from '../control/decisionEffects.js';

export type {
  ReviewActorResolverV1,
  ReviewDecisionPortV1,
} from '../domain/reviewDecision.js';

export interface RuntimeSource {
  getState(): RuntimeView;
  subscribe(listener: (view: RuntimeView) => void): () => void;
  forceAbort(id: string): void;
  /**
   * Immediate cancel of live agent or in-flight verification (does not wait
   * for the next tick — cargo L1 can block the tick for hours).
   */
  requestCancel?(id: string): void;
  recoverReviewerProvider?(
    provider: import('../domain/agents.js').AdapterKind,
    input: { readonly mode: 'health_check' | 'operator' },
  ): Promise<{ readonly recovered: number }>;
  /** Queue Remote Control chat for a live task (optional). */
  queueTaskChat?(
    id: string,
    message: string,
    opts?: { readonly clientMessageId?: string | null },
  ):
    | readonly string[]
    | {
        readonly mode: 'queued' | 'duplicate';
        readonly queued: readonly string[];
        readonly reason?: string;
        readonly priorMode?: string;
      };
}

export type ReviewReadReason = 'source_unavailable' | 'integrity_unavailable';

export interface ReviewPackageV2SourceReadPort {
  read(taskId: string): Promise<
    | { readonly status: 'available'; readonly source: ReviewPackageV2Source }
    | { readonly status: 'not_found' }
    | { readonly status: 'unavailable'; readonly reason: ReviewReadReason }
  >;
}

/** One TCB object must own both fresh projection reads and decision CAS. */
export interface ReviewDecisionAuthorityV1
  extends ReviewPackageV2SourceReadPort, ReviewDecisionPortV1 {}

export interface ReviewEvidenceReadPort {
  isReady(): boolean;
  resolveActor(): Promise<ReviewActorV1 | null>;
  read(request: ReviewEvidencePortRequestV1): Promise<ReviewEvidencePortResultV1>;
}

export interface LearningProposalReadPort {
  isReady(): boolean;
  read(request: Readonly<{
    taskId: string;
    projectionHash: string;
  }>): Promise<
    | { readonly status: 'available'; readonly proposals: readonly LearningProposalViewV1[] }
    | { readonly status: 'not_found' }
    | { readonly status: 'unavailable'; readonly reason: ReviewReadReason }
  >;
}

export interface ApiDeps {
  readonly runtime: RuntimeSource;
  readonly actions: ActionService;
  /** Shared secret required on every request. */
  readonly token: string;
  /** Persistent root of behavioral evidence screenshots (SPEC §9.6). */
  readonly screenshotsRoot?: string;
  /**
   * Staging release evidence screenshots (`…/screenshots/releases`).
   * Served only over Bearer auth; path-confined under this root.
   */
  readonly releaseScreenshotsRoot?: string;
  /** Free Remote Control sessions (optional). */
  readonly sessions?: SessionManager;
  /** Work dir for weekly voice avatars, session files, etc. */
  readonly workRoot?: string;
  /**
   * Phone Settings → pull + build + restart. Optional so pure API tests stay
   * free of side effects; production wires `createSelfUpdateService()`.
   */
  readonly selfUpdate?: SelfUpdateService;
  /**
   * Staging auto-unlock handoff. Production sets `mintFile` only (can create
   * codes, never answers redeems); staging sets `redeemFile` only (exchanges
   * a valid code for its own token). See src/server/stagingHandoff.ts.
   */
  /** Read files a task changed, from the trusted mirror at its verified sha. */
  readonly taskFiles?: {
    list(repo: RepoConfig, sha: string): Promise<readonly string[]>;
    read(repo: RepoConfig, sha: string, path: string): Promise<string | null>;
  };
  /**
   * Browse repo documentation (README / docs/**\/*.md) from the trusted
   * mirror default branch — offline, read-only phone Repos panel.
   */
  readonly repoDocs?: {
    list(repo: RepoConfig): Promise<readonly string[]>;
    read(repo: RepoConfig, path: string): Promise<string | null>;
  };
  readonly stagingHandoff?: {
    readonly mintFile?: string;
    readonly redeemFile?: string;
  };
  /** Optional M6 metadata-only source adapter; production is intentionally unwired. */
  readonly reviewPackageV2?: ReviewPackageV2SourceReadPort;
  /** Optional M7 trusted evidence boundary; production is intentionally unwired. */
  readonly reviewEvidence?: ReviewEvidenceReadPort;
  /** Optional M7 advisory learning read model; production is intentionally unwired. */
  readonly learningProposals?: LearningProposalReadPort;
  /** Optional M7 trusted human principal resolver; production is intentionally unwired. */
  readonly reviewDecisionActor?: ReviewActorResolverV1;
  /** Optional M7 transactional outcome-decision port; production is intentionally unwired. */
  readonly reviewDecisions?: ReviewDecisionAuthorityV1;
  /**
   * Optional M11 Control API V2 reader; production is intentionally unwired.
   * Fail-closed `503 provider_unavailable` when unset.
   */
  readonly controlApiV2Reader?: ControlApiV2ReaderPortV1;
  /**
   * Optional M11 Control API V2 mutator; production is intentionally unwired.
   * Fail-closed `503 provider_unavailable` when unset.
   */
  readonly controlApiV2Mutator?: ControlApiV2MutatorPortV1;
  /**
   * Optional M11 Control API V2 event read port; production is intentionally unwired.
   * Fail-closed `503 provider_unavailable` when unset. Reached only through the
   * domain `ControlEventReadPortV1` (never the SQLite state store).
   */
  readonly controlApiV2Events?: ControlEventReadPortV1;
  /**
   * Optional C3.5 decision-effect driver. When set, a committed V2 decision
   * receipt triggers a post-commit legacy ActionService drive. Absence leaves
   * the route byte-identical to pre-C3.5 behaviour. Never wired from main in
   * this slice — tests inject it.
   */
  readonly decisionEffects?: DecisionEffectDriver;
  /**
   * Optional analyst stage (intent → bound draft). When absent, draft-from-intent
   * falls back to the keyword heuristic. Closure compiles trusted-mirror context.
   * Activity listener streams phase/tool/text/thought into the draft-jobs registry.
   */
  readonly analyst?: {
    draft(
      intent: string,
      repo: RepoConfig,
      onActivity?: AnalystActivityListener,
    ): Promise<AnalystDraft>;
  };
  /** Optional registry for background analyst drafts; created internally when omitted. Tests inject one. */
  readonly draftJobs?: DraftJobs;
}

function heuristicDraft(intent: string, repoKey: string): AnalystDraft {
  const draft = draftTaskFromIntent(intent, repoKey);
  return {
    ...draft,
    source: 'heuristic' as const,
    lint: lintAcceptance(draft.body),
    notes: [] as const,
    repairRounds: 0,
  };
}

type M7ReviewApiDeps = Pick<
  ApiDeps,
  | 'reviewPackageV2'
  | 'reviewEvidence'
  | 'learningProposals'
  | 'reviewDecisionActor'
  | 'reviewDecisions'
>;

/** Closed fake-only composition seam; the raw source inspector never escapes this module. */
export async function openIsolatedM7ReviewApiDeps(input: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  workRoot: string;
}>): Promise<Partial<M7ReviewApiDeps>> {
  const fixturePath = input.env['HERCULES_M7_L2_FIXTURE_PATH'];
  if (fixturePath === undefined || fixturePath.trim().length === 0) return {};
  try {
    const authority = await openM7L2ReviewProvider({
      env: input.env,
      workRoot: input.workRoot,
      fixturePath,
      inspectSource: inspectReviewPackageV2Source,
    });
    if (authority === null) return {};
    return Object.freeze({
      reviewPackageV2: authority,
      reviewEvidence: authority.evidence,
      learningProposals: authority.learning,
      reviewDecisionActor: authority.actor,
      reviewDecisions: authority,
    });
  } catch {
    console.error('[hercules] isolated M7 review fixture rejected; V2 capabilities disabled');
    return {};
  }
}

function boundReviewDecisionAuthority(
  deps: Pick<ApiDeps, 'reviewPackageV2' | 'reviewDecisions'>,
): ReviewDecisionAuthorityV1 | undefined {
  return deps.reviewPackageV2 !== undefined &&
    deps.reviewPackageV2 === deps.reviewDecisions
    ? deps.reviewDecisions
    : undefined;
}

const CONTROL_API_V2_EMPTY_READS: ControlApiV2ReadsV1 = Object.freeze({
  aggregateExists: false,
  currentStateVersion: null,
  taskStatus: null,
  latestEventSequence: null,
  freshProjectionHash: null,
  reviewPackage: null,
  admissionLedger: [],
  events: null,
  eventsHasMore: false,
});

function controlApiV2PortsReady(
  deps: Pick<
    ApiDeps,
    'controlApiV2Reader' | 'controlApiV2Mutator' | 'controlApiV2Events'
  >,
):
  | {
      readonly reader: ControlApiV2ReaderPortV1;
      readonly mutator: ControlApiV2MutatorPortV1;
      readonly events: ControlEventReadPortV1;
    }
  | null {
  if (
    deps.controlApiV2Reader === undefined ||
    deps.controlApiV2Mutator === undefined ||
    deps.controlApiV2Events === undefined
  ) {
    return null;
  }
  return {
    reader: deps.controlApiV2Reader,
    mutator: deps.controlApiV2Mutator,
    events: deps.controlApiV2Events,
  };
}

function isAdmissionVerdictV1(
  decision: ControlApiV2DecisionV1,
): decision is AdmissionVerdictV1 {
  return (
    typeof decision === 'object' &&
    decision !== null &&
    'schema' in decision &&
    (decision as { schema: string }).schema ===
      'hercules-control-api-admit-verdict/v2'
  );
}

function resolveControlApiV2Response(
  request: unknown,
  ports: {
    readonly reader: ControlApiV2ReaderPortV1;
    readonly mutator: ControlApiV2MutatorPortV1;
  },
  now: string,
): ControlApiV2ResponseV1 {
  let reads: ControlApiV2ReadsV1 = CONTROL_API_V2_EMPTY_READS;
  let validated: ControlApiV2RequestV1 | null = null;
  try {
    assertControlApiV2RequestV1(request);
    validated = request;
    reads = ports.reader.read(validated);
  } catch (error) {
    if (!(error instanceof ControlApiV2Error)) {
      throw error;
    }
  }
  const decision = decideControlApiV2(
    (validated ?? request) as ControlApiV2RequestV1,
    reads,
    now,
  );
  if (isAdmissionVerdictV1(decision)) {
    if (validated === null) {
      throw new ControlApiV2Error(
        'invalid_input_schema',
        'admit verdict requires a validated request',
      );
    }
    return ports.mutator.commit(validated, decision);
  }
  return decision;
}

const ACTIONS = ['approve', 'reject', 'cancel', 'retry'] as const;
type ActionName = (typeof ACTIONS)[number];

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) &&
    allowed.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseAmendPathLeaseInput(raw: unknown): AmendPathLeaseInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const root = raw as Readonly<Record<string, unknown>>;
  if (!exactKeys(root, ['expected', 'replacement'])) return null;
  const expectedRaw = root['expected'];
  const replacementRaw = root['replacement'];
  if (
    typeof expectedRaw !== 'object' || expectedRaw === null || Array.isArray(expectedRaw) ||
    typeof replacementRaw !== 'object' || replacementRaw === null || Array.isArray(replacementRaw)
  ) return null;
  const expected = expectedRaw as Readonly<Record<string, unknown>>;
  const replacement = replacementRaw as Readonly<Record<string, unknown>>;
  if (!exactKeys(expected, [
    'state', 'plannedBaseRevision', 'expectedBaseRevision', 'affectedPaths', 'protectedPathsSnapshot',
    'expectedRemoteTip', 'verifiedSha', 'lastEventAt',
  ])) return null;
  if (!exactKeys(replacement, [
    'plannedBaseRevision', 'affectedPaths', 'protectedPathsSnapshot',
  ])) return null;
  const strings = (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (
    (expected['state'] !== 'review' &&
      expected['state'] !== 'failed' &&
      expected['state'] !== 'cancelled') ||
    typeof expected['plannedBaseRevision'] !== 'string' ||
    typeof expected['expectedBaseRevision'] !== 'string' ||
    !strings(expected['affectedPaths']) ||
    !strings(expected['protectedPathsSnapshot']) ||
    typeof expected['expectedRemoteTip'] !== 'string' ||
    (expected['verifiedSha'] !== null && typeof expected['verifiedSha'] !== 'string') ||
    (expected['lastEventAt'] !== null && typeof expected['lastEventAt'] !== 'string') ||
    typeof replacement['plannedBaseRevision'] !== 'string' ||
    !strings(replacement['affectedPaths']) ||
    !strings(replacement['protectedPathsSnapshot'])
  ) return null;
  return {
    expected: {
      state: expected['state'],
      plannedBaseRevision: expected['plannedBaseRevision'],
      expectedBaseRevision: expected['expectedBaseRevision'],
      affectedPaths: expected['affectedPaths'],
      protectedPathsSnapshot: expected['protectedPathsSnapshot'],
      expectedRemoteTip: expected['expectedRemoteTip'],
      verifiedSha: expected['verifiedSha'],
      lastEventAt: expected['lastEventAt'],
    },
    replacement: {
      plannedBaseRevision: replacement['plannedBaseRevision'],
      affectedPaths: replacement['affectedPaths'],
      protectedPathsSnapshot: replacement['protectedPathsSnapshot'],
    },
  };
}

/**
 * The token is read ONLY from the `Authorization: Bearer` header — never a query
 * string or cookie. Query strings leak into access logs, browser history, and
 * Referer headers; a bare cookie would be CSRF-exposed. The SSE client uses
 * fetch + a readable stream (not EventSource) precisely so it can send this
 * header too.
 */
function presentedToken(c: Context): string | null {
  const header = c.req.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

function reviewReadPortIsReady(port: { readonly isReady: () => boolean } | undefined): boolean {
  try {
    return port?.isReady() === true;
  } catch {
    return false;
  }
}

function reviewPackageSourceIsReady(
  port: ReviewPackageV2SourceReadPort | undefined,
): boolean {
  if (port === undefined) return false;
  const readiness = (port as ReviewPackageV2SourceReadPort & {
    readonly isReady?: unknown;
  }).isReady;
  if (readiness === undefined) return true;
  if (typeof readiness !== 'function') return false;
  try {
    return readiness.call(port) === true;
  } catch {
    return false;
  }
}

type CurrentReviewPackageRead =
  | { readonly status: 'available'; readonly package: ReviewPackageV2 }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable'; readonly reason: ReviewReadReason | 'invalid_source' };

/**
 * The reviewed authority boundary for raw ReviewPackageV2 source projection.
 * Isolated fixture providers may receive this function as a TCB dependency,
 * but cannot construct an authoritative projection themselves.
 */
function inspectReviewPackageV2Source(
  source: ReviewPackageV2Source,
): SourceProjectedReviewPackageV2 {
  return projectAndAssertReviewPackageV2(source);
}

async function readCurrentReviewPackage(
  provider: ReviewPackageV2SourceReadPort,
  taskId: string,
): Promise<CurrentReviewPackageRead> {
  try {
    const result: unknown = await provider.read(taskId);
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return { status: 'unavailable', reason: 'invalid_source' };
    }
    const record = result as Readonly<Record<string, unknown>>;
    if (record['status'] === 'not_found' && exactKeys(record, ['status'])) {
      return { status: 'not_found' };
    }
    if (
      record['status'] === 'unavailable' &&
      exactKeys(record, ['status', 'reason']) &&
      (record['reason'] === 'source_unavailable' ||
        record['reason'] === 'integrity_unavailable')
    ) {
      return { status: 'unavailable', reason: record['reason'] };
    }
    if (record['status'] !== 'available' || !exactKeys(record, ['status', 'source'])) {
      return { status: 'unavailable', reason: 'invalid_source' };
    }
    const packageValue = inspectReviewPackageV2Source(
      record['source'] as ReviewPackageV2Source,
    );
    if (packageValue.task.id !== taskId) {
      return { status: 'unavailable', reason: 'invalid_source' };
    }
    return { status: 'available', package: packageValue };
  } catch {
    return { status: 'unavailable', reason: 'invalid_source' };
  }
}

const REVIEW_TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-ndjson',
]);
const REVIEW_IMAGE_MEDIA_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/webm',
  'video/mp4',
]);

function isReviewTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || REVIEW_TEXT_MEDIA_TYPES.has(mediaType);
}

function reviewEvidenceImagePath(request: Readonly<{
  taskId: string;
  artifactRefId: string;
  projectionHash: string;
}>): string {
  return `/api/v2/tasks/${encodeURIComponent(request.taskId)}/review-evidence/${encodeURIComponent(request.artifactRefId)}/content/${encodeURIComponent(request.projectionHash)}`;
}

type EvidenceResolution =
  | {
      readonly status: 'available';
      readonly request: ReviewEvidencePortRequestV1;
      readonly result: Extract<ReviewEvidencePortResultV1, { readonly status: 'available' }>;
    }
  | {
      readonly status: 'unavailable_content';
      readonly artifactRefId: string;
      readonly reason: Extract<ReviewEvidencePortResultV1, { readonly status: 'unavailable' }>['reason'];
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'stale' }
  | { readonly status: 'unavailable' };

const REVIEW_DECISION_UNAVAILABLE_REASONS = new Set([
  'source_unavailable',
  'integrity_unavailable',
  'transaction_unavailable',
  'provider_contract_violation',
]);

function snapshotReviewDecisionApplyResult(
  value: unknown,
): Readonly<ReviewDecisionApplyResultV1> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('review decision result must be an exact object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    (record['kind'] === 'stale' || record['kind'] === 'idempotency_conflict') &&
    exactKeys(record, ['kind'])
  ) return Object.freeze({ kind: record['kind'] });
  if (
    record['kind'] === 'unavailable' &&
    exactKeys(record, ['kind', 'reason']) &&
    REVIEW_DECISION_UNAVAILABLE_REASONS.has(String(record['reason']))
  ) {
    return Object.freeze({
      kind: 'unavailable',
      reason: record['reason'] as Extract<
        ReviewDecisionApplyResultV1,
        { readonly kind: 'unavailable' }
      >['reason'],
    });
  }
  if (
    (record['kind'] === 'committed' || record['kind'] === 'duplicate') &&
    exactKeys(record, ['kind', 'receipt'])
  ) {
    return Object.freeze({
      kind: record['kind'],
      receipt: snapshotReviewDecisionReceiptV1(record['receipt']),
    });
  }
  throw new TypeError('review decision result is invalid');
}

async function validateCommittedReviewDecision(input: Readonly<{
  port: ReviewDecisionPortV1;
  request: ReviewDecisionRequestV1;
  requestHash: string;
  actor: ReviewActorV1;
  receipt: unknown;
}>): Promise<Readonly<ReviewDecisionReceiptV1> | null> {
  try {
    const receipt = assertReviewDecisionReceiptMatches(input);
    const key = reviewDecisionIdempotencyKey(input.actor, input.request);
    const validation: unknown = await input.port.validateCommittedReceipt({
      key,
      requestHash: input.requestHash,
      receipt,
    });
    if (
      validation === null ||
      typeof validation !== 'object' ||
      Array.isArray(validation)
    ) return null;
    const record = validation as Readonly<Record<string, unknown>>;
    if (!exactKeys(record, ['kind']) || record['kind'] !== 'valid') return null;
    return receipt;
  } catch {
    return null;
  }
}

async function resolveReviewEvidence(
  deps: ApiDeps,
  input: Readonly<{
    taskId: string;
    projectionHash: string;
    artifactRefId: string;
  }>,
): Promise<EvidenceResolution> {
  const source = deps.reviewPackageV2;
  const evidencePort = deps.reviewEvidence;
  if (
    source === undefined ||
    evidencePort === undefined ||
    !reviewReadPortIsReady(evidencePort)
  ) return { status: 'unavailable' };
  const first = await readCurrentReviewPackage(source, input.taskId);
  if (first.status === 'not_found') return { status: 'not_found' };
  if (first.status === 'unavailable') return { status: 'unavailable' };
  if (first.package.projectionHash !== input.projectionHash) return { status: 'stale' };
  const evidence = first.package.evidence.find(
    (item) => item.artifactRefId === input.artifactRefId,
  );
  if (evidence === undefined) return { status: 'not_found' };

  try {
    const actorValue: unknown = await evidencePort.resolveActor();
    if (actorValue === null) return { status: 'unavailable' };
    const actor = snapshotReviewActorV1(actorValue);
    const portRequest: ReviewEvidencePortRequestV1 = Object.freeze({
      schema: 'hercules-review-evidence-read/v1',
      taskId: input.taskId,
      projectionHash: input.projectionHash,
      artifactRefId: input.artifactRefId,
      actor,
      sha256: evidence.sha256,
      redactionState: evidence.redactionState,
      purpose: 'operator_review',
    });
    const portResult = snapshotReviewEvidencePortResultV1(
      await evidencePort.read(portRequest),
    );
    const latest = await readCurrentReviewPackage(source, input.taskId);
    if (latest.status === 'unavailable') return { status: 'unavailable' };
    if (
      latest.status === 'not_found' ||
      latest.package.projectionHash !== input.projectionHash
    ) return { status: 'stale' };
    const latestEvidence = latest.package.evidence.find(
      (item) => item.artifactRefId === input.artifactRefId,
    );
    if (
      latestEvidence === undefined ||
      latestEvidence.sha256 !== evidence.sha256 ||
      latestEvidence.redactionState !== evidence.redactionState
    ) return { status: 'stale' };
    if (portResult.status === 'unavailable') {
      if (
        evidence.redactionState === 'restricted' &&
        portResult.reason !== 'restricted' &&
        portResult.reason !== 'access_denied'
      ) return { status: 'unavailable' };
      return {
        status: 'unavailable_content',
        artifactRefId: input.artifactRefId,
        reason: portResult.reason,
      };
    }
    if (
      evidence.redactionState === 'restricted' ||
      portResult.sha256 !== evidence.sha256 ||
      `sha256:${createHash('sha256').update(portResult.bytes).digest('hex')}` !== evidence.sha256 ||
      portResult.redactionState !== evidence.redactionState
    ) return { status: 'unavailable' };
    return { status: 'available', request: portRequest, result: portResult };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Content-Type for task evidence media served under /screenshots/:name. */
function screenshotMediaType(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.(png|jpe?g|webp|webm|mp4)$/i.test(name)) return null;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'webm':
      return 'video/webm';
    case 'mp4':
      return 'video/mp4';
    default:
      return null;
  }
}

export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();
  const draftJobs = deps.draftJobs ?? createDraftJobs();

  // Auth middleware for the whole API surface. Sole carve-out: the staging
  // handoff redeem — the caller is by definition not yet authenticated; the
  // route itself is code-gated (single-use, TTL, hash-compared).
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/staging-handoff/redeem' && c.req.method === 'POST') {
      await next();
      return;
    }
    if (presentedToken(c) !== deps.token) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  app.get('/api/v2/review-experience/capabilities', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({
      schema: 'hercules-review-experience-capabilities/v1',
      outcomeReviewRead: reviewPackageSourceIsReady(deps.reviewPackageV2),
      evidenceContent:
        reviewPackageSourceIsReady(deps.reviewPackageV2) &&
        reviewReadPortIsReady(deps.reviewEvidence),
      learningProposals:
        reviewPackageSourceIsReady(deps.reviewPackageV2) &&
        reviewReadPortIsReady(deps.learningProposals),
      boundDecisions:
        boundReviewDecisionAuthority(deps) !== undefined &&
        reviewReadPortIsReady(deps.reviewDecisionActor) &&
        reviewReadPortIsReady(deps.reviewDecisions),
      controlApiV2: controlApiV2PortsReady(deps) !== null,
    });
  });

  app.get('/api/v2/tasks/:id/review-package', async (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) {
      return c.json({ error: `unknown task '${id}'` }, 404);
    }
    const provider = deps.reviewPackageV2;
    if (provider === undefined) {
      return c.json(
        { error: 'review package unavailable', reason: 'provider_unavailable' },
        503,
      );
    }
    const result = await readCurrentReviewPackage(provider, id);
    if (result.status === 'not_found') {
      return c.json({ error: `unknown task '${id}'` }, 404);
    }
    if (result.status === 'unavailable') {
      return c.json(
        { error: 'review package unavailable', reason: result.reason },
        503,
      );
    }
    return c.json(result.package);
  });

  app.post('/api/v2/tasks/:id/review-evidence', async (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('id');
    let request;
    try {
      request = parseReviewEvidenceReadRequestV1(await c.req.json());
    } catch {
      return c.json({ error: 'invalid review evidence request' }, 400);
    }
    if (!isValidIdentifier(id) || request.taskId !== id || new URL(c.req.url).search !== '') {
      return c.json({ error: 'invalid review evidence request' }, 400);
    }
    const resolution = await resolveReviewEvidence(deps, request);
    if (resolution.status === 'not_found') {
      return c.json({ error: 'review evidence not found' }, 404);
    }
    if (resolution.status === 'stale') {
      return c.json({ error: 'stale review projection', reason: 'stale_projection' }, 409);
    }
    if (resolution.status === 'unavailable') {
      return c.json({ error: 'review evidence unavailable' }, 503);
    }
    if (resolution.status === 'unavailable_content') {
      return c.json({
        schema: 'hercules-review-evidence-content/v1',
        kind: 'unavailable',
        artifactRefId: resolution.artifactRefId,
        reason: resolution.reason,
      });
    }
    const { result } = resolution;
    if (isReviewTextMediaType(result.mediaType)) {
      if (result.bytes.byteLength > REVIEW_EVIDENCE_MAX_TEXT_BYTES) {
        return c.json({ error: 'review evidence unavailable' }, 503);
      }
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
      } catch {
        return c.json({ error: 'review evidence unavailable' }, 503);
      }
      return c.json({
        schema: 'hercules-review-evidence-content/v1',
        kind: 'text',
        artifactRefId: request.artifactRefId,
        sha256: result.sha256,
        mediaType: result.mediaType,
        redactionState: result.redactionState,
        text: decoded,
      });
    }
    if (REVIEW_IMAGE_MEDIA_TYPES.has(result.mediaType)) {
      return c.json({
        schema: 'hercules-review-evidence-content/v1',
        kind: 'image',
        artifactRefId: request.artifactRefId,
        sha256: result.sha256,
        mediaType: result.mediaType,
        redactionState: result.redactionState,
        authenticatedPath: reviewEvidenceImagePath(request),
      });
    }
    return c.json({
      schema: 'hercules-review-evidence-content/v1',
      kind: 'unavailable',
      artifactRefId: request.artifactRefId,
      reason: 'unsupported_media',
    });
  });

  app.get(
    '/api/v2/tasks/:id/review-evidence/:artifactRefId/content/:projectionHash',
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const taskId = c.req.param('id');
      const artifactRefId = c.req.param('artifactRefId');
      const projectionHash = c.req.param('projectionHash');
      let request;
      try {
        if (new URL(c.req.url).search !== '') throw new TypeError('query is not permitted');
        request = parseReviewEvidenceReadRequestV1({
          schema: 'hercules-review-evidence-read/v1',
          taskId,
          projectionHash,
          artifactRefId,
        });
      } catch {
        return c.json({ error: 'invalid review evidence request' }, 400);
      }
      const resolution = await resolveReviewEvidence(deps, request);
      if (resolution.status === 'not_found') {
        return c.json({ error: 'review evidence not found' }, 404);
      }
      if (resolution.status === 'stale') {
        return c.json({ error: 'stale review projection', reason: 'stale_projection' }, 409);
      }
      if (resolution.status !== 'available') {
        return c.json({ error: 'review evidence unavailable' }, 503);
      }
      if (!REVIEW_IMAGE_MEDIA_TYPES.has(resolution.result.mediaType)) {
        return c.json({ error: 'review image unavailable' }, 503);
      }
      const body = resolution.result.bytes.buffer.slice(
        resolution.result.bytes.byteOffset,
        resolution.result.bytes.byteOffset + resolution.result.bytes.byteLength,
      ) as ArrayBuffer;
      return new Response(body, {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': resolution.result.mediaType,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    },
  );

  app.get('/api/v2/tasks/:id/learning-proposals', async (c) => {
    c.header('Cache-Control', 'no-store');
    const taskId = c.req.param('id');
    const query = new URL(c.req.url).searchParams;
    const hashes = query.getAll('projectionHash');
    if (
      !isValidIdentifier(taskId) ||
      [...query.keys()].some((key) => key !== 'projectionHash') ||
      hashes.length !== 1 ||
      !/^sha256:[0-9a-f]{64}$/.test(hashes[0]!)
    ) return c.json({ error: 'invalid learning proposal request' }, 400);
    const projectionHash = hashes[0]!;
    const source = deps.reviewPackageV2;
    const port = deps.learningProposals;
    if (source === undefined || port === undefined || !reviewReadPortIsReady(port)) {
      return c.json({ error: 'learning proposals unavailable' }, 503);
    }
    const first = await readCurrentReviewPackage(source, taskId);
    if (first.status === 'not_found') {
      return c.json({ error: `unknown task '${taskId}'` }, 404);
    }
    if (first.status === 'unavailable') {
      return c.json({ error: 'learning proposals unavailable' }, 503);
    }
    if (first.package.projectionHash !== projectionHash) {
      return c.json({ error: 'stale review projection', reason: 'stale_projection' }, 409);
    }
    try {
      const raw: unknown = await port.read({ taskId, projectionHash });
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TypeError('invalid learning proposal source result');
      }
      const record = raw as Readonly<Record<string, unknown>>;
      if (record['status'] === 'not_found' && exactKeys(record, ['status'])) {
        return c.json({ error: 'learning proposals not found' }, 404);
      }
      if (
        record['status'] === 'unavailable' &&
        exactKeys(record, ['status', 'reason']) &&
        (record['reason'] === 'source_unavailable' ||
          record['reason'] === 'integrity_unavailable')
      ) return c.json({ error: 'learning proposals unavailable' }, 503);
      if (record['status'] !== 'available' || !exactKeys(record, ['status', 'proposals'])) {
        throw new TypeError('invalid learning proposal source result');
      }
      const proposals = snapshotLearningProposalViewsV1(record['proposals']);
      const evidenceIds = new Set(
        first.package.evidence.map((item) => item.artifactRefId),
      );
      if (proposals.some((proposal) =>
        proposal.taskId !== taskId ||
        proposal.projectionHash !== projectionHash ||
        proposal.evidenceArtifactIds.some((id) => !evidenceIds.has(id))
      )) throw new TypeError('learning proposal binding is invalid');
      const latest = await readCurrentReviewPackage(source, taskId);
      if (latest.status === 'unavailable') {
        return c.json({ error: 'learning proposals unavailable' }, 503);
      }
      if (
        latest.status === 'not_found' ||
        latest.package.projectionHash !== projectionHash
      ) return c.json({ error: 'stale review projection', reason: 'stale_projection' }, 409);
      return c.json(proposals);
    } catch {
      return c.json({ error: 'learning proposals unavailable' }, 503);
    }
  });

  app.post('/api/v2/tasks/:id/review-decisions', async (c) => {
    c.header('Cache-Control', 'no-store');
    const authority = boundReviewDecisionAuthority(deps);
    const actorResolver = deps.reviewDecisionActor;
    const port = authority;
    if (
      authority === undefined ||
      actorResolver === undefined ||
      port === undefined ||
      !reviewReadPortIsReady(actorResolver) ||
      !reviewReadPortIsReady(port)
    ) return c.json({ error: 'review decisions unavailable' }, 503);

    let actor: ReviewActorV1;
    try {
      const value: unknown = await actorResolver.resolveActor();
      if (value === null) return c.json({ error: 'review decisions unavailable' }, 503);
      actor = snapshotReviewActorV1(value);
    } catch {
      return c.json({ error: 'review decisions unavailable' }, 503);
    }

    let request: ReviewDecisionRequestV1;
    try {
      request = parseReviewDecisionRequestV1(await c.req.json());
    } catch {
      return c.json({ error: 'invalid review decision request' }, 400);
    }
    const taskId = c.req.param('id');
    if (
      !isValidIdentifier(taskId) ||
      request.taskId !== taskId ||
      request.decisionBinding.taskId !== taskId ||
      new URL(c.req.url).search !== ''
    ) return c.json({ error: 'invalid review decision request' }, 400);

    const requestHash = reviewDecisionRequestHash(request);
    const key = reviewDecisionIdempotencyKey(actor, request);
    try {
      const existing: unknown = await port.lookup(key);
      if (existing !== null) {
        const receipt = snapshotReviewDecisionReceiptV1(existing);
        if (receipt.requestHash !== requestHash) {
          return c.json(
            { error: 'review decision request id is already used', reason: 'idempotency_conflict' },
            409,
          );
        }
        const valid = await validateCommittedReviewDecision({
          port, request, requestHash, actor, receipt,
        });
        if (valid === null) {
          return c.json(
            { error: 'review decision provider contract violation', reason: 'provider_contract_violation' },
            503,
          );
        }
        return c.json({
          schema: 'hercules-review-decision-response/v1',
          receipt: valid,
          duplicate: true,
        });
      }
    } catch {
      return c.json({ error: 'review decisions unavailable' }, 503);
    }

    const current = await readCurrentReviewPackage(authority, taskId);
    if (current.status === 'not_found') {
      return c.json({ error: `unknown task '${taskId}'` }, 404);
    }
    if (current.status === 'unavailable') {
      return c.json({ error: 'review decisions unavailable' }, 503);
    }
    if (current.package.projectionHash !== request.projectionHash) {
      return c.json({ error: 'stale review projection', reason: 'stale_projection' }, 409);
    }
    if (current.package.decisionBinding === null) {
      return c.json(
        { error: 'more evidence is required for this decision', reason: 'need_more_evidence' },
        422,
      );
    }
    if (
      reviewDecisionBindingHash(current.package.decisionBinding) !==
      reviewDecisionBindingHash(request.decisionBinding)
    ) return c.json({ error: 'stale review projection', reason: 'stale_projection' }, 409);
    if (!current.package.validDecisions.includes(request.action)) {
      return c.json(
        { error: 'more evidence is required for this decision', reason: 'need_more_evidence' },
        422,
      );
    }
    const riskCodes = [
      ...current.package.blockingFindings.map((finding) => finding.code),
      ...current.package.remainingRisks.map((finding) => finding.code),
    ].sort();
    const acknowledgementsMatch =
      request.acknowledgedRiskCodes.length === riskCodes.length &&
      request.acknowledgedRiskCodes.every((code, index) => code === riskCodes[index]);
    const reasonIsValid = request.action === 'request_changes'
      ? request.reason !== null && request.reason.trim().length > 0
      : request.reason === null;
    if (
      !reasonIsValid ||
      (request.action === 'request_changes'
        ? request.acknowledgedRiskCodes.length !== 0
        : !acknowledgementsMatch)
    ) return c.json({ error: 'invalid review decision request' }, 400);

    const expectedDecisionBindingHash = reviewDecisionBindingHash(
      current.package.decisionBinding,
    );
    const command: Readonly<ReviewDecisionCommandV1> = Object.freeze({
      request,
      requestHash,
      actor,
      expectedProjectionHash: current.package.projectionHash,
      expectedDecisionBindingHash,
    });
    let result: Readonly<ReviewDecisionApplyResultV1>;
    try {
      result = snapshotReviewDecisionApplyResult(await port.apply(command));
    } catch {
      return c.json(
        { error: 'review decision provider contract violation', reason: 'provider_contract_violation' },
        503,
      );
    }
    if (result.kind === 'stale') {
      return c.json({ error: 'stale review projection', reason: 'stale_projection' }, 409);
    }
    if (result.kind === 'idempotency_conflict') {
      return c.json(
        { error: 'review decision request id is already used', reason: 'idempotency_conflict' },
        409,
      );
    }
    if (result.kind === 'unavailable') {
      return c.json({ error: 'review decisions unavailable', reason: result.reason }, 503);
    }
    const valid = await validateCommittedReviewDecision({
      port,
      request,
      requestHash,
      actor,
      receipt: result.receipt,
    });
    if (valid === null) {
      return c.json(
        { error: 'review decision provider contract violation', reason: 'provider_contract_violation' },
        503,
      );
    }
    return c.json({
      schema: 'hercules-review-decision-response/v1',
      receipt: valid,
      duplicate: result.kind === 'duplicate',
    });
  });

  // --- M11 Control API V2 (additive, fail-closed) ---------------------------

  app.post('/api/v2/control/tasks', async (c) => {
    c.header('Cache-Control', 'no-store');
    const ports = controlApiV2PortsReady(deps);
    if (ports === null) {
      return c.json({ reason: 'provider_unavailable' }, 503);
    }
    const now = new Date().toISOString();
    if (new URL(c.req.url).search !== '') {
      const response = resolveControlApiV2Response(
        { schema: 'invalid', resource: 'task', operation: 'create' },
        ports,
        now,
      );
      return c.json(response, controlApiV2HttpStatusForResponse(response));
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    try {
      const response = resolveControlApiV2Response(body, ports, now);
      return c.json(response, controlApiV2HttpStatusForResponse(response));
    } catch (error) {
      if (error instanceof ControlApiV2Error && error.code === 'provider_unavailable') {
        return c.json({ reason: 'provider_unavailable' }, 503);
      }
      throw error;
    }
  });

  app.post('/api/v2/control/tasks/:id/decision', async (c) => {
    c.header('Cache-Control', 'no-store');
    const ports = controlApiV2PortsReady(deps);
    if (ports === null) {
      return c.json({ reason: 'provider_unavailable' }, 503);
    }
    const now = new Date().toISOString();
    if (new URL(c.req.url).search !== '') {
      const response = resolveControlApiV2Response(
        { schema: 'invalid', resource: 'decision', operation: 'submit' },
        ports,
        now,
      );
      return c.json(response, controlApiV2HttpStatusForResponse(response));
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const response = resolveControlApiV2Response(body, ports, now);
    if (
      response.schema === 'hercules-control-api-receipt/v2' &&
      response.outcome === 'committed' &&
      deps.decisionEffects
    ) {
      try {
        await deps.decisionEffects.driveCommitted(response.keyHash);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[hercules] decision effect: route drive failed: ${detail}`);
      }
    }
    return c.json(response, controlApiV2HttpStatusForResponse(response));
  });

  app.get('/api/v2/control/tasks/:id/status', (c) => {
    c.header('Cache-Control', 'no-store');
    const ports = controlApiV2PortsReady(deps);
    if (ports === null) {
      return c.json({ reason: 'provider_unavailable' }, 503);
    }
    const now = new Date().toISOString();
    if (new URL(c.req.url).search !== '') {
      const response = resolveControlApiV2Response(
        { schema: 'invalid', resource: 'status', operation: 'read' },
        ports,
        now,
      );
      return c.json(response, controlApiV2HttpStatusForResponse(response));
    }
    const id = c.req.param('id');
    let request: unknown;
    try {
      request = buildControlApiV2ReadRequest('status', id, now);
    } catch {
      request = {
        schema: 'hercules-control-api-request/v2',
        resource: 'status',
        operation: 'read',
        aggregateId: id,
      };
    }
    const response = resolveControlApiV2Response(request, ports, now);
    return c.json(response, controlApiV2HttpStatusForResponse(response));
  });

  app.get('/api/v2/control/tasks/:id/review', (c) => {
    c.header('Cache-Control', 'no-store');
    const ports = controlApiV2PortsReady(deps);
    if (ports === null) {
      return c.json({ reason: 'provider_unavailable' }, 503);
    }
    const now = new Date().toISOString();
    if (new URL(c.req.url).search !== '') {
      const response = resolveControlApiV2Response(
        { schema: 'invalid', resource: 'review', operation: 'read' },
        ports,
        now,
      );
      return c.json(response, controlApiV2HttpStatusForResponse(response));
    }
    const id = c.req.param('id');
    let request: unknown;
    try {
      request = buildControlApiV2ReadRequest('review', id, now);
    } catch {
      request = {
        schema: 'hercules-control-api-request/v2',
        resource: 'review',
        operation: 'read',
        aggregateId: id,
      };
    }
    const response = resolveControlApiV2Response(request, ports, now);
    return c.json(response, controlApiV2HttpStatusForResponse(response));
  });

  app.get('/api/v2/control/events', (c) => {
    c.header('Cache-Control', 'no-store');
    const ports = controlApiV2PortsReady(deps);
    if (ports === null) {
      return c.json({ reason: 'provider_unavailable' }, 503);
    }
    void ports.events;
    const now = new Date().toISOString();
    const url = new URL(c.req.url);
    const afterRaw = url.searchParams.get('afterSequence');
    const limitRaw = url.searchParams.get('limit');
    const expectedRaw = url.searchParams.get('expectedPreviousEventHash');
    const afterSequence =
      afterRaw !== null && afterRaw !== '' && /^-?\d+$/.test(afterRaw)
        ? Number(afterRaw)
        : Number.NaN;
    const limit =
      limitRaw !== null && limitRaw !== '' && /^-?\d+$/.test(limitRaw)
        ? Number(limitRaw)
        : Number.NaN;
    const expectedPreviousEventHash =
      expectedRaw === null || expectedRaw === '' ? null : expectedRaw;
    let request: unknown;
    try {
      request = buildControlApiV2EventReadRequest({
        afterSequence,
        limit,
        expectedPreviousEventHash,
        issuedAt: now,
      });
    } catch {
      request = {
        schema: 'hercules-control-api-request/v2',
        resource: 'event',
        operation: 'read',
        aggregateId: '',
        payload: {
          schema: 'hercules-control-api-event-cursor/v2',
          afterSequence,
          limit,
          expectedPreviousEventHash,
        },
      };
    }
    const response = resolveControlApiV2Response(request, ports, now);
    return c.json(response, controlApiV2HttpStatusForResponse(response));
  });

  // Staging auto-unlock: production mints (Bearer-authed), staging redeems.
  app.post('/api/staging-handoff/mint', async (c) => {
    const file = deps.stagingHandoff?.mintFile;
    if (!file) return c.json({ error: 'not found' }, 404);
    const code = await mintHandoffCode({ file });
    return c.json({ code });
  });

  app.post('/api/staging-handoff/redeem', async (c) => {
    const file = deps.stagingHandoff?.redeemFile;
    if (!file) return c.json({ error: 'not found' }, 404);
    let code = '';
    try {
      const body = (await c.req.json()) as { code?: unknown };
      if (typeof body.code === 'string') code = body.code;
    } catch {
      /* fall through to reject */
    }
    const ok = await redeemHandoffCode({ file, code });
    if (!ok) return c.json({ error: 'invalid or expired code' }, 403);
    return c.json({ token: deps.token });
  });

  app.get('/api/state', (c) => c.json(serializeState(deps.runtime.getState())));

  app.post('/api/reviewer-health/:provider/recover', async (c) => {
    const provider = c.req.param('provider');
    if (!isAdapterKind(provider) || provider === 'fake') {
      return c.json({ error: 'unknown reviewer provider' }, 400);
    }
    if (!deps.runtime.recoverReviewerProvider) {
      return c.json({ error: 'reviewer recovery unavailable' }, 503);
    }
    let mode: 'health_check' | 'operator' = 'health_check';
    try {
      const body = (await c.req.json()) as { mode?: unknown };
      if (body.mode === 'operator') mode = 'operator';
      else if (body.mode !== undefined && body.mode !== 'health_check') {
        return c.json({ error: 'mode must be health_check or operator' }, 400);
      }
    } catch {
      // Empty body uses the safer health-check mode.
    }
    try {
      return c.json(await deps.runtime.recoverReviewerProvider(provider, { mode }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'reviewer recovery failed';
      return c.json({ error: message.slice(0, 240) }, 409);
    }
  });

  // Serve behavioral evidence screenshots (authenticated, path-confined).
  // Range responses are chunked so large videos stream without reading the
  // whole file into memory (N2); range-aware clients continue with further
  // requests. A plain GET is always complete (or 413) because the SPA blob
  // loaders cannot assemble ranges.
  const SCREENSHOT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  /** Plain (no Range) GET: complete body up to this size, else 413. */
  const SCREENSHOT_MAX_PLAIN_BYTES = 64 * 1024 * 1024;
  app.get('/api/tasks/:id/screenshots/:name', async (c) => {
    const root = deps.screenshotsRoot;
    const id = c.req.param('id');
    const name = c.req.param('name');
    const media = screenshotMediaType(name);
    if (!root || !isValidIdentifier(id) || !media) {
      return c.json({ error: 'not found' }, 404);
    }
    const lexical = resolve(join(root, id, name));
    if (!lexical.startsWith(resolve(root) + sep)) {
      return c.json({ error: 'not found' }, 404);
    }
    let dirFh: Awaited<ReturnType<typeof openFile>> | undefined;
    let fh: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      const rootReal = await realpath(root);
      const taskDirReal = join(rootReal, id);
      // Pin the task directory's identity (Codex R11 N1): open it as a
      // directory handle, verify the handle's canonical path is exactly
      // <rootReal>/<id>, then open the file THROUGH the handle via
      // /proc/self/fd — a rename/symlink swap of the directory after the
      // check cannot redirect the open. O_NONBLOCK: a FIFO must not block.
      try {
        dirFh = await openFile(
          join(root, id),
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
      } catch {
        return c.json({ error: 'not found' }, 404);
      }
      const dirFdPath = '/proc/self/fd/' + String(dirFh.fd);
      let dirReal: string;
      try {
        dirReal = await realpath(dirFdPath);
      } catch {
        return c.json({ error: 'not found' }, 404);
      }
      if (dirReal !== taskDirReal) {
        return c.json({ error: 'not found' }, 404);
      }
      try {
        fh = await openFile(
          dirFdPath + '/' + name,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
      } catch {
        return c.json({ error: 'not found' }, 404);
      }
      const st = await fh.stat();
      if (!st.isFile()) {
        return c.json({ error: 'not found' }, 404);
      }
      const size = st.size;
      const headers: Record<string, string> = {
        'content-type': media,
        'accept-ranges': 'bytes',
      };
      const range = c.req.header('range');
      if (size === 0) {
        if (range) {
          return c.body(null, 416, {
            'content-range': 'bytes */0',
            'accept-ranges': 'bytes',
          });
        }
        return c.body(Buffer.alloc(0), 200, {
          ...headers,
          'content-length': '0',
        });
      }
      let start = 0;
      let end = size - 1;
      let forcePartial = false;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
        if (!m) {
          return c.body(null, 416, {
            'content-range': 'bytes */' + String(size),
            'accept-ranges': 'bytes',
          });
        }
        const startRaw = m[1]!;
        const endRaw = m[2]!;
        // RFC 9110 §14.1.2: `bytes=-N` is a suffix range (last N bytes).
        const suffix = startRaw === '' ? Number(endRaw) : null;
        start = suffix !== null
          ? Math.max(0, size - suffix)
          : Number(startRaw);
        end = suffix !== null || endRaw === '' ? size - 1 : Number(endRaw);
        if (
          (startRaw === '' && endRaw === '') ||
          (suffix !== null && (!Number.isInteger(suffix) || suffix <= 0)) ||
          !Number.isInteger(start) || !Number.isInteger(end) ||
          start < 0 || end < start || start >= size
        ) {
          return c.body(null, 416, {
            'content-range': 'bytes */' + String(size),
            'accept-ranges': 'bytes',
          });
        }
        if (end >= size) end = size - 1;
        forcePartial = true;
      } else if (size > SCREENSHOT_MAX_PLAIN_BYTES) {
        // A plain GET must be complete or refused — the SPA blob loaders
        // cannot assemble ranges (Codex R11 B1). Larger files are refused.
        return c.json({ error: 'payload too large' }, 413);
      }
      if (range && end - start + 1 > SCREENSHOT_MAX_RESPONSE_BYTES) {
        // Range requests are chunked; the client continues with further ranges.
        end = start + SCREENSHOT_MAX_RESPONSE_BYTES - 1;
        forcePartial = true;
      }
      const length = end - start + 1;
      if (length <= 0) {
        return c.body(null, 416, {
          'content-range': 'bytes */' + String(size),
          'accept-ranges': 'bytes',
        });
      }
      const slice = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await fh.read(slice, offset, length - offset, start + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const body = offset === length ? slice : slice.subarray(0, offset);
      if (forcePartial || range) {
        return c.body(body, 206, {
          ...headers,
          'content-range':
            'bytes ' + String(start) + '-' + String(start + body.byteLength - 1) + '/' + String(size),
          'content-length': String(body.byteLength),
        });
      }
      return c.body(body, 200, {
        ...headers,
        'content-length': String(body.byteLength),
      });
    } catch {
      return c.json({ error: 'not found' }, 404);
    } finally {
      if (fh !== undefined) {
        await fh.close().catch(() => undefined);
      }
      if (dirFh !== undefined) {
        await dirFh.close().catch(() => undefined);
      }
    }
  });

  // Phone review file browser: what the task actually produced, read from the
  // trusted mirror at the task's VERIFIED sha (never a live worktree). Human
  // ACs like "spot-check docs quality" are unactionable without this.
  const resolveTaskForFiles = (
    id: string,
  ): { task: Task; repo: RepoConfig; sha: string } | null => {
    if (!isValidIdentifier(id) || !deps.taskFiles) return null;
    const snapshot = deps.runtime.getState().snapshot;
    const task = snapshot?.tasks.find((t) => t.id === id);
    if (!task) return null;
    const repo = snapshot?.repos.repos[task.repo];
    const sha = task.verifiedSha;
    if (!repo || typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    return { task, repo, sha };
  };

  app.get('/api/tasks/:id/files', async (c) => {
    const hit = resolveTaskForFiles(c.req.param('id'));
    if (!hit || !deps.taskFiles) return c.json({ error: 'no verified files to show' }, 404);
    const files = await deps.taskFiles.list(hit.repo, hit.sha);
    return c.json({ sha: hit.sha, files });
  });

  app.get('/api/tasks/:id/file', async (c) => {
    const hit = resolveTaskForFiles(c.req.param('id'));
    const path = c.req.query('path') ?? '';
    if (!hit || !deps.taskFiles || path.length === 0) {
      return c.json({ error: 'no verified files to show' }, 404);
    }
    const content = await deps.taskFiles.read(hit.repo, hit.sha, path);
    if (content === null) return c.json({ error: 'file not found at verified sha' }, 404);
    const MAX = 300_000;
    return c.json({
      path,
      sha: hit.sha,
      content: content.length > MAX ? content.slice(0, MAX) : content,
      truncated: content.length > MAX,
    });
  });

  // Staging release evidence screenshots (authenticated, path-confined).
  app.get('/api/releases/:repo/screenshots/:name', async (c) => {
    const root = deps.releaseScreenshotsRoot;
    const repo = c.req.param('repo');
    const name = c.req.param('name');
    if (!root || !isValidIdentifier(repo) || !/^[A-Za-z0-9._-]+\.png$/.test(name)) {
      return c.json({ error: 'not found' }, 404);
    }
    const path = resolve(join(root, repo, name));
    if (!path.startsWith(resolve(root) + sep)) {
      return c.json({ error: 'not found' }, 404);
    }
    try {
      const buf = await readFile(path);
      return c.body(buf, 200, { 'content-type': 'image/png' });
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });

  app.get('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    const view = deps.runtime.getState();
    const task = view.snapshot?.tasks.find((t) => t.id === id);
    if (!task) return c.json({ error: `unknown task '${id}'` }, 404);
    // Holds map can lag one tick after cancel/done; only surface for queued states.
    const dispatchHoldReason =
      task.state === 'todo' || task.state === 'retrying'
        ? (view.holds?.[id] ?? null)
        : null;
    return c.json({
      ...redactTaskProviderSession(task),
      dispatchHoldReason,
    });
  });

  app.get('/api/tasks/:id/cli-evidence', (c) => {
    const id = c.req.param('id');
    const snapshot = deps.runtime.getState().snapshot;
    const task = snapshot?.tasks.find((candidate) => candidate.id === id);
    if (!task) return c.json({ error: `unknown task '${id}'` }, 404);
    if (!task.verifiedSha) return c.json({ error: 'no CLI evidence receipt' }, 404);
    const body = redactTaskProviderSession(task).body;
    const packetPrefix = '## Review packet\n\n' + CLI_EVIDENCE_PACKET_AUTHORITY + '\n';
    const authority = body.indexOf(packetPrefix);
    let packetBody = authority < 0 ? '' : body.slice(authority + packetPrefix.length);
    // Honour matching packet-end when fenced — trail-looking headings inside
    // agent prose must not truncate the CLI evidence receipt slice.
    if (packetBody.length > 0) {
      packetBody = cutReviewPacketInterior(packetBody);
    }
    const receipt = authority < 0 ? null : extractCliEvidenceReceipt(packetBody);
    if (!receipt) return c.json({ error: 'no CLI evidence receipt' }, 404);
    return c.json(receipt);
  });

  app.post('/api/tasks', async (c) => {
    let input: CreateTaskInput;
    try {
      input = (await c.req.json()) as CreateTaskInput;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      const task = redactTaskProviderSession(await deps.actions.createTask(input));
      // Creation is never blocked by AC lint — advisory only.
      if (typeof input.body === 'string' && input.body.length > 0) {
        try {
          const { lintAcceptance } = await import('../domain/acceptanceLint.js');
          return c.json({ ...task, acLint: lintAcceptance(input.body) }, 201);
        } catch {
          /* lint must never break create */
        }
      }
      return c.json(task, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Draft structured DoD from free-form intent (G5 / analyst) — no create/dispatch. */
  app.post('/api/tasks/draft-from-intent', async (c) => {
    let body: { intent?: string; repo?: string };
    try {
      body = (await c.req.json()) as { intent?: string; repo?: string };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const intent = (body.intent ?? '').trim();
    const repoKey = (body.repo ?? '').trim() || 'hercules';
    if (intent.length === 0) return c.json({ error: 'intent is required' }, 400);
    if (!isValidIdentifier(repoKey)) {
      return c.json({ error: `unknown repo '${repoKey}'` }, 404);
    }
    const snapshot = deps.runtime.getState().snapshot;
    const repoCfg = snapshot?.repos.repos[repoKey];
    if (!repoCfg) return c.json({ error: `unknown repo '${repoKey}'` }, 404);

    let draft = heuristicDraft(intent, repoKey);
    let jobId: string | null = null;
    if (deps.analyst) {
      const analyst = deps.analyst;
      const job = draftJobs.start({
        repo: repoKey,
        intent,
        run: (onActivity) => analyst.draft(intent, repoCfg, onActivity),
      });
      jobId = job?.id ?? null;
      if (job === null) {
        draft = {
          ...draft,
          warnings: [...draft.warnings, 'analyst busy — heuristic draft only'],
        };
      }
    }
    return c.json({ draft, jobId });
  });

  app.get('/api/draft-jobs', (c) => c.json({ jobs: draftJobs.list() }));

  app.get('/api/draft-jobs/:id', (c) => {
    const id = c.req.param('id');
    const job = draftJobs.get(id);
    if (!job) return c.json({ error: 'unknown draft job' }, 404);
    return c.json({ job });
  });

  app.post('/api/draft-jobs/:id/ack', (c) => {
    const id = c.req.param('id');
    if (!draftJobs.ack(id)) return c.json({ error: 'unknown draft job' }, 404);
    return c.json({ ok: true });
  });

  /** Pure AC lint of a task body — no side effects. */
  app.post('/api/tasks/lint-acceptance', async (c) => {
    let body: { body?: unknown };
    try {
      body = (await c.req.json()) as { body?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.body !== 'string') {
      return c.json({ error: 'body string is required' }, 400);
    }
    const { lintAcceptance } = await import('../domain/acceptanceLint.js');
    return c.json(lintAcceptance(body.body));
  });

  /** Human approves a plan draft so the task becomes dispatchable (G5). */
  app.post('/api/tasks/:id/approve-plan', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    try {
      return c.json(redactTaskProviderSession(await deps.actions.approvePlan(id)));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Human authorizes host_operation / deploy with a bounded named command
   * scope (P0). Until set, scheduling will not dispatch the task.
   */
  app.post('/api/tasks/:id/approve-host-operation', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    let body: { commandScope?: unknown };
    try {
      body = (await c.req.json()) as { commandScope?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!Array.isArray(body.commandScope)) {
      return c.json({ error: 'commandScope must be an array of named commands' }, 400);
    }
    if (!body.commandScope.every((item) => typeof item === 'string')) {
      return c.json({ error: 'every commandScope entry must be a string' }, 400);
    }
    const commandScope = body.commandScope as string[];
    try {
      return c.json(redactTaskProviderSession(await deps.actions.approveHostOperation(id, { commandScope })));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Push a queued task to the front of the dispatch queue (priority). */
  app.post('/api/tasks/:id/queue-front', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    try {
      return c.json(redactTaskProviderSession(await deps.actions.moveToQueueFront(id)));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Re-run L1/L2/L3/L5 only on preserved branch (G6). */
  app.post('/api/tasks/:id/reverify', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    try {
      return c.json(redactTaskProviderSession(await deps.actions.reverify(id)));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Exact-CAS repair of one inactive task's complete path-lease declaration. */
  app.post('/api/tasks/:id/path-lease/amend', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const input = parseAmendPathLeaseInput(raw);
    if (!input) return c.json({ error: 'invalid path-lease amendment request' }, 400);
    try {
      return c.json(redactTaskProviderSession(await deps.actions.amendPathLease(id, input)));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Explicit clean-salvage fork: create a new task from a terminal failed
   * or cancelled source, stamped at the preserved branch tip. Audited; never
   * automatic. Empty body is valid; malformed JSON and wrong field types
   * return 400.
   */
  app.post('/api/tasks/:id/salvage-fork', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    const { parseSalvageForkInput } = await import('../domain/salvage.js');
    let rawText = '';
    try {
      rawText = await c.req.text();
    } catch {
      rawText = '';
    }
    let input: import('../domain/salvage.js').SalvageForkInput = {};
    if (rawText.trim().length > 0) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText) as unknown;
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      const parsed = parseSalvageForkInput(parsedJson);
      if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
      input = parsed.value;
    }
    try {
      return c.json(redactTaskProviderSession(await deps.actions.salvageFork(id, input)), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Platform remediation chain: link a failed original to a Hercules fix task,
   * or record bootstrap escalation when the source is already a remediator.
   * Body requires `kind` (bug|capability_gap|platform_limit).
   */
  app.post('/api/tasks/:id/platform-remediation', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    const { parsePlatformRemediationInput } = await import(
      '../domain/platformRemediation.js'
    );
    let rawText = '';
    try {
      rawText = await c.req.text();
    } catch {
      rawText = '';
    }
    let parsedJson: unknown = {};
    if (rawText.trim().length > 0) {
      try {
        parsedJson = JSON.parse(rawText) as unknown;
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
    }
    const parsed = parsePlatformRemediationInput(parsedJson);
    if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
    try {
      const result = await deps.actions.requestPlatformRemediation(id, parsed.value);
      return c.json(
        {
          mode: result.mode,
          original: redactTaskProviderSession(result.original),
          remediation: result.remediation
            ? redactTaskProviderSession(result.remediation)
            : null,
        },
        result.mode === 'open_chain' ? 201 : 200,
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Multi-step agent pipeline: linear blocked_by chain + per-stage adapter. */
  app.post('/api/pipelines', async (c) => {
    let input: import('../orchestrator/actions.js').CreatePipelineInput;
    try {
      input = (await c.req.json()) as import('../orchestrator/actions.js').CreatePipelineInput;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      return c.json((await deps.actions.createPipeline(input)).map(redactTaskProviderSession), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Dependency-only, exact-lease batch transaction (authenticated by global middleware). */
  app.post('/api/tasks/dependencies/rewire', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = parseDependencyRewireInput(raw);
    if (!parsed.ok) return c.json({ error: parsed.reason }, 400);
    try {
      return c.json(await deps.actions.rewireDependencies(parsed.value));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Patch task fields humans may change mid-lifecycle (currently: adapter). */
  app.patch('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    let body: { adapter?: string | null; switchNow?: boolean };
    try {
      body = (await c.req.json()) as { adapter?: string | null; switchNow?: boolean };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!('adapter' in body)) {
      return c.json({ error: 'nothing to update (supported: adapter)' }, 400);
    }
    try {
      // null / "" → clear override; string → set
      const raw = body.adapter;
      const adapter =
        raw === null || raw === undefined || raw === ''
          ? null
          : (raw as import('../domain/agents.js').AdapterKind);
      const switchNow = body.switchNow === true;
      return c.json(redactTaskProviderSession(
        await deps.actions.setTaskAdapter(id, adapter, switchNow ? { switchNow: true } : undefined),
      ));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/repos', async (c) => {
    let input: AddRepoInput;
    try {
      input = (await c.req.json()) as AddRepoInput;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if ('ownerCheckouts' in input || 'owner_checkouts' in input) {
      return c.json({ error: 'owner checkout registration mutation is not supported by this API' }, 400);
    }
    try {
      return c.json(redactRepoOwnerCheckouts(await deps.actions.addRepo(input)), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.patch('/api/repos/:key', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key)) return c.json({ error: `unknown repo '${key}'` }, 404);
    let patch: EditRepoPatch;
    try {
      patch = (await c.req.json()) as EditRepoPatch;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if ('ownerCheckouts' in patch || 'owner_checkouts' in patch) {
      return c.json({ error: 'owner checkout registration mutation is not supported by this API' }, 400);
    }
    try {
      return c.json(redactRepoOwnerCheckouts(await deps.actions.editRepo(key, patch)));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Soft readiness checklist (SPEC §15) as an async per-repo job.
   * POST starts (or attaches to) a background check → 202.
   * GET returns immediately with job status + last completed result.
   * Does not flip repos.yaml readiness; mark-ready enforces hard gates.
   */
  app.post('/api/repos/:key/readiness-check', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key)) return c.json({ error: `unknown repo '${key}'` }, 404);
    let retryCliEvidence = c.req.query('retry_cli') === '1';
    try {
      const body = (await c.req.json()) as { retryCliEvidence?: unknown };
      if (body.retryCliEvidence === true) retryCliEvidence = true;
    } catch {
      // Empty / non-JSON body is fine — query param alone is enough.
    }
    try {
      return c.json(
        await deps.actions.startRepoReadinessCheck(key, { retryCliEvidence }),
        202,
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/repos/:key/readiness-check', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key)) return c.json({ error: `unknown repo '${key}'` }, 404);
    try {
      return c.json(await deps.actions.getRepoReadinessJob(key));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Repo docs browser: README / AGENTS / docs/** from trusted mirror @ default
  // branch (never a live worktree). Offline list/read for phone Repos panel.
  app.get('/api/repos/:key/docs', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key) || !deps.repoDocs) {
      return c.json({ error: 'docs unavailable' }, 404);
    }
    const repo = deps.runtime.getState().snapshot?.repos.repos[key];
    if (!repo) return c.json({ error: `unknown repo '${key}'` }, 404);
    const files = await deps.repoDocs.list(repo);
    return c.json({ branch: repo.defaultBranch, files });
  });

  app.get('/api/repos/:key/doc', async (c) => {
    const key = c.req.param('key');
    const path = c.req.query('path') ?? '';
    if (!isValidIdentifier(key) || !deps.repoDocs || path.length === 0) {
      return c.json({ error: 'docs unavailable' }, 404);
    }
    const repo = deps.runtime.getState().snapshot?.repos.repos[key];
    if (!repo) return c.json({ error: `unknown repo '${key}'` }, 404);
    const content = await deps.repoDocs.read(repo, path);
    if (content === null) return c.json({ error: 'file not found' }, 404);
    const MAX = 300_000;
    return c.json({
      path,
      branch: repo.defaultBranch,
      content: content.length > MAX ? content.slice(0, MAX) : content,
      truncated: content.length > MAX,
    });
  });

  /**
   * Human batch Merge (design §3): ordered approved tasks → temp main worktree
   * → L1 gates once → non-force push. Auth same as other mutating routes.
   */
  app.post('/api/repos/:key/merge', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key)) return c.json({ error: `unknown repo '${key}'` }, 404);
    let body: { taskIds?: unknown };
    try {
      body = (await c.req.json()) as { taskIds?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!Array.isArray(body.taskIds) || body.taskIds.length === 0) {
      return c.json({ error: 'body.taskIds must be a non-empty string array' }, 400);
    }
    if (!body.taskIds.every((id): id is string => typeof id === 'string')) {
      return c.json({ error: 'body.taskIds must be a non-empty string array' }, 400);
    }
    try {
      const rawIdem = (body as { idempotencyKey?: unknown }).idempotencyKey;
      const idem = parseMergeIdempotencyKeyInput(rawIdem);
      if (idem.status === 'invalid') {
        return c.json({ error: idem.reason }, 400);
      }
      const receipt = await deps.actions.startMergeOperation(
        key,
        body.taskIds,
        idem.key,
      );
      return c.json(receipt, 202);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/merge-operations/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) {
      return c.json({ error: `unknown merge operation '${id}'` }, 404);
    }
    try {
      const receipt = await deps.actions.getMergeOperation(id);
      if (!receipt) {
        return c.json({ error: `unknown merge operation '${id}'` }, 404);
      }
      return c.json(receipt);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Integrity-checked, redacted post-merge workspace succession facts. */
  app.get('/api/repos/:key/succession', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key)) return c.json({ error: `unknown repo '${key}'` }, 404);
    try {
      return c.json({ succession: await deps.actions.getWorkspaceSuccession(key) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Human Promote (design §3): staging ready + no drift → production deploy.
   * Automatic rollback on failure. Auth same as other mutating routes.
   */
  app.post('/api/repos/:key/promote', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key)) return c.json({ error: `unknown repo '${key}'` }, 404);
    try {
      return c.json(await deps.actions.promote(key));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Manual production rollback to previous known-good sha (design §3).
   */
  app.post('/api/repos/:key/rollback', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key)) return c.json({ error: `unknown repo '${key}'` }, 404);
    try {
      return c.json(await deps.actions.rollbackProduction(key));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Phone Releases panel: repos with deploy.staging + drift / packet / mergeables.
   */
  app.get('/api/releases', async (c) => {
    try {
      return c.json({ releases: await deps.actions.listReleases() });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Human "Deploy staging now" — bypasses quiet-period debounce (design §3).
   */
  app.post('/api/repos/:key/deploy-staging', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key)) return c.json({ error: `unknown repo '${key}'` }, 404);
    try {
      return c.json(deps.actions.requestStagingDeployNow(key));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.delete('/api/repos/:key', async (c) => {
    const key = c.req.param('key');
    if (!isValidIdentifier(key)) return c.json({ error: `unknown repo '${key}'` }, 404);
    try {
      return c.json(await deps.actions.removeRepo(key));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/tasks/:id/force-abort', (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    deps.runtime.forceAbort(id);
    return c.json({ aborting: id });
  });

  /** Open or create a GitHub PR for hercules/<id> (review or done). */
  app.post('/api/tasks/:id/pr', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    try {
      return c.json(await deps.actions.openPr(id));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Approve (review → done) then open/create a PR in one step. */
  app.post('/api/tasks/:id/approve-pr', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    const approveOpts = await readApproveOpts(c);
    try {
      const result = await deps.actions.approveAndOpenPr(id, approveOpts);
      return c.json({ ...result, task: redactTaskProviderSession(result.task) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Comment-to-steer: human follow-up on a review/failed/done task (session resume). */
  app.post('/api/tasks/:id/steer', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    let body: { comment?: unknown };
    try {
      body = (await c.req.json()) as { comment?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const comment = typeof body.comment === 'string' ? body.comment : '';
    try {
      return c.json(redactTaskProviderSession(await deps.actions.steer(id, comment)));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Preview GitHub PR comments as a steer draft (no mutation). */
  app.get('/api/tasks/:id/pr-comments', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    try {
      return c.json(await deps.actions.previewPrComments(id));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Live PR CI / review / comment summary for phone review quality judgment. */
  app.get('/api/tasks/:id/pr-summary', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    try {
      return c.json(await deps.actions.prSummary(id));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Pull PR comments/reviews and queue a steer turn (explicit human action).
   * After the agent finishes, HERCULES_PUSH updates the same open PR branch.
   */
  app.post('/api/tasks/:id/steer-from-pr', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    try {
      const result = await deps.actions.steerFromPrComments(id);
      return c.json({ ...result, task: redactTaskProviderSession(result.task) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Remote Control chat on a task.
   *   - review / failed → steer (resume)
   *   - todo / retrying → pendingSteer
   *   - in_progress → queue until turn ends (auto-steer)
   *   - same clientMessageId / idempotencyKey retry → mode=duplicate
   */
  app.post('/api/tasks/:id/chat', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    let body: {
      message?: unknown;
      clientMessageId?: unknown;
      idempotencyKey?: unknown;
    };
    try {
      body = (await c.req.json()) as {
        message?: unknown;
        clientMessageId?: unknown;
        idempotencyKey?: unknown;
      };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const message = typeof body.message === 'string' ? body.message : '';
    // Prefer clientMessageId; accept idempotencyKey as an alias.
    // Malformed non-null keys are 400 — never silently fall back to legacy.
    const idField =
      body.clientMessageId !== undefined
        ? body.clientMessageId
        : body.idempotencyKey !== undefined
          ? body.idempotencyKey
          : undefined;
    const parsedId = parseClientMessageIdInput(
      idField === undefined ? null : idField,
    );
    if (parsedId.status === 'invalid') {
      return c.json({ error: parsedId.reason }, 400);
    }
    const clientMessageId = parsedId.id;
    const snapshot = deps.runtime.getState().snapshot;
    const task = snapshot?.tasks.find((t) => t.id === id);
    if (!task) return c.json({ error: `unknown task '${id}'` }, 404);

    if (task.state === 'in_progress') {
      if (!deps.runtime.queueTaskChat) {
        return c.json({ error: 'live chat queue not available' }, 503);
      }
      const text = message.trim();
      if (text.length === 0) return c.json({ error: 'message is required' }, 400);
      if (text.length > 4000) return c.json({ error: 'message too long (max 4000 chars)' }, 400);
      const result = deps.runtime.queueTaskChat(id, text, {
        clientMessageId,
      });
      // Back-compat: plain string[] from older fakes → treat as queued.
      if (Array.isArray(result)) {
        return c.json({ mode: 'queued', queued: result, task: redactTaskProviderSession(task) });
      }
      const rich = result as {
        mode: 'queued' | 'duplicate';
        queued: readonly string[];
        reason?: string;
        priorMode?: string;
      };
      if (rich.mode === 'duplicate') {
        return c.json({
          mode: 'duplicate',
          queued: rich.queued,
          task: redactTaskProviderSession(task),
          reason: rich.reason ?? 'already delivered',
          ...(rich.priorMode ? { priorMode: rich.priorMode } : {}),
        });
      }
      return c.json({ mode: 'queued', queued: rich.queued, task: redactTaskProviderSession(task) });
    }

    try {
      const result = await deps.actions.chat(id, message, { clientMessageId });
      return c.json({ ...result, task: redactTaskProviderSession(result.task) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ── Free Remote Control sessions (no task) ──────────────────────────

  app.get('/api/sessions', (c) => {
    if (!deps.sessions) return c.json({ sessions: [] });
    return c.json({ sessions: deps.sessions.list().map(redactRemoteSessionProviderSession) });
  });

  app.get('/api/sessions/:id', (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    const s = deps.sessions.get(id);
    if (!s) return c.json({ error: `unknown session '${id}'` }, 404);
    return c.json(redactRemoteSessionProviderSession(s));
  });

  app.post('/api/sessions', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    let body: {
      repo?: unknown;
      message?: unknown;
      title?: unknown;
      adapter?: unknown;
      permissionMode?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const repo = typeof body.repo === 'string' ? body.repo : '';
    const message = typeof body.message === 'string' ? body.message : '';
    const title = typeof body.title === 'string' ? body.title : undefined;
    let adapter: import('../domain/agents.js').AdapterKind | null | undefined;
    if (body.adapter === null || body.adapter === '') adapter = null;
    else if (typeof body.adapter === 'string' && isAdapterKind(body.adapter)) adapter = body.adapter;
    else if (body.adapter !== undefined) {
      return c.json({ error: 'invalid adapter' }, 400);
    }
    let permissionMode: import('../domain/session.js').PermissionMode | undefined;
    if (body.permissionMode !== undefined) {
      if (!isPermissionMode(body.permissionMode)) {
        return c.json({ error: 'invalid permissionMode (default|acceptEdits|bypass)' }, 400);
      }
      permissionMode = body.permissionMode;
    }
    try {
      const session = await deps.sessions.start({
        repo,
        message,
        ...(title !== undefined ? { title } : {}),
        ...(adapter !== undefined ? { adapter } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      });
      return c.json(redactRemoteSessionProviderSession(session), 201);
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    let body: {
      message?: unknown;
      interrupt?: unknown;
      attachments?: unknown;
      refs?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const message = typeof body.message === 'string' ? body.message : '';
    const interrupt = body.interrupt === true;
    const attachments = parseAttachments(body.attachments);
    const refs = parseRefs(body.refs);
    try {
      return c.json(redactRemoteSessionProviderSession(
        await deps.sessions.send(id, message, {
          ...(interrupt ? { interrupt: true } : {}),
          ...(attachments ? { attachments } : {}),
          ...(refs ? { refs } : {}),
        }),
      ));
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  /** Open/reuse a live session bound to a control-repo task (Session UI). */
  app.post('/api/tasks/:id/live-session', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    try {
      return c.json(redactRemoteSessionProviderSession(await deps.sessions.openTaskLive(id)), 201);
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  /** Upload an attachment (multipart field `file`). Returns ChatAttachment JSON. */
  app.post('/api/sessions/:id/attachments', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    try {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return c.json({ error: 'file field required' }, 400);
      }
      const blob = file as File;
      const buf = Buffer.from(await blob.arrayBuffer());
      const result = await deps.sessions.attachFile(id, {
        name: blob.name || 'upload',
        mime: blob.type || 'application/octet-stream',
        data: buf,
      });
      return c.json(result.attachment, 201);
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  /** Worktree diff for Diff drawer. */
  app.get('/api/sessions/:id/diff', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    try {
      return c.json(await deps.sessions.diff(id));
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  /**
   * Grok Speech-to-Text (xAI). Client records audio (WAV); daemon proxies with
   * XAI_API_KEY / GROK_API_KEY. Never expose the key to the SPA.
   */
  app.get('/api/stt', (c) =>
    c.json({
      configured: isSttConfigured(),
      provider: 'grok',
      hint: isSttConfigured()
        ? 'POST multipart field `file` (audio/wav preferred). Uses Grok STT.'
        : 'Set XAI_API_KEY or Grok CLI login for server STT; composer may still use browser speech.',
    }),
  );

  app.post('/api/stt', async (c) => {
    try {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return c.json({ error: 'file field required' }, 400);
      }
      const blob = file as File;
      const buf = Buffer.from(await blob.arrayBuffer());
      const languageRaw = form.get('language');
      const language =
        typeof languageRaw === 'string' && languageRaw.trim() ? languageRaw.trim() : undefined;
      const result = await transcribeAudio({
        data: buf,
        filename: blob.name || 'voice.wav',
        mime: blob.type || 'audio/wav',
        ...(language ? { language } : {}),
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof SttError) {
        return c.json({ error: err.message, code: err.code }, err.status as 400 | 422 | 502 | 503);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * Grok Voice Control (Realtime): mint ephemeral client secret for browser WS.
   * Tools execute client-side against Hercules APIs — no coding / worktree tools.
   */
  app.get('/api/voice/session', (c) =>
    c.json({
      configured: isVoiceConfigured(),
      provider: 'grok-realtime',
      hint: isVoiceConfigured()
        ? 'POST to mint an ephemeral client secret for Voice Control.'
        : 'Set XAI_API_KEY, or log in with Grok CLI (~/.grok/auth.json), then restart.',
    }),
  );

  app.post('/api/voice/session', async (c) => {
    try {
      const minted = await mintVoiceClientSecret();
      return c.json({ success: true, ...minted });
    } catch (err) {
      if (err instanceof VoiceError) {
        return c.json({ success: false, error: err.message, code: err.code }, err.status as 502 | 503);
      }
      return c.json(
        { success: false, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  /**
   * Weekly AI avatar (Grok Imagine). Ensures this ISO week's portrait exists,
   * then returns metadata. Image bytes: GET /api/voice/avatar/image.
   */
  app.get('/api/voice/avatar', async (c) => {
    const workRoot = deps.workRoot;
    const weekKey = isoWeekKey();
    const persona = weekPersona(weekKey);
    if (!workRoot) {
      return c.json({
        ready: false,
        weekKey,
        name: persona.name,
        error: 'workRoot not configured',
        fallback: 'svg',
      });
    }
    const force = c.req.query('force') === '1';
    const result = await ensureWeeklyAvatar({ workRoot, weekKey, force });
    if (result.ok) {
      // Cache-bust query so phones do not keep a day-old portrait after regen.
      const t = encodeURIComponent(result.meta.generatedAt || result.meta.weekKey);
      return c.json({
        ready: true,
        weekKey: result.meta.weekKey,
        name: result.meta.name,
        generatedAt: result.meta.generatedAt,
        model: result.meta.model,
        cached: result.cached,
        imagePath: `/api/voice/avatar/image?w=${encodeURIComponent(result.meta.weekKey)}&t=${t}`,
      });
    }
    return c.json({
      ready: false,
      weekKey,
      name: persona.name,
      error: result.error,
      fallback: 'svg',
    });
  });

  app.get('/api/voice/avatar/image', async (c) => {
    const workRoot = deps.workRoot;
    if (!workRoot) return c.json({ error: 'workRoot not configured' }, 503);
    const weekKey = c.req.query('w')?.trim() || isoWeekKey();
    if (!/^20\d{2}-W\d{2}$/.test(weekKey)) {
      return c.json({ error: 'invalid week key' }, 400);
    }
    let cached = await readCachedAvatar(workRoot, weekKey);
    if (!cached) {
      const result = await ensureWeeklyAvatar({ workRoot, weekKey });
      if (!result.ok) return c.json({ error: result.error }, 503);
      cached = await readCachedAvatar(workRoot, weekKey);
    }
    if (!cached) return c.json({ error: 'avatar not available' }, 503);
    // Short private cache + ETag so redeployed faces show after hard refresh.
    const etag = `"${weekKey}-${cached.meta.generatedAt || cached.bytes.length}"`;
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': 'private, max-age=60' } });
    }
    return new Response(new Uint8Array(cached.bytes), {
      status: 200,
      headers: {
        'content-type': cached.contentType,
        'cache-control': 'private, max-age=60',
        etag,
        'x-voice-avatar-week': weekKey,
        'x-voice-avatar-name': cached.meta.name,
      },
    });
  });

  /**
   * Patch free-session UI/control fields.
   * Body may include any of: permissionMode, pinned, archived.
   * (Previously two handlers shared this path; the first always won and broke archive/pin.)
   */
  app.patch('/api/sessions/:id', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    let body: { permissionMode?: unknown; pinned?: unknown; archived?: unknown };
    try {
      body = (await c.req.json()) as {
        permissionMode?: unknown;
        pinned?: unknown;
        archived?: unknown;
      };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const hasMode = body.permissionMode !== undefined;
    const hasPinned = typeof body.pinned === 'boolean';
    const hasArchived = typeof body.archived === 'boolean';
    if (!hasMode && !hasPinned && !hasArchived) {
      return c.json(
        { error: 'patch requires permissionMode and/or pinned and/or archived' },
        400,
      );
    }
    if (hasMode && !isPermissionMode(body.permissionMode)) {
      return c.json({ error: 'invalid permissionMode (default|acceptEdits|bypass)' }, 400);
    }
    try {
      let session = deps.sessions.get(id);
      if (!session) return c.json({ error: `unknown session '${id}'` }, 404);
      if (hasMode) {
        session = deps.sessions.setPermissionMode(id, body.permissionMode as import('../domain/session.js').PermissionMode);
      }
      if (hasPinned) {
        session = deps.sessions.setPinned(id, body.pinned as boolean);
      }
      if (hasArchived) {
        session = deps.sessions.setArchived(id, body.archived as boolean);
      }
      return c.json(redactRemoteSessionProviderSession(session));
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  /** Resolve a phone permission card. */
  app.post('/api/sessions/:id/permissions/:permId', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    const permId = c.req.param('permId');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    let body: { optionId?: unknown };
    try {
      body = (await c.req.json()) as { optionId?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const optionId = typeof body.optionId === 'string' ? body.optionId : '';
    try {
      return c.json(redactRemoteSessionProviderSession(
        deps.sessions.resolvePermission(id, permId, optionId),
      ));
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  app.post('/api/sessions/:id/stop', (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    try {
      return c.json(redactRemoteSessionProviderSession(deps.sessions.stop(id)));
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  /**
   * Draft a control-repo task from chat (human reviews before create).
   * GET returns suggested title/body/repo — no mutation.
   */
  app.get('/api/sessions/:id/task-draft', (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    try {
      return c.json(deps.sessions.taskDraft(id));
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  /**
   * Approve an agent-suggested task proposal (from ```hercules-task-proposal).
   * Human-only; never auto-created from agent text alone.
   */
  app.post('/api/sessions/:id/proposals/:proposalId/approve', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    const proposalId = c.req.param('proposalId');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    let body: { title?: unknown; repo?: unknown; body?: unknown; priority?: unknown } = {};
    try {
      const raw = await c.req.text();
      if (raw.trim()) body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      const proposal = deps.sessions.getProposal(id, proposalId);
      const session = deps.sessions.get(id);
      if (!session) return c.json({ error: `unknown session '${id}'` }, 404);
      const title =
        typeof body.title === 'string' && body.title.trim()
          ? body.title.trim()
          : proposal.title;
      const repo =
        typeof body.repo === 'string' && body.repo.trim()
          ? body.repo.trim()
          : (proposal.repo ?? session.repo);
      const taskBody =
        typeof body.body === 'string' && body.body.trim() ? body.body : proposal.body;
      const priority =
        typeof body.priority === 'number'
          ? body.priority
          : (proposal.priority ?? 50);
      const task = await deps.actions.createTask({
        title,
        repo,
        body: taskBody,
        priority,
        ...(session.adapter ? { adapter: session.adapter } : {}),
        labels: ['from-chat', 'agent-proposal', id],
      });
      const updatedSession = deps.sessions.linkTask(id, task.id, proposalId);
      return c.json({
        task: redactTaskProviderSession(task),
        session: redactRemoteSessionProviderSession(updatedSession),
      }, 201);
    } catch (err) {
      if (err instanceof SessionError) return sessionErrorResponse(c, err);
      return errorResponse(c, err);
    }
  });

  /** Dismiss an agent task proposal. */
  app.post('/api/sessions/:id/proposals/:proposalId/dismiss', (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    const proposalId = c.req.param('proposalId');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    try {
      return c.json(
        redactRemoteSessionProviderSession(
          deps.sessions.dismissProposal(id, proposalId),
        ),
      );
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  /**
   * Create a task from chat — **requires explicit human confirm** (phone form).
   * Never auto-creates from agent text alone.
   */
  app.post('/api/sessions/:id/tasks', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    let body: {
      title?: unknown;
      repo?: unknown;
      body?: unknown;
      priority?: unknown;
      adapter?: unknown;
      confirm?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    // Explicit confirm flag so casual POSTs cannot invent tasks by accident.
    if (body.confirm !== true) {
      return c.json({ error: 'confirm:true is required to create a task from chat' }, 400);
    }
    const session = deps.sessions.get(id);
    if (!session) return c.json({ error: `unknown session '${id}'` }, 404);
    const draft = deps.sessions.taskDraft(id);
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : draft.title;
    const repo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : draft.repo;
    const taskBody =
      typeof body.body === 'string' && body.body.trim() ? body.body : draft.body;
    const priority = typeof body.priority === 'number' ? body.priority : 50;
    let adapter: import('../domain/agents.js').AdapterKind | null | undefined;
    if (body.adapter === null || body.adapter === '') adapter = null;
    else if (typeof body.adapter === 'string' && isAdapterKind(body.adapter)) adapter = body.adapter;
    try {
      const task = await deps.actions.createTask({
        title,
        repo,
        body: taskBody,
        priority,
        ...(adapter !== undefined ? { adapter } : session.adapter ? { adapter: session.adapter } : {}),
        labels: ['from-chat', id],
      });
      const updatedSession = deps.sessions.linkTask(id, task.id);
      return c.json({
        task: redactTaskProviderSession(task),
        session: redactRemoteSessionProviderSession(updatedSession),
      }, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.delete('/api/sessions/:id', async (c) => {
    if (!deps.sessions) return c.json({ error: 'sessions disabled' }, 503);
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: `unknown session '${id}'` }, 404);
    try {
      return c.json(await deps.sessions.close(id));
    } catch (err) {
      return sessionErrorResponse(c, err);
    }
  });

  app.post('/api/tasks/:id/:action', async (c) => {
    const id = c.req.param('id');
    const action = c.req.param('action');
    if (!ACTIONS.includes(action as ActionName)) {
      return c.json({ error: `unknown action '${action}'` }, 404);
    }
    try {
      if (action === 'approve') {
        const approveOpts = await readApproveOpts(c);
        return c.json(redactTaskProviderSession(await deps.actions.approve(id, approveOpts)));
      }
      if (action === 'cancel') {
        // Disk first (durable cancelled), then abort live agent/verify immediately
        // so L1 cargo does not outlive the cancel (2026-07-31 incident).
        const task = await deps.actions.cancel(id);
        deps.runtime.requestCancel?.(id);
        return c.json(redactTaskProviderSession(task));
      }
      return c.json(redactTaskProviderSession(
        await deps.actions[action as Exclude<ActionName, 'approve' | 'cancel'>](id),
      ));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.delete('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidIdentifier(id)) return c.json({ error: `unknown task '${id}'` }, 404);
    // Default cleanup=true; ?cleanup=0 or body.cleanup=false opts out.
    let cleanup = true;
    const q = c.req.query('cleanup');
    if (q === '0' || q === 'false') cleanup = false;
    try {
      const raw = await c.req.text();
      if (raw.trim().length > 0) {
        try {
          const body = JSON.parse(raw) as { cleanup?: unknown };
          if (body.cleanup === false) cleanup = false;
          if (body.cleanup === true) cleanup = true;
        } catch {
          /* ignore non-JSON body */
        }
      }
    } catch {
      /* no body */
    }
    try {
      return c.json(await deps.actions.deleteTask(id, { cleanup }));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Self-update status (Settings). Always available when the service is wired;
   * without wiring, returns 404 so older tests stay green.
   */
  app.get('/api/system/update', (c) => {
    const svc = deps.selfUpdate;
    if (!svc) return c.json({ error: 'self-update not configured' }, 404);
    return c.json(svc.status());
  });

  /**
   * Pull latest code → pnpm install → build → systemctl restart.
   * Requires `{ confirm: true }` (phone ConfirmButton is not enough alone).
   */
  app.post('/api/system/update', async (c) => {
    const svc = deps.selfUpdate;
    if (!svc) return c.json({ error: 'self-update not configured' }, 404);
    let body: { confirm?: unknown } = {};
    try {
      body = (await c.req.json()) as { confirm?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (body.confirm !== true) {
      return c.json(
        { error: 'confirm:true is required to pull, build, and restart' },
        400,
      );
    }
    try {
      // 202 Accepted — pipeline continues in the background; process may die on restart.
      return c.json(svc.start(), 202);
    } catch (err) {
      if (err instanceof SelfUpdateError) {
        const msg = err.message;
        if (/disabled/i.test(msg)) return c.json({ error: msg }, 403);
        if (/already|in progress/i.test(msg)) return c.json({ error: msg }, 409);
        return c.json({ error: msg }, 400);
      }
      throw err;
    }
  });

  /**
   * Disk hygiene GC (admin): free residual worktrees (+ optional screenshots)
   * for terminal tasks past retention. Never deletes remote branches or
   * control-repo history. Body: `{ dryRun?: boolean, purgeScreenshots?: boolean }`.
   * Always returns (and logs) one operator digest line.
   */
  app.post('/api/system/worktree-gc', async (c) => {
    let body: { dryRun?: unknown; purgeScreenshots?: unknown } = {};
    try {
      body = (await c.req.json()) as { dryRun?: unknown; purgeScreenshots?: unknown };
    } catch {
      /* empty body = use daemon defaults */
    }
    try {
      const result = await deps.actions.runWorktreeGc({
        ...(typeof body.dryRun === 'boolean' ? { dryRun: body.dryRun } : {}),
        ...(typeof body.purgeScreenshots === 'boolean'
          ? { purgeScreenshots: body.purgeScreenshots }
          : {}),
      });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // SSE: push the current state immediately, then on every tick. Latest-wins
  // pump per connection — a stalled client must never queue snapshots
  // (4GB-heap SIGABRT, 2026-07-24); only the newest view matters.
  // Draft jobs use a per-job latest-wins pump so a stalled phone only ever
  // has the newest frame per jobId in flight (not a backlog of thinking tails).
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (view: RuntimeView): Promise<void> =>
        stream.writeSSE({ event: 'state', data: JSON.stringify(serializeState(view)) });

      await send(deps.runtime.getState());

      for (const job of draftJobs.list()) {
        await stream.writeSSE({
          event: 'draft',
          data: JSON.stringify({ job }),
        });
      }

      const pump = makeLatestWinsPump<RuntimeView>(send);
      const unsubscribe = deps.runtime.subscribe((view) => {
        pump.push(view);
      });

      const draftPumps = new Map<string, LatestWinsPump<DraftJobEvent>>();
      const writeDraft = async (ev: DraftJobEvent): Promise<void> => {
        if (ev.kind === 'removed') {
          await stream.writeSSE({
            event: 'draft',
            data: JSON.stringify({ removed: ev.id }),
          });
          return;
        }
        await stream.writeSSE({
          event: 'draft',
          data: JSON.stringify({ job: ev.job }),
        });
      };
      const unsubDraft = draftJobs.subscribe((ev) => {
        const id = ev.kind === 'removed' ? ev.id : ev.job.id;
        let jobPump = draftPumps.get(id);
        if (!jobPump) {
          jobPump = makeLatestWinsPump<DraftJobEvent>(async (pending) => {
            await writeDraft(pending);
            if (pending.kind === 'removed') draftPumps.delete(id);
          });
          draftPumps.set(id, jobPump);
        }
        jobPump.push(ev);
      });

      stream.onAbort(() => {
        unsubscribe();
        unsubDraft();
      });
      // Keep the stream open until the client disconnects.
      while (!stream.aborted) {
        await stream.sleep(15_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '1' });
      }
    }),
  );

  return app;
}

function parseDependencyRewireInput(
  raw: unknown,
): { readonly ok: true; readonly value: RewireDependenciesInput } | { readonly ok: false; readonly reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'request must be an object' };
  }
  const record = raw as Record<string, unknown>;
  const rootExtra = Object.keys(record).filter((key) => key !== 'changes');
  if (rootExtra.length > 0) return { ok: false, reason: `unsupported field '${rootExtra[0]}'` };
  if (!Array.isArray(record['changes'])) return { ok: false, reason: 'changes must be an array' };
  const changes: RewireDependenciesInput['changes'][number][] = [];
  const allowed = new Set(['id', 'expectedBlockedBy', 'blockedBy', 'dependencyMode']);
  for (const rawChange of record['changes']) {
    if (!rawChange || typeof rawChange !== 'object' || Array.isArray(rawChange)) {
      return { ok: false, reason: 'each change must be an object' };
    }
    const change = rawChange as Record<string, unknown>;
    const extra = Object.keys(change).find((key) => !allowed.has(key));
    if (extra) return { ok: false, reason: `unsupported field '${extra}'` };
    if (typeof change['id'] !== 'string') return { ok: false, reason: 'change id must be a string' };
    if (!Array.isArray(change['expectedBlockedBy']) || !change['expectedBlockedBy'].every((id) => typeof id === 'string')) {
      return { ok: false, reason: 'expectedBlockedBy must be a string array' };
    }
    if (!Array.isArray(change['blockedBy']) || !change['blockedBy'].every((id) => typeof id === 'string')) {
      return { ok: false, reason: 'blockedBy must be a string array' };
    }
    if (change['dependencyMode'] !== 'gate_merge' && change['dependencyMode'] !== 'completion_only') {
      return { ok: false, reason: 'dependencyMode must be gate_merge or completion_only' };
    }
    changes.push({
      id: change['id'],
      expectedBlockedBy: change['expectedBlockedBy'],
      blockedBy: change['blockedBy'],
      dependencyMode: change['dependencyMode'],
    });
  }
  return { ok: true, value: { changes } };
}

/**
 * Optional JSON body for approve / approve-pr:
 * `{ "humanAcknowledged": ["criterion text", ...] }`.
 * Empty body or missing field ⇒ no acknowledgements (blocks when human ACs exist).
 */
async function readApproveOpts(
  c: Context,
): Promise<{ humanAcknowledged?: readonly string[]; overrideNote?: string }> {
  try {
    const raw = await c.req.text();
    if (raw.trim().length === 0) return {};
    const parsed = JSON.parse(raw) as { humanAcknowledged?: unknown; overrideNote?: unknown };
    const overrideNote =
      typeof parsed.overrideNote === 'string' && parsed.overrideNote.trim().length > 0
        ? parsed.overrideNote.trim()
        : undefined;
    if (!Array.isArray(parsed.humanAcknowledged)) {
      return overrideNote ? { overrideNote } : {};
    }
    const humanAcknowledged = parsed.humanAcknowledged
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { humanAcknowledged, ...(overrideNote ? { overrideNote } : {}) };
  } catch {
    // Missing or non-JSON body is fine for legacy clients without human ACs.
    return {};
  }
}

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof ControlMutationConflictError) {
    return c.json({ error: err.message, conflict: true, retryable: err.retryable }, 409);
  }
  if (err instanceof ActionConflictError) {
    return c.json({ error: err.message, conflict: true }, 409);
  }
  if (err instanceof ActionError) {
    const status = /unknown (task|repo|merge operation)/.test(err.message)
      ? 404
      : /merge already in flight/.test(err.message)
        ? 409
        : 400;
    return c.json(
      {
        error: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
        ...(err.paths !== undefined ? { paths: err.paths } : {}),
        ...(err.rule !== undefined ? { rule: err.rule } : {}),
      },
      status,
    );
  }
  throw err;
}

function redactRepoOwnerCheckouts(repo: RepoConfig): Omit<RepoConfig, 'ownerCheckouts'> {
  const { ownerCheckouts: _privateRegistrations, ...publicRepo } = repo;
  return publicRepo;
}

function sessionErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof SessionError) {
    const status = /unknown (session|repo|task)/.test(err.message) ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
  throw err;
}

function parseAttachments(
  raw: unknown,
): import('../domain/session.js').ChatAttachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: import('../domain/session.js').ChatAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || typeof o['relPath'] !== 'string') continue;
    if (typeof o['name'] !== 'string' || typeof o['mime'] !== 'string') continue;
    if (typeof o['bytes'] !== 'number') continue;
    const kind = o['kind'] === 'image' ? 'image' : 'file';
    out.push({
      id: o['id'],
      kind,
      name: o['name'],
      relPath: o['relPath'],
      mime: o['mime'],
      bytes: o['bytes'],
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseRefs(raw: unknown): import('../domain/session.js').MessageRef[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: import('../domain/session.js').MessageRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const kind = o['kind'];
    const target = o['target'];
    if (kind !== 'task' && kind !== 'file' && kind !== 'pr') continue;
    if (typeof target !== 'string' || target.trim().length === 0) continue;
    out.push({
      kind,
      target: target.trim(),
      ...(typeof o['label'] === 'string' ? { label: o['label'] } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}
