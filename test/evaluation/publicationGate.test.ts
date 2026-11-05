/**
 * M8 slice 5 — publication-gate validators over host / GitHub receipts.
 */
import { describe, expect, it } from 'vitest';
import {
  computeGithubBoundResourcesByteLength,
  computeGithubBoundResourcesSha256,
  computeGithubGateReceiptHash,
  computeHostFullGateReceiptHash,
  type GithubBoundResourcesV1,
  type GithubGateReceiptV1,
  type HostFullGateReceiptV1,
} from '../../src/domain/independentReview.js';
import {
  validateGithubGateReceipt,
  validateHostFullGateReceipt,
  type HostGateLogObservationV1,
} from '../../src/evaluation/publicationGate.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LOG_SHA =
  'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const WRONG_SHA =
  'sha256:2222222222222222222222222222222222222222222222222222222222222222';
const BOGUS_RECEIPT_HASH =
  'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const STARTED_AT = '2026-08-31T12:00:00.000Z';
const COMPLETED_AT = '2026-08-31T12:05:00.000Z';
const OBSERVED_AT = '2026-08-31T12:06:00.000Z';
const RUN_ID = 42_001;

function hostLogObservation(options?: {
  readonly sha256?: string;
  readonly byteLength?: number;
  readonly spaSmokeAllPassed?: boolean;
  readonly mainSummary?: HostGateLogObservationV1['mainSummary'];
}): HostGateLogObservationV1 {
  return {
    sha256: options?.sha256 ?? LOG_SHA,
    byteLength: options?.byteLength ?? 4096,
    spaSmokeAllPassed: options?.spaSmokeAllPassed ?? true,
    mainSummary: options?.mainSummary ?? {
      testFilesPassed: 10,
      testsPassed: 100,
      testsSkipped: 2,
    },
  };
}

function hostReceiptBody(): Omit<HostFullGateReceiptV1, 'receiptHash'> {
  return {
    schema: 'hercules-host-full-gate-receipt/v1',
    issuer: 'hercules-program-control',
    command: 'pnpm check:full',
    candidateCommit: COMMIT,
    worktreeHeadBefore: COMMIT,
    worktreeHeadAfter: COMMIT,
    statusCleanBefore: true,
    statusCleanAfter: true,
    exitCode: 0,
    conclusion: 'passed',
    testFilesPassed: 10,
    testsPassed: 100,
    testsSkipped: 2,
    spaSmokePassed: true,
    logPath: 'artifacts/host-full-gate.log',
    logSha256: LOG_SHA,
    logByteLength: 4096,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
  };
}

function hostReceipt(receiptHashOverride?: string): HostFullGateReceiptV1 {
  const body = hostReceiptBody();
  const receiptHash =
    receiptHashOverride ?? computeHostFullGateReceiptHash(body);
  return { ...body, receiptHash };
}

function fullBoundDocument(
  mutate?: (document: GithubBoundResourcesV1) => GithubBoundResourcesV1,
): GithubBoundResourcesV1 {
  const document: GithubBoundResourcesV1 = {
    changedPaths: ['src/evaluation/publicationGate.ts'],
    jobs: [
      {
        jobId: 1,
        jobName: 'gates',
        runId: RUN_ID,
        conclusion: 'success',
        steps: [
          { name: 'Install', conclusion: 'success' },
          { name: 'Check', conclusion: 'success' },
        ],
      },
    ],
    run: {
      runId: RUN_ID,
      headSha: COMMIT,
      event: 'pull_request',
      workflowPath: '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: 'success',
    },
  };
  return mutate ? mutate(document) : document;
}

function docsOnlyBoundDocument(): GithubBoundResourcesV1 {
  return {
    changedPaths: ['README.md', 'docs/guide.md'],
    jobs: [
      {
        jobId: 1,
        jobName: 'gates',
        runId: RUN_ID,
        conclusion: 'success',
        steps: [
          { name: 'Docs links', conclusion: 'success' },
          { name: 'Full suite', conclusion: 'skipped' },
        ],
      },
    ],
    run: {
      runId: RUN_ID,
      headSha: COMMIT,
      event: 'pull_request',
      workflowPath: '.github/workflows/ci.yml',
      status: 'completed',
      conclusion: 'success',
    },
  };
}

function githubReceipt(
  document: GithubBoundResourcesV1,
  options?: {
    readonly scopeClassification?: GithubGateReceiptV1['scopeClassification'];
    readonly runId?: number;
    readonly boundResourcesSha256?: string;
    readonly boundResourcesByteLength?: number;
    readonly receiptHash?: string;
  },
): GithubGateReceiptV1 {
  const body: Omit<GithubGateReceiptV1, 'receiptHash'> = {
    schema: 'hercules-github-gate-receipt/v1',
    repository: 'example-org/acme',
    workflowPath: '.github/workflows/ci.yml',
    event: 'pull_request',
    scopeClassification: options?.scopeClassification ?? 'full',
    pullRequestNumber: 120,
    headSha: COMMIT,
    runId: options?.runId ?? RUN_ID,
    runUrl: 'https://github.com/example-org/acme/actions/runs/42001',
    conclusion: 'success',
    boundResourcesPath: 'artifacts/github-bound-resources.json',
    boundResourcesSha256:
      options?.boundResourcesSha256 ?? computeGithubBoundResourcesSha256(document),
    boundResourcesByteLength:
      options?.boundResourcesByteLength ??
      computeGithubBoundResourcesByteLength(document),
    observedAt: OBSERVED_AT,
  };
  const receiptHash =
    options?.receiptHash ?? computeGithubGateReceiptHash(body);
  return { ...body, receiptHash };
}

describe('validateHostFullGateReceipt', () => {
  it('accepts a happy-path host full-gate receipt bound to the log observation', () => {
    const receipt = hostReceipt();
    const result = validateHostFullGateReceipt(receipt, COMMIT, hostLogObservation());
    expect(result).toEqual({ valid: true, reason: null });
  });

  it('rejects a log digest mismatch against the observation', () => {
    const receipt = hostReceipt();
    const result = validateHostFullGateReceipt(
      receipt,
      COMMIT,
      hostLogObservation({ sha256: WRONG_SHA }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/log digest\/byteLength/);
  });

  it('rejects counts that do not equal the main vitest summary', () => {
    const receipt = hostReceipt();
    const result = validateHostFullGateReceipt(
      receipt,
      COMMIT,
      hostLogObservation({
        mainSummary: {
          testFilesPassed: 10,
          testsPassed: 999,
          testsSkipped: 2,
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mainSummary \(not the SPA-smoke summary\)/);
  });

  it('rejects worktree heads / candidateCommit unequal to the supplied candidate', () => {
    const receipt = hostReceipt();
    const result = validateHostFullGateReceipt(receipt, OTHER_COMMIT, hostLogObservation());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/must equal the supplied candidate/);
  });

  it('rejects spaSmokePassed when spaSmokeAllPassed observation is false', () => {
    const receipt = hostReceipt();
    const result = validateHostFullGateReceipt(
      receipt,
      COMMIT,
      hostLogObservation({ spaSmokeAllPassed: false }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/spaSmokePassed requires spaSmokeAllPassed/);
  });

  it('rejects a structurally dirty statusCleanBefore via type assertion', () => {
    const dirty = {
      ...hostReceiptBody(),
      statusCleanBefore: false,
      receiptHash: BOGUS_RECEIPT_HASH,
    } as unknown as HostFullGateReceiptV1;
    const result = validateHostFullGateReceipt(dirty, COMMIT, hostLogObservation());
    expect(result.valid).toBe(false);
    expect(result.reason).not.toBeNull();
  });

  it('rejects a wrong receiptHash', () => {
    const receipt = hostReceipt(BOGUS_RECEIPT_HASH);
    const result = validateHostFullGateReceipt(receipt, COMMIT, hostLogObservation());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/receipt hash does not match/);
  });
});

describe('validateGithubGateReceipt', () => {
  it('accepts a happy full-scope github gate receipt and bound document', () => {
    const document = fullBoundDocument();
    const receipt = githubReceipt(document, { scopeClassification: 'full' });
    const result = validateGithubGateReceipt(receipt, COMMIT, false, document);
    expect(result).toEqual({ valid: true, reason: null });
  });

  it('accepts an honest docs-only candidate with docs_only scope and docs paths', () => {
    const document = docsOnlyBoundDocument();
    const receipt = githubReceipt(document, { scopeClassification: 'docs_only' });
    const result = validateGithubGateReceipt(receipt, COMMIT, true, document);
    expect(result).toEqual({ valid: true, reason: null });
  });

  it('rejects docs-only candidate minted with full scopeClassification', () => {
    const document = fullBoundDocument();
    const receipt = githubReceipt(document, { scopeClassification: 'full' });
    const result = validateGithubGateReceipt(receipt, COMMIT, true, document);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(
      /docs-only candidate requires github gate scopeClassification 'docs_only'/,
    );
  });

  it('rejects full scope when the gates job lists skipped steps', () => {
    const document = fullBoundDocument((base) => ({
      ...base,
      jobs: [
        {
          jobId: 1,
          jobName: 'gates',
          runId: RUN_ID,
          conclusion: 'success',
          steps: [
            { name: 'Install', conclusion: 'success' },
            { name: 'Check', conclusion: 'skipped' },
          ],
        },
      ],
    }));
    const receipt = githubReceipt(document, { scopeClassification: 'full' });
    const result = validateGithubGateReceipt(receipt, COMMIT, false, document);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/forbids skipped steps/);
  });

  it('rejects a boundResourcesSha256 digest mismatch', () => {
    const document = fullBoundDocument();
    const receipt = githubReceipt(document, {
      scopeClassification: 'full',
      boundResourcesSha256: WRONG_SHA,
    });
    const result = validateGithubGateReceipt(receipt, COMMIT, false, document);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/boundResourcesSha256/);
  });

  it('rejects a run-identity mismatch between document.run.runId and receipt.runId', () => {
    const document = fullBoundDocument((base) => ({
      ...base,
      run: {
        ...base.run,
        runId: RUN_ID + 1,
      },
    }));
    const receipt = githubReceipt(document, {
      scopeClassification: 'full',
      runId: RUN_ID,
      boundResourcesSha256: computeGithubBoundResourcesSha256(document),
      boundResourcesByteLength: computeGithubBoundResourcesByteLength(document),
    });
    const result = validateGithubGateReceipt(receipt, COMMIT, false, document);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/run\.runId must equal receipt\.runId/);
  });
});
