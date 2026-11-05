import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, SnapshotError, groupByState } from '../../src/control/snapshot.js';
import {
  ACTIVITY_SORT_EXPECTED_IDS,
  activitySortFixtureTasks,
} from './groupByStateActivityFixtures.js';

let dir: string;

const REPOS = `repos:
  my-app:
    url: git@github.com:me/my-app.git
    default_branch: main
`;

function task(repo: string, state = 'todo'): string {
  return `---\ntitle: A task\nrepo: ${repo}\nstate: ${state}\n---\nbody\n`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hercules-snap-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRepos(content = REPOS): Promise<void> {
  await writeFile(join(dir, 'repos.yaml'), content);
}

async function writeTask(stem: string, content: string): Promise<void> {
  await mkdir(join(dir, 'tasks'), { recursive: true });
  await writeFile(join(dir, 'tasks', `${stem}.md`), content);
}

describe('buildSnapshot', () => {
  it('reads repos.yaml and all task files', async () => {
    await writeRepos();
    await writeTask('ABC-1', task('my-app', 'todo'));
    await writeTask('ABC-2', task('my-app', 'review'));

    const snap = await buildSnapshot(dir);
    expect(Object.keys(snap.repos.repos)).toEqual(['my-app']);
    expect(snap.tasks.map((t) => t.id).sort()).toEqual(['ABC-1', 'ABC-2']);
    expect(snap.problems).toEqual([]);
  });

  it('collects a problem for a malformed task file instead of throwing', async () => {
    await writeRepos();
    await writeTask('GOOD', task('my-app'));
    await writeTask('BAD', 'no front matter here');

    const snap = await buildSnapshot(dir);
    expect(snap.tasks.map((t) => t.id)).toEqual(['GOOD']);
    expect(snap.problems).toHaveLength(1);
    expect(snap.problems[0]!.stem).toBe('BAD');
  });

  it('flags a task that references an unknown repo', async () => {
    await writeRepos();
    await writeTask('ORPHAN', task('ghost-repo'));

    const snap = await buildSnapshot(dir);
    expect(snap.tasks).toEqual([]);
    expect(snap.problems).toHaveLength(1);
    expect(snap.problems[0]!.error).toMatch(/unknown repo/i);
  });

  it('ignores non-markdown files in tasks/', async () => {
    await writeRepos();
    await writeTask('ABC-1', task('my-app'));
    await writeFile(join(dir, 'tasks', 'notes.txt'), 'ignore me');
    await writeFile(join(dir, 'tasks', '.gitkeep'), '');

    const snap = await buildSnapshot(dir);
    expect(snap.tasks.map((t) => t.id)).toEqual(['ABC-1']);
    expect(snap.problems).toEqual([]);
  });

  it('returns no tasks when the tasks dir is absent', async () => {
    await writeRepos();
    const snap = await buildSnapshot(dir);
    expect(snap.tasks).toEqual([]);
  });

  it('throws when repos.yaml is missing', async () => {
    await expect(buildSnapshot(dir)).rejects.toThrow(SnapshotError);
  });
});

describe('groupByState', () => {
  it('groups tasks by state with every state key present', async () => {
    await writeRepos();
    await writeTask('A', task('my-app', 'todo'));
    await writeTask('B', task('my-app', 'todo'));
    await writeTask('C', task('my-app', 'done'));
    const snap = await buildSnapshot(dir);

    const grouped = groupByState(snap.tasks);
    expect(grouped.todo.map((t) => t.id).sort()).toEqual(['A', 'B']);
    expect(grouped.done.map((t) => t.id)).toEqual(['C']);
    expect(grouped.failed).toEqual([]);
  });

  it('groupByState orders tasks within a state by last activity descending', () => {
    expect(groupByState(activitySortFixtureTasks()).done.map((t) => t.id)).toEqual(ACTIVITY_SORT_EXPECTED_IDS);
  });
});
