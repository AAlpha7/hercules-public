import { createHash } from 'node:crypto';

function canonicalSerialize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('fixture numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(',')}]`;
  }
  if (typeof value !== 'object') throw new TypeError('fixture value is not canonical JSON');
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`
  ).join(',')}}`;
}

function hashCanonicalJson(value) {
  return `sha256:${createHash('sha256').update(canonicalSerialize(value)).digest('hex')}`;
}

function semanticContract(contract) {
  return {
    objective: contract.objective,
    context: contract.context,
    acceptanceCriteria: contract.acceptanceCriteria,
    constraints: contract.constraints,
    forbiddenActions: contract.forbiddenActions,
    capabilityPolicy: contract.capabilityPolicy,
    verificationPolicy: contract.verificationPolicy,
    approvalPolicy: contract.approvalPolicy,
    budgetPolicy: contract.budgetPolicy,
  };
}
const CANDIDATE = {
  kind: 'git',
  repository: 'example-org/acme-l2-fixture',
  revision: '0123456789abcdef0123456789abcdef01234567',
};

function sourceFor({
  taskId,
  title,
  outcome = 'pass',
  requiresHumanDecision = false,
  missingEvaluation = false,
  riskCode = null,
  projectedSecond,
}) {
  const evidencePayload = { passed: outcome !== 'fail' };
  const evidenceBytes = Buffer.from(canonicalSerialize(evidencePayload), 'utf8');
  const evidenceSha = `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`;
  const criterion = {
    id: 'criterion-1',
    text: 'The isolated unit gate passes.',
    authority: 'mechanical',
    required: true,
    proofBinding: null,
  };
  const contract = {
    taskId,
    version: 1,
    contractHash: '',
    objective: 'Review the exact isolated fixture candidate.',
    context: [],
    acceptanceCriteria: [criterion],
    constraints: ['Scratch data only.'],
    forbiddenActions: ['merge', 'deploy', 'external_send'],
    capabilityPolicy: { version: 'capability-v1', grants: [] },
    verificationPolicy: {
      version: 'verification-v1',
      requiredEvidence: ['pnpm-test'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: {
      version: 'approval-v1',
      requiredDecisions: requiresHumanDecision ? ['approve_outcome'] : [],
    },
    budgetPolicy: {
      version: 'budget-v1',
      maxCostUsd: null,
      maxTokens: null,
      maxDurationMs: null,
    },
    createdBy: { kind: 'human', id: 'l2-owner' },
    createdAt: '2026-08-29T00:00:00.000Z',
    supersedesVersion: null,
  };
  contract.contractHash = hashCanonicalJson(semanticContract(contract));

  const artifact = {
    id: 'artifact-1',
    sha256: evidenceSha,
    mediaType: 'application/json',
    byteLength: evidenceBytes.byteLength,
    storageKey: `artifacts/${taskId}/artifact-1`,
    producerStageRunId: 'verifier-1',
    createdAt: '2026-08-29T00:00:01.000Z',
    trustClass: 'primary',
    redactionState: 'none',
  };
  const manifestBody = {
    id: 'manifest-1',
    taskId,
    contractVersion: 1,
    iterationId: 'iteration-1',
    candidateRef: CANDIDATE,
    entries: [{
      artifactRefId: artifact.id,
      criterionIds: [criterion.id],
      candidateRef: CANDIDATE,
      observedAt: '2026-08-29T00:00:02.000Z',
      environmentRef: 'isolated-l2',
      surface: 'pnpm-test',
      trustClass: 'primary',
    }],
    createdAt: '2026-08-29T00:00:03.000Z',
  };
  const manifest = { ...manifestBody, manifestHash: hashCanonicalJson(manifestBody) };
  const binding = {
    taskId,
    contractVersion: 1,
    contractHash: contract.contractHash,
    iterationId: 'iteration-1',
    candidateRef: CANDIDATE,
    evidenceManifestHash: manifest.manifestHash,
    evaluatorVersion: 'evaluator-v1',
    evaluatorModel: 'model-v1',
    evaluatorRuntime: 'runtime-v1',
    policyVersion: 'policy-v1',
  };
  const iteration = {
    id: 'iteration-1',
    taskId,
    contractVersion: 1,
    ordinal: 1,
    state: 'evaluating',
    candidateRef: CANDIDATE,
    evidenceManifestId: manifest.id,
    finalVerdictId: null,
    createdAt: '2026-08-29T00:00:04.000Z',
    endedAt: null,
    supersedesIterationId: null,
  };
  const assertion = {
    id: 'assertion-1',
    subjectKey: 'tests.unit',
    kind: 'fact',
    canonicalPayload: evidencePayload,
    payloadHash: hashCanonicalJson(evidencePayload),
    advisoryText: outcome === 'fail' ? 'The isolated gate failed.' : 'The isolated gate passed.',
  };
  const verificationBody = {
    schema: 'hercules-assertion-verification/v1',
    id: 'receipt-1',
    assertionId: assertion.id,
    assertionPayloadHash: assertion.payloadHash,
    subjectKey: assertion.subjectKey,
    valueHash: assertion.payloadHash,
    taskId,
    contractVersion: 1,
    contractHash: contract.contractHash,
    iterationId: iteration.id,
    candidateRef: CANDIDATE,
    evidenceManifestId: manifest.id,
    evidenceManifestHash: manifest.manifestHash,
    evidenceEntryArtifactIds: [artifact.id],
    criterionIds: [criterion.id],
    verifierRunId: 'verifier-1',
    verifierImplementation: 'fixture-v1',
    observationSurface: 'pnpm-test',
    observedAt: '2026-08-29T00:00:02.000Z',
  };
  const verificationReceipt = {
    ...verificationBody,
    receiptHash: hashCanonicalJson(verificationBody),
  };
  const attestationBody = {
    schema: 'hercules-evidence-integrity-attestation/v1',
    result: 'intact',
    evidenceManifestId: manifest.id,
    evidenceManifestHash: manifest.manifestHash,
    candidateRef: CANDIDATE,
    checkedArtifacts: [{ artifactRefId: artifact.id, sha256: artifact.sha256 }],
    verifierImplementation: 'integrity-v1',
    checkedAt: '2026-08-29T00:00:05.000Z',
  };
  const evidenceIntegrity = {
    ...attestationBody,
    attestationHash: hashCanonicalJson(attestationBody),
  };
  const criterionResult = {
    criterionId: criterion.id,
    status: outcome === 'fail' ? 'fail' : 'pass',
    authority: criterion.authority,
    evidenceRefs: [artifact.id],
    observedAt: '2026-08-29T00:00:02.000Z',
    candidateBinding: JSON.stringify([
      CANDIDATE.kind,
      CANDIDATE.repository,
      CANDIDATE.revision,
    ]),
    explanation: outcome === 'fail' ? 'verified gate failure' : 'verified gate pass',
  };
  const finding = riskCode === null ? null : {
    code: riskCode,
    summary: outcome === 'fail' ? 'A verified blocking failure.' : 'A remaining verified risk.',
    criterionIds: [criterion.id],
  };
  const verdict = {
    id: 'verdict-1',
    binding,
    outcome,
    criterionResults: [criterionResult],
    blockingFindings: outcome === 'fail' && finding !== null ? [finding] : [],
    nonBlockingRisks: outcome !== 'fail' && finding !== null ? [finding] : [],
    recommendedNextStage: outcome === 'fail' ? 'repair' : 'complete',
    evaluatorAgentRunId: 'evaluator-1',
    createdAt: '2026-08-29T00:00:06.000Z',
  };
  const evaluation = missingEvaluation ? null : {
    schema: 'hercules-evaluation-decision/v2',
    verdict,
    criterionPremises: [{ key: criterion.id, assertionIds: [assertion.id] }],
    findingPremises: finding === null ? [] : [{ key: finding.code, assertionIds: [assertion.id] }],
    outcomeAssertionIds: [assertion.id],
    nextStageAssertionIds: [assertion.id],
  };
  return {
    task: { id: taskId, title, state: 'review' },
    currentBinding: binding,
    contract,
    currentIteration: iteration,
    iterationHistory: [iteration],
    evidenceManifest: manifest,
    artifacts: [artifact],
    evidenceIntegrity,
    assertions: [assertion],
    verificationReceipts: [verificationReceipt],
    evaluation,
    humanDecisions: [],
    authorityContext: {
      trustedVerifierRunIds: ['verifier-1'],
      implementerRunIds: ['implementer-1'],
      reviewerRunIds: ['reviewer-1'],
      evaluatorRunIds: ['evaluator-1'],
      agentClaimProducerRunIds: ['agent-claim-1'],
      evaluationAuthority: {
        evaluatorAgentRunId: 'evaluator-1',
        implementerAgentRunIds: ['implementer-1'],
      },
    },
    usage: { durationMs: 100, tokens: 20, costUsd: 0.01 },
    projectedAt: `2026-08-29T00:00:${String(projectedSecond).padStart(2, '0')}.000Z`,
  };
}

function fixtureTask(source, { learning = false } = {}) {
  const artifact = source.artifacts[0];
  const assertion = source.assertions[0];
  if (artifact === undefined || assertion === undefined) {
    throw new TypeError('fixture task requires one primary artifact and assertion');
  }
  const evidenceBytes = Buffer.from(canonicalSerialize(assertion.canonicalPayload), 'utf8');
  const evidenceSha = `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`;
  if (artifact.sha256 !== evidenceSha || assertion.payloadHash !== hashCanonicalJson(assertion.canonicalPayload)) {
    throw new TypeError('fixture evidence does not match its assertion payload');
  }
  return {
    source,
    evidence: [{
      artifactRefId: artifact.id,
      sha256: artifact.sha256,
      mediaType: artifact.mediaType,
      redactionState: artifact.redactionState,
      contentBase64: evidenceBytes.toString('base64'),
    }],
    learningProposals: learning ? [{
      id: 'proposal-1',
      title: 'Keep isolated evidence binding',
      advisorySummary: 'Advisory proposal derived from the scratch fixture only.',
      status: 'proposed',
      evidenceArtifactIds: [artifact.id],
    }] : [],
  };
}

export function buildM7ReviewFixtureEnvelope() {
  const payload = {
    schema: 'hercules-m7-l2-review-fixture/v1',
    actor: { kind: 'human', id: 'l2-operator', issuer: 'l2-fixture' },
    tasks: [
      fixtureTask(sourceFor({
        taskId: 'l2-m7-fail',
        title: '[L2 fixture] Verified failure review',
        outcome: 'fail',
        riskCode: 'verified-failure',
        projectedSecond: 9,
      })),
      fixtureTask(sourceFor({
        taskId: 'l2-m7-human',
        title: '[L2 fixture] Human outcome confirmation',
        requiresHumanDecision: true,
        riskCode: 'risk-review',
        projectedSecond: 10,
      })),
      fixtureTask(sourceFor({
        taskId: 'l2-m7-missing',
        title: '[L2 fixture] Missing evaluation evidence',
        missingEvaluation: true,
        projectedSecond: 11,
      })),
      fixtureTask(sourceFor({
        taskId: 'l2-m7-pass',
        title: '[L2 fixture] Verified pass with evidence',
        projectedSecond: 12,
      }), { learning: true }),
      fixtureTask(sourceFor({
        taskId: 'l2-m7-pass-media',
        title: '[L2 fixture] Verified pass with strip media',
        projectedSecond: 13,
      }), { learning: true }),
    ],
  };
  return {
    schema: 'hercules-m7-l2-review-fixture-envelope/v1',
    payload,
    fixtureHash: hashCanonicalJson(payload),
  };
}
