/**
 * Domain — merge long-running operation receipts (pure).
 */
import { describe, it, expect } from 'vitest';
import {
  MERGE_OPERATION_STATUSES,
  MERGE_OPERATION_PHASES,
  canTransitionMergeOperationStatus,
  classifyMergeFailureReason,
  isMergeOperationTerminal,
  isPublicMergeSuccess,
  makeMergeOperationId,
  normalizeMergeIdempotencyKey,
  parseMergeIdempotencyKeyInput,
  publicMergeStatus,
  redactMergeFailureReason,
  safePublicMergeReceipt,
  sameOrderedTaskIds,
  type MergeOperationRecord,
} from '../../src/domain/mergeOperation.js';

describe('mergeOperation domain', () => {
  it('validates idempotency keys fail-closed', () => {
    expect(normalizeMergeIdempotencyKey('abc-123')).toBe('abc-123');
    expect(normalizeMergeIdempotencyKey('a'.repeat(129))).toBeNull();
    expect(normalizeMergeIdempotencyKey('../x')).toBeNull();
    expect(normalizeMergeIdempotencyKey('')).toBeNull();
    expect(parseMergeIdempotencyKeyInput(undefined)).toEqual({
      status: 'absent',
      key: null,
    });
    expect(parseMergeIdempotencyKeyInput('ok-key').status).toBe('ok');
    expect(parseMergeIdempotencyKeyInput('').status).toBe('invalid');
    expect(parseMergeIdempotencyKeyInput(12).status).toBe('invalid');
  });

  it('builds safe operation ids', () => {
    const id = makeMergeOperationId(1_700_000_000_000, 42, 'deadbeef');
    expect(id).toMatch(/^mop-[a-z0-9]+-42-deadbeef$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it('maps phases to public status and terminal flags', () => {
    expect(MERGE_OPERATION_STATUSES).toEqual([
      'accepted', 'running', 'succeeded', 'failed', 'interrupted',
    ]);
    expect(MERGE_OPERATION_PHASES).toContain('pushed');
    expect(MERGE_OPERATION_PHASES).toContain('stamped');
    expect(publicMergeStatus('accepted')).toBe('accepted');
    expect(publicMergeStatus('precheck')).toBe('running');
    expect(publicMergeStatus('gating')).toBe('running');
    expect(publicMergeStatus('pushing')).toBe('running');
    expect(publicMergeStatus('pushed')).toBe('running');
    expect(publicMergeStatus('stamping')).toBe('running');
    expect(publicMergeStatus('stamped')).toBe('running');
    expect(publicMergeStatus('succeeded')).toBe('succeeded');
    expect(publicMergeStatus('failed')).toBe('failed');
    expect(publicMergeStatus('interrupted')).toBe('interrupted');

    expect(isMergeOperationTerminal('succeeded')).toBe(true);
    expect(isMergeOperationTerminal('failed')).toBe(true);
    expect(isMergeOperationTerminal('interrupted')).toBe(true);
    expect(isMergeOperationTerminal('running')).toBe(false);
    expect(isMergeOperationTerminal('accepted')).toBe(false);
    expect(canTransitionMergeOperationStatus('accepted', 'running')).toBe(true);
    expect(canTransitionMergeOperationStatus('running', 'succeeded')).toBe(true);
    expect(canTransitionMergeOperationStatus('succeeded', 'running')).toBe(false);
  });

  it('exposes success only after push+stamp provenance is confirmed', () => {
    const base: MergeOperationRecord = {
      version: 1,
      operationId: 'mop-a-0-b',
      repoKey: 'app',
      taskIds: ['T-1'],
      idempotencyKey: null,
      status: 'running',
      phase: 'pushing',
      mergedSha: null,
      failures: [],
      createdAtMs: 1,
      updatedAtMs: 2,
      gateProgress: null,
      failureKind: null,
      ownerPid: 1,
    };
    expect(isPublicMergeSuccess(base)).toBe(false);
    expect(
      isPublicMergeSuccess({
        ...base,
        status: 'succeeded',
        phase: 'stamped',
        mergedSha: 'a'.repeat(40),
      }),
    ).toBe(true);
    expect(
      isPublicMergeSuccess({
        ...base,
        status: 'succeeded',
        phase: 'accepted',
        mergedSha: 'a'.repeat(40),
      }),
    ).toBe(false);
    expect(
      isPublicMergeSuccess({
        ...base,
        status: 'succeeded',
        mergedSha: null,
      }),
    ).toBe(false);
    expect(
      isPublicMergeSuccess({
        ...base,
        status: 'succeeded',
        mergedSha: 'not-a-commit',
      }),
    ).toBe(false);
    expect(() =>
      safePublicMergeReceipt({
        ...base,
        status: 'succeeded',
        phase: 'stamped',
        mergedSha: 'not-a-commit',
      }),
    ).toThrow(/invalid succeeded merge receipt/);
    expect(() =>
      safePublicMergeReceipt({
        ...base,
        status: 'succeeded',
        phase: 'accepted',
        mergedSha: 'a'.repeat(40),
      }),
    ).toThrow(/invalid succeeded merge receipt/);
  });

  it('classifies bounded failure kinds', () => {
    expect(
      classifyMergeFailureReason(
        'post-merge L1 gates failed — origin main not pushed',
      ),
    ).toBe('gate_failure');
    expect(classifyMergeFailureReason('merge conflict on path')).toBe('conflict');
    expect(classifyMergeFailureReason('non-force push failed')).toBe('push_failure');
    expect(classifyMergeFailureReason('failed to stamp merged_sha')).toBe(
      'stamp_failure',
    );
    expect(classifyMergeFailureReason('verified-SHA mismatch: tip moved')).toBe(
      'precheck',
    );
    expect(
      classifyMergeFailureReason("merge already in flight for repo 'app'"),
    ).toBe('single_flight');
    expect(classifyMergeFailureReason('daemon restart interrupted merge')).toBe(
      'interrupted',
    );
  });

  it('redacts paths, long command output, and secret-like values', () => {
    const raw =
      'post-merge L1 gates failed — /home/ubuntu/secret-work/app/tmp failed: ' +
      'token=supersecret bearer abc.def.ghi ' +
      'x'.repeat(400);
    const redacted = redactMergeFailureReason(raw);
    expect(redacted).not.toMatch(/\/home\/ubuntu/);
    expect(redacted).not.toMatch(/supersecret/);
    expect(redacted).not.toContain('x'.repeat(20));
    expect(redacted.length).toBeLessThanOrEqual(280);
    expect(redacted).toBe('post-merge gates failed');
  });

  it('compares ordered task selections exactly', () => {
    expect(sameOrderedTaskIds(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrderedTaskIds(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrderedTaskIds(['a'], ['a', 'b'])).toBe(false);
  });
});
