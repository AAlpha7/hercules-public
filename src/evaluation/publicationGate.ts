/**
 * M8 publication-gate validators (pure).
 *
 * Host full-gate and GitHub gate receipt checks over supplied observations.
 * Total result objects: never throws to callers.
 */

import {
  IndependentReviewError,
  assertGithubBoundResourcesV1,
  assertGithubGateReceiptBindsCandidate,
  assertGithubGateReceiptV1,
  assertHostFullGateReceiptV1,
  computeGithubBoundResourcesByteLength,
  computeGithubBoundResourcesSha256,
  computeHostFullGateReceiptHash,
  type GithubBoundResourcesV1,
  type GithubGateReceiptV1,
  type HostFullGateReceiptV1,
} from '../domain/independentReview.js';

export interface HostGateLogObservationV1 {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mainSummary: {
    readonly testFilesPassed: number;
    readonly testsPassed: number;
    readonly testsSkipped: number;
  };
  readonly spaSmokeAllPassed: boolean;
}

export interface PublicationGateValidationV1 {
  readonly valid: boolean;
  readonly reason: string | null;
}

function ok(): PublicationGateValidationV1 {
  return { valid: true, reason: null };
}

function fail(reason: string): PublicationGateValidationV1 {
  return { valid: false, reason };
}

function catchIndependentReview(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof IndependentReviewError) {
      return error.message;
    }
    return String(error);
  }
}

/**
 * Validate a host full-gate receipt against the candidate and retained log
 * observation (main vitest summary + SPA-smoke all-passed flag).
 */
export function validateHostFullGateReceipt(
  receipt: HostFullGateReceiptV1,
  candidateCommit: string,
  logObservation: HostGateLogObservationV1,
): PublicationGateValidationV1 {
  const structural = catchIndependentReview(() => {
    assertHostFullGateReceiptV1(receipt);
  });
  if (structural !== null) {
    return fail(structural);
  }

  if (
    receipt.worktreeHeadBefore !== candidateCommit ||
    receipt.worktreeHeadAfter !== candidateCommit ||
    receipt.candidateCommit !== candidateCommit
  ) {
    return fail(
      'host full gate worktree heads and candidateCommit must equal the supplied candidate',
    );
  }

  if (
    receipt.logSha256 !== logObservation.sha256 ||
    receipt.logByteLength !== logObservation.byteLength
  ) {
    return fail('host full gate log digest/byteLength must equal the log observation');
  }

  if (
    receipt.testFilesPassed !== logObservation.mainSummary.testFilesPassed ||
    receipt.testsPassed !== logObservation.mainSummary.testsPassed ||
    receipt.testsSkipped !== logObservation.mainSummary.testsSkipped
  ) {
    return fail(
      'host full gate test counts must equal the log mainSummary (not the SPA-smoke summary)',
    );
  }

  if (receipt.spaSmokePassed === true && !logObservation.spaSmokeAllPassed) {
    return fail('host full gate spaSmokePassed requires spaSmokeAllPassed observation');
  }

  const expectedHash = computeHostFullGateReceiptHash(
    (({ receiptHash: _omit, ...rest }) => rest)(receipt),
  );
  if (receipt.receiptHash !== expectedHash) {
    return fail('host full gate receipt hash does not match the exact record');
  }

  return ok();
}

/**
 * Validate a GitHub gate receipt against the candidate, docs-only flag, and
 * bound-resources document.
 */
export function validateGithubGateReceipt(
  receipt: GithubGateReceiptV1,
  candidateCommit: string,
  candidateIsDocsOnly: boolean,
  document: GithubBoundResourcesV1,
): PublicationGateValidationV1 {
  const structural = catchIndependentReview(() => {
    assertGithubGateReceiptV1(receipt);
    assertGithubBoundResourcesV1(document, receipt);
    assertGithubGateReceiptBindsCandidate(receipt, candidateCommit);
  });
  if (structural !== null) {
    return fail(structural);
  }

  const digest = computeGithubBoundResourcesSha256(document);
  if (digest !== receipt.boundResourcesSha256) {
    return fail('github gate boundResourcesSha256 must equal the bound document digest');
  }
  if (
    computeGithubBoundResourcesByteLength(document) !== receipt.boundResourcesByteLength
  ) {
    return fail(
      'github gate boundResourcesByteLength must equal the bound document byte length',
    );
  }

  if (!candidateIsDocsOnly && receipt.scopeClassification !== 'full') {
    return fail(
      "non-docs-only candidate requires github gate scopeClassification 'full'",
    );
  }
  if (candidateIsDocsOnly && receipt.scopeClassification !== 'docs_only') {
    return fail(
      "docs-only candidate requires github gate scopeClassification 'docs_only'",
    );
  }

  if (receipt.headSha !== candidateCommit) {
    return fail('github gate headSha must equal candidateCommit');
  }

  return ok();
}
