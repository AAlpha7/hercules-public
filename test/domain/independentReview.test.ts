import { describe, expect, it } from 'vitest';
import {
  IndependentReviewError,
  INDEPENDENT_REVIEW_AXES_V1,
  assertGithubBoundResourcesV1,
  assertGithubGateReceiptBindsCandidate,
  assertGithubGateReceiptV1,
  assertHostFullGateReceiptV1,
  assertIndependentReviewEvidenceManifestV1,
  assertIndependentReviewReceiptV1,
  assertIndependentReviewRubricV1,
  assertReviewEvidenceObjectV1,
  assertScopeClassification,
  computeAxisConclusionHash,
  computeAxisConclusionSetHash,
  computeCriterionVerificationHash,
  computeCriterionVerificationSetHash,
  computeEvidenceManifestHash,
  computeFindingSetHash,
  computeGithubBoundResourcesByteLength,
  computeGithubBoundResourcesSha256,
  computeGithubGateReceiptHash,
  computeHostFullGateReceiptHash,
  computeIndependentReviewReceiptHash,
  computePremiseHash,
  computePremiseSetHash,
  computeRubricHash,
  computeWorkBindingHash,
  recomputeScopeClassification,
  type GithubBoundResourcesV1,
  type GithubGateReceiptV1,
  type HostFullGateReceiptV1,
  type IndependentReviewAxisConclusionV1,
  type IndependentReviewAxisV1,
  type IndependentReviewCriterionVerificationV1,
  type IndependentReviewEvidenceManifestV1,
  type IndependentReviewReceiptV1,
  type IndependentReviewRubricCriterionV1,
  type IndependentReviewRubricV1,
  type IndependentReviewWorkBindingV1,
  type ReviewEvidenceObjectV1,
  type ReviewFindingV1,
  type ReviewPremiseV1,
} from '../../src/domain/independentReview.js';

const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CANDIDATE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TREE = 'cccccccccccccccccccccccccccccccccccccccc';
const CONTRACT_BLOB = 'dddddddddddddddddddddddddddddddddddddddd';
const CARRIER = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const POLICY_BLOB = 'ffffffffffffffffffffffffffffffffffffffff';
const GIT_OBJ = '1111111111111111111111111111111111111111';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_CLAIM =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function expectReject(run: () => void, pattern?: RegExp): void {
  try {
    run();
    expect.fail('expected IndependentReviewError');
  } catch (error) {
    expect(error).toBeInstanceOf(IndependentReviewError);
    if (pattern !== undefined) {
      expect((error as Error).message).toMatch(pattern);
    }
  }
}

function sourceObject(
  overrides: Partial<ReviewEvidenceObjectV1> = {},
): ReviewEvidenceObjectV1 {
  return {
    evidenceId: 'ev-source-1',
    kind: 'contract',
    repository: 'example-org/acme',
    commit: CANDIDATE,
    path: 'docs/autonomy/contract.md',
    gitObjectSha: GIT_OBJ,
    contentLocator: null,
    byteLength: 128,
    sha256: HASH_A,
    ...overrides,
  };
}

function runtimeObject(
  overrides: Partial<ReviewEvidenceObjectV1> = {},
): ReviewEvidenceObjectV1 {
  return {
    evidenceId: 'ev-runtime-1',
    kind: 'gate_log',
    repository: null,
    commit: null,
    path: null,
    gitObjectSha: null,
    contentLocator: 'artifacts/gate.log',
    byteLength: 64,
    sha256: HASH_B,
    ...overrides,
  };
}

function rubricCriteria(): IndependentReviewRubricCriterionV1[] {
  return INDEPENDENT_REVIEW_AXES_V1.map((axis, index) => ({
    criterionId: `criterion-${String(index + 1).padStart(2, '0')}`,
    axis,
    statementHash: HASH_A,
    required: true,
  }));
}

function rubric(
  overrides: Partial<IndependentReviewRubricV1> = {},
): IndependentReviewRubricV1 {
  const { rubricHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-independent-review-rubric/v1' as const,
    policyId: 'hercules-independent-review-policy' as const,
    version: 1,
    carrierRepository: 'example-org/review-ledger' as const,
    carrierCommit: CARRIER,
    policyBlob: POLICY_BLOB,
    criteria: rubricCriteria(),
    ...fields,
  };
  return {
    ...withoutHash,
    rubricHash: overrideHash ?? computeRubricHash(withoutHash),
  };
}

function evidenceManifest(
  overrides: Partial<IndependentReviewEvidenceManifestV1> = {},
): IndependentReviewEvidenceManifestV1 {
  const { manifestHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-independent-review-evidence-manifest/v1' as const,
    baseCommit: BASE,
    candidateCommit: CANDIDATE,
    candidateTree: TREE,
    contractBlob: CONTRACT_BLOB,
    changedPaths: ['README.md', 'docs/a.md', 'src/x.ts'],
    objects: [
      sourceObject({ evidenceId: 'ev-contract', kind: 'contract', path: 'SPEC.md' }),
      runtimeObject({ evidenceId: 'ev-gate-log', kind: 'gate_log' }),
    ],
    ...fields,
  };
  return {
    ...withoutHash,
    manifestHash: overrideHash ?? computeEvidenceManifestHash(withoutHash),
  };
}

function workBinding(
  overrides: Partial<IndependentReviewWorkBindingV1> = {},
): IndependentReviewWorkBindingV1 {
  const { bindingHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-independent-review-work-binding/v1' as const,
    issuer: 'hercules-program-control' as const,
    milestone: 'm8',
    reviewTaskId: 'review-task-1',
    reviewIterationId: 'review-iter-1',
    reviewContractVersion: 1,
    reviewContractHash: HASH_A,
    baseCommit: BASE,
    candidateCommit: CANDIDATE,
    candidateTree: TREE,
    milestoneContractPath: 'docs/autonomy/milestone-contract.md',
    milestoneContractBlob: CONTRACT_BLOB,
    ...fields,
  };
  return {
    ...withoutHash,
    bindingHash: overrideHash ?? computeWorkBindingHash(withoutHash),
  };
}

function premise(overrides: Partial<ReviewPremiseV1> = {}): ReviewPremiseV1 {
  const { premiseHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    premiseId: 'premise-1',
    classification: 'factual_assertion' as const,
    claimTextHash: HASH_CLAIM,
    evidenceObjectIds: ['ev-contract'],
    verificationReceiptIds: [] as string[],
    contradictsPremiseIds: [] as string[],
    decisionEligible: true,
    usedByFindingIds: [] as string[],
    usedByCriterionIds: ['criterion-01'],
    ...fields,
  };
  return {
    ...withoutHash,
    premiseHash: overrideHash ?? computePremiseHash(withoutHash),
  };
}

function criterionVerification(
  overrides: Partial<IndependentReviewCriterionVerificationV1> = {},
): IndependentReviewCriterionVerificationV1 {
  const { verificationHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    criterionId: 'criterion-01',
    status: 'satisfied' as const,
    premiseIds: ['premise-1'],
    evidenceObjectIds: ['ev-contract'],
    ...fields,
  };
  return {
    ...withoutHash,
    verificationHash: overrideHash ?? computeCriterionVerificationHash(withoutHash),
  };
}

function axisConclusion(
  axis: IndependentReviewAxisV1,
  criterionIds: readonly string[],
  status: IndependentReviewAxisConclusionV1['status'] = 'clear',
): IndependentReviewAxisConclusionV1 {
  const withoutHash = { axis, status, criterionIds: [...criterionIds].sort() };
  return {
    ...withoutHash,
    conclusionHash: computeAxisConclusionHash(withoutHash),
  };
}

function fullReceipt(
  overrides: Partial<IndependentReviewReceiptV1> = {},
): IndependentReviewReceiptV1 {
  const binding = workBinding();
  const builtRubric = rubric();
  const manifest = evidenceManifest({
    objects: [
      sourceObject({
        evidenceId: 'ev-rubric',
        kind: 'rubric_source',
        path: 'policy.json',
        commit: CARRIER,
        repository: 'example-org/review-ledger',
      }),
      sourceObject({
        evidenceId: 'ev-diff',
        kind: 'candidate_diff',
        path: 'diff.patch',
      }),
      sourceObject({ evidenceId: 'ev-contract', kind: 'contract', path: 'SPEC.md' }),
      runtimeObject({
        evidenceId: 'ev-gate',
        kind: 'gate_receipt',
        contentLocator: 'receipts/gate.json',
        sha256: HASH_A,
      }),
      runtimeObject({
        evidenceId: 'ev-gh',
        kind: 'github_gate_run',
        contentLocator: 'receipts/github.json',
        sha256: HASH_B,
      }),
      sourceObject({
        evidenceId: 'ev-cont',
        kind: 'continuity_carrier_commit',
        repository: 'example-org/review-ledger',
        commit: CARRIER,
        path: 'refs/heads/main',
        sha256: HASH_A,
      }),
      runtimeObject({
        evidenceId: 'ev-claim-1',
        kind: 'claim_text',
        contentLocator: 'claims/premise-1.txt',
        sha256: HASH_CLAIM,
      }),
    ],
  });

  const premises = [
    premise({
      premiseId: 'premise-1',
      evidenceObjectIds: ['ev-contract'],
      usedByFindingIds: [],
      usedByCriterionIds: INDEPENDENT_REVIEW_AXES_V1.map(
        (_, index) => `criterion-${String(index + 1).padStart(2, '0')}`,
      ),
      decisionEligible: true,
    }),
  ];

  const verifications = builtRubric.criteria.map((criterion) =>
    criterionVerification({
      criterionId: criterion.criterionId,
      status: 'satisfied',
      premiseIds: ['premise-1'],
      evidenceObjectIds: ['ev-contract'],
    }),
  );

  const axisConclusions = INDEPENDENT_REVIEW_AXES_V1.map((axis) => {
    const criterionIds = builtRubric.criteria
      .filter((criterion) => criterion.axis === axis)
      .map((criterion) => criterion.criterionId)
      .sort();
    return axisConclusion(axis, criterionIds, 'clear');
  });

  const { receiptHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-independent-review-receipt/v1' as const,
    issuer: 'hercules-program-control' as const,
    receiptId: 'review-receipt-1',
    repository: 'example-org/acme' as const,
    reviewTaskId: binding.reviewTaskId,
    reviewIterationId: binding.reviewIterationId,
    workBinding: binding,
    workBindingHash: binding.bindingHash,
    baseCommit: BASE,
    candidateCommit: CANDIDATE,
    candidateTree: TREE,
    contractPath: binding.milestoneContractPath,
    contractBlob: CONTRACT_BLOB,
    rubric: builtRubric,
    evidenceManifest: manifest,
    reviewerRunId: 'reviewer-run-1',
    reviewerImplementation: 'reviewer-impl-1',
    freshContext: true as const,
    implementerRunIds: ['implementer-run-1'],
    reviewerRecommendation: 'blockers_no' as const,
    premises,
    premiseSetHash: computePremiseSetHash(premises),
    findings: [] as ReviewFindingV1[],
    findingSetHash: computeFindingSetHash([]),
    criterionVerifications: verifications,
    criterionVerificationSetHash: computeCriterionVerificationSetHash(verifications),
    axisConclusions,
    axisConclusionSetHash: computeAxisConclusionSetHash(axisConclusions),
    coordinatorDerivedResult: 'blockers_no' as const,
    reviewedAt: '2026-08-31T00:00:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    receiptHash: overrideHash ?? computeIndependentReviewReceiptHash(withoutHash),
  };
}

function hostReceipt(
  overrides: Partial<HostFullGateReceiptV1> = {},
): HostFullGateReceiptV1 {
  const { receiptHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-host-full-gate-receipt/v1' as const,
    issuer: 'hercules-program-control' as const,
    command: 'pnpm check:full' as const,
    candidateCommit: CANDIDATE,
    worktreeHeadBefore: CANDIDATE,
    worktreeHeadAfter: CANDIDATE,
    statusCleanBefore: true as const,
    statusCleanAfter: true as const,
    exitCode: 0 as const,
    conclusion: 'passed' as const,
    testFilesPassed: 10,
    testsPassed: 100,
    testsSkipped: 2,
    spaSmokePassed: true as const,
    logPath: 'artifacts/check-full.log',
    logSha256: HASH_A,
    logByteLength: 4096,
    startedAt: '2026-08-31T00:00:00.000Z',
    completedAt: '2026-08-31T00:05:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    receiptHash: overrideHash ?? computeHostFullGateReceiptHash(withoutHash),
  };
}

function boundDocument(
  overrides: Partial<GithubBoundResourcesV1> = {},
): GithubBoundResourcesV1 {
  return {
    changedPaths: ['README.md', 'src/domain/x.ts'],
    jobs: [
      {
        jobId: 1,
        jobName: 'gates',
        runId: 42,
        conclusion: 'success',
        steps: [
          { name: 'checkout', conclusion: 'success' },
          { name: 'test', conclusion: 'success' },
        ],
      },
    ],
    run: {
      runId: 42,
      headSha: CANDIDATE,
      event: 'pull_request',
      workflowPath: '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: 'success',
    },
    ...overrides,
  };
}

function githubReceipt(
  document: GithubBoundResourcesV1,
  overrides: Partial<GithubGateReceiptV1> = {},
): GithubGateReceiptV1 {
  const { receiptHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-github-gate-receipt/v1' as const,
    repository: 'example-org/acme' as const,
    workflowPath: '.github/workflows/ci.yml' as const,
    event: 'pull_request' as const,
    scopeClassification: recomputeScopeClassification(document),
    pullRequestNumber: 7,
    headSha: CANDIDATE,
    runId: document.run.runId,
    runUrl: 'https://github.com/example-org/acme/actions/runs/42',
    conclusion: 'success' as const,
    boundResourcesPath: 'artifacts/github-bound.json',
    boundResourcesSha256: computeGithubBoundResourcesSha256(document),
    boundResourcesByteLength: computeGithubBoundResourcesByteLength(document),
    observedAt: '2026-08-31T00:06:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    receiptHash: overrideHash ?? computeGithubGateReceiptHash(withoutHash),
  };
}

describe('independentReview domain records', () => {
  describe('ReviewEvidenceObjectV1', () => {
    it('accepts source and runtime shapes', () => {
      expect(() => assertReviewEvidenceObjectV1(sourceObject())).not.toThrow();
      expect(() => assertReviewEvidenceObjectV1(runtimeObject())).not.toThrow();
    });

    it('rejects mixed source/runtime nullability', () => {
      expectReject(() =>
        assertReviewEvidenceObjectV1(
          sourceObject({ contentLocator: 'artifacts/x', repository: 'example-org/acme' }),
        ),
        /exclusive nullability/,
      );
      expectReject(() =>
        assertReviewEvidenceObjectV1(
          runtimeObject({ commit: CANDIDATE, contentLocator: 'x' }),
        ),
        /exclusive nullability/,
      );
    });
  });

  describe('IndependentReviewRubricV1', () => {
    it('accepts a rubric covering every axis with a required criterion', () => {
      expect(() => assertIndependentReviewRubricV1(rubric())).not.toThrow();
    });

    it('rejects an axis without a required criterion', () => {
      const criteria = rubricCriteria().map((criterion) =>
        criterion.axis === 'implementation_feasibility'
          ? { ...criterion, required: false }
          : criterion,
      );
      expectReject(
        () => assertIndependentReviewRubricV1(rubric({ criteria })),
        /required criterion for axis implementation_feasibility/,
      );
    });
  });

  describe('IndependentReviewWorkBindingV1 / receipt equalities', () => {
    it('accepts a well-formed receipt', () => {
      expect(() => assertIndependentReviewReceiptV1(fullReceipt())).not.toThrow();
    });

    it('rejects workBindingHash inequality', () => {
      expectReject(
        () =>
          assertIndependentReviewReceiptV1(
            fullReceipt({
              workBindingHash: HASH_B,
              receiptHash: HASH_A,
            }),
          ),
        /workBindingHash must equal/,
      );
    });

    it('rejects outer/workBinding field inequality', () => {
      const binding = workBinding({ candidateCommit: BASE });
      expectReject(
        () =>
          assertIndependentReviewReceiptV1(
            fullReceipt({
              workBinding: binding,
              workBindingHash: binding.bindingHash,
              candidateCommit: CANDIDATE,
              receiptHash: HASH_A,
            }),
          ),
        /outer fields must equal/,
      );
    });

    it('rejects reviewer/implementer overlap', () => {
      expectReject(
        () =>
          assertIndependentReviewReceiptV1(
            fullReceipt({
              reviewerRunId: 'implementer-run-1',
              implementerRunIds: ['implementer-run-1'],
              receiptHash: HASH_A,
            }),
          ),
        /reviewerRunId must not be a member/,
      );
    });
  });

  describe('IndependentReviewEvidenceManifestV1', () => {
    it('rejects unsorted changedPaths', () => {
      expectReject(
        () =>
          assertIndependentReviewEvidenceManifestV1(
            evidenceManifest({
              changedPaths: ['src/z.ts', 'README.md'],
              manifestHash: HASH_A,
            }),
          ),
        /sorted unique/,
      );
    });
  });

  describe('HostFullGateReceiptV1', () => {
    it('accepts a passed host receipt', () => {
      expect(() => assertHostFullGateReceiptV1(hostReceipt())).not.toThrow();
    });

    it('rejects head mismatch', () => {
      expectReject(
        () =>
          assertHostFullGateReceiptV1(
            hostReceipt({
              worktreeHeadBefore: BASE,
              receiptHash: HASH_A,
            }),
          ),
        /heads must equal candidateCommit/,
      );
    });

    it('rejects dirty statusCleanBefore', () => {
      expectReject(
        () =>
          assertHostFullGateReceiptV1(
            hostReceipt({
              statusCleanBefore: false as unknown as true,
              receiptHash: HASH_A,
            }),
          ),
        /literals, counts, log binding/,
      );
    });

    it('rejects wrong receipt hash', () => {
      expectReject(
        () => assertHostFullGateReceiptV1(hostReceipt({ receiptHash: HASH_B })),
        /hash does not match/,
      );
    });
  });

  describe('GithubBoundResourcesV1 + GithubGateReceiptV1', () => {
    it('accepts matching bound document and receipt', () => {
      const document = boundDocument();
      const receipt = githubReceipt(document);
      expect(() => assertGithubGateReceiptV1(receipt)).not.toThrow();
      expect(() => assertGithubBoundResourcesV1(document, receipt)).not.toThrow();
      expect(() =>
        assertGithubGateReceiptBindsCandidate(receipt, CANDIDATE),
      ).not.toThrow();
    });

    it('rejects run identity mismatch', () => {
      const document = boundDocument({
        run: {
          runId: 99,
          headSha: CANDIDATE,
          event: 'pull_request',
          workflowPath: '.github/workflows/ci.yml',
          status: 'completed',
          conclusion: 'success',
        },
        jobs: [
          {
            jobId: 1,
            jobName: 'gates',
            runId: 99,
            conclusion: 'success',
            steps: [{ name: 'test', conclusion: 'success' }],
          },
        ],
      });
      const receipt = githubReceipt(boundDocument());
      expectReject(
        () => assertGithubBoundResourcesV1(document, receipt),
        /run\.runId must equal/,
      );
    });

    it('rejects unsorted changedPaths in bound document', () => {
      const document = boundDocument({
        changedPaths: ['src/a.ts', 'README.md'],
      });
      const receipt = githubReceipt(boundDocument());
      expectReject(
        () => assertGithubBoundResourcesV1(document, receipt),
        /sorted unique/,
      );
    });
  });

  describe('scope classification', () => {
    it('classifies docs-only paths', () => {
      expect(
        recomputeScopeClassification(
          boundDocument({ changedPaths: ['README.md', 'docs/a.md'] }),
        ),
      ).toBe('docs_only');
    });

    it('classifies mixed paths as full', () => {
      expect(
        recomputeScopeClassification(
          boundDocument({ changedPaths: ['README.md', 'src/x.ts'] }),
        ),
      ).toBe('full');
    });

    it('classifies empty changedPaths as docs_only', () => {
      expect(recomputeScopeClassification(boundDocument({ changedPaths: [] }))).toBe(
        'docs_only',
      );
    });

    it('rejects stored classification mismatch', () => {
      const document = boundDocument({ changedPaths: ['README.md', 'docs/a.md'] });
      const hashed = githubReceipt(document, { scopeClassification: 'full' });
      expectReject(
        () => assertScopeClassification(hashed, document),
        /scopeClassification must equal recomputation/,
      );
    });

    it('rejects full classification with skipped gates steps', () => {
      const document = boundDocument({
        changedPaths: ['src/x.ts'],
        jobs: [
          {
            jobId: 1,
            jobName: 'gates',
            runId: 42,
            conclusion: 'success',
            steps: [
              { name: 'checkout', conclusion: 'success' },
              { name: 'full-suite', conclusion: 'skipped' },
            ],
          },
        ],
      });
      const receipt = githubReceipt(document, { scopeClassification: 'full' });
      expectReject(
        () => assertScopeClassification(receipt, document),
        /forbids skipped steps/,
      );
    });
  });
});
