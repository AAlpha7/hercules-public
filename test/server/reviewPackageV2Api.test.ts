import { describe, expect, it, vi } from 'vitest';
import { createApi, type ReviewPackageV2SourceReadPort } from '../../src/server/api.js';
import type { ReviewPackageV2Source } from '../../src/domain/reviewPackageV2.js';
import { computeTaskContractHash } from '../../src/domain/contractHash.js';
import { computeEvidenceIntegrityAttestationHash } from '../../src/domain/claimAuthorityV2.js';
import type { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';

const TOKEN = 'review-package-secret';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

function validNonGreenSource(): ReviewPackageV2Source {
  const contractWithoutHash = {
    taskId: 'T-1',
    version: 1,
    contractHash: '',
    objective: 'Read a bounded review snapshot.',
    context: [],
    acceptanceCriteria: [
      {
        id: 'criterion-1',
        text: 'Evidence is present.',
        authority: 'mechanical' as const,
        required: true,
        proofBinding: null,
      },
    ],
    constraints: [],
    forbiddenActions: [],
    capabilityPolicy: { version: 'capability-v1', grants: [] },
    verificationPolicy: {
      version: 'verification-v1',
      requiredEvidence: [],
      independentEvaluatorRequired: false,
    },
    approvalPolicy: { version: 'approval-v1', requiredDecisions: [] },
    budgetPolicy: {
      version: 'budget-v1',
      maxCostUsd: null,
      maxTokens: null,
      maxDurationMs: null,
    },
    createdBy: { kind: 'human' as const, id: 'owner' },
    createdAt: '2026-08-29T00:00:00.000Z',
    supersedesVersion: null,
  };
  const contract = {
    ...contractWithoutHash,
    contractHash: computeTaskContractHash(contractWithoutHash),
  };
  const binding = {
    taskId: 'T-1',
    contractVersion: 1,
    contractHash: contract.contractHash,
    iterationId: 'iteration-1',
    candidateRef: null,
    evidenceManifestHash: null,
    evaluatorVersion: 'evaluator-v1',
    evaluatorModel: null,
    evaluatorRuntime: 'runtime-v1',
    policyVersion: 'policy-v1',
  };
  const iteration = {
    id: 'iteration-1',
    taskId: 'T-1',
    contractVersion: 1,
    ordinal: 1,
    state: 'planned' as const,
    candidateRef: null,
    evidenceManifestId: null,
    finalVerdictId: null,
    createdAt: '2026-08-29T00:00:01.000Z',
    endedAt: null,
    supersedesIterationId: null,
  };
  const integrityWithoutHash = {
    schema: 'hercules-evidence-integrity-attestation/v1' as const,
    result: 'missing' as const,
    evidenceManifestId: null,
    evidenceManifestHash: null,
    candidateRef: null,
    checkedArtifacts: [],
    verifierImplementation: 'integrity-v1',
    checkedAt: '2026-08-29T00:00:02.000Z',
  };
  return {
    task: { id: 'T-1', title: 'Task 1', state: 'review' },
    currentBinding: binding,
    contract,
    currentIteration: iteration,
    iterationHistory: [iteration],
    evidenceManifest: null,
    artifacts: [],
    evidenceIntegrity: {
      ...integrityWithoutHash,
      attestationHash:
        computeEvidenceIntegrityAttestationHash(integrityWithoutHash),
    },
    assertions: [],
    verificationReceipts: [],
    evaluation: null,
    humanDecisions: [],
    authorityContext: {
      trustedVerifierRunIds: [],
      implementerRunIds: [],
      reviewerRunIds: [],
      evaluatorRunIds: [],
      agentClaimProducerRunIds: [],
      evaluationAuthority: {
        evaluatorAgentRunId: null,
        implementerAgentRunIds: [],
      },
    },
    usage: null,
    projectedAt: '2026-08-29T00:00:03.000Z',
  };
}

function api(reviewPackageV2?: ReviewPackageV2SourceReadPort) {
  const view: RuntimeView = {
    snapshot: { repos: { repos: {} }, tasks: [], problems: [] },
    running: [],
    stopping: [],
    activity: {},
    pendingChat: {},
    liveRuns: {},
    lastReport: null,
    agents: { default: 'fake', available: ['fake'] },
  };
  const actions = new Proxy(
    {},
    {
      get() {
        throw new Error('review package route must not call actions');
      },
    },
  ) as ActionService;
  return createApi({
    runtime: {
      getState: () => view,
      subscribe: () => () => {},
      forceAbort: () => {},
    },
    actions,
    token: TOKEN,
    ...(reviewPackageV2 === undefined ? {} : { reviewPackageV2 }),
  });
}

describe('GET /api/v2/tasks/:id/review-package', () => {
  it('requires Bearer auth and does not accept the token in the query', async () => {
    expect((await api().request('/api/v2/tasks/T-1/review-package')).status).toBe(401);
    expect(
      (await api().request(`/api/v2/tasks/T-1/review-package?token=${TOKEN}`)).status,
    ).toBe(401);
  });

  it('returns exact bounded provider and declared unavailable responses', async () => {
    const missing = await api().request('/api/v2/tasks/T-1/review-package', auth);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({
      error: 'review package unavailable',
      reason: 'provider_unavailable',
    });

    for (const reason of ['source_unavailable', 'integrity_unavailable'] as const) {
      const read = vi.fn(async () => ({ status: 'unavailable' as const, reason }));
      const response = await api({ read }).request(
        '/api/v2/tasks/T-1/review-package',
        auth,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'review package unavailable',
        reason,
      });
      expect(read).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledWith('T-1');
    }
  });

  it('maps invalid IDs and not-found reads to the existing unknown-task body', async () => {
    const read = vi.fn(async () => ({ status: 'not_found' as const }));
    for (const [encodedId, publicId] of [
      ['bad%2Fid', 'bad/id'],
      ['T-404', 'T-404'],
    ] as const) {
      const response = await api({ read }).request(
        `/api/v2/tasks/${encodedId}/review-package`,
        auth,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: `unknown task '${publicId}'` });
    }
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('fails closed on provider exceptions, malformed sources, and undeclared reasons', async () => {
    const cases: ReviewPackageV2SourceReadPort[] = [
      { read: async () => { throw new Error('private provider detail'); } },
      {
        read: async () => ({
          status: 'available',
          source: {} as ReviewPackageV2Source,
        }),
      },
      {
        read: async () => ({
          status: 'unavailable',
          reason: 'provider_unavailable',
        } as unknown as Awaited<ReturnType<ReviewPackageV2SourceReadPort['read']>>),
      },
    ];
    for (const port of cases) {
      const response = await api(port).request('/api/v2/tasks/T-1/review-package', auth);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'review package unavailable',
        reason: 'invalid_source',
      });
    }
  });

  it('projects an available source itself and returns a valid non-green package', async () => {
    const read = vi.fn(async () => ({
      status: 'available' as const,
      source: validNonGreenSource(),
    }));
    const response = await api({ read }).request(
      '/api/v2/tasks/T-1/review-package',
      auth,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Readonly<Record<string, unknown>>;
    expect(body).toMatchObject({
      schema: 'hercules-review-package/v2',
      outcome: {
        status: 'need_more_evidence',
        evaluatorOutcome: null,
        decisionEligible: false,
      },
      evidence: [],
      validDecisions: [],
      decisionBinding: null,
      decisionToken: null,
    });
    expect(body['projectionHash']).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
