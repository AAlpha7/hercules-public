import { describe, expect, it } from 'vitest';
import {
  assertDecisionBinding,
  assertDecisionBindingIdentity,
  assertEvaluationVerdictBinding as assertTrustedEvaluationVerdictBinding,
  decisionBindingsEqual,
  type DecisionBinding,
  type EvaluationBinding,
  type EvaluationVerdict,
} from '../../src/domain/evaluationVerdict.js';
import {
  candidateRefBinding,
  type ArtifactRef,
  type EvidenceManifest,
} from '../../src/domain/artifact.js';
import {
  assertHumanDecisionBinding,
  type HumanDecision,
} from '../../src/domain/humanDecision.js';
import { V2InvariantError } from '../../src/domain/v2Invariant.js';
import { type TaskContract } from '../../src/domain/taskContract.js';

const binding: EvaluationBinding = {
  taskId: 'task-1',
  contractVersion: 1,
  contractHash: 'contract-hash',
  iterationId: 'iteration-1',
  candidateRef: {
    kind: 'git',
    repository: 'example-org/acme',
    revision: 'abc123',
  },
  evidenceManifestHash: 'evidence-hash',
  evaluatorVersion: 'evaluator-v1',
  evaluatorModel: 'model-v1',
  evaluatorRuntime: 'codex-runtime-v1',
  policyVersion: 'policy-v1',
};

const contract: TaskContract = {
  taskId: binding.taskId,
  version: binding.contractVersion,
  contractHash: binding.contractHash,
  objective: 'Prove the exact candidate',
  context: [],
  acceptanceCriteria: [
    {
      id: 'criterion-1',
      text: 'The candidate is verified',
      authority: 'mechanical',
      required: true,
      proofBinding: null,
    },
  ],
  constraints: [],
  forbiddenActions: [],
  capabilityPolicy: { version: 'capability-v1', grants: [] },
  verificationPolicy: {
    version: 'verification-v1',
    requiredEvidence: ['mechanical_gate'],
    independentEvaluatorRequired: true,
  },
  approvalPolicy: { version: 'approval-v1', requiredDecisions: [] },
  budgetPolicy: {
    version: 'budget-v1',
    maxCostUsd: null,
    maxTokens: null,
    maxDurationMs: null,
  },
  createdBy: { kind: 'human', id: 'owner' },
  createdAt: '2026-08-28T00:00:00Z',
  supersedesVersion: null,
};

const manifest: EvidenceManifest = {
  id: 'manifest-1',
  taskId: binding.taskId,
  contractVersion: binding.contractVersion,
  iterationId: binding.iterationId,
  candidateRef: binding.candidateRef,
  entries: [
    {
      artifactRefId: 'artifact-1',
      criterionIds: ['criterion-1'],
      candidateRef: binding.candidateRef,
      observedAt: '2026-08-28T00:00:00Z',
      environmentRef: 'test',
      surface: 'mechanical_gate',
      trustClass: 'primary',
    },
  ],
  manifestHash: binding.evidenceManifestHash,
  createdAt: '2026-08-28T00:00:00Z',
};

const artifact: ArtifactRef = {
  id: 'artifact-1',
  sha256: 'artifact-hash',
  mediaType: 'application/json',
  byteLength: 42,
  storageKey: 'artifacts/artifact-1',
  producerStageRunId: 'verify-stage-1',
  createdAt: '2026-08-28T00:00:00Z',
  trustClass: 'primary',
  redactionState: 'none',
};

const passingResult: EvaluationVerdict['criterionResults'][number] = {
  criterionId: 'criterion-1',
  status: 'pass',
  authority: 'mechanical',
  evidenceRefs: ['artifact-1'],
  observedAt: '2026-08-28T00:00:00Z',
  candidateBinding: candidateRefBinding(binding.candidateRef),
  explanation: 'gate passed',
};

const verdict: EvaluationVerdict = {
  id: 'verdict-1',
  binding,
  outcome: 'pass',
  criterionResults: [passingResult],
  blockingFindings: [],
  nonBlockingRisks: [],
  recommendedNextStage: 'complete',
  evaluatorAgentRunId: 'agent-run-1',
  createdAt: '2026-08-28T00:00:00Z',
};

const authorityContext = {
  evaluatorAgentRunId: 'agent-run-1',
  implementerAgentRunIds: ['implementer-run-1'],
} as const;

function assertEvaluationVerdictBinding(
  value: EvaluationVerdict,
  expected: EvaluationBinding,
): void {
  assertTrustedEvaluationVerdictBinding(
    value,
    expected,
    contract,
    manifest,
    [artifact],
    authorityContext,
  );
}

const humanDecision: HumanDecision = {
  id: 'decision-1',
  binding,
  decision: 'approve_outcome',
  comment: null,
  actor: { kind: 'human', id: 'owner' },
  createdAt: '2026-08-28T00:00:01Z',
};

describe('V2 decision bindings', () => {
  it('accepts an exact contract, iteration, candidate, and evidence binding', () => {
    expect(decisionBindingsEqual(binding, { ...binding })).toBe(true);
    expect(() => assertDecisionBinding(binding, { ...binding })).not.toThrow();
    expect(() => assertEvaluationVerdictBinding(verdict, binding)).not.toThrow();
    expect(() => assertHumanDecisionBinding(humanDecision, binding)).not.toThrow();
  });

  it.each(['agent', 'service', 'control_plane'] as const)(
    'rejects a non-human %s actor at the human-decision authority boundary',
    (kind) => {
      expect(() =>
        assertHumanDecisionBinding(
          { ...humanDecision, actor: { kind, id: `${kind}-1` } },
          binding,
        ),
      ).toThrow('human decision identity, kind, actor, comment, and timing must be valid');
    },
  );

  it.each([
    ['taskId', { ...binding, taskId: 'task-2' }],
    ['contractVersion', { ...binding, contractVersion: 2 }],
    ['contractHash', { ...binding, contractHash: 'changed' }],
    ['iterationId', { ...binding, iterationId: 'iteration-2' }],
    [
      'candidateRef',
      {
        ...binding,
        candidateRef: { ...binding.candidateRef, revision: 'changed' },
      } as DecisionBinding,
    ],
    ['evidenceManifestHash', { ...binding, evidenceManifestHash: 'changed' }],
    ['evaluatorVersion', { ...binding, evaluatorVersion: 'changed' }],
    ['evaluatorModel', { ...binding, evaluatorModel: 'changed' }],
    ['evaluatorRuntime', { ...binding, evaluatorRuntime: 'changed' }],
    ['policyVersion', { ...binding, policyVersion: 'changed' }],
  ] as const)('rejects a stale %s binding', (_field, changed) => {
    expect(decisionBindingsEqual(binding, changed)).toBe(false);
    expect(() => assertDecisionBinding(binding, changed)).toThrow(V2InvariantError);
  });

  it('rejects stale bindings through both verdict and human-decision checks', () => {
    const changed = { ...binding, evidenceManifestHash: 'new-evidence' };
    expect(() => assertEvaluationVerdictBinding(verdict, changed)).toThrow(
      'does not match the exact contract',
    );
    expect(() => assertHumanDecisionBinding(humanDecision, changed)).toThrow(
      'does not match the exact contract',
    );
  });

  it('allows a candidate-free contract decision but not a candidate-free outcome decision', () => {
    const contractBinding: DecisionBinding = {
      ...binding,
      iterationId: null,
      candidateRef: null,
      evidenceManifestHash: null,
    };
    const contractDecision: HumanDecision = {
      ...humanDecision,
      decision: 'approve_contract_change',
      binding: contractBinding,
    };
    const invalidOutcome: HumanDecision = {
      ...humanDecision,
      binding: contractBinding,
    };

    expect(() => assertHumanDecisionBinding(contractDecision, contractBinding)).not.toThrow();
    expect(() => assertHumanDecisionBinding(invalidOutcome, contractBinding)).toThrow(
      'requires an exact iteration',
    );
  });

  it('rejects two equally empty bindings instead of treating them as exact identity', () => {
    const empty: DecisionBinding = {
      taskId: '',
      contractVersion: 0,
      contractHash: '',
      iterationId: '',
      candidateRef: { kind: 'git', repository: '', revision: '' },
      evidenceManifestHash: '',
      evaluatorVersion: '',
      evaluatorModel: '',
      evaluatorRuntime: '',
      policyVersion: '',
    };
    expect(decisionBindingsEqual(empty, { ...empty })).toBe(false);
    expect(() => assertDecisionBinding(empty, { ...empty })).toThrow(
      'identities must be non-empty',
    );
  });

  it('rejects runtime evaluation bindings without iteration, candidate, or evidence', () => {
    const incomplete = {
      ...binding,
      iterationId: null,
      candidateRef: null,
      evidenceManifestHash: null,
    } as unknown as EvaluationBinding;
    const incompleteVerdict = { ...verdict, binding: incomplete };

    expect(() => assertEvaluationVerdictBinding(incompleteVerdict, binding)).toThrow(
      'evaluation binding requires an exact iteration, candidate, and evidence manifest',
    );
    expect(() => assertEvaluationVerdictBinding(verdict, incomplete)).toThrow(
      'evaluation binding requires an exact iteration, candidate, and evidence manifest',
    );
  });

  it('rejects a decoded binding with missing freshness fields using a typed error', () => {
    const { policyVersion: _policyVersion, ...withoutPolicyVersion } = binding;
    const decoded = withoutPolicyVersion as unknown as DecisionBinding;

    expect(() => assertDecisionBinding(decoded, binding)).toThrow(V2InvariantError);
  });

  it('rejects decoded verdict and human-decision enum values', () => {
    const bogusOutcome = {
      ...verdict,
      outcome: 'bogus' as EvaluationVerdict['outcome'],
    };
    const bogusNextStage = {
      ...verdict,
      recommendedNextStage: 'bogus' as EvaluationVerdict['recommendedNextStage'],
    };
    const bogusDecision = {
      ...humanDecision,
      decision: 'bogus' as HumanDecision['decision'],
    };

    expect(() => assertEvaluationVerdictBinding(bogusOutcome, binding)).toThrow(
      V2InvariantError,
    );
    expect(() => assertEvaluationVerdictBinding(bogusNextStage, binding)).toThrow(
      V2InvariantError,
    );
    expect(() => assertHumanDecisionBinding(bogusDecision, binding)).toThrow(
      V2InvariantError,
    );
  });

  it('rejects decoded null decision boundaries with typed errors', () => {
    expect(decisionBindingsEqual(null as unknown as DecisionBinding, binding)).toBe(false);
    expect(() =>
      assertDecisionBindingIdentity(null as unknown as DecisionBinding),
    ).toThrow(V2InvariantError);
    expect(() =>
      assertDecisionBinding(null as unknown as DecisionBinding, binding),
    ).toThrow(V2InvariantError);
    expect(() =>
      assertDecisionBinding(binding, null as unknown as DecisionBinding),
    ).toThrow(V2InvariantError);
    expect(() =>
      assertEvaluationVerdictBinding(null as unknown as EvaluationVerdict, binding),
    ).toThrow(V2InvariantError);
    expect(() =>
      assertEvaluationVerdictBinding(verdict, null as unknown as EvaluationBinding),
    ).toThrow(V2InvariantError);
    expect(() =>
      assertEvaluationVerdictBinding(
        { ...verdict, binding: null as unknown as EvaluationBinding },
        binding,
      ),
    ).toThrow(V2InvariantError);
    expect(() =>
      assertHumanDecisionBinding(null as unknown as HumanDecision, binding),
    ).toThrow(V2InvariantError);
    expect(() =>
      assertHumanDecisionBinding(
        { ...humanDecision, binding: null as unknown as DecisionBinding },
        binding,
      ),
    ).toThrow(V2InvariantError);
  });

  it('rejects false-green pass verdicts and duplicate criterion identities', () => {
    const result: EvaluationVerdict['criterionResults'][number] = {
      criterionId: 'criterion-1',
      status: 'pass',
      authority: 'mechanical',
      evidenceRefs: ['artifact-1'],
      observedAt: '2026-08-28T00:00:00Z',
      candidateBinding: candidateRefBinding(binding.candidateRef),
      explanation: 'gate passed',
    };
    const blockingFinding: EvaluationVerdict['blockingFindings'][number] = {
      code: 'blocking',
      summary: 'must be repaired',
      criterionIds: ['criterion-1'],
    };

    expect(() =>
      assertEvaluationVerdictBinding(
        { ...verdict, blockingFindings: [blockingFinding] },
        binding,
      ),
    ).toThrow('no blocking findings');
    for (const status of ['fail', 'pending', 'not_applicable', 'insufficient_evidence'] as const) {
      expect(() =>
        assertEvaluationVerdictBinding(
          { ...verdict, criterionResults: [{ ...result, status }] },
          binding,
        ),
      ).toThrow('all trusted required criteria');
    }
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        {
          ...verdict,
          recommendedNextStage: 'escalate_human',
          criterionResults: [{ ...result, authority: 'human' }],
        },
        binding,
        {
          ...contract,
          acceptanceCriteria: [
            { ...contract.acceptanceCriteria[0]!, authority: 'human' },
          ],
        },
        manifest,
        [artifact],
        authorityContext,
      ),
    ).toThrow('cannot decide human criterion authority');
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        {
          ...verdict,
          recommendedNextStage: 'escalate_human',
          criterionResults: [
            {
              ...result,
              authority: 'human',
              status: 'pending',
            },
          ],
        },
        binding,
        {
          ...contract,
          acceptanceCriteria: [
            { ...contract.acceptanceCriteria[0]!, authority: 'human' },
          ],
        },
        manifest,
        [artifact],
        authorityContext,
      ),
    ).toThrow('all trusted required criteria');
    expect(() =>
      assertEvaluationVerdictBinding(
        { ...verdict, criterionResults: [result, { ...result, status: 'fail' }] },
        binding,
      ),
    ).toThrow('criterion ids must be unique');
    expect(() =>
      assertEvaluationVerdictBinding(
        { ...verdict, criterionResults: [{ ...result, evidenceRefs: [] }] },
        binding,
      ),
    ).toThrow('requires bound primary evidence and an observation timestamp');
    expect(() =>
      assertEvaluationVerdictBinding(
        { ...verdict, criterionResults: [{ ...result, observedAt: null }] },
        binding,
      ),
    ).toThrow('requires bound primary evidence and an observation timestamp');
    expect(() =>
      assertEvaluationVerdictBinding(
        { ...verdict, criterionResults: [{ ...result, candidateBinding: 'stale' }] },
        binding,
      ),
    ).toThrow('bound to a different candidate');
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          outcome: 'fail',
          recommendedNextStage: 'repair',
          criterionResults: [result],
        },
        binding,
      ),
    ).toThrow('requires a failed criterion or blocking finding');
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          outcome: 'need_more_evidence',
          recommendedNextStage: 'reverify',
          criterionResults: [result],
        },
        binding,
      ),
    ).toThrow('requires a pending or insufficient criterion');
  });

  it('checks verdict authority and evidence against trusted contract and manifest data', () => {
    expect(() =>
      assertEvaluationVerdictBinding({ ...verdict, criterionResults: [] }, binding),
    ).toThrow('omits required criterion');
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          criterionResults: [{ ...passingResult, authority: 'evaluator' }],
        },
        binding,
      ),
    ).toThrow('does not match trusted contract authority');
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          criterionResults: [
            { ...passingResult, evidenceRefs: ['missing-artifact'] },
          ],
        },
        binding,
      ),
    ).toThrow('references unbound evidence');
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        verdict,
        binding,
        contract,
        {
          ...manifest,
          entries: [{ ...manifest.entries[0]!, trustClass: 'agent_claim' }],
        },
        [{ ...artifact, trustClass: 'agent_claim' }],
        authorityContext,
      ),
    ).toThrow('requires bound primary evidence');
  });

  it('enforces independent evaluation, primary surfaces, and opaque proof bindings', () => {
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        { ...verdict, evaluatorAgentRunId: null },
        binding,
        contract,
        manifest,
        [artifact],
        { ...authorityContext, evaluatorAgentRunId: null },
      ),
    ).toThrow('requires an independent evaluator agent run');
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        verdict,
        binding,
        contract,
        manifest,
        [artifact],
        { ...authorityContext, evaluatorAgentRunId: 'different-agent-run' },
      ),
    ).toThrow('match valid trusted evaluator and implementer run identities');
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        verdict,
        binding,
        contract,
        manifest,
        [artifact],
        { ...authorityContext, implementerAgentRunIds: ['agent-run-1'] },
      ),
    ).toThrow('requires an independent evaluator agent run');
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        verdict,
        binding,
        { ...contract, verificationPolicy: { ...contract.verificationPolicy, requiredEvidence: ['browser'] } },
        manifest,
        [artifact],
        authorityContext,
      ),
    ).toThrow('missing required primary evidence surface browser');
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        verdict,
        binding,
        {
          ...contract,
          acceptanceCriteria: [
            {
              ...contract.acceptanceCriteria[0]!,
              proofBinding: { proofType: 'cli', requirement: 'pnpm check:full' },
            },
          ],
        },
        manifest,
        [artifact],
        authorityContext,
      ),
    ).toThrow('cannot grant pass authority for an opaque proof-bound criterion');
  });

  it('rejects contradictory evidence-gap results and duplicate finding classifications', () => {
    const finding = {
      code: 'same-finding',
      summary: 'same fact',
      criterionIds: ['criterion-1'],
    } as const;
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          outcome: 'need_more_evidence',
          recommendedNextStage: 'reverify',
          criterionResults: [{ ...passingResult, status: 'fail' }],
          blockingFindings: [finding],
        },
        binding,
      ),
    ).toThrow('requires a pending or insufficient criterion');
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          blockingFindings: [finding],
          nonBlockingRisks: [finding],
        },
        binding,
      ),
    ).toThrow('finding codes must be unique');
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          nonBlockingRisks: [
            { ...finding, code: 'unknown-criterion', criterionIds: ['missing'] },
          ],
        },
        binding,
      ),
    ).toThrow('references unknown criterion');
  });

  it('lets only required criteria drive global failure and evidence-gap routing', () => {
    const optionalCriterion = {
      id: 'criterion-optional',
      text: 'Optional observation',
      authority: 'evaluator' as const,
      required: false,
      proofBinding: null,
    };
    const optionalResult: EvaluationVerdict['criterionResults'][number] = {
      ...passingResult,
      criterionId: optionalCriterion.id,
      authority: optionalCriterion.authority,
      status: 'fail',
      evidenceRefs: [],
      observedAt: null,
    };
    const contractWithOptional = {
      ...contract,
      acceptanceCriteria: [...contract.acceptanceCriteria, optionalCriterion],
    };
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        {
          ...verdict,
          outcome: 'fail',
          recommendedNextStage: 'repair',
          criterionResults: [passingResult, optionalResult],
        },
        binding,
        contractWithOptional,
        manifest,
        [artifact],
        authorityContext,
      ),
    ).toThrow('requires a failed criterion or blocking finding');
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        {
          ...verdict,
          outcome: 'need_more_evidence',
          recommendedNextStage: 'reverify',
          criterionResults: [
            passingResult,
            { ...optionalResult, status: 'pending' },
          ],
        },
        binding,
        contractWithOptional,
        manifest,
        [artifact],
        authorityContext,
      ),
    ).toThrow('requires a pending or insufficient criterion');
  });

  it('routes a required pending human criterion to human escalation', () => {
    const humanContract = {
      ...contract,
      acceptanceCriteria: [
        { ...contract.acceptanceCriteria[0]!, authority: 'human' as const },
      ],
    };
    const humanPending = {
      ...passingResult,
      authority: 'human' as const,
      status: 'pending' as const,
    };
    const pendingVerdict = {
      ...verdict,
      outcome: 'need_more_evidence' as const,
      recommendedNextStage: 'escalate_human' as const,
      criterionResults: [humanPending],
    };
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        pendingVerdict,
        binding,
        humanContract,
        manifest,
        [artifact],
        authorityContext,
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        { ...pendingVerdict, recommendedNextStage: 'reverify' },
        binding,
        humanContract,
        manifest,
        [artifact],
        authorityContext,
      ),
    ).toThrow('outcome and recommended next stage are inconsistent');
  });

  it('prioritizes required human escalation over a simultaneous evidence gap', () => {
    const humanCriterion = {
      id: 'criterion-human',
      text: 'The owner approves the outcome',
      authority: 'human' as const,
      required: true,
      proofBinding: null,
    };
    const mixedContract = {
      ...contract,
      acceptanceCriteria: [...contract.acceptanceCriteria, humanCriterion],
    };
    const mixedVerdict = {
      ...verdict,
      outcome: 'need_more_evidence' as const,
      recommendedNextStage: 'escalate_human' as const,
      criterionResults: [
        {
          ...passingResult,
          status: 'insufficient_evidence' as const,
          evidenceRefs: [],
          observedAt: null,
        },
        {
          ...passingResult,
          criterionId: humanCriterion.id,
          authority: humanCriterion.authority,
          status: 'pending' as const,
          evidenceRefs: [],
          observedAt: null,
        },
      ],
    };
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        mixedVerdict,
        binding,
        mixedContract,
        manifest,
        [artifact],
        authorityContext,
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedEvaluationVerdictBinding(
        { ...mixedVerdict, recommendedNextStage: 'reverify' },
        binding,
        mixedContract,
        manifest,
        [artifact],
        authorityContext,
      ),
    ).toThrow('outcome and recommended next stage are inconsistent');
  });

  it('rejects outcome and recommended-next-stage contradictions', () => {
    const baseResult: EvaluationVerdict['criterionResults'][number] = {
      criterionId: 'criterion-1',
      status: 'pass',
      authority: 'mechanical',
      evidenceRefs: ['artifact-1'],
      observedAt: '2026-08-28T00:00:00Z',
      candidateBinding: candidateRefBinding(binding.candidateRef),
      explanation: 'observed',
    };
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          outcome: 'fail',
          recommendedNextStage: 'complete',
          criterionResults: [{ ...baseResult, status: 'fail' }],
        },
        binding,
      ),
    ).toThrow('outcome and recommended next stage are inconsistent');
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          outcome: 'need_more_evidence',
          recommendedNextStage: 'complete',
          criterionResults: [{ ...baseResult, status: 'pending' }],
        },
        binding,
      ),
    ).toThrow('outcome and recommended next stage are inconsistent');
    for (const recommendedNextStage of [
      'repair',
      'reverify',
      'request_contract_change',
    ] as const) {
      expect(() =>
        assertEvaluationVerdictBinding(
          { ...verdict, recommendedNextStage },
          binding,
        ),
      ).toThrow('outcome and recommended next stage are inconsistent');
    }
    expect(() =>
      assertEvaluationVerdictBinding(
        { ...verdict, recommendedNextStage: 'escalate_human' },
        binding,
      ),
    ).not.toThrow();
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          outcome: 'fail',
          recommendedNextStage: 'reverify',
          criterionResults: [{ ...baseResult, status: 'fail' }],
        },
        binding,
      ),
    ).toThrow('outcome and recommended next stage are inconsistent');
    expect(() =>
      assertEvaluationVerdictBinding(
        {
          ...verdict,
          outcome: 'need_more_evidence',
          recommendedNextStage: 'repair',
          criterionResults: [{ ...baseResult, status: 'pending' }],
        },
        binding,
      ),
    ).toThrow('outcome and recommended next stage are inconsistent');
  });
});
