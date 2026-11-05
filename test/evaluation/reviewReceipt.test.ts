import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import {
  INDEPENDENT_REVIEW_AXES_V1,
  computeAxisConclusionHash,
  computeAxisConclusionSetHash,
  computeCriterionVerificationHash,
  computeCriterionVerificationSetHash,
  computeEvidenceManifestHash,
  computeFindingHash,
  computeFindingSetHash,
  computeGithubBoundResourcesSha256,
  computeIndependentReviewReceiptHash,
  computePremiseHash,
  computePremiseSetHash,
  computeRubricHash,
  computeWorkBindingHash,
  type GithubBoundResourcesV1,
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
import {
  deriveReviewReceipt,
  type ReviewAuthenticationContextV1,
  type ReviewSourceObjectResolutionV1,
} from '../../src/evaluation/reviewReceipt.js';

const BASE_COMMIT = '1111111111111111111111111111111111111111';
const CANDIDATE_COMMIT = '2222222222222222222222222222222222222222';
const CANDIDATE_TREE = '3333333333333333333333333333333333333333';
const CONTRACT_BLOB = '4444444444444444444444444444444444444444';
const RUBRIC_CARRIER_COMMIT = '5555555555555555555555555555555555555555';
const CONTINUITY_COMMIT = '6666666666666666666666666666666666666666';
const POLICY_BLOB = '7777777777777777777777777777777777777777';
const REVIEWED_AT = new Date('2026-08-31T12:00:00.000Z').toISOString();

const REPO = 'example-org/acme';

function digest(label: string): string {
  return hashCanonicalJson({ label });
}

function gitObjectSha(label: string): string {
  // Deterministic 40-hex from label bytes (not a real git hash; fixture only).
  const hex = Buffer.from(label, 'utf8').toString('hex').padEnd(40, '0').slice(0, 40);
  return hex;
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

function sourceObject(
  evidenceId: string,
  kind: ReviewEvidenceObjectV1['kind'],
  commit: string,
  path: string,
  sha256: string,
  byteLength: number,
): ReviewEvidenceObjectV1 {
  return {
    evidenceId,
    kind,
    repository: REPO,
    commit,
    path,
    gitObjectSha: gitObjectSha(`${evidenceId}:${path}`),
    contentLocator: null,
    byteLength,
    sha256,
  };
}

function runtimeObject(
  evidenceId: string,
  kind: ReviewEvidenceObjectV1['kind'],
  contentLocator: string,
  sha256: string,
  byteLength: number,
): ReviewEvidenceObjectV1 {
  return {
    evidenceId,
    kind,
    repository: null,
    commit: null,
    path: null,
    gitObjectSha: null,
    contentLocator,
    byteLength,
    sha256,
  };
}

function sealPremise(
  fields: Omit<ReviewPremiseV1, 'premiseHash'>,
): ReviewPremiseV1 {
  return { ...fields, premiseHash: computePremiseHash(fields) };
}

function sealFinding(fields: Omit<ReviewFindingV1, 'findingHash'>): ReviewFindingV1 {
  return { ...fields, findingHash: computeFindingHash(fields) };
}

function sealVerification(
  fields: Omit<IndependentReviewCriterionVerificationV1, 'verificationHash'>,
): IndependentReviewCriterionVerificationV1 {
  return { ...fields, verificationHash: computeCriterionVerificationHash(fields) };
}

function sealAxisConclusion(
  fields: Omit<IndependentReviewAxisConclusionV1, 'conclusionHash'>,
): IndependentReviewAxisConclusionV1 {
  return { ...fields, conclusionHash: computeAxisConclusionHash(fields) };
}

function sealWorkBinding(
  fields: Omit<IndependentReviewWorkBindingV1, 'bindingHash'>,
): IndependentReviewWorkBindingV1 {
  return { ...fields, bindingHash: computeWorkBindingHash(fields) };
}

function sealRubric(
  fields: Omit<IndependentReviewRubricV1, 'rubricHash'>,
): IndependentReviewRubricV1 {
  return { ...fields, rubricHash: computeRubricHash(fields) };
}

function sealManifest(
  fields: Omit<IndependentReviewEvidenceManifestV1, 'manifestHash'>,
): IndependentReviewEvidenceManifestV1 {
  return { ...fields, manifestHash: computeEvidenceManifestHash(fields) };
}

function sealReceipt(
  fields: Omit<IndependentReviewReceiptV1, 'receiptHash'> | IndependentReviewReceiptV1,
): IndependentReviewReceiptV1 {
  const { receiptHash: _ignored, ...withoutHash } =
    fields as IndependentReviewReceiptV1;
  return {
    ...withoutHash,
    receiptHash: computeIndependentReviewReceiptHash(withoutHash),
  };
}

function githubBoundDocument(): GithubBoundResourcesV1 {
  return {
    changedPaths: ['src/evaluation/reviewReceipt.ts'],
    jobs: [
      {
        jobId: 101,
        jobName: 'gates',
        runId: 9001,
        conclusion: 'success',
        steps: [
          { name: 'checkout', conclusion: 'success' },
          { name: 'pnpm-check-full', conclusion: 'success' },
        ],
      },
    ],
    run: {
      runId: 9001,
      headSha: CANDIDATE_COMMIT,
      event: 'pull_request',
      workflowPath: '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: 'success',
    },
  };
}

function criterionIdFor(axis: IndependentReviewAxisV1): string {
  return `crit-${axis}`;
}

function claimIdFor(premiseId: string): string {
  return `claim-${premiseId}`;
}

interface ValidWorld {
  readonly receipt: IndependentReviewReceiptV1;
  readonly authentication: ReviewAuthenticationContextV1;
}
function resolutionKey(commit: string, path: string): string {
  return `${commit}\0${path}`;
}

function buildValidWorld(): ValidWorld {
  const githubDoc = githubBoundDocument();
  const githubSha = computeGithubBoundResourcesSha256(githubDoc);
  const gateReceiptSha = digest('gate-receipt-bytes');
  const mainClaimHash = digest('claim-text-premise-main');
  const repairClaimHash = digest('claim-text-premise-repair');

  const candidateDiff = sourceObject(
    'ev-candidate-diff',
    'candidate_diff',
    CANDIDATE_COMMIT,
    'diff.patch',
    digest('candidate-diff-bytes'),
    128,
  );
  const contractObj = sourceObject(
    'ev-contract',
    'contract',
    CANDIDATE_COMMIT,
    'docs/autonomy/m8-contract.md',
    digest('contract-bytes'),
    256,
  );
  const rubricSource = sourceObject(
    'ev-rubric-source',
    'rubric_source',
    RUBRIC_CARRIER_COMMIT,
    'policies/independent-review-rubric.json',
    digest('rubric-source-bytes'),
    64,
  );
  const gateReceipt = runtimeObject(
    'ev-gate-receipt',
    'gate_receipt',
    'issuance://gate-receipt/1',
    gateReceiptSha,
    32,
  );
  const githubGateRun = runtimeObject(
    'ev-github-gate-run',
    'github_gate_run',
    'github://actions/run/9001',
    githubSha,
    Buffer.byteLength(JSON.stringify(githubDoc), 'utf8'),
  );
  const continuityCarrier = sourceObject(
    'ev-continuity-carrier',
    'continuity_carrier_commit',
    CONTINUITY_COMMIT,
    'continuity/CURRENT_STATE.md',
    digest('continuity-carrier-bytes'),
    48,
  );
  const findingResolution = sourceObject(
    'ev-finding-resolution',
    'finding_resolution',
    CANDIDATE_COMMIT,
    'repairs/finding-repaired.md',
    digest('finding-resolution-bytes'),
    40,
  );
  const claimMain = runtimeObject(
    claimIdFor('premise-main'),
    'claim_text',
    'claims://premise-main',
    mainClaimHash,
    16,
  );
  const claimRepair = runtimeObject(
    claimIdFor('premise-repair'),
    'claim_text',
    'claims://premise-repair',
    repairClaimHash,
    16,
  );

  const objects: ReviewEvidenceObjectV1[] = [
    candidateDiff,
    claimMain,
    claimRepair,
    continuityCarrier,
    contractObj,
    findingResolution,
    gateReceipt,
    githubGateRun,
    rubricSource,
  ];

  const criteria: IndependentReviewRubricCriterionV1[] = INDEPENDENT_REVIEW_AXES_V1.map(
    (axis) => ({
      criterionId: criterionIdFor(axis),
      axis,
      statementHash: digest(`statement:${axis}`),
      required: true,
    }),
  );

  const allCriterionIds = sorted(criteria.map((criterion) => criterion.criterionId));

  const premiseMain = sealPremise({
    premiseId: 'premise-main',
    classification: 'factual_assertion',
    claimTextHash: mainClaimHash,
    evidenceObjectIds: sorted([candidateDiff.evidenceId]),
    verificationReceiptIds: [],
    contradictsPremiseIds: [],
    decisionEligible: true,
    usedByFindingIds: [],
    usedByCriterionIds: allCriterionIds,
  });

  const premiseRepair = sealPremise({
    premiseId: 'premise-repair',
    classification: 'factual_assertion',
    claimTextHash: repairClaimHash,
    evidenceObjectIds: sorted([findingResolution.evidenceId]),
    verificationReceiptIds: [],
    contradictsPremiseIds: [],
    decisionEligible: true,
    usedByFindingIds: sorted(['finding-repaired']),
    usedByCriterionIds: [],
  });

  const findingRepaired = sealFinding({
    findingId: 'finding-repaired',
    severity: 'high',
    code: 'prior-blocking-issue',
    location: 'src/evaluation/reviewReceipt.ts',
    premiseIds: sorted(['premise-repair']),
    disposition: 'repaired',
  });

  const criterionVerifications = criteria.map((criterion) =>
    sealVerification({
      criterionId: criterion.criterionId,
      status: 'satisfied',
      premiseIds: sorted(['premise-main']),
      evidenceObjectIds: sorted([contractObj.evidenceId, rubricSource.evidenceId]),
    }),
  );

  const axisConclusions = INDEPENDENT_REVIEW_AXES_V1.map((axis) =>
    sealAxisConclusion({
      axis,
      status: 'clear',
      criterionIds: sorted(
        criteria
          .filter((criterion) => criterion.axis === axis)
          .map((criterion) => criterion.criterionId),
      ),
    }),
  );

  const workBinding = sealWorkBinding({
    schema: 'hercules-independent-review-work-binding/v1',
    issuer: 'hercules-program-control',
    milestone: 'm8-s5',
    reviewTaskId: 'review-task-m8-s5',
    reviewIterationId: 'review-iteration-1',
    reviewContractVersion: 1,
    reviewContractHash: digest('review-contract'),
    baseCommit: BASE_COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    milestoneContractPath: 'docs/autonomy/m8-contract.md',
    milestoneContractBlob: CONTRACT_BLOB,
  });

  const rubric = sealRubric({
    schema: 'hercules-independent-review-rubric/v1',
    policyId: 'hercules-independent-review-policy',
    version: 1,
    carrierRepository: 'example-org/review-ledger',
    carrierCommit: RUBRIC_CARRIER_COMMIT,
    policyBlob: POLICY_BLOB,
    criteria,
  });

  const evidenceManifest = sealManifest({
    schema: 'hercules-independent-review-evidence-manifest/v1',
    baseCommit: BASE_COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    contractBlob: CONTRACT_BLOB,
    changedPaths: sorted(['src/evaluation/reviewReceipt.ts']),
    objects,
  });

  const premises = [premiseMain, premiseRepair];
  const findings = [findingRepaired];

  const receipt = sealReceipt({
    schema: 'hercules-independent-review-receipt/v1',
    issuer: 'hercules-program-control',
    receiptId: 'receipt-m8-s5-valid',
    repository: 'example-org/acme',
    reviewTaskId: workBinding.reviewTaskId,
    reviewIterationId: workBinding.reviewIterationId,
    workBinding,
    workBindingHash: workBinding.bindingHash,
    baseCommit: BASE_COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    contractPath: workBinding.milestoneContractPath,
    contractBlob: CONTRACT_BLOB,
    rubric,
    evidenceManifest,
    reviewerRunId: 'reviewer-run-1',
    reviewerImplementation: 'independent-reviewer-v1',
    freshContext: true,
    implementerRunIds: sorted(['implementer-run-1']),
    reviewerRecommendation: 'blockers_no',
    premises,
    premiseSetHash: computePremiseSetHash(premises),
    findings,
    findingSetHash: computeFindingSetHash(findings),
    criterionVerifications,
    criterionVerificationSetHash:
      computeCriterionVerificationSetHash(criterionVerifications),
    axisConclusions,
    axisConclusionSetHash: computeAxisConclusionSetHash(axisConclusions),
    coordinatorDerivedResult: 'blockers_no',
    reviewedAt: REVIEWED_AT,
  });

  const sourceResolutions = new Map<string, ReviewSourceObjectResolutionV1>();
  for (const object of objects) {
    if (
      object.commit !== null &&
      object.path !== null &&
      object.gitObjectSha !== null &&
      object.contentLocator === null
    ) {
      sourceResolutions.set(resolutionKey(object.commit, object.path), {
        gitObjectSha: object.gitObjectSha,
        sha256: object.sha256,
        byteLength: object.byteLength,
      });
    }
  }

  const authentication: ReviewAuthenticationContextV1 = {
    trustedAnchorCommits: [
      BASE_COMMIT,
      CANDIDATE_COMMIT,
      RUBRIC_CARRIER_COMMIT,
      CONTINUITY_COMMIT,
    ],
    resolveSourceObject(commit, path) {
      return sourceResolutions.get(resolutionKey(commit, path)) ?? null;
    },
    issuanceRecordSha256s: new Set([gateReceiptSha]),
    continuityMainReachableCommits: new Set([CONTINUITY_COMMIT]),
    githubBoundDocuments: new Map([[githubSha, githubDoc]]),
  };

  return { receipt, authentication };
}

function resealAfterStructuralEdit(
  receipt: IndependentReviewReceiptV1,
): IndependentReviewReceiptV1 {
  const premises = receipt.premises.map((premise) => {
    const { premiseHash: _ignored, ...fields } = premise;
    return sealPremise(fields);
  });
  const findings = receipt.findings.map((finding) => {
    const { findingHash: _ignored, ...fields } = finding;
    return sealFinding(fields);
  });
  const criterionVerifications = receipt.criterionVerifications.map((verification) => {
    const { verificationHash: _ignored, ...fields } = verification;
    return sealVerification(fields);
  });
  const axisConclusions = receipt.axisConclusions.map((conclusion) => {
    const { conclusionHash: _ignored, ...fields } = conclusion;
    return sealAxisConclusion(fields);
  });
  const { bindingHash: _bindingHash, ...workBindingFields } = receipt.workBinding;
  const workBinding = sealWorkBinding(workBindingFields);
  const { rubricHash: _rubricHash, ...rubricFields } = receipt.rubric;
  const rubric = sealRubric(rubricFields);
  const { manifestHash: _manifestHash, ...manifestFields } = receipt.evidenceManifest;
  const evidenceManifest = sealManifest(manifestFields);

  return sealReceipt({
    ...receipt,
    workBinding,
    workBindingHash: workBinding.bindingHash,
    rubric,
    evidenceManifest,
    premises,
    premiseSetHash: computePremiseSetHash(premises),
    findings,
    findingSetHash: computeFindingSetHash(findings),
    criterionVerifications,
    criterionVerificationSetHash:
      computeCriterionVerificationSetHash(criterionVerifications),
    axisConclusions,
    axisConclusionSetHash: computeAxisConclusionSetHash(axisConclusions),
  });
}

function replaceObject(
  receipt: IndependentReviewReceiptV1,
  evidenceId: string,
  next: ReviewEvidenceObjectV1,
): IndependentReviewReceiptV1 {
  const objects = receipt.evidenceManifest.objects.map((object) =>
    object.evidenceId === evidenceId ? next : object,
  );
  return resealAfterStructuralEdit({
    ...receipt,
    evidenceManifest: {
      ...receipt.evidenceManifest,
      objects,
    },
  });
}

function replacePremise(
  receipt: IndependentReviewReceiptV1,
  premiseId: string,
  update: (premise: ReviewPremiseV1) => ReviewPremiseV1,
): IndependentReviewReceiptV1 {
  const premises = receipt.premises.map((premise) =>
    premise.premiseId === premiseId ? update(premise) : premise,
  );
  return resealAfterStructuralEdit({ ...receipt, premises });
}

function replaceFinding(
  receipt: IndependentReviewReceiptV1,
  findingId: string,
  update: (finding: ReviewFindingV1) => ReviewFindingV1,
): IndependentReviewReceiptV1 {
  const findings = receipt.findings.map((finding) =>
    finding.findingId === findingId ? update(finding) : finding,
  );
  return resealAfterStructuralEdit({ ...receipt, findings });
}

function replaceVerification(
  receipt: IndependentReviewReceiptV1,
  criterionId: string,
  update: (
    verification: IndependentReviewCriterionVerificationV1,
  ) => IndependentReviewCriterionVerificationV1,
): IndependentReviewReceiptV1 {
  const criterionVerifications = receipt.criterionVerifications.map((verification) =>
    verification.criterionId === criterionId ? update(verification) : verification,
  );
  return resealAfterStructuralEdit({ ...receipt, criterionVerifications });
}

function replaceAxisConclusion(
  receipt: IndependentReviewReceiptV1,
  axis: IndependentReviewAxisV1,
  update: (
    conclusion: IndependentReviewAxisConclusionV1,
  ) => IndependentReviewAxisConclusionV1,
): IndependentReviewReceiptV1 {
  const axisConclusions = receipt.axisConclusions.map((conclusion) =>
    conclusion.axis === axis ? update(conclusion) : conclusion,
  );
  return resealAfterStructuralEdit({ ...receipt, axisConclusions });
}

function authWith(
  base: ReviewAuthenticationContextV1,
  overrides: Partial<{
    trustedAnchorCommits: readonly string[];
    resolveSourceObject: ReviewAuthenticationContextV1['resolveSourceObject'];
    issuanceRecordSha256s: ReadonlySet<string>;
    continuityMainReachableCommits: ReadonlySet<string>;
    githubBoundDocuments: ReadonlyMap<string, GithubBoundResourcesV1>;
  }>,
): ReviewAuthenticationContextV1 {
  return {
    trustedAnchorCommits: overrides.trustedAnchorCommits ?? base.trustedAnchorCommits,
    resolveSourceObject: overrides.resolveSourceObject ?? base.resolveSourceObject.bind(base),
    issuanceRecordSha256s: overrides.issuanceRecordSha256s ?? base.issuanceRecordSha256s,
    continuityMainReachableCommits:
      overrides.continuityMainReachableCommits ?? base.continuityMainReachableCommits,
    githubBoundDocuments: overrides.githubBoundDocuments ?? base.githubBoundDocuments,
  };
}

describe('deriveReviewReceipt', () => {
  it('happy path: valid world derives blockers_no', () => {
    const { receipt, authentication } = buildValidWorld();
    const result = deriveReviewReceipt(receipt, authentication);
    expect(result.valid).toBe(true);
    expect(result.invalidReason).toBeNull();
    expect(result.recomputedDerivedResult).toBe('blockers_no');
    expect(result.recomputedAxisConclusions).toHaveLength(INDEPENDENT_REVIEW_AXES_V1.length);
    expect(
      result.recomputedAxisConclusions.every((conclusion) => conclusion.status === 'clear'),
    ).toBe(true);
    expect(result.recomputedDecisionEligible.get('premise-main')).toBe(true);
    expect(result.recomputedDecisionEligible.get('premise-repair')).toBe(true);
  });

  it('is deterministic for the same receipt and authentication context', () => {
    const { receipt, authentication } = buildValidWorld();
    const first = deriveReviewReceipt(receipt, authentication);
    const second = deriveReviewReceipt(receipt, authentication);
    expect(second).toEqual(first);
  });

  it('invalidates a source object whose commit is outside the trusted anchor set', () => {
    const { receipt, authentication } = buildValidWorld();
    const result = deriveReviewReceipt(
      receipt,
      authWith(authentication, {
        trustedAnchorCommits: [BASE_COMMIT, RUBRIC_CARRIER_COMMIT, CONTINUITY_COMMIT],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/outside trusted anchor set/);
  });

  it('invalidates a source object that does not resolve over supplied bytes', () => {
    const { receipt, authentication } = buildValidWorld();
    const result = deriveReviewReceipt(
      receipt,
      authWith(authentication, {
        resolveSourceObject: () => null,
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/does not resolve over supplied object-store bytes/);
  });

  it('invalidates a fabricated gate_receipt sha256 absent from issuance records', () => {
    const { receipt, authentication } = buildValidWorld();
    const result = deriveReviewReceipt(
      receipt,
      authWith(authentication, {
        issuanceRecordSha256s: new Set([digest('unrelated-issuance')]),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /gate_receipt .* sha256 is not in program-control issuance records/,
    );
  });

  it('invalidates continuity_carrier_commit when its commit is not main-reachable', () => {
    const { receipt, authentication } = buildValidWorld();
    const result = deriveReviewReceipt(
      receipt,
      authWith(authentication, {
        // Keep anchors + resolve so authenticity fails only on reachability.
        continuityMainReachableCommits: new Set([
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ]),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /continuity_carrier_commit .* commit is not reachable from continuity main/,
    );
  });

  it('invalidates a premise that lists claim_text in evidenceObjectIds', () => {
    const { receipt, authentication } = buildValidWorld();
    const mutated = replacePremise(receipt, 'premise-main', (premise) => ({
      ...premise,
      evidenceObjectIds: sorted([claimIdFor('premise-main')]),
    }));
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /premise premise-main evidenceObjectIds must not include claim_text/,
    );
  });

  it('invalidates when supplied decisionEligible disagrees with recomputation', () => {
    const { receipt, authentication } = buildValidWorld();
    const mutated = replacePremise(receipt, 'premise-main', (premise) => ({
      ...premise,
      decisionEligible: false,
    }));
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /premise premise-main decisionEligible differs from recomputation/,
    );
  });

  it('invalidates when a contradiction-edge participant is marked decisionEligible', () => {
    const { receipt, authentication } = buildValidWorld();
    const withEdges = resealAfterStructuralEdit({
      ...receipt,
      premises: receipt.premises.map((premise) => {
        if (premise.premiseId === 'premise-main') {
          return {
            ...premise,
            contradictsPremiseIds: sorted(['premise-repair']),
            decisionEligible: true,
          };
        }
        if (premise.premiseId === 'premise-repair') {
          return {
            ...premise,
            contradictsPremiseIds: sorted(['premise-main']),
            decisionEligible: true,
          };
        }
        return premise;
      }),
    });
    const result = deriveReviewReceipt(withEdges, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/decisionEligible differs from recomputation/);
  });

  it('invalidates an unknown contradiction edge id', () => {
    const { receipt, authentication } = buildValidWorld();
    const mutated = replacePremise(receipt, 'premise-main', (premise) => ({
      ...premise,
      contradictsPremiseIds: sorted(['premise-does-not-exist']),
      decisionEligible: false,
    }));
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /contradiction edge from premise-main names unknown premise premise-does-not-exist/,
    );
  });

  it('invalidates repaired disposition governed only by a runtime finding_resolution', () => {
    const { receipt, authentication } = buildValidWorld();
    const runtimeResolution = runtimeObject(
      'ev-finding-resolution',
      'finding_resolution',
      'runtime://finding-resolution/1',
      digest('finding-resolution-runtime-bytes'),
      40,
    );
    // Runtime resolution is not authenticatable, so eligibility must be false
    // to pass Rule 1 and reach the Rule 2 disposition governance check.
    let mutated = replaceObject(receipt, 'ev-finding-resolution', runtimeResolution);
    mutated = replacePremise(mutated, 'premise-repair', (premise) => ({
      ...premise,
      decisionEligible: false,
    }));
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /finding finding-repaired disposition repaired lacks an authenticatable source finding_resolution premise/,
    );
  });

  it('invalidates vacuous satisfied criterion verification without a decision-eligible premise', () => {
    const { receipt, authentication } = buildValidWorld();
    // Drop premise-main from every verification and clear its inverse use map.
    const mutated = resealAfterStructuralEdit({
      ...receipt,
      premises: receipt.premises.map((premise) =>
        premise.premiseId === 'premise-main'
          ? { ...premise, usedByCriterionIds: [] }
          : premise,
      ),
      criterionVerifications: receipt.criterionVerifications.map((verification) => ({
        ...verification,
        premiseIds: [],
        status: 'satisfied' as const,
      })),
    });
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /criterion verification .* status satisfied requires a decision-eligible premise/,
    );
  });

  it('invalidates a violated required criterion that lacks a blocking or high finding', () => {
    const { receipt, authentication } = buildValidWorld();
    const targetCriterion = criterionIdFor('claim_authority');
    const targetAxis: IndependentReviewAxisV1 = 'claim_authority';
    let mutated = replaceVerification(receipt, targetCriterion, (verification) => ({
      ...verification,
      status: 'violated',
    }));
    mutated = replaceAxisConclusion(mutated, targetAxis, (conclusion) => ({
      ...conclusion,
      status: 'blocked',
    }));
    mutated = resealAfterStructuralEdit({
      ...mutated,
      reviewerRecommendation: 'blockers_yes',
      coordinatorDerivedResult: 'blockers_yes',
    });
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /violated required criterion .* must share a premise with a blocking or high finding/,
    );
  });

  it('invalidates reviewer-supplied axis conclusion status drift', () => {
    const { receipt, authentication } = buildValidWorld();
    const mutated = replaceAxisConclusion(receipt, 'fail_closed_semantics', (conclusion) => ({
      ...conclusion,
      status: 'blocked',
    }));
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /axis conclusion fail_closed_semantics differs from coordinator recomputation/,
    );
  });

  it('invalidates stored coordinatorDerivedResult that differs from recomputation', () => {
    const { receipt, authentication } = buildValidWorld();
    // Force blockers_yes via an open high finding while storing blockers_no.
    let mutated = replaceFinding(receipt, 'finding-repaired', (finding) => ({
      ...finding,
      disposition: 'open',
    }));
    mutated = resealAfterStructuralEdit({
      ...mutated,
      coordinatorDerivedResult: 'blockers_no',
      reviewerRecommendation: 'blockers_no',
    });
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /coordinatorDerivedResult differs from recomputation \(stored blockers_no, recomputed blockers_yes\)/,
    );
  });

  it('invalidates an open blocking finding when stored result is blockers_no', () => {
    const { receipt, authentication } = buildValidWorld();
    let mutated = replaceFinding(receipt, 'finding-repaired', (finding) => ({
      ...finding,
      severity: 'blocking',
      disposition: 'open',
    }));
    mutated = resealAfterStructuralEdit({
      ...mutated,
      coordinatorDerivedResult: 'blockers_no',
      reviewerRecommendation: 'blockers_no',
    });
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(
      /coordinatorDerivedResult differs from recomputation \(stored blockers_no, recomputed blockers_yes\)/,
    );
  });

  it('invalidates an unused evidence object', () => {
    const { receipt, authentication } = buildValidWorld();
    const unused = runtimeObject(
      'ev-unused-assertion',
      'assertion',
      'runtime://unused-assertion',
      digest('unused-assertion-bytes'),
      8,
    );
    const mutated = resealAfterStructuralEdit({
      ...receipt,
      evidenceManifest: {
        ...receipt.evidenceManifest,
        objects: [...receipt.evidenceManifest.objects, unused],
      },
    });
    const result = deriveReviewReceipt(mutated, authentication);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/evidence object ev-unused-assertion is unused/);
  });
});
