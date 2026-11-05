/**
 * M8 independent review receipt derivation (pure).
 *
 * Implements the contract's closed authenticatable / used / Rules 1–5
 * coordinator derivation in order. Total: never throws.
 */

import {
  ALWAYS_REQUIRED_EVIDENCE_KINDS_V1,
  IndependentReviewError,
  assertIndependentReviewReceiptV1,
  computeAxisConclusionHash,
  computeGithubBoundResourcesSha256,
  isReviewEvidenceSourceObject,
  type GithubBoundResourcesV1,
  type IndependentReviewAxisConclusionV1,
  type IndependentReviewAxisV1,
  type IndependentReviewReceiptV1,
  type ReviewEvidenceObjectV1,
  type ReviewPremiseV1,
} from '../domain/independentReview.js';

export interface ReviewSourceObjectResolutionV1 {
  readonly gitObjectSha: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ReviewAuthenticationContextV1 {
  readonly trustedAnchorCommits: readonly string[];
  resolveSourceObject(
    commit: string,
    path: string,
  ): ReviewSourceObjectResolutionV1 | null;
  readonly issuanceRecordSha256s: ReadonlySet<string>;
  readonly continuityMainReachableCommits: ReadonlySet<string>;
  readonly githubBoundDocuments: ReadonlyMap<string, GithubBoundResourcesV1>;
}

export interface ReviewDerivationResultV1 {
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly recomputedDecisionEligible: ReadonlyMap<string, boolean>;
  readonly recomputedDerivedResult:
    | 'blockers_no'
    | 'blockers_yes'
    | 'need_more_evidence'
    | null;
  readonly recomputedAxisConclusions: readonly IndependentReviewAxisConclusionV1[];
}

function invalid(
  reason: string,
  extras: {
    readonly recomputedDecisionEligible?: ReadonlyMap<string, boolean>;
    readonly recomputedDerivedResult?: ReviewDerivationResultV1['recomputedDerivedResult'];
    readonly recomputedAxisConclusions?: readonly IndependentReviewAxisConclusionV1[];
  } = {},
): ReviewDerivationResultV1 {
  return {
    valid: false,
    invalidReason: reason,
    recomputedDecisionEligible: extras.recomputedDecisionEligible ?? new Map(),
    recomputedDerivedResult: extras.recomputedDerivedResult ?? null,
    recomputedAxisConclusions: extras.recomputedAxisConclusions ?? [],
  };
}

function validResult(
  recomputedDecisionEligible: ReadonlyMap<string, boolean>,
  recomputedDerivedResult: 'blockers_no' | 'blockers_yes' | 'need_more_evidence',
  recomputedAxisConclusions: readonly IndependentReviewAxisConclusionV1[],
): ReviewDerivationResultV1 {
  return {
    valid: true,
    invalidReason: null,
    recomputedDecisionEligible,
    recomputedDerivedResult,
    recomputedAxisConclusions,
  };
}

function tryStructuralAssert(receipt: IndependentReviewReceiptV1): string | null {
  try {
    assertIndependentReviewReceiptV1(receipt);
    return null;
  } catch (error) {
    if (error instanceof IndependentReviewError) {
      return error.message;
    }
    return String(error);
  }
}

function objectById(
  receipt: IndependentReviewReceiptV1,
): ReadonlyMap<string, ReviewEvidenceObjectV1> {
  return new Map(
    receipt.evidenceManifest.objects.map((object) => [object.evidenceId, object]),
  );
}

/**
 * Classify authenticatable objects. Returns an error string if a hard
 * authenticity rule is violated (invalidates the receipt).
 *
 * Source objects must resolve against the trusted anchor set or the receipt
 * is invalid. Typed kinds apply in addition (any object of that kind):
 * continuity reachability, github bound-document digest, or issuance set.
 */
function classifyAuthenticatable(
  receipt: IndependentReviewReceiptV1,
  authentication: ReviewAuthenticationContextV1,
): { readonly authenticatableIds: ReadonlySet<string> } | { readonly error: string } {
  const anchorSet = new Set(authentication.trustedAnchorCommits);
  const authenticatableIds = new Set<string>();

  for (const object of receipt.evidenceManifest.objects) {
    let sourceAuthenticated = false;
    if (isReviewEvidenceSourceObject(object)) {
      const commit = object.commit;
      const path = object.path;
      if (commit === null || path === null || object.gitObjectSha === null) {
        return { error: `source object ${object.evidenceId} has null source fields` };
      }
      if (!anchorSet.has(commit)) {
        return {
          error: `source object ${object.evidenceId} names commit outside trusted anchor set`,
        };
      }
      const resolution = authentication.resolveSourceObject(commit, path);
      if (
        resolution === null ||
        resolution.gitObjectSha !== object.gitObjectSha ||
        resolution.sha256 !== object.sha256 ||
        resolution.byteLength !== object.byteLength
      ) {
        return {
          error: `source object ${object.evidenceId} does not resolve over supplied object-store bytes`,
        };
      }
      sourceAuthenticated = true;
    }

    let typedAuthenticated = false;
    switch (object.kind) {
      case 'continuity_carrier_commit': {
        if (
          object.commit === null ||
          !authentication.continuityMainReachableCommits.has(object.commit)
        ) {
          return {
            error: `continuity_carrier_commit ${object.evidenceId} commit is not reachable from continuity main`,
          };
        }
        typedAuthenticated = true;
        break;
      }
      case 'github_gate_run': {
        const document = authentication.githubBoundDocuments.get(object.sha256);
        if (document === undefined) {
          return {
            error: `github_gate_run ${object.evidenceId} has no bound document under its sha256`,
          };
        }
        const digest = computeGithubBoundResourcesSha256(document);
        if (digest !== object.sha256) {
          return {
            error: `github_gate_run ${object.evidenceId} bound document digest mismatch`,
          };
        }
        typedAuthenticated = true;
        break;
      }
      case 'gate_receipt':
      case 'verification_receipt': {
        if (!authentication.issuanceRecordSha256s.has(object.sha256)) {
          return {
            error: `${object.kind} ${object.evidenceId} sha256 is not in program-control issuance records`,
          };
        }
        typedAuthenticated = true;
        break;
      }
      default:
        break;
    }

    if (sourceAuthenticated || typedAuthenticated) {
      authenticatableIds.add(object.evidenceId);
    }
  }

  return { authenticatableIds };
}

function assertUsedRule(
  receipt: IndependentReviewReceiptV1,
  objects: ReadonlyMap<string, ReviewEvidenceObjectV1>,
): string | null {
  const usedIds = new Set<string>();

  for (const premise of receipt.premises) {
    for (const evidenceId of premise.evidenceObjectIds) {
      const object = objects.get(evidenceId);
      if (object === undefined) {
        return `premise ${premise.premiseId} evidenceObjectIds member ${evidenceId} does not resolve`;
      }
      if (object.kind === 'claim_text') {
        return `premise ${premise.premiseId} evidenceObjectIds must not include claim_text`;
      }
      usedIds.add(evidenceId);
    }
    for (const receiptId of premise.verificationReceiptIds) {
      const object = objects.get(receiptId);
      if (object === undefined || object.kind !== 'verification_receipt') {
        return `premise ${premise.premiseId} verificationReceiptIds member ${receiptId} must resolve to verification_receipt`;
      }
      usedIds.add(receiptId);
    }
    let claimBound = false;
    for (const object of receipt.evidenceManifest.objects) {
      if (object.kind === 'claim_text' && object.sha256 === premise.claimTextHash) {
        usedIds.add(object.evidenceId);
        claimBound = true;
        break;
      }
    }
    if (!claimBound) {
      return `premise ${premise.premiseId} claimTextHash does not bind a claim_text evidence object`;
    }
  }

  for (const verification of receipt.criterionVerifications) {
    for (const evidenceId of verification.evidenceObjectIds) {
      const object = objects.get(evidenceId);
      if (object === undefined) {
        return `criterion verification ${verification.criterionId} evidenceObjectIds member ${evidenceId} does not resolve`;
      }
      if (object.kind === 'claim_text') {
        return `criterion verification ${verification.criterionId} evidenceObjectIds must not include claim_text`;
      }
      usedIds.add(evidenceId);
    }
  }

  for (const object of receipt.evidenceManifest.objects) {
    if (ALWAYS_REQUIRED_EVIDENCE_KINDS_V1.has(object.kind)) {
      usedIds.add(object.evidenceId);
    }
  }

  for (const object of receipt.evidenceManifest.objects) {
    if (!usedIds.has(object.evidenceId)) {
      return `evidence object ${object.evidenceId} is unused`;
    }
  }

  // Inverse use maps.
  const usedByFinding = new Map<string, string[]>();
  const usedByCriterion = new Map<string, string[]>();
  for (const premise of receipt.premises) {
    usedByFinding.set(premise.premiseId, []);
    usedByCriterion.set(premise.premiseId, []);
  }
  for (const finding of receipt.findings) {
    for (const premiseId of finding.premiseIds) {
      const list = usedByFinding.get(premiseId);
      if (list === undefined) {
        return `finding ${finding.findingId} names unknown premise ${premiseId}`;
      }
      list.push(finding.findingId);
    }
  }
  for (const verification of receipt.criterionVerifications) {
    for (const premiseId of verification.premiseIds) {
      const list = usedByCriterion.get(premiseId);
      if (list === undefined) {
        return `criterion verification ${verification.criterionId} names unknown premise ${premiseId}`;
      }
      list.push(verification.criterionId);
    }
  }
  for (const premise of receipt.premises) {
    const expectedFindings = [...(usedByFinding.get(premise.premiseId) ?? [])].sort();
    const expectedCriteria = [...(usedByCriterion.get(premise.premiseId) ?? [])].sort();
    if (
      premise.usedByFindingIds.length !== expectedFindings.length ||
      premise.usedByFindingIds.some((id, index) => id !== expectedFindings[index])
    ) {
      return `premise ${premise.premiseId} usedByFindingIds differs from recomputed inverse map`;
    }
    if (
      premise.usedByCriterionIds.length !== expectedCriteria.length ||
      premise.usedByCriterionIds.some((id, index) => id !== expectedCriteria[index])
    ) {
      return `premise ${premise.premiseId} usedByCriterionIds differs from recomputed inverse map`;
    }
  }

  return null;
}

function contradictionParticipants(
  premises: readonly ReviewPremiseV1[],
): { readonly participants: ReadonlySet<string> } | { readonly error: string } {
  const ids = new Set(premises.map((premise) => premise.premiseId));
  const adjacency = new Map<string, Set<string>>();
  for (const id of ids) {
    adjacency.set(id, new Set());
  }
  for (const premise of premises) {
    for (const otherId of premise.contradictsPremiseIds) {
      if (!ids.has(otherId)) {
        return {
          error: `contradiction edge from ${premise.premiseId} names unknown premise ${otherId}`,
        };
      }
      adjacency.get(premise.premiseId)?.add(otherId);
      adjacency.get(otherId)?.add(premise.premiseId);
    }
  }
  const participants = new Set<string>();
  for (const [id, neighbors] of adjacency) {
    if (neighbors.size > 0) {
      participants.add(id);
    }
  }
  return { participants };
}

function recomputeDecisionEligible(
  receipt: IndependentReviewReceiptV1,
  objects: ReadonlyMap<string, ReviewEvidenceObjectV1>,
  authenticatableIds: ReadonlySet<string>,
  contradictionIds: ReadonlySet<string>,
): ReadonlyMap<string, boolean> {
  const result = new Map<string, boolean>();
  for (const premise of receipt.premises) {
    if (premise.classification !== 'factual_assertion') {
      result.set(premise.premiseId, false);
      continue;
    }
    if (premise.evidenceObjectIds.length === 0) {
      result.set(premise.premiseId, false);
      continue;
    }
    let allResolveNonClaim = true;
    let sawAuthenticatable = false;
    for (const evidenceId of premise.evidenceObjectIds) {
      const object = objects.get(evidenceId);
      if (object === undefined || object.kind === 'claim_text') {
        allResolveNonClaim = false;
        break;
      }
      if (authenticatableIds.has(evidenceId)) {
        sawAuthenticatable = true;
      }
    }
    const eligible =
      allResolveNonClaim &&
      sawAuthenticatable &&
      !contradictionIds.has(premise.premiseId);
    result.set(premise.premiseId, eligible);
  }
  return result;
}

function recomputeAxisConclusions(
  receipt: IndependentReviewReceiptV1,
): readonly IndependentReviewAxisConclusionV1[] {
  const verificationByCriterion = new Map(
    receipt.criterionVerifications.map((item) => [item.criterionId, item]),
  );
  const axes = new Map<IndependentReviewAxisV1, string[]>();
  for (const criterion of receipt.rubric.criteria) {
    const list = axes.get(criterion.axis) ?? [];
    list.push(criterion.criterionId);
    axes.set(criterion.axis, list);
  }

  const conclusions: IndependentReviewAxisConclusionV1[] = [];
  for (const axis of [...axes.keys()].sort()) {
    const criterionIds = [...(axes.get(axis) ?? [])].sort();
    const requiredCriteria = receipt.rubric.criteria.filter(
      (criterion) => criterion.axis === axis && criterion.required,
    );
    let blocked = false;
    let insufficient = false;
    for (const criterion of requiredCriteria) {
      const verification = verificationByCriterion.get(criterion.criterionId);
      if (verification === undefined) {
        insufficient = true;
        continue;
      }
      if (verification.status === 'violated') {
        blocked = true;
      } else if (verification.status === 'insufficient_evidence') {
        insufficient = true;
      }
    }
    const status = blocked
      ? 'blocked'
      : insufficient
        ? 'insufficient_evidence'
        : 'clear';
    const withoutHash = {
      axis,
      status: status as IndependentReviewAxisConclusionV1['status'],
      criterionIds,
    };
    conclusions.push({
      ...withoutHash,
      conclusionHash: computeAxisConclusionHash(withoutHash),
    });
  }
  return conclusions;
}

function deriveTotalResult(
  receipt: IndependentReviewReceiptV1,
  axisConclusions: readonly IndependentReviewAxisConclusionV1[],
): 'blockers_no' | 'blockers_yes' | 'need_more_evidence' {
  if (axisConclusions.some((conclusion) => conclusion.status === 'blocked')) {
    return 'blockers_yes';
  }
  if (
    receipt.findings.some(
      (finding) =>
        (finding.severity === 'blocking' || finding.severity === 'high') &&
        finding.disposition === 'open',
    )
  ) {
    return 'blockers_yes';
  }
  if (
    axisConclusions.some((conclusion) => conclusion.status === 'insufficient_evidence')
  ) {
    return 'need_more_evidence';
  }
  return 'blockers_no';
}

/**
 * Total coordinator derivation over a supplied authentication context.
 * Returns the first violation as invalidReason; never throws.
 */
export function deriveReviewReceipt(
  receipt: IndependentReviewReceiptV1,
  authentication: ReviewAuthenticationContextV1,
): ReviewDerivationResultV1 {
  // 1. Structural validation
  const structuralError = tryStructuralAssert(receipt);
  if (structuralError !== null) {
    return invalid(structuralError);
  }

  const objects = objectById(receipt);

  // 2. Authenticatable classification
  const authenticity = classifyAuthenticatable(receipt, authentication);
  if ('error' in authenticity) {
    return invalid(authenticity.error);
  }
  const { authenticatableIds } = authenticity;

  // 3. Used rule
  const usedError = assertUsedRule(receipt, objects);
  if (usedError !== null) {
    return invalid(usedError);
  }

  // Contradiction edges (needed for Rule 1; unknown id invalidates)
  const contradiction = contradictionParticipants(receipt.premises);
  if ('error' in contradiction) {
    return invalid(contradiction.error);
  }

  // 4. Rule 1 — decisionEligible
  const recomputedDecisionEligible = recomputeDecisionEligible(
    receipt,
    objects,
    authenticatableIds,
    contradiction.participants,
  );
  for (const premise of receipt.premises) {
    const expected = recomputedDecisionEligible.get(premise.premiseId);
    if (expected === undefined || premise.decisionEligible !== expected) {
      return invalid(
        `premise ${premise.premiseId} decisionEligible differs from recomputation`,
        { recomputedDecisionEligible },
      );
    }
  }

  // 5. Rule 2 — dispositions
  for (const finding of receipt.findings) {
    if (finding.disposition === 'open') {
      continue;
    }
    let governed = false;
    for (const premiseId of finding.premiseIds) {
      if (recomputedDecisionEligible.get(premiseId) !== true) {
        continue;
      }
      const premise = receipt.premises.find((item) => item.premiseId === premiseId);
      if (premise === undefined) {
        return invalid(`finding ${finding.findingId} names unknown premise ${premiseId}`, {
          recomputedDecisionEligible,
        });
      }
      for (const evidenceId of premise.evidenceObjectIds) {
        const object = objects.get(evidenceId);
        if (
          object !== undefined &&
          object.kind === 'finding_resolution' &&
          isReviewEvidenceSourceObject(object) &&
          authenticatableIds.has(evidenceId)
        ) {
          governed = true;
          break;
        }
      }
      if (governed) {
        break;
      }
    }
    if (!governed) {
      return invalid(
        `finding ${finding.findingId} disposition ${finding.disposition} lacks an authenticatable source finding_resolution premise`,
        { recomputedDecisionEligible },
      );
    }
  }

  // 6. Rule 3 — criterion verifications
  const rubricById = new Map(
    receipt.rubric.criteria.map((criterion) => [criterion.criterionId, criterion]),
  );
  for (const verification of receipt.criterionVerifications) {
    if (
      verification.status === 'satisfied' ||
      verification.status === 'violated'
    ) {
      const hasEligible = verification.premiseIds.some(
        (premiseId) => recomputedDecisionEligible.get(premiseId) === true,
      );
      if (!hasEligible) {
        return invalid(
          `criterion verification ${verification.criterionId} status ${verification.status} requires a decision-eligible premise`,
          { recomputedDecisionEligible },
        );
      }
    }
    if (verification.status === 'violated') {
      const criterion = rubricById.get(verification.criterionId);
      if (criterion?.required === true) {
        const shared = verification.premiseIds;
        const hasBlockingFinding = receipt.findings.some(
          (finding) =>
            (finding.severity === 'blocking' || finding.severity === 'high') &&
            finding.premiseIds.some((premiseId) => shared.includes(premiseId)),
        );
        if (!hasBlockingFinding) {
          return invalid(
            `violated required criterion ${verification.criterionId} must share a premise with a blocking or high finding`,
            { recomputedDecisionEligible },
          );
        }
      }
    }
  }

  // 7. Rule 4 — axis conclusions
  const recomputedAxisConclusions = recomputeAxisConclusions(receipt);
  if (receipt.axisConclusions.length !== recomputedAxisConclusions.length) {
    return invalid('axis conclusions differ from coordinator recomputation', {
      recomputedDecisionEligible,
      recomputedAxisConclusions,
    });
  }
  for (let index = 0; index < recomputedAxisConclusions.length; index += 1) {
    const expected = recomputedAxisConclusions[index];
    const supplied = receipt.axisConclusions.find(
      (item) => item.axis === expected?.axis,
    );
    if (
      expected === undefined ||
      supplied === undefined ||
      supplied.status !== expected.status ||
      supplied.criterionIds.length !== expected.criterionIds.length ||
      supplied.criterionIds.some((id, i) => id !== expected.criterionIds[i]) ||
      supplied.conclusionHash !== expected.conclusionHash
    ) {
      return invalid(
        `axis conclusion ${expected?.axis ?? 'unknown'} differs from coordinator recomputation`,
        { recomputedDecisionEligible, recomputedAxisConclusions },
      );
    }
  }

  // 8. Rule 5 — total result
  const recomputedDerivedResult = deriveTotalResult(receipt, recomputedAxisConclusions);
  if (receipt.coordinatorDerivedResult !== recomputedDerivedResult) {
    return invalid(
      `coordinatorDerivedResult differs from recomputation (stored ${receipt.coordinatorDerivedResult}, recomputed ${recomputedDerivedResult})`,
      {
        recomputedDecisionEligible,
        recomputedDerivedResult,
        recomputedAxisConclusions,
      },
    );
  }

  return validResult(
    recomputedDecisionEligible,
    recomputedDerivedResult,
    recomputedAxisConclusions,
  );
}
