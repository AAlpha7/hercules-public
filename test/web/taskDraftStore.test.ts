/**
 * Create-form per-repo draft store: bounding, no-throw storage, round-trip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  TASK_DRAFT_KEY,
  TASK_DRAFT_MAX_BYTES,
  TASK_DRAFT_MAX_REPOS,
  boundTaskDraftStore,
  clearTaskDraft,
  isEmptyTaskDraft,
  listTaskDrafts,
  loadTaskDraft,
  parseTaskDraftStore,
  saveTaskDraft,
  type StorageLike,
  type TaskDraftFields,
  type TaskDraftStoreV1,
} from '../../src/web/taskDraftStore.js';

function installMemoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const mem: StorageLike & { map: Map<string, string> } = {
    map,
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: mem,
  });
  return mem;
}

function sampleDraft(over: Partial<TaskDraftFields> = {}): TaskDraftFields {
  return {
    intent: 'fix logout',
    title: 'Settings instead of Logout',
    slug: 'settings-logout',
    body: '## Task\n\ndo it',
    adapter: 'grok',
    executionClass: 'implement',
    asPlan: true,
    createMode: 'task',
    stages: [
      { title: 'Implement', body: '', adapter: 'grok' },
      { title: 'Review / polish', body: '', adapter: 'grok' },
    ],
    draftNotes: ['note-a'],
    draftSource: 'heuristic',
    jobId: null,
    ...over,
  };
}

describe('taskDraftStore', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it('load/save/clear round-trips a draft under hercules_task_draft_v1', () => {
    const now = new Date('2026-09-07T12:00:00.000Z');
    expect(loadTaskDraft('alpha')).toBeNull();
    expect(saveTaskDraft('alpha', sampleDraft(), now)).toBe(true);

    const raw = globalThis.localStorage.getItem(TASK_DRAFT_KEY);
    expect(raw).toBeTruthy();
    const parsed = parseTaskDraftStore(raw!);
    expect(parsed.v).toBe(1);
    expect(parsed.byRepo['alpha']?.title).toBe('Settings instead of Logout');
    expect(parsed.byRepo['alpha']?.savedAt).toBe(now.toISOString());

    const loaded = loadTaskDraft('alpha');
    expect(loaded).toMatchObject({
      intent: 'fix logout',
      title: 'Settings instead of Logout',
      slug: 'settings-logout',
      body: '## Task\n\ndo it',
      adapter: 'grok',
      executionClass: 'implement',
      asPlan: true,
      createMode: 'task',
      draftSource: 'heuristic',
      jobId: null,
      savedAt: now.toISOString(),
    });
    expect(loaded?.draftNotes).toEqual(['note-a']);

    expect(clearTaskDraft('alpha')).toBe(true);
    expect(loadTaskDraft('alpha')).toBeNull();
    expect(globalThis.localStorage.getItem(TASK_DRAFT_KEY)).toBeNull();
  });

  it('bounds to 8 repos by evicting oldest savedAt', () => {
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    for (let i = 0; i < TASK_DRAFT_MAX_REPOS + 2; i++) {
      saveTaskDraft(
        `repo-${i}`,
        sampleDraft({ title: `T${i}` }),
        new Date(base + i * 60_000),
      );
    }
    const listed = listTaskDrafts();
    expect(listed.length).toBe(TASK_DRAFT_MAX_REPOS);
    expect(listed.map((e) => e.repoKey)).not.toContain('repo-0');
    expect(listed.map((e) => e.repoKey)).not.toContain('repo-1');
    expect(listed.map((e) => e.repoKey)).toContain('repo-2');
    expect(listed.map((e) => e.repoKey)).toContain(`repo-${TASK_DRAFT_MAX_REPOS + 1}`);
  });

  it('bounds total size to 64 KiB by dropping oldest', () => {
    const bigBody = 'x'.repeat(20_000);
    const byRepo: Record<string, ReturnType<typeof sampleDraft> & { savedAt: string }> = {};
    for (let i = 0; i < 6; i++) {
      byRepo[`big-${i}`] = {
        ...sampleDraft({ title: `Big ${i}`, body: bigBody }),
        savedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      };
    }
    const fat: TaskDraftStoreV1 = { v: 1, byRepo };
    expect(new TextEncoder().encode(JSON.stringify(fat)).length).toBeGreaterThan(
      TASK_DRAFT_MAX_BYTES,
    );
    const bounded = boundTaskDraftStore(fat);
    const size = new TextEncoder().encode(JSON.stringify(bounded)).length;
    expect(size).toBeLessThanOrEqual(TASK_DRAFT_MAX_BYTES);
    expect(Object.keys(bounded.byRepo).length).toBeGreaterThan(0);
    expect(bounded.byRepo['big-0']).toBeUndefined();
    expect(Object.keys(bounded.byRepo).some((k) => k.startsWith('big-'))).toBe(true);
  });

  it('never throws on broken storage and returns static no-ops', () => {
    const broken: StorageLike = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
      removeItem() {
        throw new Error('denied');
      },
    };
    expect(() => loadTaskDraft('alpha', broken)).not.toThrow();
    expect(loadTaskDraft('alpha', broken)).toBeNull();
    expect(() => saveTaskDraft('alpha', sampleDraft(), new Date(), broken)).not.toThrow();
    expect(saveTaskDraft('alpha', sampleDraft(), new Date(), broken)).toBe(false);
    expect(() => clearTaskDraft('alpha', broken)).not.toThrow();
    expect(() => listTaskDrafts(broken)).not.toThrow();
    expect(listTaskDrafts(broken)).toEqual([]);
  });

  it('treats empty / seed-like drafts as empty and refuses to persist them', () => {
    expect(
      isEmptyTaskDraft({
        intent: '',
        title: '',
        slug: undefined,
        body: '',
        adapter: '',
        executionClass: 'implement',
        asPlan: false,
        createMode: 'task',
        stages: [
          { title: 'Implement', body: '', adapter: '' },
          { title: 'Review / polish', body: '', adapter: '' },
        ],
        draftNotes: [],
        draftSource: null,
        jobId: null,
      }),
    ).toBe(true);
    expect(
      saveTaskDraft(
        'alpha',
        sampleDraft({
          title: '',
          intent: '',
          body: '',
          slug: undefined,
          asPlan: false,
          draftNotes: [],
          draftSource: null,
        }),
        new Date(),
      ),
    ).toBe(true);
    expect(loadTaskDraft('alpha')).toBeNull();
  });

  it('listTaskDrafts returns newest first', () => {
    saveTaskDraft('old', sampleDraft({ title: 'Old' }), new Date('2026-01-01T00:00:00.000Z'));
    saveTaskDraft('new', sampleDraft({ title: 'New' }), new Date('2026-06-01T00:00:00.000Z'));
    const listed = listTaskDrafts();
    expect(listed[0]?.repoKey).toBe('new');
    expect(listed[1]?.repoKey).toBe('old');
  });
});

describe('oversized draft (Claude R18 B1)', () => {
  it('refuses a draft that cannot fit on its own and keeps the other repos', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
    const small = { intent: 'x', title: 't', slug: undefined, body: 'b', adapter: 'grok', executionClass: 'implement' as const, asPlan: false, createMode: 'task' as const, stages: [], draftNotes: [], draftSource: null, jobId: null };
    expect(saveTaskDraft('a', small, new Date('2026-01-01'), storage)).toBe(true);
    expect(saveTaskDraft('b', small, new Date('2026-01-02'), storage)).toBe(true);
    const huge = { ...small, body: 'y'.repeat(65 * 1024) };
    expect(saveTaskDraft('c', huge, new Date('2026-01-03'), storage)).toBe(false);
    expect(listTaskDrafts(storage).map((e) => e.repoKey).sort()).toEqual(['a', 'b']);
  });
});
