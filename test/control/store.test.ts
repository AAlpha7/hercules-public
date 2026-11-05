import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeTaskFile,
  taskPathFor,
  StoreError,
  deleteTaskFile,
  writeReposFile,
  writeReleaseFile,
  readReleaseFile,
  releasePathFor,
} from '../../src/control/store.js';
import { parseTaskFile } from '../../src/control/taskFile.js';
import { parseReposConfig } from '../../src/control/reposConfig.js';
import { emptyRelease } from '../../src/domain/release.js';
import type { Task } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';

let dir: string;

const TASK: Task = {
  id: 'ABC-12',
  title: 'A task',
  repo: 'my-app',
  state: 'todo',
  priority: 2,
  blockedBy: [],
  dependencyMode: null,
  labels: [],
  adapter: null,
  fakeBehavior: null,
  agentSession: null,
  agentSessionAdapter: null,
  pendingSteer: null,
  attempts: 0,
  lastEventAt: null, createdAt: null, startedAt: null, endedAt: null,
  prUrl: null,
  prStatus: null,
  planPending: false,
  verifiedSha: null,
  mergedSha: null,
  mergedVia: null,
  executionClass: 'implement',
  hostCommandScope: null,
  hostApprovedAt: null,
  hostExecutionStartedAt: null,
  salvageSourceTask: null,
  salvageSourceSha: null,
  body: 'do the thing',
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hercules-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeTaskFile', () => {
  it('writes a task to tasks/<id>.md (creating tasks/) and round-trips', async () => {
    const path = await writeTaskFile(dir, TASK);
    expect(path).toBe(join(dir, 'tasks', 'ABC-12.md'));

    const onDisk = await readFile(path, 'utf8');
    expect(parseTaskFile(onDisk, 'ABC-12')).toEqual(TASK);
  });

  it('overwrites an existing task file', async () => {
    await writeTaskFile(dir, TASK);
    await writeTaskFile(dir, { ...TASK, state: 'done' });
    const onDisk = await readFile(join(dir, 'tasks', 'ABC-12.md'), 'utf8');
    expect(parseTaskFile(onDisk, 'ABC-12').state).toBe('done');
  });

  it('rejects a task whose id is not a safe identifier (SPEC §10)', async () => {
    await expect(writeTaskFile(dir, { ...TASK, id: '../escape' })).rejects.toThrow(StoreError);
    // nothing should have been written outside the control dir
    await expect(readFile(join(dir, '..', 'escape.md'), 'utf8')).rejects.toThrow();
  });
});

describe('taskPathFor', () => {
  it('resolves inside the control dir', () => {
    expect(taskPathFor(dir, 'ABC-12')).toBe(join(dir, 'tasks', 'ABC-12.md'));
  });

  it('throws for an unsafe id', () => {
    expect(() => taskPathFor(dir, '../escape')).toThrow(StoreError);
  });

  it('throws even if a crafted id would resolve back inside via traversal', async () => {
    // Defense in depth: an id that is technically charset-valid but resolves
    // outside tasks/ must still be rejected.
    await writeFile(join(dir, 'sentinel'), 'x');
    expect(() => taskPathFor(dir, 'a/../../b')).toThrow(StoreError);
  });
});

describe('deleteTaskFile', () => {
  let delDir: string;
  beforeEach(async () => {
    delDir = await mkdtemp(join(tmpdir(), 'hercules-store-del-'));
    await mkdir(join(delDir, 'tasks'), { recursive: true });
    await writeFile(join(delDir, 'tasks', 'T-1.md'), '---\nid: T-1\n---\nbody');
  });
  afterEach(async () => { await rm(delDir, { recursive: true, force: true }); });

  it('removes the task file', async () => {
    await deleteTaskFile(delDir, 'T-1');
    await expect(access(join(delDir, 'tasks', 'T-1.md'))).rejects.toThrow();
  });
  it('is quiet when the file is already gone', async () => {
    await expect(deleteTaskFile(delDir, 'ghost')).resolves.toBeUndefined();
  });
  it('rejects an unsafe id', async () => {
    await expect(deleteTaskFile(delDir, '../etc')).rejects.toBeInstanceOf(StoreError);
  });
});

describe('writeReposFile', () => {
  it('writes parseable repos.yaml at the control-repo root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'herc-repos-'));
    try {
      const config: ReposConfig = {
        repos: { app: { key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' } },
      };
      const path = await writeReposFile(dir, config);
      expect(path).toBe(join(dir, 'repos.yaml'));
      expect(parseReposConfig(await readFile(path, 'utf8'))).toEqual(config);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('writeReleaseFile / readReleaseFile', () => {
  it('writes releases/<repoKey>.md and round-trips', async () => {
    const release = {
      ...emptyRelease('app'),
      stagingSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      stagingStatus: 'ready' as const,
      // parseReleaseFile trims the body (same as tasks)
      body: '## Release packet\n\n- t-1: Ship',
    };
    const path = await writeReleaseFile(dir, release);
    expect(path).toBe(join(dir, 'releases', 'app.md'));
    expect(releasePathFor(dir, 'app')).toBe(path);
    const loaded = await readReleaseFile(dir, 'app');
    expect(loaded).toEqual(release);
  });

  it('returns null when the release file is missing', async () => {
    expect(await readReleaseFile(dir, 'ghost')).toBeNull();
  });

  it('rejects an unsafe repo key', () => {
    expect(() => releasePathFor(dir, '../escape')).toThrow(StoreError);
  });
});
