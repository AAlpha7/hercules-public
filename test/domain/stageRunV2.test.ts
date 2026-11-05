import { describe, expect, it } from 'vitest';
import {
  appendStageAttempt,
  canTransitionStageRun,
  transitionStageRun,
  type StageRun,
} from '../../src/domain/stageRun.js';
import { V2InvariantError } from '../../src/domain/v2Invariant.js';

function stage(attempt: number, overrides: Partial<StageRun> = {}): StageRun {
  const state = overrides.state ?? 'queued';
  return {
    id: `verify-${attempt}`,
    iterationId: 'iteration-1',
    type: 'verify',
    attempt,
    state: 'queued',
    jobSpecHash: `job-${attempt}`,
    workerId:
      state === 'leased' ||
      state === 'running' ||
      state === 'succeeded' ||
      state === 'failed'
        ? 'worker-1'
        : null,
    agentRunIds: [],
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    structuredResult: null,
    startedAt: null,
    endedAt: null,
    failureClass: null,
    ...overrides,
  };
}

describe('V2 stage-run transitions', () => {
  it('preserves each input record while advancing through a valid attempt', () => {
    const queued = stage(1);
    const leased = transitionStageRun(
      queued,
      'leased',
      { startedAt: null, endedAt: null },
      null,
      'worker-1',
    );
    const running = transitionStageRun(
      leased,
      'running',
      { startedAt: 'start', endedAt: null },
      null,
    );
    const failed = transitionStageRun(
      running,
      'failed',
      { startedAt: 'start', endedAt: 'end' },
      'verification_environment',
    );

    expect(queued.state).toBe('queued');
    expect(leased.state).toBe('leased');
    expect(running.state).toBe('running');
    expect(failed).toMatchObject({ state: 'failed', failureClass: 'verification_environment' });
  });

  it('rejects illegal jumps and incomplete timing/failure facts', () => {
    expect(() =>
      transitionStageRun(
        stage(1),
        'succeeded',
        { startedAt: 'start', endedAt: 'end' },
        null,
      ),
    ).toThrow(V2InvariantError);
    expect(() =>
      transitionStageRun(
        stage(1, { state: 'leased' }),
        'running',
        { startedAt: null, endedAt: null },
        null,
      ),
    ).toThrow('requires startedAt');
    expect(() =>
      transitionStageRun(
        stage(1, { state: 'running', startedAt: 'start' }),
        'failed',
        { startedAt: 'start', endedAt: 'end' },
        null,
      ),
    ).toThrow('requires failureClass');
    expect(() =>
      transitionStageRun(
        stage(1, { state: 'leased' }),
        'running',
        { startedAt: '', endedAt: null },
        null,
      ),
    ).toThrow('timestamps must be null or non-empty strings');
    expect(() =>
      transitionStageRun(
        stage(1, { state: 'running', startedAt: 'start' }),
        'succeeded',
        { startedAt: 'start', endedAt: '' },
        null,
      ),
    ).toThrow('timestamps must be null or non-empty strings');
  });

  it('rejects rewriting terminal facts or the start of a running attempt', () => {
    const failed = stage(1, {
      state: 'failed',
      startedAt: 'start',
      endedAt: 'end',
      failureClass: 'verification_environment',
    });
    expect(
      transitionStageRun(
        failed,
        'failed',
        { startedAt: 'start', endedAt: 'end' },
        'verification_environment',
      ),
    ).toBe(failed);
    expect(() =>
      transitionStageRun(
        failed,
        'failed',
        { startedAt: 'changed', endedAt: 'changed' },
        'verification_flake',
      ),
    ).toThrow('cannot rewrite timing or failure facts');
    expect(() =>
      transitionStageRun(
        stage(1, { state: 'running', startedAt: 'start' }),
        'succeeded',
        { startedAt: 'changed', endedAt: 'end' },
        null,
      ),
    ).toThrow('cannot rewrite the running stage startedAt');
  });

  it('rejects an idempotent transition from a forged unstarted state', () => {
    expect(() =>
      transitionStageRun(
        stage(1, { startedAt: 'forged' }),
        'queued',
        { startedAt: 'forged', endedAt: null },
        null,
      ),
    ).toThrow('source stage record is invalid: queued stage cannot have startedAt');
  });

  it.each([
    ['empty id', { id: '' }],
    ['empty iterationId', { iterationId: '' }],
    ['empty jobSpecHash', { jobSpecHash: '' }],
    ['zero attempt', { attempt: 0 }],
  ] as const)('rejects a transition from a source with %s', (_case, overrides) => {
    const forged = stage(1, overrides);
    expect(() =>
      transitionStageRun(forged, 'leased', { startedAt: null, endedAt: null }, null),
    ).toThrow('source stage record is invalid');
  });

  it('rejects unknown runtime state, stage type, and failure taxonomy', () => {
    const unknownState = stage(1, { state: 'unknown' as StageRun['state'] });
    const unknownType = stage(1, { type: 'unknown' as StageRun['type'] });
    const unknownFailure = stage(1, {
      state: 'failed',
      startedAt: 'start',
      endedAt: 'end',
      failureClass: 'unknown' as StageRun['failureClass'],
    });

    expect(() =>
      transitionStageRun(unknownState, 'leased', { startedAt: null, endedAt: null }, null),
    ).toThrow(V2InvariantError);
    expect(() =>
      transitionStageRun(unknownType, 'leased', { startedAt: null, endedAt: null }, null),
    ).toThrow(V2InvariantError);
    expect(() =>
      transitionStageRun(
        unknownFailure,
        'failed',
        { startedAt: 'start', endedAt: 'end' },
        unknownFailure.failureClass,
      ),
    ).toThrow('closed failure taxonomy');
    expect(
      canTransitionStageRun(
        'unknown' as StageRun['state'],
        'unknown' as StageRun['state'],
      ),
    ).toBe(false);
    expect(() =>
      transitionStageRun(
        stage(1, { state: 'running', startedAt: 'start' }),
        'failed',
        { startedAt: 'start', endedAt: 'end' },
        'unknown' as StageRun['failureClass'],
      ),
    ).toThrow('closed failure taxonomy');
  });

  it('rejects decoded null transition inputs with a typed error', () => {
    expect(() =>
      transitionStageRun(
        null as unknown as StageRun,
        'leased',
        { startedAt: null, endedAt: null },
        null,
      ),
    ).toThrow(V2InvariantError);
    expect(() =>
      transitionStageRun(
        stage(1),
        'leased',
        null as unknown as {
          readonly startedAt: string | null;
          readonly endedAt: string | null;
        },
        null,
      ),
    ).toThrow(V2InvariantError);
    expect(() =>
      transitionStageRun(
        stage(1),
        'leased',
        { startedAt: null, endedAt: null },
        null,
        'worker-1',
        null as unknown as {
          readonly agentRunIds: readonly string[];
          readonly outputArtifactRefs: readonly string[];
          readonly structuredResult: unknown;
        },
      ),
    ).toThrow(V2InvariantError);
  });

  it('requires a worker identity when a queued stage is leased', () => {
    expect(() =>
      transitionStageRun(
        stage(1),
        'leased',
        { startedAt: null, endedAt: null },
        null,
        null,
      ),
    ).toThrow('leased stage requires worker identity');
  });

  it('introduces output and structured results only on a terminal transition', () => {
    const running = stage(1, {
      state: 'running',
      startedAt: 'start',
      agentRunIds: ['agent-1'],
    });
    expect(() =>
      transitionStageRun(
        { ...running, outputArtifactRefs: ['forged'], structuredResult: { forged: true } },
        'succeeded',
        { startedAt: 'start', endedAt: 'end' },
        null,
      ),
    ).toThrow('source stage record is invalid');

    const succeeded = transitionStageRun(
      running,
      'succeeded',
      { startedAt: 'start', endedAt: 'end' },
      null,
      'worker-1',
      {
        agentRunIds: ['agent-1'],
        outputArtifactRefs: ['artifact-1'],
        structuredResult: { outcome: 'verified' },
      },
    );
    expect(succeeded).toMatchObject({
      state: 'succeeded',
      outputArtifactRefs: ['artifact-1'],
      structuredResult: { outcome: 'verified' },
    });
  });

  it('rejects duplicate execution identities', () => {
    expect(() =>
      transitionStageRun(
        stage(1, { state: 'leased' }),
        'running',
        { startedAt: 'start', endedAt: null },
        null,
        'worker-1',
        {
          agentRunIds: ['agent-1', 'agent-1'],
          outputArtifactRefs: [],
          structuredResult: null,
        },
      ),
    ).toThrow('execution references must be unique');
  });

  it('rejects cancelled provenance that no legal transition can produce', () => {
    const forgedWithoutWorker = stage(1, {
      state: 'cancelled',
      startedAt: 'start',
      endedAt: 'end',
      agentRunIds: ['agent-1'],
      outputArtifactRefs: ['artifact-1'],
      structuredResult: { outcome: 'forged' },
    });
    expect(() =>
      transitionStageRun(
        forgedWithoutWorker,
        'cancelled',
        { startedAt: 'start', endedAt: 'end' },
        null,
        null,
        {
          agentRunIds: ['agent-1'],
          outputArtifactRefs: ['artifact-1'],
          structuredResult: forgedWithoutWorker.structuredResult,
        },
      ),
    ).toThrow('cancelled stage without a worker cannot carry start, execution, or result facts');

    const forgedUnstarted = stage(1, {
      state: 'cancelled',
      workerId: 'worker-1',
      endedAt: 'end',
      agentRunIds: ['agent-1'],
    });
    expect(() =>
      transitionStageRun(
        forgedUnstarted,
        'cancelled',
        { startedAt: null, endedAt: 'end' },
        null,
        'worker-1',
        {
          agentRunIds: ['agent-1'],
          outputArtifactRefs: [],
          structuredResult: null,
        },
      ),
    ).toThrow('cancelled unstarted stage cannot carry execution or result facts');
  });

  it('preserves the distinct queued, leased, and running cancellation shapes', () => {
    expect(
      transitionStageRun(
        stage(1),
        'cancelled',
        { startedAt: null, endedAt: 'end' },
        null,
      ),
    ).toMatchObject({ state: 'cancelled', workerId: null, startedAt: null });

    const leased = stage(1, { state: 'leased' });
    expect(
      transitionStageRun(
        leased,
        'cancelled',
        { startedAt: null, endedAt: 'end' },
        null,
      ),
    ).toMatchObject({ state: 'cancelled', workerId: 'worker-1', startedAt: null });

    const running = stage(1, {
      state: 'running',
      startedAt: 'start',
      agentRunIds: ['agent-1'],
    });
    expect(
      transitionStageRun(
        running,
        'cancelled',
        { startedAt: 'start', endedAt: 'end' },
        null,
        'worker-1',
        {
          agentRunIds: ['agent-1'],
          outputArtifactRefs: ['partial-artifact'],
          structuredResult: { outcome: 'cancelled' },
        },
      ),
    ).toMatchObject({
      state: 'cancelled',
      workerId: 'worker-1',
      startedAt: 'start',
      outputArtifactRefs: ['partial-artifact'],
    });
  });
});

describe('V2 stage-attempt history', () => {
  it('appends the next attempt after failure without overwriting the first', () => {
    const failed = stage(1, {
      state: 'failed',
      startedAt: 'start',
      endedAt: 'end',
      failureClass: 'verification_flake',
    });
    const history = [failed] as const;
    const result = appendStageAttempt(history, stage(2));

    expect(result).toEqual([failed, stage(2)]);
    expect(history).toEqual([failed]);
  });

  it('rejects attempt overwrite, gaps, and retry after success', () => {
    const failed = stage(1, {
      state: 'failed',
      startedAt: 'start',
      endedAt: 'end',
      failureClass: 'verification_flake',
    });
    expect(() => appendStageAttempt([failed], stage(1, { id: 'other-id' }))).toThrow(
      'already exists',
    );
    expect(() => appendStageAttempt([failed], stage(3))).toThrow('advance exactly to 2');
    expect(() =>
      appendStageAttempt(
        [stage(1, { state: 'succeeded', startedAt: 'start', endedAt: 'end' })],
        stage(2),
      ),
    ).toThrow('failed or cancelled');
  });

  it('tracks attempts independently by iteration and stage type', () => {
    const recon = stage(1, { id: 'recon-1', type: 'recon' });
    const otherIteration = stage(1, { id: 'verify-other', iterationId: 'iteration-2' });
    expect(appendStageAttempt([recon, otherIteration], stage(1))).toHaveLength(3);
  });

  it('rejects a malformed existing attempt chain before appending', () => {
    const failed = stage(1, {
      state: 'failed',
      startedAt: 'start',
      endedAt: 'end',
      failureClass: 'verification_flake',
    });
    const duplicate = stage(1, {
      id: 'verify-duplicate-attempt',
      state: 'failed',
      startedAt: 'start-2',
      endedAt: 'end-2',
      failureClass: 'verification_environment',
    });
    expect(() => appendStageAttempt([failed, duplicate], stage(3))).toThrow(
      'contiguous at attempt 2',
    );
  });

  it.each(['queued', 'leased'] as const)(
    'rejects a forged %s record with startedAt in existing history',
    (state) => {
      const forged = stage(1, {
        id: `${state}-forged`,
        type: 'recon',
        state,
        startedAt: 'forged',
      });
      expect(() => appendStageAttempt([forged], stage(1))).toThrow(
        `${state} stage cannot have startedAt`,
      );
    },
  );

  it('rejects decoded append records with invalid stage type or scalar identity', () => {
    const bogusType = stage(1, { type: 'bogus' as StageRun['type'] });
    const numericId = stage(1, { id: 42 as unknown as string });

    expect(() => appendStageAttempt([], bogusType)).toThrow(V2InvariantError);
    expect(() => appendStageAttempt([], numericId)).toThrow(V2InvariantError);
  });

  it('rejects decoded null records and non-array histories with a typed error', () => {
    expect(() =>
      appendStageAttempt(null as unknown as readonly StageRun[], stage(1)),
    ).toThrow(V2InvariantError);
    expect(() => appendStageAttempt([], null as unknown as StageRun)).toThrow(
      V2InvariantError,
    );
  });

  it('rejects an unstarted attempt carrying future worker or result facts', () => {
    expect(() =>
      appendStageAttempt(
        [],
        stage(1, {
          workerId: 'worker-1',
          agentRunIds: ['agent-1'],
          outputArtifactRefs: ['artifact-1'],
          structuredResult: { outcome: 'forged' },
        }),
      ),
    ).toThrow('queued stage cannot carry worker identity');
  });

  it('rejects unreachable cancelled provenance in existing history', () => {
    expect(() =>
      appendStageAttempt(
        [
          stage(1, {
            state: 'cancelled',
            startedAt: 'start',
            endedAt: 'end',
            agentRunIds: ['agent-1'],
            outputArtifactRefs: ['artifact-1'],
            structuredResult: { outcome: 'forged' },
          }),
        ],
        stage(2),
      ),
    ).toThrow('cancelled stage without a worker cannot carry start, execution, or result facts');
  });
});
