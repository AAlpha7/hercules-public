import { describe, expect, it } from 'vitest';
import {
  appendIteration,
  canTransitionIteration,
  transitionIteration,
  type Iteration,
} from '../../src/domain/iteration.js';
import { V2InvariantError } from '../../src/domain/v2Invariant.js';

function iteration(ordinal: number, overrides: Partial<Iteration> = {}): Iteration {
  return {
    id: `iteration-${ordinal}`,
    taskId: 'task-1',
    contractVersion: 1,
    ordinal,
    state: 'planned',
    candidateRef: null,
    evidenceManifestId: null,
    finalVerdictId: null,
    createdAt: `2026-08-28T00:00:0${ordinal}Z`,
    endedAt: null,
    supersedesIterationId: ordinal === 1 ? null : `iteration-${ordinal - 1}`,
    ...overrides,
  };
}

describe('V2 iteration transitions', () => {
  it('returns new records and leaves the previous state immutable', () => {
    const planned = iteration(1);
    const executing = transitionIteration(planned, 'executing', null);
    const failed = transitionIteration(executing, 'failed', '2026-08-28T00:01:00Z');

    expect(planned.state).toBe('planned');
    expect(executing).toMatchObject({ state: 'executing', endedAt: null });
    expect(failed).toMatchObject({ state: 'failed', endedAt: '2026-08-28T00:01:00Z' });
  });

  it('returns from evaluation to verification when more evidence is required', () => {
    const evaluating = iteration(1, {
      state: 'evaluating',
      candidateRef: { kind: 'git', repository: 'example-org/acme', revision: 'abc123' },
      evidenceManifestId: 'manifest-1',
    });
    const verifying = transitionIteration(evaluating, 'verifying', null);
    expect(verifying).toMatchObject({
      state: 'verifying',
      evidenceManifestId: 'manifest-1',
      endedAt: null,
    });
    const reevaluating = transitionIteration(verifying, 'evaluating', null, {
      candidateRef: evaluating.candidateRef,
      evidenceManifestId: 'manifest-2',
      finalVerdictId: null,
    });
    expect(verifying.evidenceManifestId).toBe('manifest-1');
    expect(reevaluating.evidenceManifestId).toBe('manifest-2');
  });

  it('allows re-verification to fail while retaining the prior evidence manifest', () => {
    const candidateRef = {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: 'abc123',
    };
    const evaluating = iteration(1, {
      state: 'evaluating',
      candidateRef,
      evidenceManifestId: 'manifest-1',
    });
    const verifying = transitionIteration(evaluating, 'verifying', null);
    expect(
      transitionIteration(verifying, 'failed', 'end'),
    ).toMatchObject({
      state: 'failed',
      evidenceManifestId: 'manifest-1',
      finalVerdictId: null,
    });
  });

  it('rejects illegal jumps and inconsistent terminal timestamps', () => {
    expect(() => transitionIteration(iteration(1), 'passed', 'now')).toThrow(
      V2InvariantError,
    );
    expect(() => transitionIteration(iteration(1), 'abandoned', null)).toThrow(
      'requires endedAt',
    );
    expect(() => transitionIteration(iteration(1), 'executing', 'now')).toThrow(
      'cannot have endedAt',
    );
    expect(() =>
      transitionIteration(
        iteration(1, { state: 'executing' }),
        'failed',
        '',
      ),
    ).toThrow('endedAt must be null or a non-empty string');
  });

  it('treats a self-transition as an exact no-op and rejects terminal fact rewrites', () => {
    const failed = iteration(1, { state: 'failed', endedAt: 'original' });
    expect(transitionIteration(failed, 'failed', 'original')).toBe(failed);
    expect(() => transitionIteration(failed, 'failed', 'changed')).toThrow(
      'cannot rewrite timing or lifecycle facts',
    );
  });

  it.each([
    ['planned', 'forged-end'],
    ['failed', null],
  ] as const)('rejects an idempotent transition from forged %s timing', (state, endedAt) => {
    const forged = iteration(1, { state, endedAt });
    expect(() => transitionIteration(forged, state, endedAt)).toThrow(
      'source iteration record is invalid',
    );
  });

  it('rejects a transition from a source with an invalid candidate identity', () => {
    const forged = iteration(1, {
      state: 'verifying',
      candidateRef: { kind: 'git', repository: '', revision: '' },
    });
    expect(() => transitionIteration(forged, 'failed', 'end')).toThrow(
      'candidate git identity fields must be non-empty',
    );
  });

  it('rejects unknown runtime states with a typed invariant error', () => {
    const forged = iteration(1, { state: 'unknown' as Iteration['state'] });
    expect(() => transitionIteration(forged, 'executing', null)).toThrow(V2InvariantError);
    expect(() =>
      transitionIteration(iteration(1), 'unknown' as Iteration['state'], null),
    ).toThrow(V2InvariantError);
    expect(
      canTransitionIteration(
        'unknown' as Iteration['state'],
        'unknown' as Iteration['state'],
      ),
    ).toBe(false);
  });

  it.each([
    ['empty id', { id: '' }],
    ['empty taskId', { taskId: '' }],
    ['zero contractVersion', { contractVersion: 0 }],
    ['zero ordinal', { ordinal: 0 }],
  ] as const)('rejects a transition from a source with %s', (_case, overrides) => {
    const forged = iteration(1, overrides);
    expect(() => transitionIteration(forged, 'executing', null)).toThrow(
      'source iteration record is invalid',
    );
  });

  it('rejects a decoded null transition source with a typed error', () => {
    expect(() =>
      transitionIteration(null as unknown as Iteration, 'executing', null),
    ).toThrow(V2InvariantError);
    expect(() =>
      transitionIteration(
        iteration(1),
        'executing',
        null,
        null as unknown as {
          readonly candidateRef: null;
          readonly evidenceManifestId: null;
          readonly finalVerdictId: null;
        },
      ),
    ).toThrow(V2InvariantError);
  });

  it('requires exact completion facts before an iteration can pass', () => {
    const candidateRef = {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: 'abc123',
    };
    const executing = transitionIteration(iteration(1), 'executing', null);
    const verifying = transitionIteration(executing, 'verifying', null, {
      candidateRef,
      evidenceManifestId: null,
      finalVerdictId: null,
    });
    const evaluating = transitionIteration(verifying, 'evaluating', null, {
      candidateRef,
      evidenceManifestId: 'manifest-1',
      finalVerdictId: null,
    });
    expect(() => transitionIteration(evaluating, 'passed', 'end')).toThrow(
      'requires a final verdict',
    );
    expect(() =>
      transitionIteration(
        evaluating,
        'failed',
        'end',
        {
          candidateRef,
          evidenceManifestId: 'manifest-1',
          finalVerdictId: null,
        },
      ),
    ).toThrow('requires a final verdict');
    expect(
      transitionIteration(evaluating, 'passed', 'end', {
        candidateRef,
        evidenceManifestId: 'manifest-1',
        finalVerdictId: 'verdict-1',
      }),
    ).toMatchObject({ state: 'passed', finalVerdictId: 'verdict-1' });
    expect(
      transitionIteration(evaluating, 'failed', 'end', {
        candidateRef,
        evidenceManifestId: 'manifest-1',
        finalVerdictId: 'verdict-fail-1',
      }),
    ).toMatchObject({ state: 'failed', finalVerdictId: 'verdict-fail-1' });
  });

  it('rejects lifecycle facts injected before their transition edge', () => {
    const candidateRef = {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: 'abc123',
    };
    expect(() =>
      transitionIteration(
        iteration(1, { state: 'executing', candidateRef }),
        'verifying',
        null,
      ),
    ).toThrow('source iteration record is invalid');
    expect(() =>
      transitionIteration(
        iteration(1, {
          state: 'evaluating',
          candidateRef,
          evidenceManifestId: 'manifest-1',
          finalVerdictId: 'forged-verdict',
        }),
        'passed',
        'end',
      ),
    ).toThrow('source iteration record is invalid');
    expect(() =>
      transitionIteration(
        iteration(1, { state: 'verifying', candidateRef }),
        'evaluating',
        null,
        {
          candidateRef: { ...candidateRef, revision: 'replacement' },
          evidenceManifestId: 'manifest-1',
          finalVerdictId: null,
        },
      ),
    ).toThrow('only an executing-to-verifying transition can establish candidate identity');
  });

  it('rejects terminal fact combinations that no legal transition can produce', () => {
    const candidateRef = {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: 'abc123',
    };
    expect(() =>
      transitionIteration(
        iteration(1, {
          state: 'abandoned',
          candidateRef,
          evidenceManifestId: 'manifest-1',
          finalVerdictId: 'forged-verdict',
          endedAt: 'end',
        }),
        'abandoned',
        'end',
      ),
    ).toThrow('abandoned iteration cannot carry a final verdict identity');
  });
});

describe('V2 iteration history', () => {
  it('appends a retry only after a failed attempt and preserves the failed record', () => {
    const failed = iteration(1, { state: 'failed', endedAt: 'now' });
    const history = [failed] as const;
    const result = appendIteration(history, iteration(2));

    expect(result).toEqual([failed, iteration(2)]);
    expect(history).toEqual([failed]);
  });

  it('rejects duplicate identities, ordinal overwrite, gaps, and wrong supersession', () => {
    const failed = iteration(1, { state: 'failed', endedAt: 'now' });
    expect(() => appendIteration([failed], iteration(1))).toThrow('already exists');
    expect(() => appendIteration([failed], iteration(3))).toThrow('advance exactly to 2');
    expect(() =>
      appendIteration([failed], iteration(2, { supersedesIterationId: null })),
    ).toThrow('must supersede iteration-1');
  });

  it('rejects retrying a passed or still-active attempt', () => {
    expect(() => appendIteration([iteration(1)], iteration(2))).toThrow(
      'only a failed iteration',
    );
    expect(() =>
      appendIteration(
        [
          iteration(1, {
            state: 'passed',
            candidateRef: {
              kind: 'git',
              repository: 'example-org/acme',
              revision: 'abc123',
            },
            evidenceManifestId: 'manifest-1',
            finalVerdictId: 'verdict-1',
            endedAt: 'now',
          }),
        ],
        iteration(2),
      ),
    ).toThrow('only a failed iteration');
  });

  it('rejects retrying an abandoned attempt', () => {
    expect(() =>
      appendIteration(
        [iteration(1, { state: 'abandoned', endedAt: 'now' })],
        iteration(2),
      ),
    ).toThrow('only a failed iteration can be superseded');
  });

  it('allows a newer contract version but never a version rollback', () => {
    const failed = iteration(1, { contractVersion: 2, state: 'failed', endedAt: 'now' });
    expect(appendIteration([failed], iteration(2, { contractVersion: 3 }))).toHaveLength(2);
    expect(() => appendIteration([failed], iteration(2, { contractVersion: 1 }))).toThrow(
      'cannot move backwards',
    );
  });

  it('rejects invalid contract versions and malformed existing ordinal chains', () => {
    expect(() => appendIteration([], iteration(1, { contractVersion: 0 }))).toThrow(
      'contractVersion',
    );
    const malformed = [
      iteration(1, { state: 'failed', endedAt: 'one' }),
      iteration(1, {
        id: 'iteration-duplicate-ordinal',
        state: 'failed',
        endedAt: 'two',
        supersedesIterationId: 'iteration-1',
      }),
    ];
    expect(() => appendIteration(malformed, iteration(3))).toThrow(
      'contiguous at ordinal 2',
    );
  });

  it('rejects decoded append records with invalid scalar or candidate identity', () => {
    const numericId = iteration(1, { id: 42 as unknown as string });
    const bogusCandidate = iteration(1, {
      candidateRef: { kind: 'bogus' } as unknown as Iteration['candidateRef'],
    });

    expect(() => appendIteration([], numericId)).toThrow(V2InvariantError);
    expect(() => appendIteration([], bogusCandidate)).toThrow(V2InvariantError);
  });

  it('rejects decoded null records and non-array histories with a typed error', () => {
    expect(() =>
      appendIteration(null as unknown as readonly Iteration[], iteration(1)),
    ).toThrow(V2InvariantError);
    expect(() => appendIteration([], null as unknown as Iteration)).toThrow(
      V2InvariantError,
    );
  });

  it('rejects a new planned iteration carrying future completion facts', () => {
    expect(() =>
      appendIteration(
        [],
        iteration(1, {
          candidateRef: {
            kind: 'git',
            repository: 'example-org/acme',
            revision: 'abc123',
          },
          evidenceManifestId: 'manifest-1',
          finalVerdictId: 'verdict-1',
        }),
      ),
    ).toThrow('planned iteration cannot carry future');
  });

  it('rejects unreachable terminal facts in existing history', () => {
    const candidateRef = {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: 'abc123',
    };
    expect(() =>
      appendIteration(
        [
          iteration(1, {
            state: 'abandoned',
            candidateRef,
            evidenceManifestId: 'manifest-1',
            finalVerdictId: 'forged-verdict',
            endedAt: 'end',
          }),
        ],
        iteration(2),
      ),
    ).toThrow('abandoned iteration cannot carry a final verdict identity');
  });
});
