import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition, TransitionError } from '../../src/domain/stateMachine.js';

describe('canTransition (SPEC §5)', () => {
  it('allows the happy path todo → in_progress → review → done', () => {
    expect(canTransition('todo', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'review')).toBe(true);
    expect(canTransition('review', 'done')).toBe(true);
  });

  it('allows the failure/retry edges', () => {
    expect(canTransition('in_progress', 'retrying')).toBe(true);
    expect(canTransition('retrying', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'failed')).toBe(true);
    expect(canTransition('retrying', 'failed')).toBe(true);
    // Recovery: finalize a done run after disk already moved to retrying.
    expect(canTransition('retrying', 'review')).toBe(true);
  });

  it('allows cancellation from active states', () => {
    expect(canTransition('todo', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'cancelled')).toBe(true);
    expect(canTransition('review', 'cancelled')).toBe(true);
  });

  it('allows reopening a review back to in_progress (steer / reject)', () => {
    expect(canTransition('review', 'in_progress')).toBe(true);
  });

  it('allows human rework/requeue edges (reject, retry, post-PR steer, merge fail)', () => {
    expect(canTransition('review', 'todo')).toBe(true); // reject → rework
    expect(canTransition('failed', 'todo')).toBe(true); // manual retry
    expect(canTransition('retrying', 'todo')).toBe(true); // human Retry recovery
    expect(canTransition('cancelled', 'todo')).toBe(true); // human Retry recovery
    expect(canTransition('failed', 'cancelled')).toBe(true); // dismiss
    expect(canTransition('done', 'todo')).toBe(true); // comment-to-steer after Approve&PR
    expect(canTransition('done', 'review')).toBe(true); // merge failure → re-review
  });

  it('forbids leaving genuinely terminal states', () => {
    expect(canTransition('done', 'in_progress')).toBe(false);
    // cancelled→todo is human Retry only (asserted above); not in_progress.
    expect(canTransition('cancelled', 'in_progress')).toBe(false);
    expect(canTransition('failed', 'in_progress')).toBe(false);
  });

  it('allows soft-delete trash and restore', () => {
    expect(canTransition('todo', 'deleted')).toBe(true);
    expect(canTransition('done', 'deleted')).toBe(true);
    expect(canTransition('failed', 'deleted')).toBe(true);
    expect(canTransition('cancelled', 'deleted')).toBe(true);
    expect(canTransition('deleted', 'todo')).toBe(true);
    expect(canTransition('deleted', 'done')).toBe(false);
    expect(canTransition('in_progress', 'deleted')).toBe(false);
  });

  it('allows todo → review for pre-dispatch fail-fast (protected-path park)', () => {
    expect(canTransition('todo', 'review')).toBe(true);
  });

  it('forbids nonsensical jumps', () => {
    expect(canTransition('todo', 'done')).toBe(false);
    expect(canTransition('review', 'retrying')).toBe(false);
  });

  it('treats a self-transition as a no-op (allowed)', () => {
    expect(canTransition('in_progress', 'in_progress')).toBe(true);
  });
});

describe('assertTransition', () => {
  it('returns silently for a legal transition', () => {
    expect(() => assertTransition('todo', 'in_progress')).not.toThrow();
  });

  it('throws TransitionError for an illegal transition', () => {
    expect(() => assertTransition('cancelled', 'in_progress')).toThrow(TransitionError);
  });

  it('allows cancelled → todo for explicit human Retry', () => {
    expect(() => assertTransition('cancelled', 'todo')).not.toThrow();
  });

  it('allows done → todo for post-PR steer', () => {
    expect(() => assertTransition('done', 'todo')).not.toThrow();
  });
});
