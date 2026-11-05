/**
 * Control layer — derived in-memory snapshot of the control repo (SPEC §7.2).
 *
 * The snapshot is rebuilt from disk on every tick and is NEVER persisted: the
 * git working tree is the source of truth. A single malformed task file must
 * not take down the whole snapshot, so per-file failures are collected as
 * `problems` rather than thrown.
 */
import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { TASK_STATES, compareTasksByLastActivityDesc, type Task, type TaskState } from '../domain/task.js';
import type { ReposConfig } from '../domain/repos.js';
import { parseReposConfig } from './reposConfig.js';
import { parseTaskFile } from './taskFile.js';

export class SnapshotError extends Error {
  override readonly name = 'SnapshotError';
}

export interface SnapshotProblem {
  /** File stem (task id) the problem relates to. */
  readonly stem: string;
  readonly error: string;
}

export interface ControlSnapshot {
  readonly repos: ReposConfig;
  /** Successfully parsed and validated tasks, sorted by id for determinism. */
  readonly tasks: readonly Task[];
  /** Files that could not be parsed or failed validation. */
  readonly problems: readonly SnapshotProblem[];
}

const REPOS_FILE = 'repos.yaml';
const TASKS_DIR = 'tasks';

export async function buildSnapshot(controlRepoDir: string): Promise<ControlSnapshot> {
  let reposText: string;
  try {
    reposText = await readFile(join(controlRepoDir, REPOS_FILE), 'utf8');
  } catch (err) {
    throw new SnapshotError(
      `could not read ${REPOS_FILE} in ${controlRepoDir}: ${(err as Error).message}`,
    );
  }
  const repos = parseReposConfig(reposText);

  const tasks: Task[] = [];
  const problems: SnapshotProblem[] = [];

  for (const stem of await listTaskStems(join(controlRepoDir, TASKS_DIR))) {
    const path = join(controlRepoDir, TASKS_DIR, `${stem}.md`);
    try {
      const task = parseTaskFile(await readFile(path, 'utf8'), stem);
      if (!(task.repo in repos.repos)) {
        problems.push({ stem, error: `references unknown repo '${task.repo}'` });
        continue;
      }
      tasks.push(task);
    } catch (err) {
      problems.push({ stem, error: (err as Error).message });
    }
  }

  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { repos, tasks, problems };
}

async function listTaskStems(tasksDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch {
    // Missing tasks/ dir is normal for a fresh control repo.
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.slice(0, -'.md'.length));
}

/**
 * Group tasks by state, with every state key present (empty arrays for unused
 * states) so the UI can render all buckets without guarding (SPEC §14).
 */
export function groupByState(tasks: readonly Task[]): Record<TaskState, Task[]> {
  const grouped = Object.fromEntries(TASK_STATES.map((s) => [s, [] as Task[]])) as Record<
    TaskState,
    Task[]
  >;
  for (const task of tasks) {
    grouped[task.state].push(task);
  }
  for (const s of TASK_STATES) {
    // Phone list: newest activity first within each state bucket (not dispatch order).
    grouped[s].sort(compareTasksByLastActivityDesc);
  }
  return grouped;
}
