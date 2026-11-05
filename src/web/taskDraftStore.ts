/**
 * Per-repo Create-form draft persistence (localStorage).
 *
 * Key `hercules_task_draft_v1`. Bounded to 8 repos (evict oldest `savedAt`)
 * and 64 KiB total (drop oldest until it fits). Every read/write is try/catch;
 * missing/throwing storage → no-ops (static behaviour).
 */

import type { ExecutionClass } from './api.js';

export const TASK_DRAFT_KEY = 'hercules_task_draft_v1';
export const TASK_DRAFT_MAX_REPOS = 8;
export const TASK_DRAFT_MAX_BYTES = 64 * 1024;

export type TaskDraftCreateMode = 'task' | 'pipeline';
export type TaskDraftSource = 'analyst' | 'heuristic';

export interface TaskDraftStage {
  readonly title: string;
  readonly body: string;
  readonly adapter: string;
}

/** Fields persisted per repo (no `savedAt`). */
export interface TaskDraftFields {
  readonly intent: string;
  readonly title: string;
  readonly slug: string | undefined;
  readonly body: string;
  readonly adapter: string;
  readonly executionClass: ExecutionClass;
  readonly asPlan: boolean;
  readonly createMode: TaskDraftCreateMode;
  readonly stages: readonly TaskDraftStage[];
  readonly draftNotes: readonly string[];
  readonly draftSource: TaskDraftSource | null;
  readonly jobId: string | null;
}

export interface StoredTaskDraft extends TaskDraftFields {
  readonly savedAt: string;
}

export interface TaskDraftStoreV1 {
  readonly v: 1;
  readonly byRepo: Readonly<Record<string, StoredTaskDraft>>;
}

export interface TaskDraftListEntry {
  readonly repoKey: string;
  readonly draft: StoredTaskDraft;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const EXECUTION_CLASSES = new Set<string>([
  'explore',
  'implement',
  'verify',
  'host_operation',
  'deploy',
]);

function storage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

function isExecutionClass(v: unknown): v is ExecutionClass {
  return typeof v === 'string' && EXECUTION_CLASSES.has(v);
}

function isCreateMode(v: unknown): v is TaskDraftCreateMode {
  return v === 'task' || v === 'pipeline';
}

function isDraftSource(v: unknown): v is TaskDraftSource {
  return v === 'analyst' || v === 'heuristic';
}

function parseStage(raw: unknown): TaskDraftStage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['title'] !== 'string') return null;
  if (typeof o['body'] !== 'string') return null;
  if (typeof o['adapter'] !== 'string') return null;
  return { title: o['title'], body: o['body'], adapter: o['adapter'] };
}

function parseDraft(raw: unknown): StoredTaskDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['savedAt'] !== 'string' || !o['savedAt']) return null;
  if (typeof o['intent'] !== 'string') return null;
  if (typeof o['title'] !== 'string') return null;
  if (o['slug'] !== undefined && typeof o['slug'] !== 'string') return null;
  if (typeof o['body'] !== 'string') return null;
  if (typeof o['adapter'] !== 'string') return null;
  if (!isExecutionClass(o['executionClass'])) return null;
  if (typeof o['asPlan'] !== 'boolean') return null;
  if (!isCreateMode(o['createMode'])) return null;
  if (!Array.isArray(o['stages'])) return null;
  const stages: TaskDraftStage[] = [];
  for (const s of o['stages']) {
    const parsed = parseStage(s);
    if (!parsed) return null;
    stages.push(parsed);
  }
  if (!Array.isArray(o['draftNotes'])) return null;
  const draftNotes: string[] = [];
  for (const n of o['draftNotes']) {
    if (typeof n !== 'string') return null;
    draftNotes.push(n);
  }
  const draftSource =
    o['draftSource'] === null
      ? null
      : isDraftSource(o['draftSource'])
        ? o['draftSource']
        : null;
  if (o['draftSource'] !== null && draftSource === null && o['draftSource'] !== undefined) {
    return null;
  }
  const jobId =
    o['jobId'] === null ? null : typeof o['jobId'] === 'string' ? o['jobId'] : null;
  if (o['jobId'] !== null && o['jobId'] !== undefined && typeof o['jobId'] !== 'string') {
    return null;
  }
  return {
    savedAt: o['savedAt'],
    intent: o['intent'],
    title: o['title'],
    slug: typeof o['slug'] === 'string' ? o['slug'] : undefined,
    body: o['body'],
    adapter: o['adapter'],
    executionClass: o['executionClass'],
    asPlan: o['asPlan'],
    createMode: o['createMode'],
    stages,
    draftNotes,
    draftSource,
    jobId,
  };
}

/** Parse raw JSON into a store; corrupt input → empty store. */
export function parseTaskDraftStore(raw: string): TaskDraftStoreV1 {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { v: 1, byRepo: {} };
    }
    const o = parsed as Record<string, unknown>;
    if (o['v'] !== 1) return { v: 1, byRepo: {} };
    const byRaw = o['byRepo'];
    if (!byRaw || typeof byRaw !== 'object' || Array.isArray(byRaw)) {
      return { v: 1, byRepo: {} };
    }
    const byRepo: Record<string, StoredTaskDraft> = {};
    for (const [key, value] of Object.entries(byRaw as Record<string, unknown>)) {
      if (typeof key !== 'string' || key.length === 0) continue;
      const draft = parseDraft(value);
      if (draft) byRepo[key] = draft;
    }
    return { v: 1, byRepo };
  } catch {
    return { v: 1, byRepo: {} };
  }
}

function entriesByOldest(byRepo: Readonly<Record<string, StoredTaskDraft>>): TaskDraftListEntry[] {
  return Object.entries(byRepo)
    .map(([repoKey, draft]) => ({ repoKey, draft }))
    .sort((a, b) => {
      const ta = Date.parse(a.draft.savedAt);
      const tb = Date.parse(b.draft.savedAt);
      const na = Number.isFinite(ta) ? ta : 0;
      const nb = Number.isFinite(tb) ? tb : 0;
      if (na !== nb) return na - nb;
      return a.repoKey.localeCompare(b.repoKey);
    });
}

function byteLength(store: TaskDraftStoreV1): number {
  return new TextEncoder().encode(JSON.stringify(store)).length;
}

/**
 * Evict oldest repos until ≤ maxRepos and ≤ maxBytes.
 * Pure — never throws.
 */
export function boundTaskDraftStore(
  store: TaskDraftStoreV1,
  maxRepos: number = TASK_DRAFT_MAX_REPOS,
  maxBytes: number = TASK_DRAFT_MAX_BYTES,
): TaskDraftStoreV1 {
  let byRepo: Record<string, StoredTaskDraft> = { ...store.byRepo };
  let next: TaskDraftStoreV1 = { v: 1, byRepo };

  // Cap repo count first (drop oldest).
  while (Object.keys(byRepo).length > maxRepos) {
    const oldest = entriesByOldest(byRepo)[0];
    if (!oldest) break;
    const { [oldest.repoKey]: _removed, ...rest } = byRepo;
    byRepo = rest;
    next = { v: 1, byRepo };
  }

  // Cap total serialized size (drop oldest until it fits or empty).
  while (Object.keys(byRepo).length > 0 && byteLength(next) > maxBytes) {
    const oldest = entriesByOldest(byRepo)[0];
    if (!oldest) break;
    const { [oldest.repoKey]: _removed, ...rest } = byRepo;
    byRepo = rest;
    next = { v: 1, byRepo };
  }

  return next;
}

/** True when the draft has no user content worth keeping. */
export function isEmptyTaskDraft(draft: TaskDraftFields): boolean {
  if (draft.title.trim().length > 0) return false;
  if (draft.intent.trim().length > 0) return false;
  if (draft.body.trim().length > 0) return false;
  if (draft.jobId) return false;
  if (draft.slug && draft.slug.trim().length > 0) return false;
  if (draft.draftNotes.length > 0) return false;
  if (draft.draftSource) return false;
  if (draft.createMode === 'pipeline') {
    const hasStageBody = draft.stages.some((s) => s.body.trim().length > 0);
    const hasCustomTitle = draft.stages.some(
      (s, i) =>
        s.title.trim().length > 0 &&
        s.title !== 'Implement' &&
        s.title !== 'Review / polish' &&
        s.title !== `Stage ${i + 1}`,
    );
    if (hasStageBody || hasCustomTitle) return false;
  }
  return true;
}

/** Field-level equality for "untouched vs seed" checks. */
export function taskDraftFieldsEqual(a: TaskDraftFields, b: TaskDraftFields): boolean {
  if (a.intent !== b.intent) return false;
  if (a.title !== b.title) return false;
  if ((a.slug ?? '') !== (b.slug ?? '')) return false;
  if (a.body !== b.body) return false;
  if (a.adapter !== b.adapter) return false;
  if (a.executionClass !== b.executionClass) return false;
  if (a.asPlan !== b.asPlan) return false;
  if (a.createMode !== b.createMode) return false;
  if (a.draftSource !== b.draftSource) return false;
  if (a.jobId !== b.jobId) return false;
  if (a.draftNotes.length !== b.draftNotes.length) return false;
  for (let i = 0; i < a.draftNotes.length; i++) {
    if (a.draftNotes[i] !== b.draftNotes[i]) return false;
  }
  if (a.stages.length !== b.stages.length) return false;
  for (let i = 0; i < a.stages.length; i++) {
    const sa = a.stages[i]!;
    const sb = b.stages[i]!;
    if (sa.title !== sb.title || sa.body !== sb.body || sa.adapter !== sb.adapter) return false;
  }
  return true;
}

/** Upsert one repo draft (does not bound). */
export function upsertTaskDraft(
  store: TaskDraftStoreV1,
  repoKey: string,
  draft: TaskDraftFields,
  now: Date,
): TaskDraftStoreV1 {
  if (!repoKey) return store;
  const savedAt = now.toISOString();
  return {
    v: 1,
    byRepo: {
      ...store.byRepo,
      [repoKey]: { ...draft, savedAt },
    },
  };
}

/** Remove one repo draft. */
export function removeTaskDraft(store: TaskDraftStoreV1, repoKey: string): TaskDraftStoreV1 {
  if (!repoKey || !(repoKey in store.byRepo)) return store;
  const { [repoKey]: _removed, ...rest } = store.byRepo;
  return { v: 1, byRepo: rest };
}

/** Load store from storage (injected or localStorage). */
export function readTaskDraftStore(storageOverride?: StorageLike | null): TaskDraftStoreV1 {
  const s = storageOverride === undefined ? storage() : storageOverride;
  if (!s) return { v: 1, byRepo: {} };
  try {
    const raw = s.getItem(TASK_DRAFT_KEY);
    if (!raw) return { v: 1, byRepo: {} };
    return parseTaskDraftStore(raw);
  } catch {
    return { v: 1, byRepo: {} };
  }
}

/** Persist store (bounded). Returns false when storage missing/throws. */
export function writeTaskDraftStore(
  store: TaskDraftStoreV1,
  storageOverride?: StorageLike | null,
): boolean {
  const s = storageOverride === undefined ? storage() : storageOverride;
  if (!s) return false;
  try {
    const bounded = boundTaskDraftStore(store);
    if (Object.keys(bounded.byRepo).length === 0) {
      s.removeItem(TASK_DRAFT_KEY);
      return true;
    }
    s.setItem(TASK_DRAFT_KEY, JSON.stringify(bounded));
    return true;
  } catch {
    return false;
  }
}

/** Load one repo's draft; missing → null. */
export function loadTaskDraft(
  repoKey: string,
  storageOverride?: StorageLike | null,
): StoredTaskDraft | null {
  if (!repoKey) return null;
  try {
    const store = readTaskDraftStore(storageOverride);
    return store.byRepo[repoKey] ?? null;
  } catch {
    return null;
  }
}

/**
 * Save a draft for `repoKey`. Empty drafts are not written (existing entry
 * cleared). Never throws.
 */
export function saveTaskDraft(
  repoKey: string,
  draft: TaskDraftFields,
  now: Date,
  storageOverride?: StorageLike | null,
): boolean {
  if (!repoKey) return false;
  try {
    if (isEmptyTaskDraft(draft)) {
      return clearTaskDraft(repoKey, storageOverride);
    }
    const store = readTaskDraftStore(storageOverride);
    // A draft that cannot fit on its own must never evict the other repos'
    // drafts to make room for nothing (Claude R18 B1): refuse it, keep the
    // store as is (the form keeps the text in memory).
    const alone = upsertTaskDraft({ v: 1, byRepo: {} }, repoKey, draft, now);
    if (byteLength(alone) > TASK_DRAFT_MAX_BYTES) return false;
    const next = boundTaskDraftStore(upsertTaskDraft(store, repoKey, draft, now));
    return writeTaskDraftStore(next, storageOverride);
  } catch {
    return false;
  }
}

/** Clear one repo's draft. */
export function clearTaskDraft(
  repoKey: string,
  storageOverride?: StorageLike | null,
): boolean {
  if (!repoKey) return false;
  try {
    const store = readTaskDraftStore(storageOverride);
    if (!(repoKey in store.byRepo)) return true;
    const next = removeTaskDraft(store, repoKey);
    return writeTaskDraftStore(next, storageOverride);
  } catch {
    return false;
  }
}

/** List all drafts, newest `savedAt` first. */
export function listTaskDrafts(
  storageOverride?: StorageLike | null,
): TaskDraftListEntry[] {
  try {
    const store = readTaskDraftStore(storageOverride);
    return entriesByOldest(store.byRepo).reverse();
  } catch {
    return [];
  }
}
