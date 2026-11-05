import { describe, it, expect } from 'vitest';
import {
  TASK_STATES,
  hasOpenPr,
  isAwaitingMerge,
  isTaskState,
  isTerminalState,
  isValidIdentifier,
  isDeletableState,
} from '../../src/domain/task.js';

describe('task state machine', () => {
  it('enumerates SPEC states plus soft-delete trash', () => {
    expect([...TASK_STATES].sort()).toEqual(
      [
        'cancelled',
        'deleted',
        'done',
        'failed',
        'in_progress',
        'retrying',
        'review',
        'todo',
      ].sort(),
    );
  });

  it('recognizes valid states', () => {
    expect(isTaskState('todo')).toBe(true);
    expect(isTaskState('review')).toBe(true);
    expect(isTaskState('deleted')).toBe(true);
    expect(isTaskState('nonsense')).toBe(false);
    expect(isTaskState('')).toBe(false);
  });

  it('treats done, cancelled, failed and deleted as terminal for scheduling', () => {
    expect(isTerminalState('done')).toBe(true);
    expect(isTerminalState('cancelled')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('deleted')).toBe(true);
  });

  it('treats todo, in_progress, review and retrying as non-terminal', () => {
    expect(isTerminalState('todo')).toBe(false);
    expect(isTerminalState('in_progress')).toBe(false);
    expect(isTerminalState('review')).toBe(false);
    expect(isTerminalState('retrying')).toBe(false);
  });
});

describe('isDeletableState', () => {
  it('blocks deletion of running states', () => {
    expect(isDeletableState('in_progress')).toBe(false);
    expect(isDeletableState('retrying')).toBe(false);
  });
  it('allows deletion of non-running states including trash', () => {
    for (const s of ['todo', 'review', 'done', 'cancelled', 'failed', 'deleted'] as const) {
      expect(isDeletableState(s)).toBe(true);
    }
  });
});

describe('identifier sanitization (SPEC §10)', () => {
  it('accepts [A-Za-z0-9._-]', () => {
    expect(isValidIdentifier('ABC-12')).toBe(true);
    expect(isValidIdentifier('my-app')).toBe(true);
    expect(isValidIdentifier('v1.2_beta')).toBe(true);
  });

  it('rejects path-traversal and shell-dangerous characters', () => {
    expect(isValidIdentifier('../etc')).toBe(false);
    expect(isValidIdentifier('a/b')).toBe(false);
    expect(isValidIdentifier('a b')).toBe(false);
    expect(isValidIdentifier('a;rm -rf')).toBe(false);
    expect(isValidIdentifier('')).toBe(false);
  });
});

describe('hasOpenPr / isAwaitingMerge (phone section honesty)', () => {
  it('hasOpenPr is true for any state with open PR fields', () => {
    expect(
      hasOpenPr({ prStatus: 'open', prUrl: 'https://github.com/o/r/pull/1' }),
    ).toBe(true);
    expect(hasOpenPr({ prStatus: 'merged', prUrl: 'https://github.com/o/r/pull/1' })).toBe(
      false,
    );
    expect(hasOpenPr({ prStatus: 'open', prUrl: null })).toBe(false);
  });

  it('isAwaitingMerge only for done + open PR (not failed salvage)', () => {
    const pr = {
      prStatus: 'open' as const,
      prUrl: 'https://github.com/example-org/acme-app/pull/5',
    };
    // Case study: orbit-repo-readiness-onboarding failed after max attempts but
    // still had PR #5 open — must not appear under 等待合并.
    expect(isAwaitingMerge({ state: 'failed', ...pr })).toBe(false);
    expect(isAwaitingMerge({ state: 'review', ...pr })).toBe(false);
    expect(isAwaitingMerge({ state: 'todo', ...pr })).toBe(false);
    expect(isAwaitingMerge({ state: 'in_progress', ...pr })).toBe(false);
    expect(isAwaitingMerge({ state: 'done', ...pr })).toBe(true);
    expect(
      isAwaitingMerge({ state: 'done', prStatus: 'merged', prUrl: pr.prUrl }),
    ).toBe(false);
  });
});
