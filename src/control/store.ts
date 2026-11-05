/**
 * Control layer — writing task files to disk (SPEC §3.2 write half, §10).
 *
 * Two layers of path safety, because task ids may be human- or programmatically
 * supplied and become filesystem paths:
 *   1. the id must be a safe identifier ({@link isValidIdentifier}); and
 *   2. defense in depth — the resolved path MUST still land inside tasks/.
 */
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isValidIdentifier, type Task } from '../domain/task.js';
import type { Release } from '../domain/release.js';
import { serializeTask } from './taskFile.js';
import { serializeReposConfig } from './reposConfig.js';
import { parseReleaseFile, serializeRelease } from './releaseFile.js';
import type { ReposConfig } from '../domain/repos.js';
import type { WorkspaceSuccessionLedger } from '../domain/workspaceSuccession.js';
import { parseSuccessionLedger, serializeSuccessionLedger } from './successionReceiptFile.js';

export class StoreError extends Error {
  override readonly name = 'StoreError';
}

const TASKS_DIR = 'tasks';
const RELEASES_DIR = 'releases';
const SUCCESSIONS_DIR = 'successions';
const REPOS_FILE = 'repos.yaml';

/** Serialize the repo registry and write it to <root>/repos.yaml. */
export async function writeReposFile(controlRepoDir: string, config: ReposConfig): Promise<string> {
  const path = join(controlRepoDir, REPOS_FILE);
  await writeFile(path, serializeReposConfig(config), 'utf8');
  return path;
}

/** Resolve (and confinement-check) the on-disk path for a task id. */
export function taskPathFor(controlRepoDir: string, id: string): string {
  if (!isValidIdentifier(id)) {
    throw new StoreError(`task id '${id}' is not a safe identifier`);
  }
  const tasksRoot = resolve(controlRepoDir, TASKS_DIR);
  const path = resolve(tasksRoot, `${id}.md`);
  // The resolved path must be a direct child of tasks/ (no traversal).
  if (path !== join(tasksRoot, `${id}.md`) || !path.startsWith(tasksRoot + sep)) {
    throw new StoreError(`task id '${id}' resolves outside ${TASKS_DIR}/`);
  }
  return path;
}

/** Unlink tasks/<id>.md; resolves quietly if the file is already absent. */
export async function deleteTaskFile(dir: string, id: string): Promise<void> {
  if (!isValidIdentifier(id)) throw new StoreError(`unsafe task id '${id}'`);
  try {
    await unlink(join(dir, 'tasks', `${id}.md`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // already gone
    throw new StoreError(`could not delete task '${id}': ${(err as Error).message}`);
  }
}

/** Serialize a task and write it to tasks/<id>.md, creating tasks/ if needed. */
export async function writeTaskFile(controlRepoDir: string, task: Task): Promise<string> {
  const path = taskPathFor(controlRepoDir, task.id);
  await mkdir(join(controlRepoDir, TASKS_DIR), { recursive: true });
  await writeFile(path, serializeTask(task), 'utf8');
  return path;
}

/** Resolve (and confinement-check) the on-disk path for a release repo key. */
export function releasePathFor(controlRepoDir: string, repoKey: string): string {
  if (!isValidIdentifier(repoKey)) {
    throw new StoreError(`repo key '${repoKey}' is not a safe identifier`);
  }
  const releasesRoot = resolve(controlRepoDir, RELEASES_DIR);
  const path = resolve(releasesRoot, `${repoKey}.md`);
  if (path !== join(releasesRoot, `${repoKey}.md`) || !path.startsWith(releasesRoot + sep)) {
    throw new StoreError(`repo key '${repoKey}' resolves outside ${RELEASES_DIR}/`);
  }
  return path;
}

/** Serialize a release and write it to releases/<repoKey>.md. */
export async function writeReleaseFile(controlRepoDir: string, release: Release): Promise<string> {
  const path = releasePathFor(controlRepoDir, release.repoKey);
  await mkdir(join(controlRepoDir, RELEASES_DIR), { recursive: true });
  await writeFile(path, serializeRelease(release), 'utf8');
  return path;
}

/**
 * Read releases/<repoKey>.md. Returns null when the file is missing
 * (bootstrap — first staging deploy creates it).
 */
export async function readReleaseFile(
  controlRepoDir: string,
  repoKey: string,
): Promise<Release | null> {
  const path = releasePathFor(controlRepoDir, repoKey);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StoreError(`could not read release '${repoKey}': ${(err as Error).message}`);
  }
  try {
    return parseReleaseFile(text, repoKey);
  } catch (err) {
    throw new StoreError(`could not parse release '${repoKey}': ${(err as Error).message}`);
  }
}

export function successionPathFor(controlRepoDir: string, repoKey: string): string {
  if (!isValidIdentifier(repoKey)) throw new StoreError(`repo key '${repoKey}' is not a safe identifier`);
  const root = resolve(controlRepoDir, SUCCESSIONS_DIR);
  const path = resolve(root, `${repoKey}.json`);
  if (path !== join(root, `${repoKey}.json`) || !path.startsWith(root + sep)) {
    throw new StoreError(`repo key '${repoKey}' resolves outside ${SUCCESSIONS_DIR}/`);
  }
  return path;
}

/** Temp-write + fsync + rename: readers see either the old sealed ledger or the new one. */
export async function writeSuccessionFile(
  controlRepoDir: string,
  ledger: WorkspaceSuccessionLedger,
  options: {
    readonly beforeRename?: () => Promise<void>;
    readonly afterRename?: () => Promise<void>;
  } = {},
): Promise<string> {
  const path = successionPathFor(controlRepoDir, ledger.repoKey);
  const dir = join(controlRepoDir, SUCCESSIONS_DIR);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${ledger.repoKey}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(serializeSuccessionLedger(ledger), 'utf8');
    await handle.sync();
    await handle.close();
    await options.beforeRename?.();
    await rename(temp, path);
    await options.afterRename?.();
    const directory = await open(dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw err;
  }
  return path;
}

export async function readSuccessionFile(
  controlRepoDir: string,
  repoKey: string,
): Promise<WorkspaceSuccessionLedger | null> {
  const path = successionPathFor(controlRepoDir, repoKey);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StoreError(`could not read succession '${repoKey}': ${(err as Error).message}`);
  }
  try {
    return parseSuccessionLedger(text, repoKey);
  } catch (err) {
    throw new StoreError(`could not parse succession '${repoKey}': ${(err as Error).message}`);
  }
}
