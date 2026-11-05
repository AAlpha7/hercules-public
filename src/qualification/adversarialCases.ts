/**
 * M13 adversarial fail-closed fixtures — eight cases, each driving the
 * relevant real engine to the closed reason pinned in `ADVERSARIAL_CASE_TABLE`.
 *
 * Taint reaches the engine's own refusal/verdict token (never a fabricated
 * string). No state/approval/merge/action is committed by these fixtures; the
 * sealed `resultHash` records the fail-closed disposition.
 */

import { hashCanonicalJson } from '../domain/canonicalJson.js';
import {
  computeEvidenceIntegrityAttestationHash,
  computeVerificationReceiptHash,
} from '../domain/claimAuthorityV2.js';
import {
  assertAdmissionLedgerEntryV1,
  assertControlApiV2ReceiptV1,
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeReceiptHash,
  deriveAggregateId,
  type AdmissionLedgerEntryV1,
  type ControlApiV2ReadsV1,
  type ControlApiV2ReceiptV1,
  type CreatePayloadV1,
  type DecisionPayloadV1,
} from '../domain/controlApiV2.js';
import { computeTaskContractHash } from '../domain/contractHash.js';
import {
  ADVERSARIAL_CASES,
  ADVERSARIAL_CASE_TABLE,
  assertAdversarialCaseResultV1,
  computeAdversarialCaseResultHash,
  type AdversarialCaseResultV1,
  type AdversarialCaseV1,
  type AdversarialEngineV1,
  type AdversarialExpectationV1,
  type AdversarialTaintKindV1,
} from '../domain/qualification.js';
import type {
  ReviewPackageV2,
  ReviewPackageV2Source,
} from '../domain/reviewPackageV2.js';
import type { TaskContract } from '../domain/taskContract.js';
import { isCanonicalTimestamp } from '../domain/workerBoundary.js';
import { decideControlApiV2 } from '../controlapi/requestPolicy.js';
import { projectReviewPackageForProof } from '../proofs/engineChain.js';
import { buildEvaluationReceipt } from '../proofs/evaluationReceipt.js';
import { buildReviewPackageSource } from '../proofs/spine.js';
import { QualificationHarnessError } from './heldOutCorpus.js';

const INTENT_DIGEST =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const T0 = '2026-08-29T00:00:00.000Z';
const STATE_VERSION = 3;

function assertInjectedNow(now: string): void {
  if (!isCanonicalTimestamp(now)) {
    throw new QualificationHarnessError(
      'injected now must be a canonical UTC-Z timestamp',
    );
  }
}

function sealAdversarial(args: {
  readonly case: AdversarialCaseV1;
  readonly engine: AdversarialEngineV1;
  readonly expectation: AdversarialExpectationV1;
  readonly taintKind: AdversarialTaintKindV1;
  readonly refusalReason: string;
}): AdversarialCaseResultV1 {
  const pinned = ADVERSARIAL_CASE_TABLE[args.case];
  if (
    args.expectation !== pinned.expectation ||
    args.taintKind !== pinned.taintKind ||
    !pinned.engines.includes(args.engine)
  ) {
    throw new QualificationHarnessError(
      `adversarial case ${args.case} does not match ADVERSARIAL_CASE_TABLE`,
    );
  }
  const withoutHash: Omit<AdversarialCaseResultV1, 'resultHash'> = {
    case: args.case,
    expectation: args.expectation,
    engine: args.engine,
    refusalReason: args.refusalReason,
    taintKind: args.taintKind,
  };
  const result: AdversarialCaseResultV1 = {
    ...withoutHash,
    resultHash: computeAdversarialCaseResultHash(withoutHash),
  };
  assertAdversarialCaseResultV1(result);
  return result;
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

function submitReads(
  reviewPackage: ReviewPackageV2,
  overrides: Partial<ControlApiV2ReadsV1> = {},
): ControlApiV2ReadsV1 {
  return emptyReads({
    aggregateExists: true,
    currentStateVersion: STATE_VERSION,
    taskStatus: 'review',
    latestEventSequence: 7,
    freshProjectionHash: reviewPackage.projectionHash,
    reviewPackage,
    admissionLedger: [],
    events: null,
    eventsHasMore: false,
    ...overrides,
  });
}

function replaceAttestation(
  source: ReviewPackageV2Source,
  overrides: Partial<
    Omit<ReviewPackageV2Source['evidenceIntegrity'], 'attestationHash'>
  >,
): ReviewPackageV2Source {
  const { attestationHash: _drop, ...withoutHash } = source.evidenceIntegrity;
  const next = { ...withoutHash, ...overrides };
  return {
    ...source,
    evidenceIntegrity: {
      ...next,
      attestationHash: computeEvidenceIntegrityAttestationHash(next),
    },
  };
}

function replaceContract(
  source: ReviewPackageV2Source,
  mutate: (contract: TaskContract) => TaskContract,
): ReviewPackageV2Source {
  const proposed = mutate(source.contract);
  const { contractHash: _drop, ...withoutHash } = proposed;
  const hashInput: TaskContract = { ...withoutHash, contractHash: '' };
  const contract: TaskContract = {
    ...hashInput,
    contractHash: computeTaskContractHash(hashInput),
  };
  const currentBinding = {
    ...source.currentBinding,
    contractHash: contract.contractHash,
  };
  const verificationReceipts = source.verificationReceipts.map((receipt) => {
    const { receiptHash: _r, ...rest } = receipt;
    const next = { ...rest, contractHash: contract.contractHash };
    return {
      ...next,
      receiptHash: computeVerificationReceiptHash(next),
    };
  });
  const evaluation = source.evaluation;
  if (evaluation === null) {
    throw new QualificationHarnessError(
      'replaceContract requires a non-null evaluation record',
    );
  }
  return {
    ...source,
    contract,
    currentBinding,
    verificationReceipts,
    evaluation: {
      ...evaluation,
      verdict: {
        ...evaluation.verdict,
        binding: {
          ...evaluation.verdict.binding,
          contractHash: contract.contractHash,
        },
      },
    },
  };
}

function withHumanCriterion(source: ReviewPackageV2Source): ReviewPackageV2Source {
  const rebound = replaceContract(source, (contract) => ({
    ...contract,
    acceptanceCriteria: [
      ...contract.acceptanceCriteria,
      {
        id: 'criterion-human',
        text: 'The owner accepts the outcome.',
        authority: 'human' as const,
        required: true,
        proofBinding: null,
      },
    ],
    approvalPolicy: {
      version: 'approval-v1' as const,
      requiredDecisions: ['approve_outcome' as const],
    },
  }));
  const evaluation = rebound.evaluation;
  if (evaluation === null) {
    throw new QualificationHarnessError(
      'withHumanCriterion requires a non-null evaluation record',
    );
  }
  return {
    ...rebound,
    evaluation: {
      ...evaluation,
      verdict: {
        ...evaluation.verdict,
        outcome: 'need_more_evidence',
        recommendedNextStage: 'escalate_human',
        criterionResults: [
          ...evaluation.verdict.criterionResults,
          {
            criterionId: 'criterion-human',
            status: 'pending',
            authority: 'human',
            evidenceRefs: [],
            observedAt: null,
            candidateBinding:
              evaluation.verdict.criterionResults[0]!.candidateBinding,
            explanation: 'awaiting owner authority',
          },
        ],
      },
      criterionPremises: [
        ...evaluation.criterionPremises,
        { key: 'criterion-human', assertionIds: [] },
      ],
    },
  };
}

function committedReceipt(args: {
  readonly resource: 'task' | 'decision';
  readonly aggregateId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly stateVersion: number;
  readonly eventSequence: number;
  readonly decidedAt: string;
}): ControlApiV2ReceiptV1 {
  const withoutHash: Omit<ControlApiV2ReceiptV1, 'receiptHash'> = {
    schema: 'hercules-control-api-receipt/v2',
    outcome: 'committed',
    resource: args.resource,
    aggregateId: args.aggregateId,
    keyHash: args.keyHash,
    requestHash: args.requestHash,
    stateVersion: args.stateVersion,
    eventSequence: args.eventSequence,
    reason: null,
    decidedAt: args.decidedAt,
  };
  const receipt: ControlApiV2ReceiptV1 = {
    ...withoutHash,
    receiptHash: computeReceiptHash(withoutHash),
  };
  assertControlApiV2ReceiptV1(receipt);
  return receipt;
}

function ledgerEntry(receipt: ControlApiV2ReceiptV1): AdmissionLedgerEntryV1 {
  const entry: AdmissionLedgerEntryV1 = {
    keyHash: receipt.keyHash,
    requestHash: receipt.requestHash,
    receipt,
  };
  assertAdmissionLedgerEntryV1(entry);
  return entry;
}

function expectRefusedReason(
  decision: ReturnType<typeof decideControlApiV2>,
  expected: string,
  label: string,
): string {
  if (
    decision === null ||
    typeof decision !== 'object' ||
    !('schema' in decision) ||
    decision.schema !== 'hercules-control-api-receipt/v2' ||
    decision.outcome !== 'refused' ||
    decision.reason !== expected
  ) {
    const got =
      decision !== null &&
      typeof decision === 'object' &&
      'reason' in decision
        ? String((decision as { reason: unknown }).reason)
        : 'non-receipt';
    throw new QualificationHarnessError(
      `${label}: expected refused reason '${expected}', got '${got}'`,
    );
  }
  return decision.reason;
}

// ---------------------------------------------------------------------------
// Case fixtures
// ---------------------------------------------------------------------------

/**
 * false_green → M8 verdict is not `pass`.
 *
 * Unlike the other seven fixtures (which drive an engine that autonomously
 * refuses tainted input), this case CONSTRUCTS an M8 receipt with a `fail`
 * verdict via the real `buildEvaluationReceipt` constructor/validator, under
 * recorded owner decision `m12-evaluation-construction` — the autonomous M8
 * grader is not driven here. It then asserts the sealed receipt is not a
 * `pass`, i.e. an unsupported "pass" claim cannot be represented as a passing
 * M8 receipt.
 */
function runFalseGreen(now: string): AdversarialCaseResultV1 {
  const source = buildReviewPackageSource({
    taskId: 'adv-false-green',
    iterationId: 'iteration-1',
  });
  if (source.evidenceManifest === null) {
    throw new QualificationHarnessError('false_green spine missing manifest');
  }
  // Constructed, not engine-derived: seal a fail verdict through the real
  // receipt constructor/validator (no clock needed).
  void now;
  const receipt = buildEvaluationReceipt({
    contract: source.contract,
    evidenceManifest: source.evidenceManifest,
    requestId: 'request-false-green',
    receiptId: 'receipt-false-green',
    iterationId: 'iteration-1',
    outcome: 'fail',
  });
  if (receipt.verdict.outcome === 'pass') {
    throw new QualificationHarnessError(
      'false_green: M8 verdict must not be pass',
    );
  }
  return sealAdversarial({
    case: 'false_green',
    engine: 'm8_evaluation',
    expectation: 'refused',
    taintKind: 'confident_self_report',
    refusalReason: receipt.verdict.outcome,
  });
}

/** Stale concurrency token → M11 `stale_version`. */
function runStaleApproval(now: string): AdversarialCaseResultV1 {
  const source = buildReviewPackageSource({
    taskId: 'adv-stale-approval',
    iterationId: 'iteration-1',
    requiresHumanDecision: true,
  });
  const reviewPackage = projectReviewPackageForProof(source);
  const createKey = buildIdempotencyKey({
    actorIssuer: 'hercules-web',
    actorId: 'actor-adv',
    aggregateId: '',
    clientRequestId: 'req-create-stale',
  });
  const aggregateId = deriveAggregateId(createKey.keyHash);
  const decisionKey = buildIdempotencyKey({
    actorIssuer: 'hercules-web',
    actorId: 'actor-adv',
    aggregateId,
    clientRequestId: 'req-decision-stale',
  });
  const staleToken = buildConcurrencyToken({
    aggregateId,
    stateVersion: 1, // stale vs reads.currentStateVersion = 3
    projectionHash: reviewPackage.projectionHash,
  });
  const payload: DecisionPayloadV1 = {
    kind: 'decision',
    action: 'approve_outcome',
    reason: 'Stale approval attempt',
    acknowledgedRiskCodes: [],
  };
  const request = buildControlApiV2Request({
    resource: 'decision',
    operation: 'submit',
    aggregateId,
    idempotencyKey: decisionKey,
    concurrencyToken: staleToken,
    payload,
    issuedAt: T0,
  });
  const decision = decideControlApiV2(
    request,
    submitReads(reviewPackage),
    now,
  );
  const reason = expectRefusedReason(decision, 'stale_version', 'stale_approval');
  return sealAdversarial({
    case: 'stale_approval',
    engine: 'm11_admission',
    expectation: 'refused',
    taintKind: 'stale_binding',
    refusalReason: reason,
  });
}

/** Tampered evidence integrity → M6 `need_more_evidence`, not decision-eligible. */
function runEvidenceTamper(_now: string): AdversarialCaseResultV1 {
  const source = buildReviewPackageSource({
    taskId: 'adv-evidence-tamper',
    iterationId: 'iteration-1',
  });
  const pkg = projectReviewPackageForProof(
    replaceAttestation(source, { result: 'tampered' }),
  );
  if (pkg.outcome.status !== 'need_more_evidence') {
    throw new QualificationHarnessError(
      `evidence_tamper: expected M6 need_more_evidence, got '${pkg.outcome.status}'`,
    );
  }
  if (pkg.outcome.decisionEligible !== false) {
    throw new QualificationHarnessError(
      'evidence_tamper: M6 package must not be decision-eligible',
    );
  }
  if (!pkg.outcome.reasonCodes.includes('evidence_tampered')) {
    throw new QualificationHarnessError(
      'evidence_tamper: expected evidence_tampered reason code',
    );
  }
  return sealAdversarial({
    case: 'evidence_tamper',
    engine: 'm6_eligibility',
    expectation: 'refused',
    taintKind: 'tampering',
    refusalReason: pkg.outcome.status,
  });
}

/**
 * Restart recovery — same idempotency key + same payload after "restart"
 * returns the byte-identical stored committed receipt (no second effect).
 */
function runRestartRecovery(now: string): AdversarialCaseResultV1 {
  const createPayload: CreatePayloadV1 = {
    kind: 'create',
    taskContractHash:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    intentDigest: INTENT_DIGEST,
  };
  const createKey = buildIdempotencyKey({
    actorIssuer: 'hercules-web',
    actorId: 'actor-adv',
    aggregateId: '',
    clientRequestId: 'req-create-restart',
  });
  const request = buildControlApiV2Request({
    resource: 'task',
    operation: 'create',
    aggregateId: '',
    idempotencyKey: createKey,
    concurrencyToken: null,
    payload: createPayload,
    issuedAt: T0,
  });
  // First admit (pre-restart), then seal a committed receipt into the ledger
  // as if the effect landed and the process restarted.
  const first = decideControlApiV2(request, emptyReads(), now);
  if (
    first === null ||
    typeof first !== 'object' ||
    !('schema' in first) ||
    first.schema !== 'hercules-control-api-admit-verdict/v2'
  ) {
    throw new QualificationHarnessError(
      'restart_recovery: first create must admit',
    );
  }
  const stored = committedReceipt({
    resource: 'task',
    aggregateId: first.aggregateId,
    keyHash: first.keyHash,
    requestHash: first.requestHash,
    stateVersion: 1,
    eventSequence: 1,
    decidedAt: now,
  });
  const replay = decideControlApiV2(
    request,
    emptyReads({ admissionLedger: [ledgerEntry(stored)] }),
    now,
  );
  if (replay !== stored) {
    // Byte-identical content is required; prefer reference equality when the
    // ledger returns the stored object, else compare canonical serialization.
    if (
      replay === null ||
      typeof replay !== 'object' ||
      !('schema' in replay) ||
      replay.schema !== 'hercules-control-api-receipt/v2' ||
      hashCanonicalJson(replay) !== hashCanonicalJson(stored)
    ) {
      throw new QualificationHarnessError(
        'restart_recovery: replay must return the byte-identical stored receipt',
      );
    }
  }
  if (replay.outcome !== 'committed') {
    throw new QualificationHarnessError(
      'restart_recovery: replayed receipt outcome must be committed',
    );
  }
  return sealAdversarial({
    case: 'restart_recovery',
    engine: 'm11_admission',
    expectation: 'no_effect',
    taintKind: 'raw_prose',
    refusalReason: replay.outcome,
  });
}

/** Same key, different payload → M11 `idempotency_conflict`. */
function runDuplicateAction(now: string): AdversarialCaseResultV1 {
  const createKey = buildIdempotencyKey({
    actorIssuer: 'hercules-web',
    actorId: 'actor-adv',
    aggregateId: '',
    clientRequestId: 'req-create-dup',
  });
  const payloadA: CreatePayloadV1 = {
    kind: 'create',
    taskContractHash:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    intentDigest: INTENT_DIGEST,
  };
  const requestA = buildControlApiV2Request({
    resource: 'task',
    operation: 'create',
    aggregateId: '',
    idempotencyKey: createKey,
    concurrencyToken: null,
    payload: payloadA,
    issuedAt: T0,
  });
  const prior = committedReceipt({
    resource: 'task',
    aggregateId: deriveAggregateId(createKey.keyHash),
    keyHash: createKey.keyHash,
    // Different requestHash than requestA → conflict on same key.
    requestHash:
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    stateVersion: 1,
    eventSequence: 1,
    decidedAt: now,
  });
  const decision = decideControlApiV2(
    requestA,
    emptyReads({ admissionLedger: [ledgerEntry(prior)] }),
    now,
  );
  const reason = expectRefusedReason(
    decision,
    'idempotency_conflict',
    'duplicate_action',
  );
  return sealAdversarial({
    case: 'duplicate_action',
    engine: 'm11_admission',
    expectation: 'no_effect',
    taintKind: 'inference',
    refusalReason: reason,
  });
}

/**
 * Approve action not in validDecisions of a request_changes-only review →
 * M11 `ineligible_decision`.
 */
function runReviewerRejection(now: string): AdversarialCaseResultV1 {
  const source = buildReviewPackageSource({
    taskId: 'adv-reviewer-rejection',
    iterationId: 'iteration-1',
  });
  const reviewPackage = projectReviewPackageForProof(source);
  if (
    reviewPackage.validDecisions.length !== 1 ||
    reviewPackage.validDecisions[0] !== 'request_changes'
  ) {
    throw new QualificationHarnessError(
      `reviewer_rejection: expected validDecisions ['request_changes'], got ${JSON.stringify(reviewPackage.validDecisions)}`,
    );
  }
  const createKey = buildIdempotencyKey({
    actorIssuer: 'hercules-web',
    actorId: 'actor-adv',
    aggregateId: '',
    clientRequestId: 'req-create-reject',
  });
  const aggregateId = deriveAggregateId(createKey.keyHash);
  const decisionKey = buildIdempotencyKey({
    actorIssuer: 'hercules-web',
    actorId: 'actor-adv',
    aggregateId,
    clientRequestId: 'req-decision-reject',
  });
  const token = buildConcurrencyToken({
    aggregateId,
    stateVersion: STATE_VERSION,
    projectionHash: reviewPackage.projectionHash,
  });
  const payload: DecisionPayloadV1 = {
    kind: 'decision',
    action: 'approve_outcome',
    reason: 'Override a rejected review',
    acknowledgedRiskCodes: [],
  };
  const request = buildControlApiV2Request({
    resource: 'decision',
    operation: 'submit',
    aggregateId,
    idempotencyKey: decisionKey,
    concurrencyToken: token,
    payload,
    issuedAt: T0,
  });
  const decision = decideControlApiV2(
    request,
    submitReads(reviewPackage),
    now,
  );
  const reason = expectRefusedReason(
    decision,
    'ineligible_decision',
    'reviewer_rejection',
  );
  return sealAdversarial({
    case: 'reviewer_rejection',
    engine: 'm11_admission',
    expectation: 'refused',
    taintKind: 'opinion',
    refusalReason: reason,
  });
}

/**
 * Browser task whose browser-surface evidence is ABSENT from the manifest →
 * M6 `need_more_evidence` (never the live-browser BrowserUnavailableError path).
 */
function runMissingBrowserEnvironment(_now: string): AdversarialCaseResultV1 {
  const source = buildReviewPackageSource({
    taskId: 'adv-missing-browser',
    iterationId: 'iteration-1',
    browserEvidence: true,
  });
  if (source.evidenceManifest === null || source.evaluation === null) {
    throw new QualificationHarnessError(
      'missing_browser_environment spine incomplete',
    );
  }
  if (
    !source.contract.verificationPolicy.requiredEvidence.includes(
      'browser-dom-snapshot',
    )
  ) {
    throw new QualificationHarnessError(
      'missing_browser_environment: contract must require browser-dom-snapshot',
    );
  }
  // ABSENT browser-surface evidence: empty manifest entries + missing integrity
  // + evaluation already reporting the evidence gap.
  const manifestWithoutHash = {
    id: source.evidenceManifest.id,
    taskId: source.evidenceManifest.taskId,
    contractVersion: source.evidenceManifest.contractVersion,
    iterationId: source.evidenceManifest.iterationId,
    candidateRef: source.evidenceManifest.candidateRef,
    entries: [] as const,
    createdAt: source.evidenceManifest.createdAt,
  };
  const emptyManifest = {
    ...manifestWithoutHash,
    manifestHash: hashCanonicalJson(manifestWithoutHash),
  };
  const iterationId = source.currentBinding.iterationId;
  const candidateRef = source.currentBinding.candidateRef;
  if (iterationId === null || candidateRef === null) {
    throw new QualificationHarnessError(
      'missing_browser_environment: spine binding must carry iterationId and candidateRef',
    );
  }
  const binding = {
    taskId: source.currentBinding.taskId,
    contractVersion: source.currentBinding.contractVersion,
    contractHash: source.currentBinding.contractHash,
    iterationId,
    candidateRef,
    evidenceManifestHash: emptyManifest.manifestHash,
    evaluatorVersion: source.currentBinding.evaluatorVersion,
    evaluatorModel: source.currentBinding.evaluatorModel,
    evaluatorRuntime: source.currentBinding.evaluatorRuntime,
    policyVersion: source.currentBinding.policyVersion,
  };
  const attestationWithoutHash = {
    schema: 'hercules-evidence-integrity-attestation/v1' as const,
    result: 'missing' as const,
    evidenceManifestId: emptyManifest.id,
    evidenceManifestHash: emptyManifest.manifestHash,
    candidateRef: emptyManifest.candidateRef,
    checkedArtifacts: [] as const,
    verifierImplementation: 'integrity-v1',
    checkedAt: '2026-08-29T00:00:05.000Z',
  };
  const pkg = projectReviewPackageForProof({
    ...source,
    currentBinding: binding,
    evidenceManifest: emptyManifest,
    artifacts: [],
    verificationReceipts: [],
    evidenceIntegrity: {
      ...attestationWithoutHash,
      attestationHash: computeEvidenceIntegrityAttestationHash(
        attestationWithoutHash,
      ),
    },
    evaluation: {
      ...source.evaluation,
      verdict: {
        ...source.evaluation.verdict,
        binding,
        outcome: 'need_more_evidence',
        recommendedNextStage: 'reverify',
        criterionResults: [
          {
            ...source.evaluation.verdict.criterionResults[0]!,
            status: 'insufficient_evidence',
            evidenceRefs: [],
          },
        ],
      },
    },
  });
  if (pkg.outcome.status !== 'need_more_evidence') {
    throw new QualificationHarnessError(
      `missing_browser_environment: expected M6 need_more_evidence, got '${pkg.outcome.status}'`,
    );
  }
  if (pkg.outcome.decisionEligible !== false) {
    throw new QualificationHarnessError(
      'missing_browser_environment: must not be decision-eligible',
    );
  }
  return sealAdversarial({
    case: 'missing_browser_environment',
    engine: 'm6_eligibility',
    expectation: 'refused',
    taintKind: 'missing_binding',
    refusalReason: pkg.outcome.status,
  });
}

/** Human-authority criterion → M6 `needs_human`. */
function runHumanCriterion(_now: string): AdversarialCaseResultV1 {
  const source = buildReviewPackageSource({
    taskId: 'adv-human-criterion',
    iterationId: 'iteration-1',
  });
  const pkg = projectReviewPackageForProof(withHumanCriterion(source));
  if (pkg.outcome.status !== 'needs_human') {
    throw new QualificationHarnessError(
      `human_criterion: expected M6 needs_human, got '${pkg.outcome.status}'`,
    );
  }
  const humanRow = pkg.criteria.find((row) => row.criterionId === 'criterion-human');
  if (humanRow === undefined || humanRow.authority !== 'human') {
    throw new QualificationHarnessError(
      'human_criterion: projected package must carry a human-authority criterion',
    );
  }
  return sealAdversarial({
    case: 'human_criterion',
    engine: 'm6_eligibility',
    expectation: 'held_for_human',
    taintKind: 'missing_binding',
    refusalReason: pkg.outcome.status,
  });
}

const CASE_RUNNERS: Readonly<
  Record<AdversarialCaseV1, (now: string) => AdversarialCaseResultV1>
> = {
  false_green: runFalseGreen,
  stale_approval: runStaleApproval,
  evidence_tamper: runEvidenceTamper,
  restart_recovery: runRestartRecovery,
  duplicate_action: runDuplicateAction,
  reviewer_rejection: runReviewerRejection,
  missing_browser_environment: runMissingBrowserEnvironment,
  human_criterion: runHumanCriterion,
};

/**
 * Run all eight adversarial fail-closed fixtures. Results are sorted-unique by
 * case (matching `ADVERSARIAL_CASES` order).
 */
export function runAdversarialCases(
  now: string,
): readonly AdversarialCaseResultV1[] {
  assertInjectedNow(now);
  const results = ADVERSARIAL_CASES.map((caseId) => CASE_RUNNERS[caseId](now));
  // ADVERSARIAL_CASES is already sorted-unique; freeze the sealed list.
  return Object.freeze(results);
}

/** Alias used by the M13 final-package assembly brief. */
export const runAllAdversarialCases = runAdversarialCases;
