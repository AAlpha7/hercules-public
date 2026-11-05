/**
 * M12 engine chain — GENUINELY DRIVES the real M6/M9/M10/M11 decision engines
 * over ONE seeded spine and binds their outputs into an
 * `AssembleCapabilityProofInputsV1` bundle. The M8 receipt is CONSTRUCTED (not
 * coordinator-driven) and the browser evidence is a self-seeded browser-surface
 * artifact (not the M7 L2 provider); both are documented realizability decisions.
 *
 * - M6: `projectAndAssertReviewPackageV2` (real).
 * - M9: `createRepairRouter().route` (real) over a projected qualified view.
 * - M10: `admitLease` + `validateResult` (real).
 * - M11: `decideControlApiV2` (real) for create + decision.
 * - M8: receipt CONSTRUCTED via the real `computeEvaluationReceiptHash` +
 *   `assertIndependentEvaluationReceiptV1` (owner decision
 *   `m12-evaluation-construction`) — driving `createIndependentEvaluationCoordinator`
 *   would port ~1k lines of the trusted-eval runtime, disproportionate for a
 *   composition fixture; M8's verdict logic is proven in its own suite.
 * - Browser evidence: a self-seeded genuine browser-surface DOM-snapshot artifact
 *   (owner decision `m12-browser-evidence-seeding`) — wiring the 1640-line
 *   L2-gated M7 provider is likewise disproportionate for a composition fixture.
 * Spine identity fields are pinned; all own-hashes are recomputed.
 */

import {
  computeCapabilityCostHash,
  type AssembleCapabilityProofInputsV1,
  type CapabilityArchetypeV1,
  type CapabilityCostV1,
  type CapabilityOperatorReviewV1,
} from '../domain/capabilityProof.js';
import {
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  deriveAggregateId,
  type AdmissionVerdictV1,
  type ControlApiV2ReadsV1,
  type ControlApiV2RequestV1,
  type CreatePayloadV1,
  type DecisionPayloadV1,
} from '../domain/controlApiV2.js';
import type { IndependentEvaluationReceiptV1 } from '../domain/independentEvaluation.js';
import {
  computeFailureSignature,
  computeInputHash,
  computeRecordHash,
  computeViewHash,
  type IterationAttemptRecordV1,
  type QualifiedEvaluationReceiptViewV1,
  type RoutingDecisionV1,
  type RoutingInputV1,
} from '../domain/repairRouting.js';
import {
  projectAndAssertReviewPackageV2,
  type M6OutcomeDecision,
  type ReviewPackageV2,
  type ReviewPackageV2Source,
} from '../domain/reviewPackageV2.js';
import {
  computeEnvironmentPolicyHash,
  computeGrantHash,
  computeJobSpecHash,
  computeLeasePolicyHash,
  computePayloadHash,
  computeResultHash,
  type JobSpecV1,
  type ResultAdmissionV1,
  type ResultPackageV1,
  type WorkerLeaseV1,
} from '../domain/workerBoundary.js';
import { decideControlApiV2 } from '../controlapi/requestPolicy.js';
import {
  createRepairRouter,
  type TrustedRoutingReceiptReconfirmationV1,
} from '../routing/repairRouter.js';
import { admitLease } from '../worker/leasePolicy.js';
import { validateResult } from '../worker/resultValidation.js';
import { buildEvaluationReceipt } from './evaluationReceipt.js';
import {
  PROOF_CANDIDATE_COMMIT,
  ProofHarnessError,
  buildReviewPackageSource,
} from './spine.js';

/** Arbitrary (non-recomputed) digest used for intentDigest / nested placeholders. */
const INTENT_DIGEST =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WORKSPACE_REF =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const COMMAND_HASH =
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const OUTPUT_SCHEMA_REF =
  'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ARTIFACT_SHA =
  'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

const T0 = '2026-08-29T00:00:00.000Z';
const T_PLUS_1S = '2026-08-29T00:00:01.000Z';
const T_PLUS_5S = '2026-08-29T00:00:05.000Z';
const T_PLUS_6S = '2026-08-29T00:00:06.000Z';
const STATE_VERSION = 3;

export interface EngineChainSeed {
  readonly archetype: CapabilityArchetypeV1;
  readonly taskId: string;
  /** Final (evaluated) iteration — bound into M5/M6/R2. */
  readonly finalIterationId: string;
  /**
   * When set, drive the M9 repair loop: R1 fail on this iteration, R2 pass on
   * `finalIterationId`, same taskId.
   */
  readonly failIterationId?: string;
  readonly decisionAction: M6OutcomeDecision;
  /** When true, M6 validDecisions includes approve_outcome (needs_human). */
  readonly requiresHumanDecision?: boolean;
}

function identityReconfirm(): TrustedRoutingReceiptReconfirmationV1 {
  return {
    reconfirm(view) {
      return view;
    },
  };
}

function projectQualifiedView(
  receipt: IndependentEvaluationReceiptV1,
  overrides: {
    readonly outcomeReasonCodes?: readonly string[];
    readonly blockingFindingCodes?: readonly string[];
    readonly qualifiedAt?: string;
  } = {},
): QualifiedEvaluationReceiptViewV1 {
  const outcomeReasonCodes = overrides.outcomeReasonCodes ?? [
    ...receipt.outcomeReasonCodes,
  ];
  const blockingFindingCodes =
    overrides.blockingFindingCodes ??
    receipt.verdict.blockingFindings.map((finding) => finding.code).sort();
  const withoutHash: Omit<QualifiedEvaluationReceiptViewV1, 'viewHash'> = {
    schema: 'hercules-qualified-evaluation-receipt-view/v1',
    receiptId: receipt.receiptId,
    requestId: receipt.requestId,
    taskId: receipt.taskId,
    taskContractHash: receipt.taskContractHash,
    iterationId: receipt.iterationId,
    candidateCommit: receipt.candidateCommit,
    outcome: receipt.verdict.outcome,
    recommendedNextStage: receipt.verdict.recommendedNextStage,
    outcomeReasonCodes,
    blockingFindingCodes,
    requiredHumanCriterionPending: false,
    evaluatorInfrastructureFailed: outcomeReasonCodes.some(
      (code) =>
        code === 'evaluator_contract_violation' ||
        code === 'evaluator_unavailable',
    ),
    failureSignature: computeFailureSignature(
      receipt.verdict.outcome,
      outcomeReasonCodes,
      blockingFindingCodes,
    ),
    qualifiedAt: overrides.qualifiedAt ?? '2026-08-29T00:00:09.000Z',
  };
  return {
    ...withoutHash,
    viewHash: computeViewHash(withoutHash),
  };
}

function routeRepair(
  failReceipt: IndependentEvaluationReceiptV1,
  now: string,
): RoutingDecisionV1 {
  const view = projectQualifiedView(failReceipt, {
    // Clean verified_defect subset so classifyFailure → repair (not escalate).
    outcomeReasonCodes: ['required_criterion_failed'],
    blockingFindingCodes: [],
  });
  const attemptWithoutHash: Omit<IterationAttemptRecordV1, 'recordHash'> = {
    iterationId: view.iterationId,
    ordinal: 1,
    state: 'failed',
    candidateCommit: view.candidateCommit,
    finalVerdictId: failReceipt.verdict.id,
    failureSignature: view.failureSignature,
    nonReversibleActionTaken: false,
    supersedesIterationId: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    endedAt: '2026-08-29T00:00:01.000Z',
  };
  const history: readonly IterationAttemptRecordV1[] = [
    {
      ...attemptWithoutHash,
      recordHash: computeRecordHash(attemptWithoutHash),
    },
  ];
  const withoutHash: Omit<RoutingInputV1, 'inputHash'> = {
    schema: 'hercules-routing-input/v1',
    decisionRequestId: `decision-${failReceipt.receiptId}`,
    taskId: failReceipt.taskId,
    receipt: view,
    history,
    budget: {
      maxAttempts: 3,
      maxSameSignatureRepeats: 2,
      attemptsUsed: 1,
      costExceeded: false,
      tokensExceeded: false,
      durationExceeded: false,
    },
  };
  const input: RoutingInputV1 = {
    ...withoutHash,
    inputHash: computeInputHash(withoutHash),
  };
  const router = createRepairRouter(identityReconfirm(), {
    clock: { nowUtc: () => now },
  });
  const outcome = router.route(input);
  if (outcome.kind !== 'decision') {
    throw new ProofHarnessError(
      `M9 repair router did not return a decision (kind=${outcome.kind})`,
    );
  }
  if (outcome.decision.route !== 'repair') {
    throw new ProofHarnessError(
      `M9 expected route 'repair', got '${outcome.decision.route}'`,
    );
  }
  if (outcome.decision.receiptId !== failReceipt.receiptId) {
    throw new ProofHarnessError(
      'M9 routing decision receiptId must equal the fail receipt receiptId',
    );
  }
  if (outcome.decision.taskId !== failReceipt.taskId) {
    throw new ProofHarnessError(
      'M9 routing decision taskId must equal the fail receipt taskId',
    );
  }
  return outcome.decision;
}

function buildJobSpec(args: {
  readonly taskId: string;
  readonly taskContractHash: string;
  readonly iterationId: string;
  readonly jobId: string;
}): JobSpecV1 {
  const grantWithoutHash = {
    grantId: 'grant-1',
    capabilityId: 'cap-net',
    operation: 'fetch',
    scope: 'repo:example',
    issuedAt: T0,
    expiresAt: '2026-08-29T01:00:00.000Z',
  };
  const grant = {
    ...grantWithoutHash,
    grantHash: computeGrantHash(grantWithoutHash),
  };
  const payloadWithoutHash = {
    workspaceRef: WORKSPACE_REF,
    inputArtifacts: [
      { artifactId: 'artifact-1', sha256: ARTIFACT_SHA, byteLength: 4 },
    ],
    agentRole: 'implementer' as const,
    commandOrSpecHash: COMMAND_HASH,
    outputSchemaRef: OUTPUT_SCHEMA_REF,
  };
  const executionPayload = {
    ...payloadWithoutHash,
    payloadHash: computePayloadHash(payloadWithoutHash),
  };
  const envWithoutHash = {
    cleanPolicy: 'clean' as const,
    maxDurationMs: 60_000,
    maxOutputBytes: 1_048_576,
    allowedCapabilityIds: ['cap-net'],
  };
  const environmentPolicy = {
    ...envWithoutHash,
    policyHash: computeEnvironmentPolicyHash(envWithoutHash),
  };
  const leaseWithoutHash = {
    heartbeatIntervalMs: 5_000,
    leaseDurationMs: 30_000,
    maxLeaseLifetimeMs: 300_000,
  };
  const leasePolicy = {
    ...leaseWithoutHash,
    leasePolicyHash: computeLeasePolicyHash(leaseWithoutHash),
  };
  const withoutHash: Omit<JobSpecV1, 'jobSpecHash'> = {
    schema: 'hercules-job-spec/v1',
    issuer: 'hercules-program-control',
    jobId: args.jobId,
    taskId: args.taskId,
    taskContractHash: args.taskContractHash,
    iterationId: args.iterationId,
    candidateCommit: PROOF_CANDIDATE_COMMIT,
    stageType: 'implement',
    executionPayload,
    capabilityGrants: [grant],
    environmentPolicy,
    leasePolicy,
    authorityEpoch: 'epoch-1',
    issuedAt: T0,
    expiresAt: '2026-08-29T02:00:00.000Z',
  };
  return {
    ...withoutHash,
    jobSpecHash: computeJobSpecHash(withoutHash),
  };
}

function driveWorkerBoundary(args: {
  readonly jobSpec: JobSpecV1;
  readonly workerId: string;
}): {
  readonly resultPackage: ResultPackageV1;
  readonly resultAdmission: ResultAdmissionV1;
  readonly lease: WorkerLeaseV1;
} {
  const leaseAdmission = admitLease(null, args.jobSpec, args.workerId, T0);
  if (leaseAdmission.outcome !== 'admitted' || leaseAdmission.lease === null) {
    throw new ProofHarnessError(
      `M10 admitLease refused: ${leaseAdmission.reason ?? 'unknown'}`,
    );
  }
  const lease = leaseAdmission.lease;
  const artifacts = [
    { artifactId: 'artifact-1', sha256: ARTIFACT_SHA, byteLength: 4 },
  ];
  const resultWithoutHash: Omit<ResultPackageV1, 'resultHash'> = {
    schema: 'hercules-result-package/v1',
    resultId: `result-${args.jobSpec.jobId}`,
    jobId: args.jobSpec.jobId,
    jobSpecHash: args.jobSpec.jobSpecHash,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    workerId: lease.workerId,
    completionStatus: 'completed',
    exitCode: 0,
    startedAt: T_PLUS_1S,
    completedAt: T_PLUS_5S,
    artifacts,
    totalOutputBytes: artifacts.reduce(
      (sum, artifact) => sum + artifact.byteLength,
      0,
    ),
  };
  const resultPackage: ResultPackageV1 = {
    ...resultWithoutHash,
    resultHash: computeResultHash(resultWithoutHash),
  };
  const resultAdmission = validateResult(
    resultPackage,
    args.jobSpec,
    lease,
    [],
    T_PLUS_6S,
  );
  if (resultAdmission.outcome !== 'admitted') {
    throw new ProofHarnessError(
      `M10 validateResult refused: ${resultAdmission.reason ?? 'unknown'}`,
    );
  }
  return { resultPackage, resultAdmission, lease };
}

function emptyReads(
  overrides: Partial<ControlApiV2ReadsV1> = {},
): ControlApiV2ReadsV1 {
  return {
    aggregateExists: false,
    currentStateVersion: null,
    taskStatus: null,
    latestEventSequence: null,
    freshProjectionHash: null,
    reviewPackage: null,
    admissionLedger: [],
    events: null,
    eventsHasMore: false,
    ...overrides,
  };
}

function expectAdmissionVerdict(
  decision: ReturnType<typeof decideControlApiV2>,
  label: string,
): AdmissionVerdictV1 {
  if (
    decision === null ||
    typeof decision !== 'object' ||
    !('schema' in decision) ||
    decision.schema !== 'hercules-control-api-admit-verdict/v2'
  ) {
    throw new ProofHarnessError(
      `M11 ${label} did not return an AdmissionVerdictV1`,
    );
  }
  return decision;
}

function driveControlApi(args: {
  readonly taskContractHash: string;
  readonly reviewPackage: ReviewPackageV2;
  readonly decisionAction: M6OutcomeDecision;
  readonly clientSuffix: string;
  readonly now: string;
}): {
  readonly controlCreateRequest: ControlApiV2RequestV1;
  readonly controlCreateVerdict: AdmissionVerdictV1;
  readonly controlDecisionRequest: ControlApiV2RequestV1;
  readonly controlDecisionVerdict: AdmissionVerdictV1;
} {
  if (!args.reviewPackage.validDecisions.includes(args.decisionAction)) {
    throw new ProofHarnessError(
      `decision action '${args.decisionAction}' is not in M6 validDecisions`,
    );
  }

  const createPayload: CreatePayloadV1 = {
    kind: 'create',
    taskContractHash: args.taskContractHash,
    intentDigest: INTENT_DIGEST,
  };
  const createKey = buildIdempotencyKey({
    actorIssuer: 'hercules-web',
    actorId: 'actor-1',
    aggregateId: '',
    clientRequestId: `req-create-${args.clientSuffix}`,
  });
  const controlCreateRequest = buildControlApiV2Request({
    resource: 'task',
    operation: 'create',
    aggregateId: '',
    idempotencyKey: createKey,
    concurrencyToken: null,
    payload: createPayload,
    issuedAt: T0,
  });
  const controlCreateVerdict = expectAdmissionVerdict(
    decideControlApiV2(controlCreateRequest, emptyReads(), args.now),
    'create',
  );

  const aggregateId = deriveAggregateId(createKey.keyHash);
  const decisionPayload: DecisionPayloadV1 = {
    kind: 'decision',
    action: args.decisionAction,
    reason: 'Capability-proof decision',
    acknowledgedRiskCodes: [],
  };
  const decisionKey = buildIdempotencyKey({
    actorIssuer: 'hercules-web',
    actorId: 'actor-1',
    aggregateId,
    clientRequestId: `req-decision-${args.clientSuffix}`,
  });
  const concurrencyToken = buildConcurrencyToken({
    aggregateId,
    stateVersion: STATE_VERSION,
    projectionHash: args.reviewPackage.projectionHash,
  });
  const controlDecisionRequest = buildControlApiV2Request({
    resource: 'decision',
    operation: 'submit',
    aggregateId,
    idempotencyKey: decisionKey,
    concurrencyToken,
    payload: decisionPayload,
    issuedAt: T0,
  });
  const submitReads = emptyReads({
    aggregateExists: true,
    currentStateVersion: STATE_VERSION,
    taskStatus: 'review',
    latestEventSequence: 7,
    freshProjectionHash: args.reviewPackage.projectionHash,
    reviewPackage: args.reviewPackage,
    admissionLedger: [],
    events: null,
    eventsHasMore: false,
  });
  const controlDecisionVerdict = expectAdmissionVerdict(
    decideControlApiV2(controlDecisionRequest, submitReads, args.now),
    'decision',
  );

  return {
    controlCreateRequest,
    controlCreateVerdict,
    controlDecisionRequest,
    controlDecisionVerdict,
  };
}

function fixtureCost(): CapabilityCostV1 {
  const base = {
    inputTokens: 100,
    outputTokens: 50,
    wallClockMillis: 1_000,
    provenance: 'fixture_declared' as const,
  };
  return { ...base, costHash: computeCapabilityCostHash(base) };
}

function fixtureOperatorReview(): CapabilityOperatorReviewV1 {
  return { millis: 5_000, provenance: 'fixture_declared' };
}

/**
 * Drive M6 → M8(bind) → M9? → M10 → M11 over one spine and return the
 * assembler input bundle (archetype set from the seed; browserEvidenceRef null).
 */
/**
 * Fenced projector entry for non-production proof / qualification harnesses.
 *
 * The raw `projectAndAssertReviewPackageV2` authority import is confined to
 * this allowlisted src/proofs/ site (enforced by
 * reviewPackageV2AuthorityBoundary.test.ts). M13's src/qualification harness
 * drives real M6 projection over adversarially seeded/tampered sources through
 * this wrapper rather than importing the projector directly, keeping the
 * authority boundary tight.
 */
export function projectReviewPackageForProof(
  source: ReviewPackageV2Source,
): ReturnType<typeof projectAndAssertReviewPackageV2> {
  return projectAndAssertReviewPackageV2(source);
}

export function driveEngineChain(
  seed: EngineChainSeed,
  now: string,
): AssembleCapabilityProofInputsV1 {
  const requiresHumanDecision =
    seed.requiresHumanDecision ?? seed.decisionAction === 'approve_outcome';

  // --- Spine + M6 ---
  const source = buildReviewPackageSource({
    taskId: seed.taskId,
    iterationId: seed.finalIterationId,
    requiresHumanDecision,
    browserEvidence: seed.archetype === 'browser',
  });
  const reviewPackage = projectAndAssertReviewPackageV2(source);
  const contract = source.contract;
  if (source.evidenceManifest === null) {
    throw new ProofHarnessError('spine source must carry a non-null evidenceManifest');
  }
  const evidenceManifest = source.evidenceManifest;
  const spine = contract.contractHash;

  // --- M8 final (R2 / sole) pass receipt ---
  const evaluationReceipt = buildEvaluationReceipt({
    contract,
    evidenceManifest,
    requestId: `request-final-${seed.taskId}`,
    receiptId: `receipt-final-${seed.taskId}`,
    iterationId: seed.finalIterationId,
    outcome: 'pass',
  });

  // --- Optional M9 repair over a distinct fail iteration (R1) ---
  let routingDecision: RoutingDecisionV1 | null = null;
  let routedEvaluationReceipt: IndependentEvaluationReceiptV1 | null = null;
  if (seed.failIterationId !== undefined) {
    if (seed.failIterationId === seed.finalIterationId) {
      throw new ProofHarnessError(
        'failIterationId must be distinct from finalIterationId',
      );
    }
    // Fail receipt shares the FINAL spine contract (same taskContractHash +
    // taskId) but a distinct iteration. Its own fail-iteration manifest is
    // fine — the assembler only requires spine+taskId+distinct iteration on R1.
    // Build the fail-iteration source with the same approvalPolicy as the final
    // spine so the contract content (and thus contractHash) stays identical;
    // we still bind the receipt to the final `contract` object explicitly.
    const failSource = buildReviewPackageSource({
      taskId: seed.taskId,
      iterationId: seed.failIterationId,
      requiresHumanDecision,
    });
    if (failSource.contract.contractHash !== spine) {
      throw new ProofHarnessError(
        'fail-iteration spine contract hash diverged from final spine',
      );
    }
    if (failSource.evidenceManifest === null) {
      throw new ProofHarnessError(
        'fail-iteration source must carry a non-null evidenceManifest',
      );
    }
    routedEvaluationReceipt = buildEvaluationReceipt({
      contract,
      evidenceManifest: failSource.evidenceManifest,
      requestId: `request-fail-${seed.taskId}`,
      receiptId: `receipt-fail-${seed.taskId}`,
      iterationId: seed.failIterationId,
      outcome: 'fail',
    });
    routingDecision = routeRepair(routedEvaluationReceipt, now);
  }

  // --- M10 ---
  const jobSpec = buildJobSpec({
    taskId: seed.taskId,
    taskContractHash: spine,
    iterationId: seed.finalIterationId,
    jobId: `job-${seed.taskId}`,
  });
  const { resultPackage, resultAdmission } = driveWorkerBoundary({
    jobSpec,
    workerId: `worker-${seed.taskId}`,
  });

  // --- M11 ---
  const control = driveControlApi({
    taskContractHash: spine,
    reviewPackage,
    decisionAction: seed.decisionAction,
    clientSuffix: seed.taskId,
    now,
  });

  // Browser archetype binds a self-seeded genuine browser-surface artifact (a
  // DOM snapshot, mediaType text/html, surface browser-dom-snapshot — distinct
  // from the code/non-code JSON evidence) through the M6 evidence projection
  // (EvidenceSummaryV2): a member of the spine-bound M5 manifest whose digest
  // matches the projection. Non-null iff archetype 'browser'. (Owner decision
  // m12-browser-evidence-seeding — the L2-gated M7 provider is not wired.)
  let browserEvidenceRef: { readonly artifactRefId: string; readonly sha256: string } | null =
    null;
  if (seed.archetype === 'browser') {
    const summary = reviewPackage.evidence[0];
    if (summary === undefined) {
      throw new ProofHarnessError(
        'browser archetype requires a projected review-package evidence entry to bind',
      );
    }
    browserEvidenceRef = {
      artifactRefId: summary.artifactRefId,
      sha256: summary.sha256,
    };
  }

  return {
    archetype: seed.archetype,
    contract,
    evidenceManifest,
    reviewPackage,
    evaluationReceipt,
    routingDecision,
    routedEvaluationReceipt,
    browserEvidenceRef,
    jobSpec,
    resultPackage,
    resultAdmission,
    controlCreateRequest: control.controlCreateRequest,
    controlCreateVerdict: control.controlCreateVerdict,
    controlDecisionRequest: control.controlDecisionRequest,
    controlDecisionVerdict: control.controlDecisionVerdict,
    cost: fixtureCost(),
    operatorReview: fixtureOperatorReview(),
  };
}
