/**
 * Verified-evidence producer (cutover C3.1a).
 *
 * Stages live under VerifiedEvidenceIntake. This module captures staged bytes
 * through ArtifactEvidenceArchive, builds assertions/receipts/attestation, and
 * binds via store.bindReviewEvidence. Injectable — no main/orchestrator wiring.
 */
import { createHash } from 'node:crypto';

import type {
  ArtifactRef,
  CandidateRef,
  EvidenceManifest,
} from '../domain/artifact.js';
import {
  computeAssertionPayloadHash,
  computeEvidenceIntegrityAttestationHash,
  computeVerificationReceiptHash,
  type AssertionVerificationReceipt,
  type DecisionAssertion,
  type EvidenceIntegrityAttestation,
} from '../domain/claimAuthorityV2.js';
import { parseMechProofBinding } from '../domain/mechProof.js';
import type { ActorRef } from '../domain/taskContract.js';
import type { AuthorityRoster } from './authorityRoster.js';
import type {
  ArchiveAuthorityContext,
  ArtifactCaptureObservation,
} from './artifacts/archiveTypes.js';
import type { ArtifactEvidenceArchive } from './artifacts/evidenceArchive.js';
import type { StageRun } from '../domain/stageRun.js';
import type {
  ShadowCommitCommand,
  ShadowCommitReceipt,
  ShadowTaskState,
  V2BoundEvidenceV1,
} from './state/stateStore.js';
import type {
  StagedVerificationBundleV1,
  VerifiedEvidenceIntake,
} from './verifiedEvidenceIntake.js';

export {
  createVerifiedEvidenceIntake,
  type StagedVerificationBundleV1,
  type VerifiedEvidenceIntake,
  type VerifiedEvidenceIntakeOptions,
  VerifiedEvidenceIntakeError,
  STAGED_VERIFICATION_BUNDLE_SCHEMA,
  DEFAULT_STAGED_BUNDLE_MAX_BYTES,
} from './verifiedEvidenceIntake.js';

export const VERIFIED_EVIDENCE_PRODUCER_IMPLEMENTATION =
  'hercules-control/verifiedEvidence/v1' as const;

const ENVIRONMENT_REF = 'legacy-verifier';
const SURFACE = 'workspace-verification';
const MEDIA_GATE = 'text/plain';
const MEDIA_DIFF = 'text/x-diff';
const MEDIA_PNG = 'image/png';
const PRODUCER_ACTOR: ActorRef = {
  kind: 'control_plane',
  id: 'verified-evidence-producer',
};

export type ProduceOutcome =
  | {
      readonly kind: 'bound';
      readonly aggregateId: string;
      readonly iterationId: string;
      readonly manifestId: string;
      readonly evidenceHash: string;
    }
  | {
      readonly kind: 'skipped';
      readonly aggregateId: string;
      readonly reason:
        | 'no_staged_bundle'
        | 'candidate_mismatch'
        | 'criteria_mismatch'
        | 'already_bound'
        | 'contract_missing';
    }
  | {
      readonly kind: 'failed';
      readonly aggregateId: string;
      readonly error: string;
    };

export interface VerifiedEvidenceProducerPorts {
  readonly store: {
    listAggregatesAwaitingEvidence(): readonly {
      readonly aggregateId: string;
      readonly iterationId: string;
      readonly candidateRef: CandidateRef;
    }[];
    readTask(taskId: string): ShadowTaskState | null;
    commit(command: ShadowCommitCommand): ShadowCommitReceipt;
    bindReviewEvidence(
      record: Omit<V2BoundEvidenceV1, 'evidenceHash'>,
      actor: ActorRef,
    ): {
      readonly evidenceHash: string;
      readonly eventSequence: number;
      readonly refresh: 'materialized' | 'refreshed' | 'unchanged';
    };
    readBoundEvidence(aggregateId: string, iterationId: string): V2BoundEvidenceV1 | null;
  };
  readonly archive: ArtifactEvidenceArchive;
  readonly intake: VerifiedEvidenceIntake;
  readonly roster: AuthorityRoster;
  readonly clock: () => string;
  readonly log: (line: string) => void;
  /**
   * How to obtain the branded archive contexts for a capture; the composition
   * root binds these to the real capability issuer / snapshot functions.
   */
  readonly archiveContexts: {
    authority(input: {
      readonly taskId: string;
      readonly contractVersion: number;
      readonly iterationId: string;
      readonly candidateRef: CandidateRef;
      readonly producerStageRunId: string;
      readonly environmentRef: string;
      readonly surface: string;
      /** Staged bundle `capturedAt` — authority window is derived from this. */
      readonly stageStartedAt: string;
    }): ArchiveAuthorityContext;
    observation(input: {
      readonly authorizationId: string;
      readonly sha256: string;
      readonly byteLength: number;
      readonly observedAt: string;
    }): ArtifactCaptureObservation;
  };
}

interface CapturedArtifact {
  readonly kind: 'gate' | 'diff' | 'screenshot';
  readonly name: string;
  readonly relativeFile: string;
  readonly mediaType: string;
  readonly artifact: ArtifactRef;
  readonly basename: string | null;
}

function loud(
  log: (line: string) => void,
  aggregateId: string,
  detail: string,
): void {
  log(`[hercules] verified evidence ${aggregateId}: ${detail}`);
}

function sortedUnique(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function toArtifactRef(value: {
  readonly id: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly producerStageRunId: string;
  readonly createdAt: string;
  readonly trustClass: ArtifactRef['trustClass'];
  readonly redactionState: ArtifactRef['redactionState'];
}): ArtifactRef {
  return {
    id: value.id,
    sha256: value.sha256,
    mediaType: value.mediaType,
    byteLength: value.byteLength,
    storageKey: value.storageKey,
    producerStageRunId: value.producerStageRunId,
    createdAt: value.createdAt,
    trustClass: value.trustClass,
    redactionState: value.redactionState,
  };
}

function toEvidenceManifest(manifest: EvidenceManifest): EvidenceManifest {
  // ArchivedEvidenceManifest carries schema + entry access/redaction extras that
  // are part of the archived manifestHash body — keep them for hash agreement.
  return manifest;
}

function mechanicalCriterionIds(
  contractCriteria: readonly { readonly id: string; readonly authority: string }[],
): readonly string[] {
  return sortedUnique(
    contractCriteria.filter((criterion) => criterion.authority === 'mechanical').map((c) => c.id),
  );
}

function mapScreenshotCriteria(input: {
  readonly bundle: StagedVerificationBundleV1;
  readonly contractCriteria: readonly {
    readonly id: string;
    readonly text: string;
    readonly authority: string;
  }[];
  readonly screenshotBasename: string;
  readonly screenshotRelativeFile: string;
}): readonly string[] {
  const matched = new Set<string>();
  const basename = input.screenshotBasename;
  for (let index = 0; index < input.bundle.dod.criteria.length; index += 1) {
    const dod = input.bundle.dod.criteria[index]!;
    const contract = input.contractCriteria[index];
    if (contract === undefined || contract.authority !== 'mechanical') continue;
    if (dod.proof.includes(basename)) {
      matched.add(contract.id);
      continue;
    }
    const steps = input.bundle.evidenceRun?.steps ?? [];
    for (const step of steps) {
      if (step.screenshot === null) continue;
      const stepBase = step.screenshot.split(/[/\\]/).pop() ?? step.screenshot;
      if (
        stepBase === basename ||
        step.screenshot === input.screenshotRelativeFile ||
        step.screenshot.endsWith(basename)
      ) {
        if (step.detail.includes(dod.text) || step.detail.includes(contract.text)) {
          matched.add(contract.id);
        }
      }
    }
  }
  return sortedUnique([...matched]);
}

function contentSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function plannedArtifactIds(
  taskId: string,
  iterationId: string,
  bundle: StagedVerificationBundleV1,
): readonly string[] {
  const ids: string[] = [];
  let ordinal = 0;
  for (const _gate of bundle.gates) {
    ordinal += 1;
    ids.push(`artifact-${taskId}-${iterationId}-${ordinal}`);
  }
  ordinal += 1;
  ids.push(`artifact-${taskId}-${iterationId}-${ordinal}`);
  for (const _screenshot of bundle.screenshots) {
    ordinal += 1;
    ids.push(`artifact-${taskId}-${iterationId}-${ordinal}`);
  }
  return sortedUnique(ids);
}

function verifyStageRunId(iterationId: string): string {
  return `stage-verify-${iterationId}`;
}

/**
 * Commit the verify stage-run history the archive requires before capture.
 * The store only admits a new attempt as `queued`, so production walks
 * queued → leased → running → succeeded with deterministic idempotency keys
 * derived from (taskId, iterationId, bundleHash). A retry replays the same
 * commands; a conflicting succeeded row fails loudly.
 */
function ensureVerifyStageRun(
  ports: VerifiedEvidenceProducerPorts,
  input: {
    readonly taskId: string;
    readonly iterationId: string;
    readonly bundle: StagedVerificationBundleV1;
    readonly outputArtifactRefs: readonly string[];
  },
): { readonly ok: true; readonly stageRunId: string } | { readonly ok: false; readonly error: string } {
  const stageRunId = verifyStageRunId(input.iterationId);
  const shadow = ports.store.readTask(input.taskId);
  const existing = shadow?.stageRuns.find((run) => run.id === stageRunId);
  if (existing !== undefined) {
    if (existing.jobSpecHash !== input.bundle.bundleHash) {
      const error =
        `verify stage run ${stageRunId} already exists with a different jobSpecHash ` +
        `(${existing.jobSpecHash} != ${input.bundle.bundleHash}); refusing to overwrite`;
      loud(ports.log, input.taskId, `failed ${error}`);
      return { ok: false, error };
    }
    if (
      existing.state === 'succeeded' &&
      !sameStringArray(existing.outputArtifactRefs, input.outputArtifactRefs)
    ) {
      const error =
        `verify stage run ${stageRunId} already exists with different outputArtifactRefs; ` +
        'refusing to overwrite';
      loud(ports.log, input.taskId, `failed ${error}`);
      return { ok: false, error };
    }
  }

  const structuredResult = {
    schema: 'hercules-c3-verify-stage/v1' as const,
    gates: input.bundle.gates.map((gate) => ({
      name: gate.name,
      passed: gate.passed,
      exitCode: gate.exitCode,
      outcome: gate.outcome,
    })),
    evidenceRunOk: input.bundle.evidenceRun?.ok ?? null,
  };
  const keyBase = `c3-verify:${input.taskId}:${input.iterationId}:${input.bundle.bundleHash}`;
  const eventBase = `c3-verify-event:${input.taskId}:${input.iterationId}:${input.bundle.bundleHash}`;
  const occurredAt = input.bundle.capturedAt;
  const workerId = ports.roster.verifier.runId;

  const queued: StageRun = {
    id: stageRunId,
    iterationId: input.iterationId,
    type: 'verify',
    attempt: 1,
    state: 'queued',
    jobSpecHash: input.bundle.bundleHash,
    workerId: null,
    agentRunIds: [],
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    structuredResult: null,
    startedAt: null,
    endedAt: null,
    failureClass: null,
  };
  const leased: StageRun = {
    ...queued,
    state: 'leased',
    workerId,
  };
  const running: StageRun = {
    ...leased,
    state: 'running',
    startedAt: occurredAt,
  };
  const succeeded: StageRun = {
    ...running,
    state: 'succeeded',
    outputArtifactRefs: input.outputArtifactRefs,
    structuredResult,
    endedAt: occurredAt,
  };

  const steps: ReadonlyArray<{ readonly suffix: string; readonly stageRun: StageRun }> = [
    { suffix: 'queued', stageRun: queued },
    { suffix: 'leased', stageRun: leased },
    { suffix: 'running', stageRun: running },
    { suffix: 'succeeded', stageRun: succeeded },
  ];
  for (const step of steps) {
    ports.store.commit({
      idempotencyKey: `${keyBase}:${step.suffix}`.slice(0, 512),
      event: {
        eventId: `${eventBase}:${step.suffix}`.slice(0, 512),
        actor: PRODUCER_ACTOR,
        occurredAt,
      },
      mutation: { kind: 'put_stage_run', stageRun: step.stageRun },
    });
  }
  return { ok: true, stageRunId };
}

async function captureOne(
  ports: VerifiedEvidenceProducerPorts,
  input: {
    readonly taskId: string;
    readonly contractVersion: number;
    readonly iterationId: string;
    readonly candidateRef: CandidateRef;
    readonly producerStageRunId: string;
    readonly bundle: StagedVerificationBundleV1;
    readonly ordinal: number;
    readonly kind: CapturedArtifact['kind'];
    readonly name: string;
    readonly relativeFile: string;
    readonly mediaType: string;
    readonly basename: string | null;
    readonly expectedSha256: string;
  },
): Promise<CapturedArtifact> {
  const bytes = await ports.intake.readFile(
    input.taskId,
    input.bundle.verifiedSha,
    input.relativeFile,
  );
  const digest = contentSha256(bytes);
  if (digest !== input.expectedSha256) {
    throw new Error(
      `staged bytes digest ${digest} disagrees with bundle digest ${input.expectedSha256} for ${input.relativeFile}`,
    );
  }
  const captureId = `capture-${input.taskId}-${input.iterationId}-${input.ordinal}`;
  const artifactRefId = `artifact-${input.taskId}-${input.iterationId}-${input.ordinal}`;
  const idempotencyKey = `idem-${input.bundle.bundleHash}-${input.name}`.slice(0, 512);
  const authority = ports.archiveContexts.authority({
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    iterationId: input.iterationId,
    candidateRef: input.candidateRef,
    producerStageRunId: input.producerStageRunId,
    environmentRef: ENVIRONMENT_REF,
    surface: SURFACE,
    stageStartedAt: input.bundle.capturedAt,
  });
  const authorization = await ports.archive.issueCaptureAuthorization(
    {
      id: captureId,
      artifactRefId,
      idempotencyKey,
      mediaType: input.mediaType,
      maximumByteLength: Math.max(bytes.byteLength, 1),
      accessClass: 'operator',
    },
    authority,
  );
  const observation = ports.archiveContexts.observation({
    authorizationId: authorization.id,
    sha256: digest,
    byteLength: bytes.byteLength,
    observedAt: input.bundle.capturedAt,
  });
  // With authority derived from bundle.capturedAt, command bytes are identical
  // on retry so issueCaptureAuthorization / recordArtifact replay idempotently.
  const archived = await ports.archive.recordArtifact({
    authorizationId: authorization.id,
    observation,
    mediaType: input.mediaType,
    bytes,
  });
  if (archived.sha256 !== digest) {
    throw new Error(
      `archived artifact sha256 ${archived.sha256} disagrees with staged digest ${digest}`,
    );
  }
  return {
    kind: input.kind,
    name: input.name,
    relativeFile: input.relativeFile,
    mediaType: input.mediaType,
    basename: input.basename,
    artifact: toArtifactRef(archived),
  };
}

function buildAssertionsAndReceipts(input: {
  readonly taskId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly iterationId: string;
  readonly candidateRef: CandidateRef;
  readonly bundle: StagedVerificationBundleV1;
  readonly manifest: EvidenceManifest;
  readonly captured: readonly CapturedArtifact[];
  readonly contractCriteria: readonly {
    readonly id: string;
    readonly text: string;
    readonly authority: string;
  }[];
  readonly roster: AuthorityRoster;
  readonly artifactCriteria: ReadonlyMap<string, readonly string[]>;
}): {
  readonly assertions: readonly DecisionAssertion[];
  readonly verificationReceipts: readonly AssertionVerificationReceipt[];
} {
  const assertions: DecisionAssertion[] = [];
  const receipts: AssertionVerificationReceipt[] = [];
  const mechanicalIds = mechanicalCriterionIds(input.contractCriteria);

  for (const captured of input.captured) {
    if (captured.kind !== 'gate') continue;
    const gate = input.bundle.gates.find((entry) => entry.name === captured.name);
    if (gate === undefined) continue;
    if (captured.artifact.sha256 !== gate.sha256) {
      throw new Error(
        `gate assertion outputSha256 must equal archived artifact sha256 for ${gate.name}`,
      );
    }
    const payload = {
      gate: gate.name,
      command: gate.command,
      passed: gate.passed,
      exitCode: gate.exitCode,
      outcome: gate.outcome,
      outputSha256: captured.artifact.sha256,
      truncated: gate.truncated,
    };
    const assertionId = `assertion-gate-${captured.artifact.id}`;
    const payloadHash = computeAssertionPayloadHash(payload);
    const assertion: DecisionAssertion = {
      id: assertionId,
      subjectKey: `gate:${gate.name}`,
      kind: 'fact',
      canonicalPayload: payload,
      payloadHash,
      advisoryText: gate.truncated
        ? 'gate output was truncated to the staged bundle byte budget; passed/exitCode still reflect the verifier run'
        : null,
    };
    assertions.push(assertion);
    const receiptWithoutHash = {
      schema: 'hercules-assertion-verification/v1' as const,
      id: `receipt-gate-${captured.artifact.id}`,
      assertionId,
      assertionPayloadHash: payloadHash,
      subjectKey: assertion.subjectKey,
      valueHash: payloadHash,
      taskId: input.taskId,
      contractVersion: input.contractVersion,
      contractHash: input.contractHash,
      iterationId: input.iterationId,
      candidateRef: input.candidateRef,
      evidenceManifestId: input.manifest.id,
      evidenceManifestHash: input.manifest.manifestHash,
      evidenceEntryArtifactIds: sortedUnique([captured.artifact.id]),
      criterionIds: mechanicalIds,
      verifierRunId: input.roster.verifier.runId,
      verifierImplementation: input.roster.verifier.implementation,
      observationSurface: SURFACE,
      observedAt: input.bundle.capturedAt,
    };
    receipts.push({
      ...receiptWithoutHash,
      receiptHash: computeVerificationReceiptHash(receiptWithoutHash),
    });
  }

  for (let index = 0; index < input.contractCriteria.length; index += 1) {
    const criterion = input.contractCriteria[index]!;
    if (criterion.authority !== 'mechanical') continue;
    const dod = input.bundle.dod.criteria[index];
    const status = dod?.status ?? 'pending';
    const proof = dod?.proof ?? '';
    const payload = {
      criterionId: criterion.id,
      status,
      proof,
    };
    const assertionId = `assertion-criterion-${criterion.id}`;
    const payloadHash = computeAssertionPayloadHash(payload);
    const assertion: DecisionAssertion = {
      id: assertionId,
      subjectKey: `criterion:${criterion.id}`,
      kind: 'fact',
      canonicalPayload: payload,
      payloadHash,
      advisoryText: null,
    };
    assertions.push(assertion);
    const boundArtifacts: string[] = [];
    for (const [artifactId, criterionIds] of input.artifactCriteria) {
      if (criterionIds.includes(criterion.id)) boundArtifacts.push(artifactId);
    }
    const receiptWithoutHash = {
      schema: 'hercules-assertion-verification/v1' as const,
      id: `receipt-criterion-${criterion.id}`,
      assertionId,
      assertionPayloadHash: payloadHash,
      subjectKey: assertion.subjectKey,
      valueHash: payloadHash,
      taskId: input.taskId,
      contractVersion: input.contractVersion,
      contractHash: input.contractHash,
      iterationId: input.iterationId,
      candidateRef: input.candidateRef,
      evidenceManifestId: input.manifest.id,
      evidenceManifestHash: input.manifest.manifestHash,
      evidenceEntryArtifactIds: sortedUnique(boundArtifacts),
      criterionIds: sortedUnique([criterion.id]),
      verifierRunId: input.roster.verifier.runId,
      verifierImplementation: input.roster.verifier.implementation,
      observationSurface: SURFACE,
      observedAt: input.bundle.capturedAt,
    };
    receipts.push({
      ...receiptWithoutHash,
      receiptHash: computeVerificationReceiptHash(receiptWithoutHash),
    });
  }

  return { assertions, verificationReceipts: receipts };
}

export async function produceVerifiedEvidence(
  ports: VerifiedEvidenceProducerPorts,
  aggregateId: string,
): Promise<ProduceOutcome> {
  // Staged bundle under production, kept for the catch: a deterministic
  // content rejection must discard it, or every producer run (each tick)
  // re-tries the same bytes forever (C3.52 — 34 identical failures on one
  // a downstream project task, 2026-09-12).
  let stagedBundle: { readonly verifiedSha: string } | null = null;
  try {
    const waiting = ports.store.listAggregatesAwaitingEvidence();
    const listed = waiting.find((entry) => entry.aggregateId === aggregateId);
    if (listed === undefined) {
      const shadow = ports.store.readTask(aggregateId);
      if (shadow === null || shadow.iterations.length === 0) {
        loud(ports.log, aggregateId, 'skipped no_staged_bundle (aggregate not awaiting evidence)');
        return { kind: 'skipped', aggregateId, reason: 'no_staged_bundle' };
      }
      const current = shadow.iterations[shadow.iterations.length - 1]!;
      const existing = ports.store.readBoundEvidence(aggregateId, current.id);
      if (existing !== null) {
        loud(ports.log, aggregateId, 'skipped already_bound');
        return { kind: 'skipped', aggregateId, reason: 'already_bound' };
      }
      loud(ports.log, aggregateId, 'skipped no_staged_bundle (aggregate not awaiting evidence)');
      return { kind: 'skipped', aggregateId, reason: 'no_staged_bundle' };
    }

    const { iterationId, candidateRef } = listed;
    if (ports.store.readBoundEvidence(aggregateId, iterationId) !== null) {
      loud(ports.log, aggregateId, 'skipped already_bound');
      return { kind: 'skipped', aggregateId, reason: 'already_bound' };
    }

    if (candidateRef.kind !== 'git') {
      loud(ports.log, aggregateId, 'skipped candidate_mismatch (candidate is not git)');
      return { kind: 'skipped', aggregateId, reason: 'candidate_mismatch' };
    }

    const bundle = await ports.intake.read(aggregateId, candidateRef.revision);
    if (bundle === null) {
      loud(ports.log, aggregateId, 'skipped no_staged_bundle');
      return { kind: 'skipped', aggregateId, reason: 'no_staged_bundle' };
    }
    stagedBundle = bundle;

    if (
      bundle.repository !== candidateRef.repository ||
      bundle.verifiedSha !== candidateRef.revision
    ) {
      loud(
        ports.log,
        aggregateId,
        'skipped candidate_mismatch (bundle repository/revision disagree with candidateRef)',
      );
      return { kind: 'skipped', aggregateId, reason: 'candidate_mismatch' };
    }

    const shadow = ports.store.readTask(aggregateId);
    if (shadow === null) {
      loud(ports.log, aggregateId, 'skipped contract_missing (no shadow task)');
      return { kind: 'skipped', aggregateId, reason: 'contract_missing' };
    }
    const current = shadow.iterations[shadow.iterations.length - 1];
    if (current === undefined || current.id !== iterationId) {
      loud(ports.log, aggregateId, 'skipped contract_missing (iteration tip mismatch)');
      return { kind: 'skipped', aggregateId, reason: 'contract_missing' };
    }
    const contract = shadow.contracts.find((entry) => entry.version === current.contractVersion);
    if (contract === undefined) {
      loud(ports.log, aggregateId, 'skipped contract_missing');
      return { kind: 'skipped', aggregateId, reason: 'contract_missing' };
    }

    if (bundle.dod.criteria.length !== contract.acceptanceCriteria.length) {
      loud(
        ports.log,
        aggregateId,
        `skipped criteria_mismatch (dod length ${bundle.dod.criteria.length} != contract length ${contract.acceptanceCriteria.length})`,
      );
      return { kind: 'skipped', aggregateId, reason: 'criteria_mismatch' };
    }
    for (let index = 0; index < contract.acceptanceCriteria.length; index += 1) {
      const expected = contract.acceptanceCriteria[index]!.text;
      const actual = parseMechProofBinding(bundle.dod.criteria[index]!.text).cleanText;
      if (expected !== actual) {
        loud(
          ports.log,
          aggregateId,
          `skipped criteria_mismatch at index ${index}: contract=${JSON.stringify(expected)} dod=${JSON.stringify(actual)}`,
        );
        return { kind: 'skipped', aggregateId, reason: 'criteria_mismatch' };
      }
    }

    const outputArtifactRefs = plannedArtifactIds(aggregateId, iterationId, bundle);
    const stage = ensureVerifyStageRun(ports, {
      taskId: aggregateId,
      iterationId,
      bundle,
      outputArtifactRefs,
    });
    if (!stage.ok) {
      return { kind: 'failed', aggregateId, error: stage.error };
    }
    const producerStageRunId = stage.stageRunId;
    const captured: CapturedArtifact[] = [];
    let ordinal = 0;

    for (const gate of bundle.gates) {
      ordinal += 1;
      captured.push(
        await captureOne(ports, {
          taskId: aggregateId,
          contractVersion: contract.version,
          iterationId,
          candidateRef,
          producerStageRunId,
          bundle,
          ordinal,
          kind: 'gate',
          name: gate.name,
          relativeFile: gate.outputFile,
          mediaType: MEDIA_GATE,
          basename: null,
          expectedSha256: gate.sha256,
        }),
      );
    }

    ordinal += 1;
    captured.push(
      await captureOne(ports, {
        taskId: aggregateId,
        contractVersion: contract.version,
        iterationId,
        candidateRef,
        producerStageRunId,
        bundle,
        ordinal,
        kind: 'diff',
        name: 'diff',
        relativeFile: bundle.diffFile,
        mediaType: MEDIA_DIFF,
        basename: null,
        expectedSha256: bundle.diffSha256,
      }),
    );

    for (const screenshot of bundle.screenshots) {
      ordinal += 1;
      // Legacy manifests omit mediaType; default to image/png (PNG-only era).
      const screenshotMediaType = screenshot.mediaType ?? MEDIA_PNG;
      captured.push(
        await captureOne(ports, {
          taskId: aggregateId,
          contractVersion: contract.version,
          iterationId,
          candidateRef,
          producerStageRunId,
          bundle,
          ordinal,
          kind: 'screenshot',
          name: screenshot.name,
          relativeFile: screenshot.file,
          mediaType: screenshotMediaType,
          basename: screenshot.name,
          expectedSha256: screenshot.sha256,
        }),
      );
    }

    const mechanicalIds = mechanicalCriterionIds(contract.acceptanceCriteria);
    const artifactCriteria = new Map<string, readonly string[]>();
    const manifestEntries: Array<{ artifactRefId: string; criterionIds: readonly string[] }> = [];
    const mappedArtifacts: ArtifactRef[] = [];
    const unmappedArtifacts: ArtifactRef[] = [];

    for (const item of captured) {
      let criterionIds: readonly string[] = [];
      if (item.kind === 'gate' || item.kind === 'diff') {
        criterionIds = mechanicalIds;
      } else if (item.kind === 'screenshot' && item.basename !== null) {
        criterionIds = mapScreenshotCriteria({
          bundle,
          contractCriteria: contract.acceptanceCriteria,
          screenshotBasename: item.basename,
          screenshotRelativeFile: item.relativeFile,
        });
      }
      if (criterionIds.length === 0) {
        unmappedArtifacts.push(item.artifact);
        ports.log(
          `[hercules] verified evidence ${aggregateId}: archived artifact ${item.artifact.id} (${item.kind}:${item.name}) has no criterion mapping; omitted from manifest entries`,
        );
        continue;
      }
      artifactCriteria.set(item.artifact.id, criterionIds);
      mappedArtifacts.push(item.artifact);
      manifestEntries.push({
        artifactRefId: item.artifact.id,
        criterionIds,
      });
    }

    if (manifestEntries.length === 0) {
      const error = 'no archive artifacts mapped to contract criteria for the evidence manifest';
      loud(ports.log, aggregateId, `failed ${error}`);
      return { kind: 'failed', aggregateId, error };
    }

    const manifestId = `manifest-${aggregateId}-${iterationId}`;
    const archivedManifest = await ports.archive.recordManifest({
      id: manifestId,
      idempotencyKey: bundle.bundleHash,
      taskId: aggregateId,
      contractVersion: contract.version,
      iterationId,
      entries: manifestEntries,
    });
    const evidenceManifest = toEvidenceManifest(archivedManifest);

    // Drop unmapped artifacts from the bound record so assertEvidenceManifestArtifacts
    // and the projector inventory stay aligned with manifest entries. Unmapped bytes
    // remain in the archive for operator inspection.
    const boundArtifacts = mappedArtifacts;
    if (unmappedArtifacts.length > 0) {
      ports.log(
        `[hercules] verified evidence ${aggregateId}: dropped ${unmappedArtifacts.length} unmapped artifact(s) from bindReviewEvidence.artifacts`,
      );
    }

    const { assertions, verificationReceipts } = buildAssertionsAndReceipts({
      taskId: aggregateId,
      contractVersion: contract.version,
      contractHash: contract.contractHash,
      iterationId,
      candidateRef,
      bundle,
      manifest: evidenceManifest,
      captured,
      contractCriteria: contract.acceptanceCriteria,
      roster: ports.roster,
      artifactCriteria,
    });

    const checkedArtifacts = evidenceManifest.entries.map((entry) => {
      const artifact = boundArtifacts.find((item) => item.id === entry.artifactRefId);
      if (artifact === undefined) {
        throw new Error(`manifest entry artifact missing from bound set: ${entry.artifactRefId}`);
      }
      return { artifactRefId: artifact.id, sha256: artifact.sha256 };
    });

    const attestationWithoutHash = {
      schema: 'hercules-evidence-integrity-attestation/v1' as const,
      result: 'intact' as const,
      evidenceManifestId: evidenceManifest.id,
      evidenceManifestHash: evidenceManifest.manifestHash,
      candidateRef,
      checkedArtifacts,
      verifierImplementation: VERIFIED_EVIDENCE_PRODUCER_IMPLEMENTATION,
      checkedAt: ports.clock(),
    };
    const evidenceIntegrity: EvidenceIntegrityAttestation = {
      ...attestationWithoutHash,
      attestationHash: computeEvidenceIntegrityAttestationHash(attestationWithoutHash),
    };

    const record: Omit<V2BoundEvidenceV1, 'evidenceHash'> = {
      schema: 'hercules-v2-bound-evidence/v1',
      aggregateId,
      iterationId,
      candidateRef,
      evidenceManifest,
      artifacts: boundArtifacts,
      assertions,
      verificationReceipts,
      evidenceIntegrity,
      producer: {
        implementation: VERIFIED_EVIDENCE_PRODUCER_IMPLEMENTATION,
        verifierRunId: ports.roster.verifier.runId,
      },
      recordedAt: ports.clock(),
    };

    const bound = ports.store.bindReviewEvidence(record, PRODUCER_ACTOR);
    await ports.intake.discard(aggregateId, bundle.verifiedSha);
    return {
      kind: 'bound',
      aggregateId,
      iterationId,
      manifestId: evidenceManifest.id,
      evidenceHash: bound.evidenceHash,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A secret-scan rejection is a property of the staged bytes: retrying can
    // never bind them. Discard the bundle so the next producer run skips this
    // aggregate ("no_staged_bundle") until a fresh verification stages new
    // evidence; the operator re-verifies after the content (or scanner) is fixed.
    const code = (error as { code?: unknown }).code;
    if (code === 'artifact_secret' && stagedBundle !== null) {
      try {
        await ports.intake.discard(aggregateId, stagedBundle.verifiedSha);
        loud(ports.log, aggregateId, `failed ${message} — staged bundle discarded; re-verify after fixing`);
      } catch (discardError) {
        loud(ports.log, aggregateId, `failed ${message} — discard failed: ${
          discardError instanceof Error ? discardError.message : String(discardError)}`);
      }
      return { kind: 'failed', aggregateId, error: message };
    }
    loud(ports.log, aggregateId, `failed ${message}`);
    return { kind: 'failed', aggregateId, error: message };
  }
}

export async function produceAllVerifiedEvidence(
  ports: VerifiedEvidenceProducerPorts,
): Promise<readonly ProduceOutcome[]> {
  const waiting = ports.store.listAggregatesAwaitingEvidence();
  const outcomes: ProduceOutcome[] = [];
  for (const entry of waiting) {
    outcomes.push(await produceVerifiedEvidence(ports, entry.aggregateId));
  }
  return outcomes;
}
