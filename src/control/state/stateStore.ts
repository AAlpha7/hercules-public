import type {
  ArtifactRef,
  CandidateRef,
  EvidenceManifest,
} from '../../domain/artifact.js';
import type {
  AssertionVerificationReceipt,
  DecisionAssertion,
  EvidenceIntegrityAttestation,
} from '../../domain/claimAuthorityV2.js';
import type {
  ContractChangeProvenance,
  ContractChangeRequest,
  TrustedContractChangeAuthority,
} from '../../domain/contractChange.js';
import type {
  AdmissionLedgerEntryV1,
  AdmissionVerdictV1,
  ControlApiV2ReceiptV1,
  ControlApiV2RequestV1,
} from '../../domain/controlApiV2.js';
import type {
  ControlEvent,
  ControlEventMetadata,
  V2ProjectionState,
  V2UnprojectableReason,
} from '../../domain/controlEvent.js';
import type { HumanDecision } from '../../domain/humanDecision.js';
import type { IndependentEvaluationReceiptV1 } from '../../domain/independentEvaluation.js';
import type { Iteration } from '../../domain/iteration.js';
import type {
  EvaluationDecisionRecordV2,
  ReviewPackageV2,
} from '../../domain/reviewPackageV2.js';
import type { StageRun } from '../../domain/stageRun.js';
import type { TaskContract } from '../../domain/taskContract.js';
import type { Task } from '../../domain/task.js';
import type { V2TaskStatus } from '../../domain/v2TaskStatus.js';

export type ShadowMutation =
  | { readonly kind: 'insert_contract_root'; readonly contract: TaskContract }
  | {
      readonly kind: 'append_contract_successor';
      readonly request: ContractChangeRequest;
      readonly provenance: ContractChangeProvenance;
      readonly trustedAuthority: TrustedContractChangeAuthority;
    }
  | { readonly kind: 'put_iteration'; readonly iteration: Iteration }
  | { readonly kind: 'put_stage_run'; readonly stageRun: StageRun }
  | { readonly kind: 'retire_task'; readonly taskId: string; readonly revision: string };

export interface ShadowCommitCommand {
  readonly idempotencyKey: string;
  readonly event: ControlEventMetadata;
  readonly mutation: ShadowMutation;
}

export interface ShadowCommitReceipt {
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly eventHash: string;
  readonly mutationKind: ShadowMutation['kind'];
  readonly aggregateKind: ControlEvent['aggregateKind'];
  readonly aggregateId: string;
  readonly committedAt: string;
}

export interface ShadowTaskState {
  readonly taskId: string;
  readonly contracts: readonly TaskContract[];
  readonly iterations: readonly Iteration[];
  readonly stageRuns: readonly StageRun[];
  readonly retirement: ShadowTaskRetirement | null;
}

export interface ShadowTaskRetirement {
  readonly taskId: string;
  readonly revision: string;
}

export interface ProjectionManifestEntry {
  readonly idempotencyKey: string;
  readonly commandDigest: string;
}

/**
 * Reconciliation envelopes (C3.40, 2026-09-11) persist one stub per task —
 * identity + state — instead of the whole task: a full snapshot per observe
 * pass grew the store 2.7 GB/day (1907 envelopes, 5.3 GB) and made every boot
 * replay it. The exact tree stays bound through the reconciliation delivery
 * id (a digest over every task including its body) and is reconstructed from
 * Git when history is built. Live (`git-`) and bridge deliveries still
 * persist full tasks.
 */
export interface ReconciliationAuthorityStub {
  readonly id: string;
  readonly state: Task['state'];
  readonly reconciliationStub: true;
}

export type ProjectionAuthorityWrite = Task | ReconciliationAuthorityStub;

export function isReconciliationAuthorityStub(
  write: ProjectionAuthorityWrite,
): write is ReconciliationAuthorityStub {
  return (write as ReconciliationAuthorityStub).reconciliationStub === true;
}

export interface ProjectionEnvelopeInput {
  readonly deliveryId: string;
  readonly authorityRevision: string;
  /**
   * Exact immutable authority input of a persisted envelope. Since C3.58 a
   * delivery that projects no command and no gap persists no envelope (the
   * control repo keeps those bytes; the observed-revision cursor records that
   * the revision was processed), so "declared no-op task writes" appear here
   * only when the same delivery also carried a projecting write.
   */
  readonly authorityInput: {
    readonly writes: readonly ProjectionAuthorityWrite[];
    readonly retiredTaskIds: readonly string[];
  };
  readonly manifest: readonly ProjectionManifestEntry[];
  readonly gapCodes: readonly string[];
}

export interface ProjectionEnvelopeState extends ProjectionEnvelopeInput {
  readonly manifestDigest: string;
  readonly completed: boolean;
  readonly acknowledgedCommands: number;
  /**
   * C3.58: the delivery projected zero commands, so no envelope was persisted
   * (materialized aggregates were still refreshed; `gapCodes` carries the
   * live-computed gaps for the caller). Never true on a state read back from
   * the store.
   */
  readonly skipped?: true;
}

/** Identity columns of one envelope — never carries the authority input. */
export interface ProjectionEnvelopeKey {
  readonly deliveryId: string;
  readonly authorityRevision: string;
  readonly manifestDigest: string;
  readonly commandCount: number;
  readonly completed: boolean;
  readonly acknowledgedCommands: number;
}

/** Manifest + gap codes of one envelope, read without its authority input. */
export interface ProjectionEnvelopeManifest {
  readonly deliveryId: string;
  readonly authorityRevision: string;
  readonly manifest: readonly ProjectionManifestEntry[];
  readonly gapCodes: readonly string[];
  readonly manifestDigest: string;
}

export interface StartupIntegrityReport {
  readonly schemaVersion: number;
  readonly eventCount: number;
  readonly receiptCount: number;
  readonly lastEventHash: string | null;
  readonly journalMode: 'wal';
  readonly foreignKeys: true;
  readonly synchronous: 'full';
}

export interface ExportReceipt {
  readonly bundlePath: string;
  readonly databaseSha256: string;
  readonly manifestSha256: string;
  readonly eventCount: number;
  readonly lastEventHash: string | null;
  /** This inherited export is diagnostic metadata, never a recoverable evidence archive. */
  readonly artifactContentIncluded: false;
}

export const STATE_STORE_ERROR_CODES = [
  'invalid_input',
  'not_initialized',
  'closed',
  'integrity',
  'migration',
  'idempotency_conflict',
  'constraint',
  'busy',
  'unsafe_path',
  'export',
  'unsupported',
] as const;

export type StateStoreErrorCode = (typeof STATE_STORE_ERROR_CODES)[number];

export class StateStoreError extends Error {
  override readonly name = 'StateStoreError';

  constructor(
    readonly code: StateStoreErrorCode,
    message: string,
    readonly originalCause?: unknown,
  ) {
    super(message);
  }
}

export interface V2BoundEvidenceV1 {
  readonly schema: 'hercules-v2-bound-evidence/v1';
  readonly aggregateId: string;
  readonly iterationId: string;
  readonly candidateRef: CandidateRef;
  readonly evidenceManifest: EvidenceManifest;
  readonly artifacts: readonly ArtifactRef[];
  readonly assertions: readonly DecisionAssertion[];
  readonly verificationReceipts: readonly AssertionVerificationReceipt[];
  readonly evidenceIntegrity: EvidenceIntegrityAttestation;
  readonly producer: { readonly implementation: string; readonly verifierRunId: string };
  readonly recordedAt: string;
  readonly evidenceHash: string;
}

export interface V2BoundEvaluationV1 {
  readonly schema: 'hercules-v2-bound-evaluation/v1';
  readonly aggregateId: string;
  readonly iterationId: string;
  readonly evidenceHash: string;
  readonly receipt: IndependentEvaluationReceiptV1;
  readonly evaluation: EvaluationDecisionRecordV2;
  readonly evaluator: {
    readonly runId: string;
    readonly implementationId: string;
    readonly version: string;
    readonly model: string | null;
    readonly runtime: string;
  };
  readonly recordedAt: string;
  readonly evaluationHash: string;
}

export interface ReviewPackageRefreshInput {
  readonly aggregateId: string;
  readonly taskStatus: V2TaskStatus;
  readonly shadow: ShadowTaskState;
  readonly humanDecisions: readonly HumanDecision[];
  readonly evidence: V2BoundEvidenceV1 | null;
  readonly evaluation: V2BoundEvaluationV1 | null;
}

export type ReviewPackageRefreshResult =
  | { readonly kind: 'projected'; readonly reviewPackage: ReviewPackageV2 }
  | { readonly kind: 'unprojectable'; readonly reason: V2UnprojectableReason };

/** Injected by main.ts (C2.3 assembler). Throwing = infrastructure failure = the enclosing transaction fails loudly. */
export type ReviewPackageRefreshSeam = (input: ReviewPackageRefreshInput) => ReviewPackageRefreshResult;

export interface V2AggregateRow {
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly taskStatus: V2TaskStatus;
  readonly projectionState: V2ProjectionState;
  readonly unprojectableReason: V2UnprojectableReason | null;
  readonly projectionHash: string | null;
  readonly reviewPackage: ReviewPackageV2 | null;
  readonly updatedAtSequence: number;
}

export interface V2SweepReport {
  readonly performed: boolean;
  readonly reason: 'seam_not_wired' | 'already_swept' | 'swept';
  readonly materializedCount: number;
}

export const V2_INITIAL_SWEEP_KEY = 'c2_initial_materialization';

export interface V2PendingEffectRow {
  readonly keyHash: string;
  readonly aggregateId: string;
  readonly action: 'approve_outcome' | 'reject_outcome' | 'request_changes';
  readonly eventSequence: number;
  readonly effectState: 'pending' | 'applied';
  readonly appliedAtSequence: number | null;
}

export interface V2DecisionEventView {
  readonly aggregateId: string;
  readonly action: V2PendingEffectRow['action'];
  readonly reason: string;
  readonly actorId: string;
  readonly actorIssuer: string;
  readonly decidedAt: string;
  readonly keyHash: string;
  readonly acknowledgedRiskCodes: readonly string[];
}

export interface ControlStateStore {
  initialize(): StartupIntegrityReport;
  commit(command: ShadowCommitCommand): ShadowCommitReceipt;
  beginEnvelope(envelope: ProjectionEnvelopeInput): ProjectionEnvelopeState;
  commitBatch(
    deliveryId: string,
    batchOrdinal: number,
    commands: readonly ShadowCommitCommand[],
  ): readonly ShadowCommitReceipt[];
  completeEnvelope(deliveryId: string): ProjectionEnvelopeState;
  readEnvelope(deliveryId: string): ProjectionEnvelopeState | null;
  /**
   * Manifest + gap codes of one envelope WITHOUT its authority input. The
   * authority input of a reconciliation envelope snapshots every task body
   * (multi-MB); replay only needs the manifest, whose replay check against
   * Git authority stays fail-closed regardless of this row's digest.
   */
  readEnvelopeManifest(deliveryId: string): ProjectionEnvelopeManifest | null;
  /** Immutable insertion order, including completed and incomplete envelopes. */
  listProjectionEnvelopes(): readonly ProjectionEnvelopeState[];
  /**
   * Same order as `listProjectionEnvelopes` but only the cheap identity
   * columns — no JSON blob is read or parsed. History-sized loops must use
   * this; a full listing materializes every envelope's authority input.
   */
  listProjectionEnvelopeKeys(): readonly ProjectionEnvelopeKey[];
  listIncompleteEnvelopes(): readonly ProjectionEnvelopeState[];
  /**
   * Cheap caught-up probe: authority revision of the latest envelope by rowid,
   * or null when the store has no projection envelopes.
   */
  latestProjectionEnvelopeRevision(): string | null;
  /**
   * C3.58: authority revision the observer has fully processed (durable cursor;
   * envelopes alone no longer mark no-op revisions). Null before the first record.
   */
  observedAuthorityRevision?(): string | null;
  recordObservedAuthorityRevision?(revision: string): void;
  /**
   * C3.58: refresh the V2 materialized aggregates for a delivery whose
   * projection produced no envelope (same side effect completeEnvelope has).
   */
  refreshMaterializedForDelivery?(delivery: {
    readonly writes: readonly ProjectionAuthorityWrite[];
    readonly retiredTaskIds: readonly string[];
  }): void;
  listTaskIds(): readonly string[];
  readTask(taskId: string): ShadowTaskState | null;
  readEvents(afterSequence: number, limit: number): readonly ControlEvent[];
  /** Seam-keyed one-time materialize-if-absent + refresh over the current legacy snapshot (contract §C2.1 mechanism 1). Idempotent. */
  sweepV2Aggregates(tasks: readonly Task[]): V2SweepReport;
  readV2Aggregate(aggregateId: string): V2AggregateRow | null;
  /** This aggregate's committed decisions rebuilt from V2DecisionCommitted events, chain order. */
  readV2HumanDecisions(aggregateId: string): readonly HumanDecision[];
  /** The admission-ledger entry for an idempotency key hash, or null. Never returns refused receipts (they are never ledgered). */
  readV2AdmissionLedgerEntry(keyHash: string): AdmissionLedgerEntryV1 | null;
  /**
   * Contract §C2.1 commitV2 — ONE transaction().immediate() on this connection:
   * replay-first with request_hash comparison → CAS vs request.concurrencyToken.stateVersion →
   * append V2DecisionCommitted, bump, ledger insert, refresh seam (V2AggregateRefreshed AFTER),
   * pending-effect marker, committed receipt. Refusals are validated receipts and are NEVER ledgered.
   * Only decision submits are supported; anything else throws StateStoreError('unsupported').
   */
  commitV2(request: ControlApiV2RequestV1, verdict: AdmissionVerdictV1): ControlApiV2ReceiptV1;
  readPendingEffect(keyHash: string): V2PendingEffectRow | null;
  /** Pending markers only (`effect_state = 'pending'`), ordered by event_sequence. */
  listPendingEffects(): readonly V2PendingEffectRow[];
  /**
   * Marks the effect applied at the given control-event sequence; idempotent for an
   * already-applied row with the same sequence; unknown keyHash → StateStoreError('invalid_input');
   * a different sequence on an applied row → StateStoreError('integrity'). Never deletes rows.
   */
  markEffectApplied(keyHash: string, appliedAtSequence: number): V2PendingEffectRow;
  /** The decision event's payload for an effect, read from control_events by event_sequence. */
  readDecisionEvent(eventSequence: number): V2DecisionEventView | null;
  /** max(sequence) of control_events, or 0 when empty. */
  latestEventSequence(): number;
  exportSnapshot(destinationRoot: string, bundleName: string): ExportReceipt;
  close(): void;
}
