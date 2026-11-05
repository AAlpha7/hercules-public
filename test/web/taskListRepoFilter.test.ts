/**
 * Task list repo filter: pure helpers (collect / match / normalize / prefs).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { StateDto, Task, TaskState } from '../../src/web/api.js';
import {
  REPO_FILTER_KEY,
  collectTaskRepos,
  loadRepoFilter,
  matchesRepoFilter,
  normalizeRepoFilter,
  saveRepoFilter,
  type RepoFilter,
} from '../../src/web/taskUi.js';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'repo' | 'state'>): Task {
  return {
    title: overrides.title ?? overrides.id,
    priority: 0,
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
    ...overrides,
  };
}

function emptyByState(): Record<TaskState, Task[]> {
  return {
    todo: [],
    in_progress: [],
    review: [],
    done: [],
    cancelled: [],
    retrying: [],
    failed: [],
    deleted: [],
  };
}

function makeState(tasks: Task[]): StateDto {
  const byState = emptyByState();
  for (const t of tasks) {
    byState[t.state].push(t);
  }
  return {
    ready: true,
    running: [],
    stopping: [],
    repos: [],
    problems: [],
    byState,
    activity: {},
    lastReport: null,
    agents: { default: 'grok', available: ['grok'] },
  };
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function installMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  const store: StorageLike = {
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: store,
    configurable: true,
    writable: true,
  });
  return store;
}

describe('collectTaskRepos', () => {
  it('returns sorted unique repo keys from all state groups', () => {
    const state = makeState([
      makeTask({ id: 'a', repo: 'zeta', state: 'todo' }),
      makeTask({ id: 'b', repo: 'alpha', state: 'review' }),
      makeTask({ id: 'c', repo: 'alpha', state: 'done' }),
      makeTask({ id: 'd', repo: 'mid', state: 'failed' }),
    ]);
    expect(collectTaskRepos(state)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('returns empty when there are no tasks', () => {
    expect(collectTaskRepos(makeState([]))).toEqual([]);
  });
});

describe('matchesRepoFilter', () => {
  const task = makeTask({ id: 't1', repo: 'app', state: 'todo' });

  it('null filter matches every task', () => {
    expect(matchesRepoFilter(task, null)).toBe(true);
  });

  it('matches only the selected repo key', () => {
    expect(matchesRepoFilter(task, 'app')).toBe(true);
    expect(matchesRepoFilter(task, 'other')).toBe(false);
  });
});

describe('normalizeRepoFilter', () => {
  it('keeps null and known keys; drops stale keys', () => {
    expect(normalizeRepoFilter(null, ['a', 'b'])).toBeNull();
    expect(normalizeRepoFilter('a', ['a', 'b'])).toBe('a');
    expect(normalizeRepoFilter('gone', ['a', 'b'])).toBeNull();
  });
});

describe('repo filter prefs', () => {
  let store: StorageLike;

  beforeEach(() => {
    store = installMemoryStorage();
  });

  it('defaults to all (null) and round-trips a valid key', () => {
    expect(loadRepoFilter()).toBeNull();
    saveRepoFilter('hercules');
    expect(store.getItem(REPO_FILTER_KEY)).toBe('hercules');
    expect(loadRepoFilter()).toBe('hercules');
    saveRepoFilter(null);
    expect(store.getItem(REPO_FILTER_KEY)).toBeNull();
    expect(loadRepoFilter()).toBeNull();
  });

  it('rejects invalid identifiers', () => {
    store.setItem(REPO_FILTER_KEY, '../evil');
    expect(loadRepoFilter()).toBeNull();
    saveRepoFilter('../evil' as RepoFilter);
    expect(store.getItem(REPO_FILTER_KEY)).toBeNull();
  });
});
