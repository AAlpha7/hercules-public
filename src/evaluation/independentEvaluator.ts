/**
 * M8 trusted independent-evaluation coordinator.
 *
 * May import only from `src/domain/` and local `src/evaluation/` modules.
 * No Node builtins, no timers, no clock reads outside the injected clock port.
 */

import { hashCanonicalJson } from '../domain/canonicalJson.js';
import {
  IndependentEvaluationError,
  assertCurrentEvaluationContextV1,
  assertRuntimeCapabilityIdentityV1,
  assertEvaluationGapV1,
  assertIndependentEvaluationInputV1,
  assertIndependentEvaluationReceiptV1,
  computeCurrentContextHash,
  computeEvaluationReceiptHash,
  computeGapHash,
  computeGateReceiptSetHash,
  computeStableContextHash,
  computeVerdictHash,
  type CurrentGateReceiptQueryV1,
  type DeterministicGateReceiptV1,
  type EvaluationCancellationDispatchV1,
  type EvaluationClockV1,
  type EvaluationDeadlinePortV1,
  type EvaluationGapV1,
  type EvaluatorProposalV1,
  type IndependentEvaluationErrorCode,
  type IndependentEvaluationInputV1,
  type IndependentEvaluationReceiptV1,
  type IndependentEvaluatorPortV1,
  type TrustedCurrentEvaluationContextV1,
  type TrustedDeterministicGateRunnerV1,
  type TrustedEvaluationCancellationFactoryV1,
  type TrustedEvaluationControlSnapshotV1,
  type TrustedEvaluationEvidenceSnapshotV1,
  type TrustedEvaluationRuntimeCapabilityIdentityV1,
  type TrustedEvaluationStableContextIdentityV1,
  type TrustedEvaluatorAuthoritySnapshotV1,
} from '../domain/independentEvaluation.js';
import {
  buildSanitizedEvaluationRequest,
  runEvaluatorAttempt,
  type EvaluatorAttemptOutcomeV1,
} from './evaluatorPort.js';
import { runDeterministicPreflight } from './deterministicPreflight.js';
import { deriveVerdict } from './verdictPolicy.js';

const DEFAULT_MAX_RESERVATIONS = 1024;
const ABSOLUTE_MAX_RESERVATIONS = 4096;

export interface TrustedEvaluationSourcesV1 {
  resolveControl(): Promise<TrustedEvaluationControlSnapshotV1>;
  resolveEvidence(): Promise<TrustedEvaluationEvidenceSnapshotV1>;
  resolveEvaluatorAuthority(): Promise<TrustedEvaluatorAuthoritySnapshotV1>;
}

export interface TrustedEvaluationRuntimeCapabilitiesV1 {
  readonly identity: TrustedEvaluationRuntimeCapabilityIdentityV1;
  readonly sources: TrustedEvaluationSourcesV1;
  readonly gateRunner: TrustedDeterministicGateRunnerV1;
  readonly evaluatorPort: IndependentEvaluatorPortV1;
  readonly deadline: EvaluationDeadlinePortV1;
  readonly cancellationFactory: TrustedEvaluationCancellationFactoryV1;
  readonly clock: EvaluationClockV1;
  readonly coordinatorRunId: string;
  readonly evaluatorVersion: string;
  readonly evaluatorModel: string | null;
  readonly evaluatorRuntime: string;
}

export type IndependentEvaluationOutcomeV1 =
  | { readonly kind: 'receipt'; readonly receipt: IndependentEvaluationReceiptV1 }
  | { readonly kind: 'gap'; readonly gap: EvaluationGapV1 }
  | {
      readonly kind: 'conflict';
      readonly code: 'idempotency_conflict';
      readonly detail: string;
    }
  | {
      readonly kind: 'capacity';
      readonly code: 'coordinator_capacity';
      readonly detail: string;
    }
  | {
      readonly kind: 'unavailable';
      readonly code: IndependentEvaluationErrorCode;
      readonly detail: string;
    };

export interface ReceiptReconstructionV1 {
  readonly input: IndependentEvaluationInputV1;
  readonly proposal: EvaluatorProposalV1 | null;
  readonly evaluatorInfrastructureFailure?: {
    readonly code: 'evaluator_unavailable' | 'evaluator_contract_violation';
    readonly detail: string;
  };
}

export interface IndependentEvaluationCoordinatorV1 {
  evaluate(input: IndependentEvaluationInputV1): Promise<IndependentEvaluationOutcomeV1>;
  isAuthorityQualified(receipt: IndependentEvaluationReceiptV1): boolean;
  restoreQualifiedReceipt(
    dto: IndependentEvaluationReceiptV1,
    reconstruction: ReceiptReconstructionV1,
  ): Promise<{ readonly restored: boolean; readonly reason: string }>;
}

interface ResolvedFreshContextV1 {
  readonly context: TrustedCurrentEvaluationContextV1;
  readonly control: TrustedEvaluationControlSnapshotV1;
  readonly evidence: TrustedEvaluationEvidenceSnapshotV1;
  readonly gateReceipts: readonly DeterministicGateReceiptV1[];
  readonly evaluatorAuthority: TrustedEvaluatorAuthoritySnapshotV1;
  readonly observedAt: string;
  readonly freshUntil: string;
}

type ReservationState =
  | {
      readonly stableContextHash: string;
      readonly accepted: ResolvedFreshContextV1;
      readonly status: 'in_flight';
      readonly promise: Promise<IndependentEvaluationOutcomeV1>;
    }
  | {
      readonly stableContextHash: string;
      readonly accepted: ResolvedFreshContextV1;
      readonly status: 'settled';
      readonly promise: Promise<IndependentEvaluationOutcomeV1>;
      readonly outcome: IndependentEvaluationOutcomeV1;
    };

function unavailable(
  code: IndependentEvaluationErrorCode,
  detail: string,
): IndependentEvaluationOutcomeV1 {
  return Object.freeze({
    kind: 'unavailable' as const,
    code,
    detail,
  });
}

function mapThrownToUnavailable(error: unknown): IndependentEvaluationOutcomeV1 {
  if (error instanceof IndependentEvaluationError) {
    return unavailable(error.code, error.message);
  }
  return unavailable('evaluator_unavailable', String(error));
}

function earliestTimestamp(timestamps: readonly string[]): string {
  if (timestamps.length === 0) {
    throw new IndependentEvaluationError(
      'evaluator_unavailable',
      'freshUntil derivation requires at least one trusted expiry',
    );
  }
  let earliest = timestamps[0]!;
  for (let index = 1; index < timestamps.length; index += 1) {
    const candidate = timestamps[index]!;
    if (Date.parse(candidate) < Date.parse(earliest)) {
      earliest = candidate;
    }
  }
  return earliest;
}

function reservationKey(requestId: string, stableContextHash: string): string {
  return `${requestId}\u0000${stableContextHash}`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Recurse into children before freezing the node, and descend even when the
  // node is already frozen so a shallow-frozen caller DTO still gets its nested
  // state frozen. The M8 records are acyclic canonical structures, so this
  // terminates.
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
}

function freezeOutcome(
  outcome: IndependentEvaluationOutcomeV1,
): IndependentEvaluationOutcomeV1 {
  return deepFreeze(outcome);
}

export function createIndependentEvaluationCoordinator(
  capabilities: TrustedEvaluationRuntimeCapabilitiesV1,
  options?: { readonly maxReservations?: number },
): IndependentEvaluationCoordinatorV1 {
  const maxReservations = Math.min(
    options?.maxReservations ?? DEFAULT_MAX_RESERVATIONS,
    ABSOLUTE_MAX_RESERVATIONS,
  );

  const qualifiedReceipts = new WeakSet<IndependentEvaluationReceiptV1>();
  const reservations = new Map<string, ReservationState>();
  const requestIdToStableHash = new Map<string, string>();

  const identity = capabilities.identity;
  // Caller-supplied identity is validated (closed keys, hash recompute) before
  // any evaluation; every later context resolution re-validates it nested.
  assertRuntimeCapabilityIdentityV1(identity);

  class PostEvaluationContextMalformedError extends Error {
    override readonly name = 'PostEvaluationContextMalformedError';
  }

  async function resolveFreshContext(
    inputHash: string,
    mode: 'pre_acceptance' | 'post_evaluation',
  ): Promise<ResolvedFreshContextV1> {
    if (identity.clockCapabilityId !== capabilities.clock.capabilityId) {
      throw new IndependentEvaluationError(
        'evaluator_unavailable',
        'runtime clockCapabilityId does not match the injected clock.capabilityId',
      );
    }
    if (identity.clockEpochId !== capabilities.clock.epochId) {
      throw new IndependentEvaluationError(
        'evaluator_unavailable',
        'runtime clockEpochId does not match the injected clock.epochId',
      );
    }

    const control = await capabilities.sources.resolveControl();
    const evidence = await capabilities.sources.resolveEvidence();
    const evaluatorAuthority =
      await capabilities.sources.resolveEvaluatorAuthority();

    if (
      evaluatorAuthority.evaluatorCapabilityId !== identity.evaluatorCapabilityId
    ) {
      throw new IndependentEvaluationError(
        'evaluator_unavailable',
        'evaluatorAuthority.evaluatorCapabilityId does not match runtime evaluatorCapabilityId',
      );
    }

    const query: CurrentGateReceiptQueryV1 = {
      gatePlanId: control.gatePlan.gatePlanId,
      gatePlanHash: control.gatePlan.gatePlanHash,
      taskId: evidence.taskContract.taskId,
      taskContractHash: evidence.taskContract.contractHash,
      iterationId: evidence.iterationId,
      candidateCommit: evidence.verificationResult.candidateCommit,
      authorityEpoch: control.authorityEpoch,
    };
    const gateReceipts =
      await capabilities.gateRunner.resolveCurrentReceipts(query);
    const gateReceiptSetHash = computeGateReceiptSetHash(gateReceipts);

    const observedAt = capabilities.clock.nowUtc();

    const freshUntil = earliestTimestamp([
      control.policy.expiresAt,
      control.roles.expiresAt,
      evaluatorAuthority.expiresAt,
      ...gateReceipts.map((receipt) => receipt.expiresAt),
      evidence.freshUntil,
    ]);

    const observedAfterFreshUntil =
      Date.parse(observedAt) > Date.parse(freshUntil);
    if (observedAfterFreshUntil && mode === 'pre_acceptance') {
      throw new IndependentEvaluationError(
        'evaluator_unavailable',
        `observedAt ${observedAt} is after derived freshUntil ${freshUntil}`,
      );
    }

    const stableWithoutHash: Omit<
      TrustedEvaluationStableContextIdentityV1,
      'stableContextHash'
    > = {
      schema: 'hercules-trusted-evaluation-stable-context/v1',
      inputHash,
      controlIdentityHash: control.controlIdentityHash,
      evidenceIdentityHash: evidence.evidenceIdentityHash,
      gateReceiptSetHash,
      roleAuthorityHash: control.roles.authorityHash,
      evaluatorAuthorityHash: evaluatorAuthority.authorityHash,
      runtimeCapabilitySetHash: identity.capabilitySetHash,
      authorityEpoch: control.authorityEpoch,
      clockCapabilityId: identity.clockCapabilityId,
      clockEpochId: identity.clockEpochId,
      freshUntil,
    };
    const stableIdentity: TrustedEvaluationStableContextIdentityV1 = {
      ...stableWithoutHash,
      stableContextHash: computeStableContextHash(stableWithoutHash),
    };

    const contextWithoutHash: Omit<TrustedCurrentEvaluationContextV1, 'contextHash'> =
      {
        schema: 'hercules-trusted-current-evaluation-context/v1',
        inputHash,
        control,
        evidence,
        gateReceipts,
        gateReceiptSetHash,
        evaluatorAuthority,
        runtimeCapabilities: identity,
        stableIdentity,
        observedAt,
        freshness: 'fresh',
      };
    const context: TrustedCurrentEvaluationContextV1 = {
      ...contextWithoutHash,
      contextHash: computeCurrentContextHash(contextWithoutHash),
    };

    // Post-evaluation expiry is classified by comparePostEvaluation; skip the
    // validator's freshness assert so we can return freshness_expired instead.
    if (!(observedAfterFreshUntil && mode === 'post_evaluation')) {
      try {
        assertCurrentEvaluationContextV1(context);
      } catch (error) {
        if (mode === 'post_evaluation') {
          throw new PostEvaluationContextMalformedError(String(error));
        }
        throw error;
      }
    }

    return {
      context,
      control,
      evidence,
      gateReceipts,
      evaluatorAuthority,
      observedAt,
      freshUntil,
    };
  }

  function comparePostEvaluation(
    accepted: ResolvedFreshContextV1,
    second: ResolvedFreshContextV1 | null,
    resolutionError: unknown | null,
  ): EvaluationGapV1['reason'] | null {
    if (resolutionError instanceof PostEvaluationContextMalformedError) {
      return 'post_evaluation_context_malformed';
    }
    if (resolutionError !== null || second === null) {
      return 'trusted_source_unavailable';
    }

    const a = accepted.context.stableIdentity;
    const b = second.context.stableIdentity;

    if (a.controlIdentityHash !== b.controlIdentityHash) {
      return 'control_changed';
    }
    if (a.evidenceIdentityHash !== b.evidenceIdentityHash) {
      return 'evidence_changed';
    }
    if (a.gateReceiptSetHash !== b.gateReceiptSetHash) {
      return 'gate_receipts_changed';
    }
    if (a.roleAuthorityHash !== b.roleAuthorityHash) {
      return 'role_authority_changed';
    }
    if (a.evaluatorAuthorityHash !== b.evaluatorAuthorityHash) {
      return 'evaluator_authority_changed';
    }
    if (a.runtimeCapabilitySetHash !== b.runtimeCapabilitySetHash) {
      return 'capability_identity_changed';
    }
    if (
      a.clockCapabilityId !== b.clockCapabilityId ||
      a.clockEpochId !== b.clockEpochId
    ) {
      return 'clock_identity_changed';
    }
    if (a.authorityEpoch !== b.authorityEpoch) {
      return 'authority_epoch_changed';
    }
    if (a.inputHash !== b.inputHash) {
      return 'post_evaluation_context_malformed';
    }
    if (a.freshUntil !== b.freshUntil) {
      return 'freshness_expired';
    }
    // Defense: compare identity payload hashes, not only stored fields.
    if (
      accepted.control.controlIdentityHash !== second.control.controlIdentityHash ||
      accepted.evidence.evidenceIdentityHash !==
        second.evidence.evidenceIdentityHash
    ) {
      return accepted.control.controlIdentityHash !==
        second.control.controlIdentityHash
        ? 'control_changed'
        : 'evidence_changed';
    }

    if (Date.parse(second.observedAt) < Date.parse(accepted.observedAt)) {
      return 'clock_moved_backwards';
    }
    if (
      Date.parse(second.control.observedAt) <
      Date.parse(accepted.control.observedAt)
    ) {
      return 'clock_moved_backwards';
    }
    if (
      Date.parse(second.evidence.observedAt) <
      Date.parse(accepted.evidence.observedAt)
    ) {
      return 'clock_moved_backwards';
    }
    if (
      Date.parse(second.control.observedAt) > Date.parse(second.observedAt) ||
      Date.parse(second.evidence.observedAt) > Date.parse(second.observedAt)
    ) {
      return 'post_evaluation_context_malformed';
    }
    if (Date.parse(second.observedAt) > Date.parse(accepted.freshUntil)) {
      return 'freshness_expired';
    }

    return null;
  }

  function buildGap(args: {
    readonly requestId: string;
    readonly inputHash: string;
    readonly accepted: ResolvedFreshContextV1;
    readonly second: ResolvedFreshContextV1 | null;
    readonly reason: EvaluationGapV1['reason'];
    readonly observedAt: string;
  }): EvaluationGapV1 {
    const observedContextHash =
      args.second === null ? null : args.second.context.contextHash;
    const observedStableContextHash =
      args.second === null
        ? null
        : args.second.context.stableIdentity.stableContextHash;
    const withoutHash: Omit<EvaluationGapV1, 'gapHash'> = {
      schema: 'hercules-independent-evaluation-gap/v1',
      requestId: args.requestId,
      inputHash: args.inputHash,
      acceptedContextHash: args.accepted.context.contextHash,
      acceptedStableContextHash:
        args.accepted.context.stableIdentity.stableContextHash,
      observedContextHash,
      observedStableContextHash,
      reason: args.reason,
      proposalDiscarded: true,
      outcome: 'need_more_evidence',
      observedAt: args.observedAt,
    };
    const gap: EvaluationGapV1 = {
      ...withoutHash,
      gapHash: computeGapHash(withoutHash),
    };
    assertEvaluationGapV1(gap);
    return deepFreeze(gap);
  }

  function noProposalReasonForClassification(
    classification: string,
  ): IndependentEvaluationReceiptV1['noProposalReason'] {
    switch (classification) {
      case 'pass':
        return 'deterministic_pass';
      case 'verified_fail':
        return 'deterministic_fail';
      case 'need_more_evidence':
        return 'evidence_gap';
      default:
        return 'evidence_gap';
    }
  }

  async function runFreshEvaluation(
    input: IndependentEvaluationInputV1,
    accepted: ResolvedFreshContextV1,
  ): Promise<IndependentEvaluationOutcomeV1> {
    const preflight = runDeterministicPreflight({
      input,
      control: accepted.control,
      evidence: accepted.evidence,
      gateReceipts: accepted.gateReceipts,
    });

    let proposal: EvaluatorProposalV1 | null = null;
    let dispatches: readonly EvaluationCancellationDispatchV1[] = [];
    let infrastructureFailure:
      | {
          readonly code: 'evaluator_unavailable' | 'evaluator_contract_violation';
          readonly detail: string;
        }
      | undefined;

    if (preflight.classification === 'model_judgment_required') {
      const request = buildSanitizedEvaluationRequest({
        input,
        control: accepted.control,
        preflight,
      });
      const attempt: EvaluatorAttemptOutcomeV1 = await runEvaluatorAttempt({
        request,
        evaluatorPort: capabilities.evaluatorPort,
        deadline: capabilities.deadline,
        cancellationFactory: capabilities.cancellationFactory,
        policy: accepted.control.policy,
        rubric: accepted.control.rubric,
        roles: accepted.control.roles,
      });
      dispatches = attempt.dispatches;
      const dispatchFailed = attempt.dispatches.some(
        (dispatch) => dispatch.status === 'dispatch_failed',
      );
      if (attempt.kind === 'proposal' && !dispatchFailed) {
        proposal = attempt.proposal;
      } else if (attempt.kind === 'proposal') {
        // A dispatch_failed record is an infrastructure gap: discard the
        // proposal so no pass verdict can rest on an unsettled peer.
        infrastructureFailure = {
          code: 'evaluator_unavailable',
          detail: 'cancellation dispatch failed alongside an evaluator proposal',
        };
        proposal = null;
      } else {
        infrastructureFailure = {
          code: attempt.code,
          detail: attempt.advisoryDetail,
        };
        proposal = null;
      }
    }

    // Step 4: post-settlement second context resolution (every path).
    let second: ResolvedFreshContextV1 | null = null;
    let resolutionError: unknown | null = null;
    let secondObservedAt = accepted.observedAt;
    try {
      second = await resolveFreshContext(input.inputHash, 'post_evaluation');
      secondObservedAt = second.observedAt;
    } catch (error) {
      resolutionError = error;
      try {
        secondObservedAt = capabilities.clock.nowUtc();
      } catch {
        secondObservedAt = accepted.observedAt;
      }
    }

    const gapReason = comparePostEvaluation(accepted, second, resolutionError);
    if (gapReason !== null) {
      const observedHashesNull =
        gapReason === 'trusted_source_unavailable' ||
        gapReason === 'post_evaluation_context_malformed';
      const gap = buildGap({
        requestId: input.requestId,
        inputHash: input.inputHash,
        accepted,
        second: observedHashesNull ? null : second,
        reason: gapReason,
        observedAt: secondObservedAt,
      });
      return freezeOutcome({ kind: 'gap', gap });
    }

    // second is non-null and matching when gapReason is null
    const post = second!;

    const derived = deriveVerdict({
      input,
      control: accepted.control,
      evidence: accepted.evidence,
      preflight,
      proposal,
      verdictId: `verdict-${input.requestId}`,
      createdAt: post.observedAt,
      evaluatorVersion: capabilities.evaluatorVersion,
      evaluatorModel: capabilities.evaluatorModel,
      evaluatorRuntime: capabilities.evaluatorRuntime,
      ...(infrastructureFailure !== undefined
        ? { evaluatorInfrastructureFailure: infrastructureFailure }
        : {}),
    });

    const settledProposal = proposal;
    const proposalHash =
      settledProposal === null ? null : settledProposal.proposalHash;
    const noProposalReason =
      settledProposal !== null
        ? null
        : infrastructureFailure !== undefined
          ? 'evidence_gap'
          : noProposalReasonForClassification(preflight.classification);

    const receiptWithoutHash: Omit<IndependentEvaluationReceiptV1, 'receiptHash'> =
      {
        schema: 'hercules-independent-evaluation-receipt/v1',
        receiptId: `receipt-${input.requestId}`,
        requestId: input.requestId,
        inputHash: input.inputHash,
        taskId: accepted.evidence.taskContract.taskId,
        taskContractHash: accepted.evidence.taskContract.contractHash,
        iterationId: accepted.evidence.iterationId,
        candidateCommit: accepted.evidence.verificationResult.candidateCommit,
        manifestId: accepted.evidence.evidenceManifest.id,
        manifestHash: accepted.evidence.evidenceManifest.manifestHash,
        artifactInventoryHash: hashCanonicalJson(input.artifacts),
        verificationResultHash: accepted.evidence.verificationResult.resultHash,
        verificationReceiptSetHash: hashCanonicalJson(input.verificationReceipts),
        integrityAttestationHash:
          accepted.evidence.integrityAttestation.attestationHash,
        assertionSetHash: hashCanonicalJson(input.assertions),
        gatePlanHash: accepted.control.gatePlan.gatePlanHash,
        gateReceiptSetHash: accepted.context.gateReceiptSetHash,
        policyHash: accepted.control.policy.policyHash,
        rubricHash: accepted.control.rubric.rubricHash,
        roleAuthorityHash: accepted.control.roles.authorityHash,
        controlIdentityHash: accepted.control.controlIdentityHash,
        evidenceSourceId: accepted.evidence.sourceId,
        evidenceIdentityHash: accepted.evidence.evidenceIdentityHash,
        authorityEpoch: accepted.control.authorityEpoch,
        coordinatorRunId: capabilities.coordinatorRunId,
        evaluatorRunId: accepted.control.roles.evaluatorRunId,
        evaluatorImplementationId:
          accepted.control.roles.evaluatorImplementationId,
        acceptedContextHash: accepted.context.contextHash,
        postEvaluationContextHash: post.context.contextHash,
        stableContextHash: accepted.context.stableIdentity.stableContextHash,
        acceptedObservedAt: accepted.observedAt,
        postEvaluationObservedAt: post.observedAt,
        freshUntil: accepted.freshUntil,
        preflightHash: preflight.preflightHash,
        proposalHash,
        noProposalReason,
        cancellationDispatches: dispatches,
        verdict: derived.verdict,
        verdictHash: computeVerdictHash(derived.verdict),
        criterionRelationships: derived.criterionRelationships,
        outcomeReasonCodes: derived.outcomeReasonCodes,
        createdAt: post.observedAt,
      };

    const receipt: IndependentEvaluationReceiptV1 = deepFreeze({
      ...receiptWithoutHash,
      receiptHash: computeEvaluationReceiptHash(receiptWithoutHash),
    });
    assertIndependentEvaluationReceiptV1(receipt);
    qualifiedReceipts.add(receipt);
    return freezeOutcome({ kind: 'receipt', receipt });
  }

  async function evaluate(
    input: IndependentEvaluationInputV1,
  ): Promise<IndependentEvaluationOutcomeV1> {
    let accepted: ResolvedFreshContextV1;
    try {
      accepted = await resolveFreshContext(input.inputHash, 'pre_acceptance');
    } catch (error) {
      return mapThrownToUnavailable(error);
    }

    const stableHash = accepted.context.stableIdentity.stableContextHash;
    const existingStable = requestIdToStableHash.get(input.requestId);
    if (existingStable !== undefined && existingStable !== stableHash) {
      return freezeOutcome({
        kind: 'conflict',
        code: 'idempotency_conflict',
        detail: `requestId ${input.requestId} is reserved against a different stableContextHash`,
      });
    }

    const key = reservationKey(input.requestId, stableHash);
    const existing = reservations.get(key);
    if (existing !== undefined) {
      if (existing.status === 'in_flight' || existing.status === 'settled') {
        return existing.promise;
      }
    }

    if (reservations.size >= maxReservations) {
      return freezeOutcome({
        kind: 'capacity',
        code: 'coordinator_capacity',
        detail: `coordinator reservation table is full at ${maxReservations}`,
      });
    }

    let settle!: (outcome: IndependentEvaluationOutcomeV1) => void;
    const promise = new Promise<IndependentEvaluationOutcomeV1>((resolve) => {
      settle = resolve;
    });

    const inFlight: ReservationState = {
      stableContextHash: stableHash,
      accepted,
      status: 'in_flight',
      promise,
    };
    reservations.set(key, inFlight);
    requestIdToStableHash.set(input.requestId, stableHash);

    try {
      const outcome = await runFreshEvaluation(input, accepted);
      const settled: ReservationState = {
        stableContextHash: stableHash,
        accepted,
        status: 'settled',
        promise,
        outcome,
      };
      reservations.set(key, settled);
      settle(outcome);
      return outcome;
    } catch (error) {
      // Unexpected post-acceptance failure → memoized gap when possible.
      let observedAt = accepted.observedAt;
      try {
        observedAt = capabilities.clock.nowUtc();
      } catch {
        // keep accepted
      }
      const gap = buildGap({
        requestId: input.requestId,
        inputHash: input.inputHash,
        accepted,
        second: null,
        reason: 'trusted_source_unavailable',
        observedAt,
      });
      const outcome = freezeOutcome({ kind: 'gap', gap });
      const settled: ReservationState = {
        stableContextHash: stableHash,
        accepted,
        status: 'settled',
        promise,
        outcome,
      };
      reservations.set(key, settled);
      settle(outcome);
      // Prefer unavailable only if somehow gap construction itself is impossible;
      // otherwise contract wants memoized gap post-acceptance.
      void error;
      return outcome;
    }
  }

  function isAuthorityQualified(
    receipt: IndependentEvaluationReceiptV1,
  ): boolean {
    return qualifiedReceipts.has(receipt);
  }

  async function restoreQualifiedReceipt(
    dto: IndependentEvaluationReceiptV1,
    reconstruction: ReceiptReconstructionV1,
  ): Promise<{ readonly restored: boolean; readonly reason: string }> {
    let fresh: ResolvedFreshContextV1;
    try {
      fresh = await resolveFreshContext(dto.inputHash, 'pre_acceptance');
    } catch (error) {
      return {
        restored: false,
        reason:
          error instanceof IndependentEvaluationError
            ? error.message
            : String(error),
      };
    }

    try {
      assertIndependentEvaluationReceiptV1(dto);
    } catch (error) {
      return {
        restored: false,
        reason: `receipt assertion failed: ${String(error)}`,
      };
    }

    // A receipt that consumed an evaluator proposal cannot be re-admitted from
    // caller-supplied bytes: its verdict depends on non-deterministic evaluator
    // output that restore cannot re-authenticate (M8 has no trusted proposal
    // store — durable cross-restart re-admission of model-path receipts belongs
    // to the later state/worker integration). Only deterministic and
    // infrastructure-failure receipts (proposalHash null) are restorable, and
    // their verdicts re-derive from authenticated inputs alone. Accepting a
    // caller-supplied proposal here would let a fabricated pass proposal mint an
    // authority-qualified pass the evaluator never produced.
    if (dto.proposalHash !== null) {
      return {
        restored: false,
        reason:
          'a receipt that consumed an evaluator proposal cannot be restored without a trusted proposal source',
      };
    }
    if (reconstruction.proposal !== null) {
      return {
        restored: false,
        reason: 'restore does not accept a caller-supplied evaluator proposal',
      };
    }

    const checks: readonly { readonly ok: boolean; readonly reason: string }[] =
      [
        {
          ok: dto.controlIdentityHash === fresh.control.controlIdentityHash,
          reason: 'controlIdentityHash mismatch',
        },
        {
          ok: dto.policyHash === fresh.control.policy.policyHash,
          reason: 'policyHash mismatch',
        },
        {
          ok: dto.rubricHash === fresh.control.rubric.rubricHash,
          reason: 'rubricHash mismatch',
        },
        {
          ok: dto.evidenceIdentityHash === fresh.evidence.evidenceIdentityHash,
          reason: 'evidenceIdentityHash mismatch',
        },
        {
          ok: dto.gateReceiptSetHash === fresh.context.gateReceiptSetHash,
          reason: 'gateReceiptSetHash mismatch',
        },
        {
          ok: dto.roleAuthorityHash === fresh.control.roles.authorityHash,
          reason: 'roleAuthorityHash mismatch',
        },
        {
          ok: dto.authorityEpoch === fresh.control.authorityEpoch,
          reason: 'authorityEpoch mismatch',
        },
        {
          ok: dto.evaluatorRunId === fresh.evaluatorAuthority.evaluatorRunId,
          reason: 'evaluatorRunId mismatch',
        },
        {
          ok:
            dto.evaluatorImplementationId ===
            fresh.evaluatorAuthority.evaluatorImplementationId,
          reason: 'evaluatorImplementationId mismatch',
        },
        {
          ok: dto.inputHash === fresh.context.inputHash,
          reason: 'inputHash mismatch',
        },
        {
          ok:
            dto.artifactInventoryHash ===
            hashCanonicalJson(fresh.evidence.artifacts),
          reason: 'artifactInventoryHash mismatch',
        },
        {
          ok:
            dto.verificationReceiptSetHash ===
            hashCanonicalJson(fresh.evidence.verificationReceipts),
          reason: 'verificationReceiptSetHash mismatch',
        },
        {
          ok:
            dto.assertionSetHash ===
            hashCanonicalJson(fresh.evidence.assertions),
          reason: 'assertionSetHash mismatch',
        },
        {
          ok:
            dto.integrityAttestationHash ===
            fresh.evidence.integrityAttestation.attestationHash,
          reason: 'integrityAttestationHash mismatch',
        },
        {
          ok:
            dto.verificationResultHash ===
            fresh.evidence.verificationResult.resultHash,
          reason: 'verificationResultHash mismatch',
        },
        {
          ok:
            dto.stableContextHash ===
            fresh.context.stableIdentity.stableContextHash,
          reason: 'stableContextHash mismatch',
        },
        {
          ok: Date.parse(fresh.observedAt) <= Date.parse(dto.freshUntil),
          reason: 'fresh observedAt is after dto.freshUntil',
        },
        {
          ok: (() => {
            const { receiptHash: _drop, ...rest } = dto;
            return computeEvaluationReceiptHash(rest) === dto.receiptHash;
          })(),
          reason: 'receiptHash mismatch',
        },
      ];

    for (const check of checks) {
      if (!check.ok) {
        return { restored: false, reason: check.reason };
      }
    }

    // Bindings match the fresh context. Now re-derive the decision-bearing
    // payload from authenticated inputs rather than trusting the DTO's stored
    // verdict. The proposal is always null here (proposal-consuming receipts
    // were refused above), so the verdict is a deterministic function of
    // (input, fresh control/evidence, preflight) plus, on the model-judgment
    // infrastructure-failure path, the caller-declared failure which can only
    // produce need_more_evidence.
    const { input } = reconstruction;
    const proposal = null;
    if (input.inputHash !== dto.inputHash) {
      return { restored: false, reason: 'reconstruction input inputHash mismatch' };
    }
    try {
      assertIndependentEvaluationInputV1(input, fresh.control.policy);
    } catch (error) {
      return {
        restored: false,
        reason: `reconstruction input assertion failed: ${String(error)}`,
      };
    }
    const preflight = runDeterministicPreflight({
      input,
      control: fresh.control,
      evidence: fresh.evidence,
      gateReceipts: fresh.gateReceipts,
    });
    if (preflight.preflightHash !== dto.preflightHash) {
      return { restored: false, reason: 'reconstruction preflightHash mismatch' };
    }
    const requiresProposal = preflight.classification === 'model_judgment_required';
    if (requiresProposal && reconstruction.evaluatorInfrastructureFailure === undefined) {
      return {
        restored: false,
        reason:
          'reconstruction requires an infrastructure failure for the model-judgment path',
      };
    }
    let derived;
    try {
      derived = deriveVerdict({
        input,
        control: fresh.control,
        evidence: fresh.evidence,
        preflight,
        proposal,
        verdictId: dto.verdict.id,
        createdAt: dto.createdAt,
        evaluatorVersion: capabilities.evaluatorVersion,
        evaluatorModel: capabilities.evaluatorModel,
        evaluatorRuntime: capabilities.evaluatorRuntime,
        ...(reconstruction.evaluatorInfrastructureFailure !== undefined
          ? { evaluatorInfrastructureFailure: reconstruction.evaluatorInfrastructureFailure }
          : {}),
      });
    } catch (error) {
      return {
        restored: false,
        reason: `reconstruction verdict derivation failed: ${String(error)}`,
      };
    }
    if (hashCanonicalJson(derived.verdict) !== dto.verdictHash) {
      return { restored: false, reason: 'reconstruction verdict differs from the DTO' };
    }
    if (dto.verdictHash !== computeVerdictHash(dto.verdict)) {
      return { restored: false, reason: 'dto verdictHash does not cover its verdict' };
    }
    if (
      hashCanonicalJson(derived.criterionRelationships) !==
      hashCanonicalJson(dto.criterionRelationships)
    ) {
      return {
        restored: false,
        reason: 'reconstruction criterionRelationships differ from the DTO',
      };
    }
    if (
      hashCanonicalJson(derived.outcomeReasonCodes) !==
      hashCanonicalJson(dto.outcomeReasonCodes)
    ) {
      return {
        restored: false,
        reason: 'reconstruction outcomeReasonCodes differ from the DTO',
      };
    }

    deepFreeze(dto);
    qualifiedReceipts.add(dto);
    return { restored: true, reason: 'restored' };
  }

  return {
    evaluate,
    isAuthorityQualified,
    restoreQualifiedReceipt,
  };
}
