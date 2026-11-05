/**
 * Merge-gate failure diagnostic receipts - pure domain (bounded, redacted,
 * restart-parseable, distinct from verification failure).
 */
import { describe, it, expect } from 'vitest';
import {
  MERGE_FAILURE_RECEIPT_HEADING,
  MERGE_FAILURE_SUMMARY_MAX,
  MERGE_FAILURE_RAW_MAX,
  buildMergeGateFailureReceipt,
  formatMergeFailureReceiptMarkdown,
  parseMergeFailureReceipt,
  publicMergeFailureReceipt,
  redactMergeDiagnosticText,
  extractMergeFailureSummary,
  boundMergeDiagnosticExcerpt,
  bodyHasMergeGateFailure,
} from '../../src/domain/mergeFailureReceipt.js';

describe('redactMergeDiagnosticText', () => {
  it('redacts representative credential-shaped values before truncation', () => {
    // Build fixture material at runtime so static scanners do not flag the file.
    const jwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'payload', 'sig'].join('.');
    const ghp = ['ghp', '_', 'testfixtureabcdefghijklmnopqrst'].join('');
    const xai = ['xai', '-', 'testfixtureabcdefghijklmnopqrst'].join('');
    const sk = ['sk', '-', 'proj', '-', 'testfixtureabcdefghijklmnopqrst'].join('');
    const raw =
      'TOKEN=fixture-token-value-not-live\n' +
      `Authorization: Bearer ${jwt}\n` +
      `${ghp}\n` +
      'DATABASE_URL=postgres://user:fixturepass@db.example/app\n' +
      `${xai}\n` +
      `${sk}\n` +
      'API_KEY: fixtureapikeyvalue\n' +
      'HERCULES_TOKEN=fixture-daemon-token-xyz\n' +
      'FAIL: assertion exploded at line 42\n';
    const redacted = redactMergeDiagnosticText(raw);
    expect(redacted).not.toMatch(/fixture-token-value-not-live/);
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain(ghp);
    expect(redacted).not.toMatch(/fixturepass/);
    expect(redacted).not.toContain(xai);
    expect(redacted).not.toContain(sk);
    expect(redacted).not.toMatch(/fixtureapikeyvalue/);
    expect(redacted).not.toMatch(/fixture-daemon-token-xyz/);
    expect(redacted).toMatch(/REDACTED/);
    expect(redacted).toMatch(/FAIL: assertion exploded/);
  });

  it('bounds oversized output with explicit truncation metadata', () => {
    const huge = `${'noise line\n'.repeat(500)}FAIL: the real error at the end\n`;
    const bound = boundMergeDiagnosticExcerpt(huge, 400);
    expect(bound.truncated).toBe(true);
    expect(bound.originalChars).toBeGreaterThan(bound.retainedChars);
    expect(bound.text.length).toBeLessThanOrEqual(400 + 80);
    expect(bound.text).toMatch(/truncated/i);
    expect(bound.text).toMatch(/FAIL: the real error/);
  });
});

describe('extractMergeFailureSummary', () => {
  it('prefers final failure lines over leading noise', () => {
    const out =
      'compiling...\n'.repeat(20) +
      'PASS src/ok.test.ts\n' +
      'FAIL src/bad.test.ts\n' +
      'AssertionError: expected 1 to equal 2\n' +
      '    at Object.<anonymous> (src/bad.test.ts:10:5)\n';
    const summary = extractMergeFailureSummary(out);
    expect(summary).toMatch(/FAIL src\/bad\.test\.ts/);
    expect(summary).toMatch(/AssertionError/);
    expect(summary.length).toBeLessThanOrEqual(MERGE_FAILURE_SUMMARY_MAX);
  });

  it('redacts secrets inside the summary', () => {
    const out = 'FAIL: auth TOKEN=leaked-secret-value refused\n';
    const summary = extractMergeFailureSummary(out);
    expect(summary).not.toMatch(/leaked-secret-value/);
    expect(summary).toMatch(/REDACTED/);
  });
});

describe('buildMergeGateFailureReceipt + format/parse', () => {
  it('builds a durable receipt with gate, exit, no-push, and next action', () => {
    const receipt = buildMergeGateFailureReceipt({
      operationId: 'mf-test-001',
      createdAt: '2026-08-03T12:00:00.000Z',
      repoKey: 'app',
      taskIds: ['T-1', 'T-2'],
      failedGate: 'test',
      exitStatus: 1,
      rawOutput:
        'TOKEN=secret-abc\n' +
        'FAIL src/x.test.ts\n' +
        'Error: boom\n',
    });

    expect(receipt.version).toBe(1);
    expect(receipt.kind).toBe('merge_gate_failure');
    expect(receipt.operationStatus).toBe('merge_gate_failed');
    expect(receipt.failedGate).toBe('test');
    expect(receipt.exitStatus).toBe(1);
    expect(receipt.remoteDefaultBranchChanged).toBe(false);
    expect(receipt.verificationSucceeded).toBe(true);
    expect(receipt.failureSummary).toMatch(/FAIL|Error|boom/i);
    expect(receipt.failureSummary).not.toMatch(/secret-abc/);
    expect(receipt.rawExcerpt).not.toMatch(/secret-abc/);
    expect(receipt.nextAction.length).toBeGreaterThan(10);
    expect(receipt.nextAction).not.toMatch(/\/home\/|HERCULES_TOKEN|pnpm /i);
    expect(receipt.truncation.retainedChars).toBeLessThanOrEqual(MERGE_FAILURE_RAW_MAX + 80);

    const md = formatMergeFailureReceiptMarkdown(receipt);
    expect(md).toContain(MERGE_FAILURE_RECEIPT_HEADING);
    expect(md).toMatch(/\*\*Operation status:\*\* `merge_gate_failed`/);
    expect(md).toMatch(/\*\*Failed gate:\*\* `test`/);
    expect(md).toMatch(/\*\*Exit status:\*\* `1`/);
    expect(md).toMatch(/\*\*Remote default branch changed:\*\* `no`/);
    expect(md).toMatch(/Verification:\*\*.*succeeded/i);
    expect(md).not.toMatch(/secret-abc/);

    const parsed = parseMergeFailureReceipt(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.operationStatus).toBe('merge_gate_failed');
    expect(parsed!.failedGate).toBe('test');
    expect(parsed!.exitStatus).toBe(1);
    expect(parsed!.remoteDefaultBranchChanged).toBe(false);
    expect(parsed!.operationId).toBe('mf-test-001');
    expect(parsed!.failureSummary).toMatch(/FAIL|Error|boom/i);
    expect(bodyHasMergeGateFailure(md)).toBe(true);
  });

  it('public DTO never exposes unbounded raw logs', () => {
    const receipt = buildMergeGateFailureReceipt({
      operationId: 'mf-pub',
      createdAt: '2026-08-03T12:00:00.000Z',
      repoKey: 'app',
      taskIds: ['T-1'],
      failedGate: 'lint',
      exitStatus: 2,
      rawOutput: 'x'.repeat(50_000) + '\nFAIL lint\n',
    });
    const pub = publicMergeFailureReceipt(receipt);
    expect(pub.operationStatus).toBe('merge_gate_failed');
    expect(pub.failedGate).toBe('lint');
    expect(pub.exitStatus).toBe(2);
    expect(pub.remoteDefaultBranchChanged).toBe(false);
    expect(pub.rawExcerpt.length).toBeLessThanOrEqual(MERGE_FAILURE_RAW_MAX + 120);
    expect(pub.truncation.truncated).toBe(true);
    expect(JSON.stringify(pub)).not.toMatch(/\/home\/ubuntu/);
  });

  it('parse returns null when no diagnostic section present', () => {
    expect(parseMergeFailureReceipt('## Task\n\nhello\n')).toBeNull();
    expect(parseMergeFailureReceipt('')).toBeNull();
    expect(bodyHasMergeGateFailure('## Task\n\nhello\n')).toBe(false);
  });
});
