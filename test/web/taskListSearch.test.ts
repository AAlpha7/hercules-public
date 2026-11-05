/**
 * Task list text search: pure matchesTaskSearch helper.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../../src/web/api.js';
import { matchesRepoFilter, matchesTaskSearch } from '../../src/web/taskUi.js';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    title: overrides.title ?? overrides.id,
    repo: overrides.repo ?? 'app',
    state: overrides.state ?? 'todo',
    priority: 0,
    blockedBy: [],
    labels: overrides.labels ?? [],
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
    ...overrides,
  };
}

describe('matchesTaskSearch', () => {
  const task = makeTask({
    id: 'task-42',
    title: 'Add dark mode',
    repo: 'hercules',
    labels: ['ui', 'mobile'],
  });

  it('empty or whitespace query matches every task', () => {
    expect(matchesTaskSearch(task, '')).toBe(true);
    expect(matchesTaskSearch(task, '   ')).toBe(true);
  });

  it('matches id case-insensitively', () => {
    expect(matchesTaskSearch(task, 'TASK-42')).toBe(true);
    expect(matchesTaskSearch(task, 'task-4')).toBe(true);
    expect(matchesTaskSearch(task, 'task-99')).toBe(false);
  });

  it('matches title case-insensitively', () => {
    expect(matchesTaskSearch(task, 'dark')).toBe(true);
    expect(matchesTaskSearch(task, 'DARK MODE')).toBe(true);
    expect(matchesTaskSearch(task, 'light')).toBe(false);
  });

  it('matches repo key', () => {
    expect(matchesTaskSearch(task, 'herc')).toBe(true);
    expect(matchesTaskSearch(task, 'other')).toBe(false);
  });

  it('matches labels', () => {
    expect(matchesTaskSearch(task, 'mobile')).toBe(true);
    expect(matchesTaskSearch(task, 'UI')).toBe(true);
    expect(matchesTaskSearch(task, 'backend')).toBe(false);
  });

  it('trims surrounding whitespace on the query', () => {
    expect(matchesTaskSearch(task, '  dark  ')).toBe(true);
  });

  it('AND-composes with matchesRepoFilter', () => {
    const app = makeTask({ id: 'a', title: 'Dark mode', repo: 'app' });
    const ops = makeTask({ id: 'b', title: 'Dark mode', repo: 'ops' });
    expect(matchesRepoFilter(app, 'app') && matchesTaskSearch(app, 'dark')).toBe(true);
    expect(matchesRepoFilter(ops, 'app') && matchesTaskSearch(ops, 'dark')).toBe(false);
  });
});
