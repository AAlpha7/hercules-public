import { describe, it, expect } from 'vitest';
import {
  createVerificationCancelReason,
  isForceVerificationCancel,
  redactVerificationStage,
  toVerificationRunMeta,
  isVerificationAborted,
  VerificationAbortedError,
  throwIfVerificationAborted,
  VERIFICATION_STAGE_MAX_LEN,
} from '../../src/domain/verificationRun.js';

describe('redactVerificationStage', () => {
  it('keeps short gate names', () => {
    expect(redactVerificationStage('typecheck')).toBe('typecheck');
    expect(redactVerificationStage('held-out-smoke')).toBe('held-out-smoke');
  });

  it('redacts token-like labels and long command dumps', () => {
    expect(redactVerificationStage('Bearer sk-secret-abc')).toBe('redacted');
    expect(redactVerificationStage('HERCULES_TOKEN=demo pnpm test')).toBe('redacted');
    expect(redactVerificationStage('--api-key=xyz')).toBe('redacted');
    const long = 'x'.repeat(VERIFICATION_STAGE_MAX_LEN + 20);
    expect(redactVerificationStage(long).length).toBe(VERIFICATION_STAGE_MAX_LEN);
  });
});

describe('toVerificationRunMeta', () => {
  it('builds bounded public meta without leaking stage secrets', () => {
    const meta = toVerificationRunMeta({
      taskId: 'T-1',
      phase: 'l1',
      stage: 'test',
      startedAtMs: 1_000,
      nowMs: 6_000,
      processAlive: true,
      cancelRequested: false,
      lastCompletedStage: 'lint',
    });
    expect(meta).toEqual({
      taskId: 'T-1',
      phase: 'l1',
      stage: 'test',
      startedAt: new Date(1_000).toISOString(),
      elapsedMs: 5_000,
      processAlive: true,
      cancelRequested: false,
      lastCompletedStage: 'lint',
    });
  });
});

describe('VerificationCancelReason force flag', () => {
  it('starts soft and escalates when force flips', () => {
    const reason = createVerificationCancelReason(false);
    expect(isForceVerificationCancel(reason)).toBe(false);
    reason.force = true;
    expect(isForceVerificationCancel(reason)).toBe(true);
    expect(isForceVerificationCancel(undefined)).toBe(false);
  });
});

describe('VerificationAbortedError', () => {
  it('is recognized by isVerificationAborted', () => {
    expect(isVerificationAborted(new VerificationAbortedError())).toBe(true);
    expect(isVerificationAborted(new Error('other'))).toBe(false);
  });

  it('recognizes AbortError (Error and DOMException) as verification abort', () => {
    // fetch / AbortSignal often surface DOMException { name: 'AbortError' }.
    // Must not return false just because a `name` property exists.
    const domAbort = new DOMException('The operation was aborted.', 'AbortError');
    expect(domAbort.name).toBe('AbortError');
    expect(isVerificationAborted(domAbort)).toBe(true);

    const errAbort = new Error('aborted');
    errAbort.name = 'AbortError';
    expect(isVerificationAborted(errAbort)).toBe(true);

    // Cross-realm / structured clone: name only, not instanceof.
    expect(
      isVerificationAborted({ name: 'AbortError', message: 'aborted' }),
    ).toBe(true);
    expect(
      isVerificationAborted({ name: 'VerificationAbortedError', code: 'verification_aborted' }),
    ).toBe(true);

    // Ordinary named errors stay non-abort.
    expect(isVerificationAborted({ name: 'TypeError', message: 'x' })).toBe(false);
    expect(isVerificationAborted({ name: 'Error' })).toBe(false);
  });

  it('throwIfVerificationAborted only when aborted', () => {
    const ac = new AbortController();
    expect(() => throwIfVerificationAborted(ac.signal)).not.toThrow();
    ac.abort();
    expect(() => throwIfVerificationAborted(ac.signal)).toThrow(VerificationAbortedError);
  });

  it('preserves force-abort in the thrown error', () => {
    const ac = new AbortController();
    const reason = createVerificationCancelReason(true);
    ac.abort(reason);
    try {
      throwIfVerificationAborted(ac.signal);
      throw new Error('expected abort');
    } catch (err) {
      expect(err).toBeInstanceOf(VerificationAbortedError);
      expect((err as VerificationAbortedError).force).toBe(true);
    }
  });
});
