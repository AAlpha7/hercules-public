import { describe, it, expect } from 'vitest';
import { computeQueueFrontPriority, isQueueState } from '../../src/domain/queueFront.js';
import { HEAVY_COST_WEIGHT } from '../../src/domain/scheduling.js';
import type { Task, TaskState } from '../../src/domain/task.js';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state: 'todo' as TaskState,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: '',
    ...over,
  };
}

describe('computeQueueFrontPriority', () => {
  it('isQueueState covers only todo and retrying', () => {
    expect(isQueueState('todo')).toBe(true);
    expect(isQueueState('retrying')).toBe(true);
    expect(isQueueState('in_progress')).toBe(false);
    expect(isQueueState('review')).toBe(false);
    expect(isQueueState('done')).toBe(false);
  });

  it('returns alreadyFront when alone in the queue', () => {
    const t = task('solo', { priority: 50 });
    expect(computeQueueFrontPriority(t, [t])).toEqual({
      nextPriority: 50,
      alreadyFront: true,
    });
  });

  it('beats the lowest peer priority by 1', () => {
    const target = task('late', { priority: 100 });
    const peers = [
      task('a', { priority: 10 }),
      task('b', { priority: 5 }),
      task('c', { state: 'done', priority: 0 }),
    ];
    expect(computeQueueFrontPriority(target, [target, ...peers])).toEqual({
      nextPriority: 4,
      alreadyFront: false,
    });
  });

  it('is idempotent when already strictly ahead of peers', () => {
    const front = task('front', { priority: 0 });
    const peers = [task('a', { priority: 5 }), task('b', { priority: 10 })];
    expect(computeQueueFrontPriority(front, [front, ...peers])).toEqual({
      nextPriority: 0,
      alreadyFront: true,
    });
  });

  it('breaks ties when effective priorities are equal', () => {
    const target = task('z-late', { priority: 1 });
    const peer = task('a-early', { priority: 1 });
    expect(computeQueueFrontPriority(target, [target, peer])).toEqual({
      nextPriority: 0,
      alreadyFront: false,
    });
  });

  it('accounts for heavy-label cost weight so readiness still lands first', () => {
    const heavy = task('heavy', { priority: 50, labels: ['readiness'] });
    const light = task('light', { priority: 5, labels: [] });
    const got = computeQueueFrontPriority(heavy, [heavy, light]);
    expect(got.alreadyFront).toBe(false);
    expect(got.nextPriority + HEAVY_COST_WEIGHT).toBeLessThan(5);
    expect(got.nextPriority).toBe(5 - HEAVY_COST_WEIGHT - 1);
  });

  it('includes retrying peers in the comparison', () => {
    const target = task('t', { priority: 20, state: 'todo' });
    const retrying = task('r', { priority: 3, state: 'retrying' });
    expect(computeQueueFrontPriority(target, [target, retrying])).toEqual({
      nextPriority: 2,
      alreadyFront: false,
    });
  });
});
