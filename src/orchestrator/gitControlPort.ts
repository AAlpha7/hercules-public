/**
 * Coordination layer — the concrete {@link ControlPort}, composing the control
 * layer (snapshot read, task write) with git plumbing (pull, commit-all).
 *
 * This is the only place the orchestrator touches the real filesystem and git.
 * The orchestrator itself depends on the ControlPort interface, so it stays
 * testable against an in-memory fake.
 */
import type { Task } from '../domain/task.js';
import type { Release } from '../domain/release.js';
import { buildSnapshot, type ControlSnapshot } from '../control/snapshot.js';
import {
  deleteTaskFile,
  readReleaseFile,
  releasePathFor,
  writeReposFile,
  writeReleaseFile,
  writeTaskFile,
  readSuccessionFile,
  successionPathFor,
  writeSuccessionFile,
} from '../control/store.js';
import { taskPathFor } from '../control/store.js';
import type { ReposConfig } from '../domain/repos.js';
import type { WorkspaceSuccessionLedger } from '../domain/workspaceSuccession.js';
import { serializeSuccessionLedger } from '../control/successionReceiptFile.js';
import { serializeReposConfig } from '../control/reposConfig.js';
import { serializeRelease } from '../control/releaseFile.js';
import { ControlConflictError, ControlGit, type CommitResult } from '../control/git.js';
import { serializeTask } from '../control/taskFile.js';
import {
  validateDependencyRewire,
  type DependencyRewireChange,
} from '../domain/dependencyRewire.js';
import type { ControlMutation, ControlPort } from './orchestrator.js';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import {
  ShadowDeliveryOutbox,
  type ShadowOutboxEntryInput,
} from './shadowDeliveryOutbox.js';

export interface AuthoritativeTaskCommit {
  readonly deliveryId: string;
  readonly revision: string;
  readonly writes: readonly Task[];
  readonly retiredTaskIds: readonly string[];
}

export interface AuthoritativeTaskSnapshot {
  readonly revision: string;
  readonly tasks: readonly Task[];
  readonly shadowPending: boolean;
}

export interface GitControlPortOptions {
  /** Explicit M4 shadow mode. Omission preserves the legacy construction path. */
  readonly authoritativeTaskCommit?: (commit: AuthoritativeTaskCommit) => Promise<void>;
  /** Exact post-pull observation used only by explicit M4 shadow mode. */
  readonly authoritativeSnapshotObserved?: (
    snapshot: AuthoritativeTaskSnapshot,
  ) => Promise<void>;
  /** Test/diagnostic barrier after file write and before commit. */
  readonly beforeCreateCommit?: () => Promise<void>;
  readonly afterCreateWrites?: () => Promise<'continue' | 'interrupt'>;
  readonly afterCreateCommit?: () => Promise<'continue' | 'interrupt'>;
  /** Test/diagnostic barrier after CAS read and before its task write. */
  readonly beforeCompareAndSetWrite?: () => Promise<void>;
  readonly afterCompareAndSetWrites?: () => Promise<'continue' | 'interrupt'>;
  readonly afterCompareAndSetCommit?: () => Promise<'continue' | 'interrupt'>;
  /** Test-only crash boundary after all rewire task files are written. */
  readonly afterRewireWrites?: () => Promise<'continue' | 'interrupt'>;
  /** Test-only crash boundary after the rewire commit becomes durable. */
  readonly afterRewireCommit?: () => Promise<'continue' | 'interrupt'>;
  /** Test/diagnostic barrier after an ordinary mutation writes, before commit. */
  readonly beforeMutationCommit?: (message: string) => Promise<void>;
  /** Deterministic succession durability boundaries around atomic rename. */
  readonly beforeSuccessionRename?: () => Promise<void>;
  readonly afterSuccessionRename?: () => Promise<void>;
  /** Test-only process-death seam: leaves the durable ordinary journal intact. */
  readonly afterMutationWrites?: () => Promise<'continue' | 'interrupt'>;
  /** Test-only process-death seam immediately after commit advances HEAD. */
  readonly afterMutationCommit?: () => Promise<'continue' | 'interrupt'>;
  /** Test-only process-death seam after one rollback entry is durably restored. */
  readonly afterMutationRecoveryRestore?: (
    path: string,
    restoredCount: number,
  ) => Promise<'continue' | 'interrupt'>;
  /** Test-only crash boundary after common shadow recovery is durably synced. */
  readonly afterShadowRecoveryDurability?: (syncedPaths: readonly string[]) => Promise<void>;
}

interface RewireJournal {
  readonly version: 1;
  readonly beforeHead: string | null;
  readonly entries: readonly {
    readonly path: string;
    readonly originalBase64: string;
    readonly proposedBase64: string;
  }[];
}

const REWIRE_JOURNAL = 'hercules-dependency-rewire.json';

interface MutationJournal {
  readonly version: 2;
  readonly beforeHead: string | null;
  readonly message: string;
  readonly entries: readonly {
    readonly path: string;
    readonly originalBase64: string | null;
    readonly originalSha256: string;
    readonly proposedBase64: string | null;
    readonly proposedSha256: string;
  }[];
  readonly integrity: string;
}

const MUTATION_JOURNAL = 'hercules-control-mutation.json';

export class SimulatedControlInterruption extends Error {
  override readonly name = 'SimulatedControlInterruption';
}

export class ControlMutationConflictError extends Error {
  override readonly name = 'ControlMutationConflictError';
  readonly retryable = true;
}

export class ControlRecoveryError extends Error {
  override readonly name = 'ControlRecoveryError';
}

export class ControlMutationUsageError extends Error {
  override readonly name = 'ControlMutationUsageError';
}

export class GitControlPort implements ControlPort {
  private readonly git: ControlGit;
  private readonly shadowOutbox: Promise<ShadowDeliveryOutbox> | null;
  private serialTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly opts: GitControlPortOptions = {},
  ) {
    this.git = new ControlGit(dir);
    this.shadowOutbox = opts.authoritativeTaskCommit === undefined
      ? null
      : ShadowDeliveryOutbox.open(dir, this.git, opts.authoritativeTaskCommit, {
          ...(opts.afterShadowRecoveryDurability === undefined
            ? {}
            : { afterRecoveryDurability: opts.afterShadowRecoveryDurability }),
        });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serialTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.serialTail = previous.then(() => current);
    await previous;
    try {
      await (await this.shadowOutbox)?.recover();
      await this.recoverInterruptedMutation();
      await this.recoverInterruptedRewire();
      return await operation();
    } finally {
      release();
    }
  }

  private async prepareShadow(
    message: string,
    entries: readonly ShadowOutboxEntryInput[],
    writes: readonly Task[],
    retiredTaskIds: readonly string[],
  ): Promise<string | null> {
    if (this.shadowOutbox === null) return null;
    const beforeHead = await this.git.headHash();
    if (beforeHead === null) {
      throw new ControlRecoveryError('shadow delivery requires an initialized control HEAD');
    }
    return (await this.shadowOutbox).prepare({
      beforeHead, message, entries, writes, retiredTaskIds,
    });
  }

  private async finishShadow(
    deliveryId: string | null,
    result: CommitResult,
  ): Promise<void> {
    if (deliveryId === null || this.shadowOutbox === null) return;
    if (!result.committed || result.hash === undefined) {
      await (await this.shadowOutbox).discardUncommitted(deliveryId);
      return;
    }
    try {
      const delivered = await (await this.shadowOutbox).committed(deliveryId, result.hash);
      if (!delivered) console.error(`[hercules] shadow delivery retained for retry: ${deliveryId}`);
    } catch (error) {
      console.error(`[hercules] shadow delivery binding retained: ${(error as Error).message}`);
    }
  }

  sync(): Promise<void> {
    return this.exclusive(async () => {
      await this.git.pull();
      if (this.opts.authoritativeSnapshotObserved !== undefined) {
        await this.opts.authoritativeSnapshotObserved(await this.readVersionedTasksUnlocked());
      }
    });
  }

  read(): Promise<ControlSnapshot> {
    return this.exclusive(() => buildSnapshot(this.dir));
  }

  readVersionedTasks(): Promise<{
    readonly revision: string;
    readonly tasks: readonly Task[];
    readonly shadowPending: boolean;
  }> {
    return this.exclusive(() => this.readVersionedTasksUnlocked());
  }

  private async readVersionedTasksUnlocked(): Promise<AuthoritativeTaskSnapshot> {
    const before = await this.git.headHash();
    if (before === null) throw new ControlRecoveryError('versioned task read requires a control HEAD');
    if (!(await this.git.isClean())) {
      throw new ControlRecoveryError('versioned task read requires exact clean authority bytes');
    }
    const snapshot = await buildSnapshot(this.dir);
    const after = await this.git.headHash();
    if (after !== before || !(await this.git.isClean())) {
      throw new ControlRecoveryError('control authority changed during versioned task read');
    }
    return {
      revision: before,
      tasks: snapshot.tasks,
      shadowPending: await (await this.shadowOutbox)?.hasPending() ?? false,
    };
  }

  writeTask(_task: Task): Promise<void> {
    return Promise.reject(new ControlMutationUsageError(
      'GitControlPort task writes require mutateCommitted or compare-and-set ownership',
    ));
  }

  createTaskCommitted(task: Task, message: string): Promise<CommitResult> {
    return this.exclusive(async () => {
      const path = taskPathFor(this.dir, task.id);
      try {
        await stat(path);
        throw new ControlMutationConflictError(
          `task '${task.id}' already exists during atomic create`,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (!(await this.git.isClean())) {
        throw new ControlMutationConflictError('control repo is dirty before atomic task create');
      }
      const relativePath = `tasks/${task.id}.md`;
      const shadowDeliveryId = await this.prepareShadow(message, [{
        path: relativePath,
        original: null,
        proposed: Buffer.from(serializeTask(task), 'utf8'),
      }], [task], []);
      await writeTaskFile(this.dir, task);
      let rolledBack = false;
      const rollback = async (): Promise<void> => {
        if (rolledBack) return;
        rolledBack = true;
        await deleteTaskFile(this.dir, task.id);
        await this.git.removePathFromIndex(relativePath);
      };
      try {
        if ((await this.opts.afterCreateWrites?.()) === 'interrupt') {
          throw new SimulatedControlInterruption('interrupted after atomic create writes');
        }
        await this.opts.beforeCreateCommit?.();
        const result = await this.git.commitPaths([relativePath], message);
        if (!result.committed) await rollback();
        if (result.committed && (await this.opts.afterCreateCommit?.()) === 'interrupt') {
          throw new SimulatedControlInterruption('interrupted after atomic create commit');
        }
        await this.finishShadow(shadowDeliveryId, result);
        return result;
      } catch (err) {
        if (err instanceof SimulatedControlInterruption) throw err;
        if (shadowDeliveryId !== null) {
          const committedRevision = await (await this.shadowOutbox!).recoverPrepared(shadowDeliveryId);
          if (committedRevision !== null) {
            return { committed: true, hash: committedRevision };
          }
        } else {
          await rollback();
        }
        throw err;
      }
    });
  }

  compareAndSetTaskCommitted(
    id: string,
    expected: {
      readonly state: Task['state'];
      readonly expectedBaseRevision: Task['expectedBaseRevision'] | undefined;
      readonly expectedRemoteTip: Task['expectedRemoteTip'] | undefined;
    },
    to: Task['state'],
    fields: Partial<Task>,
    message: string,
  ): Promise<{ readonly matched: boolean; readonly committed: boolean; readonly hash?: string }> {
    return this.exclusive(async () => {
      const current = (await buildSnapshot(this.dir)).tasks.find((task) => task.id === id);
      if (
        !current ||
        current.state !== expected.state ||
        current.expectedBaseRevision !== expected.expectedBaseRevision ||
        current.expectedRemoteTip !== expected.expectedRemoteTip
      ) {
        return { matched: false, committed: false };
      }
      const path = taskPathFor(this.dir, id);
      const originalBytes = await readFile(path);
      if (!(await this.git.isClean())) {
        throw new ControlMutationConflictError(
          'control repo is dirty before atomic task compare-and-set',
        );
      }
      await this.opts.beforeCompareAndSetWrite?.();
      const next: Task = { ...current, ...fields, state: to };
      const relativePath = `tasks/${id}.md`;
      const shadowDeliveryId = await this.prepareShadow(message, [{
        path: relativePath,
        original: originalBytes,
        proposed: Buffer.from(serializeTask(next), 'utf8'),
      }], [next], []);
      await writeTaskFile(this.dir, next);
      let rolledBack = false;
      const rollback = async (): Promise<void> => {
        if (rolledBack) return;
        rolledBack = true;
        await writeFile(path, originalBytes);
        await this.git.resetPath(relativePath);
      };
      try {
        if ((await this.opts.afterCompareAndSetWrites?.()) === 'interrupt') {
          throw new SimulatedControlInterruption('interrupted after compare-and-set writes');
        }
        const result = await this.git.commitPaths([relativePath], message);
        if (!result.committed) await rollback();
        if (result.committed && (await this.opts.afterCompareAndSetCommit?.()) === 'interrupt') {
          throw new SimulatedControlInterruption('interrupted after compare-and-set commit');
        }
        await this.finishShadow(shadowDeliveryId, result);
        return { matched: true, ...result };
      } catch (err) {
        if (err instanceof SimulatedControlInterruption) throw err;
        if (shadowDeliveryId !== null) {
          const committedRevision = await (await this.shadowOutbox!).recoverPrepared(shadowDeliveryId);
          if (committedRevision !== null) {
            return { matched: true, committed: true, hash: committedRevision };
          }
        } else {
          await rollback();
        }
        throw err;
      }
    });
  }

  deleteTask(_id: string): Promise<void> {
    return Promise.reject(new ControlMutationUsageError(
      'GitControlPort task deletion requires mutateCommitted ownership',
    ));
  }

  writeRepos(_config: ReposConfig): Promise<void> {
    return Promise.reject(new ControlMutationUsageError(
      'GitControlPort repository writes require mutateCommitted ownership',
    ));
  }

  async readRelease(repoKey: string): Promise<Release | null> {
    return this.exclusive(() => readReleaseFile(this.dir, repoKey));
  }

  writeRelease(_release: Release): Promise<void> {
    return Promise.reject(new ControlMutationUsageError(
      'GitControlPort release writes require mutateCommitted ownership',
    ));
  }

  readSuccession(repoKey: string): Promise<WorkspaceSuccessionLedger | null> {
    return this.exclusive(() => readSuccessionFile(this.dir, repoKey));
  }

  writeSuccession(_ledger: WorkspaceSuccessionLedger): Promise<void> {
    return Promise.reject(new ControlMutationUsageError(
      'GitControlPort succession writes require mutateCommitted ownership',
    ));
  }

  commit(_message: string): Promise<CommitResult> {
    return Promise.reject(new ControlMutationUsageError(
      'GitControlPort commits require an ownership-scoped atomic operation',
    ));
  }

  mutateCommitted(mutation: ControlMutation, message: string): Promise<CommitResult> {
    return this.exclusive(async () => {
      if (!(await this.git.isClean())) {
        throw new ControlMutationConflictError('control repo is dirty before atomic mutation');
      }
      const taskWrites = mutation.writeTasks ?? [];
      const taskDeletes = mutation.deleteTaskIds ?? [];
      const releases = mutation.writeReleases ?? [];
      const successions = mutation.writeSuccessions ?? [];
      const declared = [
        ...taskWrites.map(({ next }) => ({
          path: `tasks/${next.id}.md`,
          absolutePath: taskPathFor(this.dir, next.id),
        })),
        ...taskDeletes.map((id) => ({
          path: `tasks/${id}.md`,
          absolutePath: taskPathFor(this.dir, id),
        })),
        ...(mutation.repos ? [{ path: 'repos.yaml', absolutePath: `${this.dir}/repos.yaml` }] : []),
        ...releases.map((release) => ({
          path: `releases/${release.repoKey}.md`,
          absolutePath: releasePathFor(this.dir, release.repoKey),
        })),
        ...successions.map(({ next }) => ({
          path: `successions/${next.repoKey}.json`,
          absolutePath: successionPathFor(this.dir, next.repoKey),
        })),
      ];
      const paths = declared.map((entry) => entry.path);
      if (new Set(paths).size !== paths.length) {
        throw new ControlMutationConflictError('atomic mutation contains duplicate paths');
      }
      const snapshot = await buildSnapshot(this.dir);
      for (const { expected, next } of taskWrites) {
        const current = snapshot.tasks.find((task) => task.id === next.id) ?? null;
        if (
          (expected === null && current !== null) ||
          (expected !== null && (
            current === null || serializeTask(current) !== serializeTask(expected)
          ))
        ) {
          throw new ControlMutationConflictError(
            `task '${next.id}' changed before atomic mutation`,
          );
        }
      }
      for (const { expected, next } of successions) {
        const current = await readSuccessionFile(this.dir, next.repoKey);
        if (
          (expected === null && current !== null) ||
          (expected !== null && (
            current === null || serializeSuccessionLedger(current) !== serializeSuccessionLedger(expected)
          ))
        ) {
          throw new ControlMutationConflictError(
            `succession '${next.repoKey}' changed before atomic mutation`,
          );
        }
      }
      const originals = await Promise.all(declared.map(async ({ path, absolutePath }) => {
        try {
          return { path, absolutePath, bytes: await readFile(absolutePath) as Buffer };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { path, absolutePath, bytes: null };
          }
          throw err;
        }
      }));
      const proposedByPath = new Map<string, Buffer | null>();
      for (const { next } of taskWrites) {
        proposedByPath.set(`tasks/${next.id}.md`, Buffer.from(serializeTask(next), 'utf8'));
      }
      for (const id of taskDeletes) proposedByPath.set(`tasks/${id}.md`, null);
      if (mutation.repos) {
        proposedByPath.set('repos.yaml', Buffer.from(serializeReposConfig(mutation.repos), 'utf8'));
      }
      for (const release of releases) {
        proposedByPath.set(
          `releases/${release.repoKey}.md`,
          Buffer.from(serializeRelease(release), 'utf8'),
        );
      }
      for (const { next } of successions) {
        proposedByPath.set(
          `successions/${next.repoKey}.json`,
          Buffer.from(serializeSuccessionLedger(next), 'utf8'),
        );
      }
      const journalPayload: Omit<MutationJournal, 'integrity'> = {
        version: 2,
        beforeHead: await this.git.headHash(),
        message,
        entries: originals.map((original) => {
          const proposed = proposedByPath.get(original.path);
          if (proposed === undefined) {
            throw new ControlRecoveryError('ordinary mutation proposal is incomplete');
          }
          return {
            path: original.path,
            originalBase64: original.bytes?.toString('base64') ?? null,
            originalSha256: mutationBytesHash(original.bytes),
            proposedBase64: proposed?.toString('base64') ?? null,
            proposedSha256: mutationBytesHash(proposed),
          };
        }),
      };
      const journal: MutationJournal = {
        ...journalPayload,
        integrity: mutationJournalIntegrity(journalPayload),
      };
      const hasTaskMutation = taskWrites.length > 0 || taskDeletes.length > 0;
      const shadowDeliveryId = hasTaskMutation
        ? await this.prepareShadow(
            message,
            originals.map((original) => ({
              path: original.path,
              original: original.bytes,
              proposed: proposedByPath.get(original.path)!,
            })),
            taskWrites.map(({ next }) => next),
            taskDeletes,
          )
        : null;
      const rollback = async (): Promise<void> => {
        for (const entry of journal.entries) {
          const absolutePath = mutationPath(this.dir, entry.path);
          await restoreJournalBytes(absolutePath, entry.originalBase64);
          if (entry.originalBase64 === null) await this.git.removePathFromIndex(entry.path);
          else await this.git.resetPath(entry.path);
          await this.syncControlIndex();
        }
        await this.assertMutationRestored(journal);
      };
      try {
        if (paths.length > 0) await this.writeMutationJournal(journal);
        for (const { next } of taskWrites) await writeTaskFile(this.dir, next);
        for (const id of taskDeletes) await deleteTaskFile(this.dir, id);
        if ((await this.opts.afterMutationWrites?.()) === 'interrupt') {
          throw new SimulatedControlInterruption('interrupted after ordinary mutation writes');
        }
        if (mutation.repos) await writeReposFile(this.dir, mutation.repos);
        for (const release of releases) await writeReleaseFile(this.dir, release);
        for (const { next } of successions) await writeSuccessionFile(this.dir, next, {
          ...(this.opts.beforeSuccessionRename
            ? { beforeRename: this.opts.beforeSuccessionRename }
            : {}),
          ...(this.opts.afterSuccessionRename
            ? { afterRename: this.opts.afterSuccessionRename }
            : {}),
        });
        await syncMutationPaths(originals.map((entry) => entry.absolutePath));
        await this.opts.beforeMutationCommit?.(message);
        const result = await this.git.commitPaths(paths, message);
        if (!result.committed) {
          await rollback();
        } else {
          if ((await this.opts.afterMutationCommit?.()) === 'interrupt') {
            throw new SimulatedControlInterruption('interrupted after ordinary mutation commit');
          }
          if (await this.mutationCommitState(journal) !== 'committed') {
            throw new ControlRecoveryError(
              'ordinary mutation commit does not match the exact audited commit',
            );
          }
          if (!(await this.git.isClean())) {
            throw new ControlRecoveryError(
              'ordinary mutation commit left a dirty control tree',
            );
          }
          await this.syncControlIndex();
        }
        if (paths.length > 0) await this.removeMutationJournal();
        await this.finishShadow(shadowDeliveryId, result);
        return result;
      } catch (err) {
        if (err instanceof SimulatedControlInterruption) throw err;
        const commitState = paths.length > 0
          ? await this.mutationCommitState(journal)
          : 'before';
        if (commitState === 'committed') {
          throw new ControlRecoveryError(
            `ordinary mutation committed durably but cleanup failed: ${errorMessage(err)}`,
          );
        }
        if (commitState === 'conflict') {
          throw new ControlRecoveryError(
            'ordinary mutation recovery conflict: HEAD advanced without the exact audited commit',
          );
        }
        await rollback();
        if (paths.length > 0) await this.removeMutationJournal();
        if (shadowDeliveryId !== null) {
          await (await this.shadowOutbox!).discardUncommitted(shadowDeliveryId);
        }
        if (err instanceof ControlConflictError) {
          throw new ControlMutationConflictError(err.message);
        }
        throw err;
      }
    });
  }

  private async mutationJournalPath(): Promise<string> {
    return `${await this.git.gitDir()}/${MUTATION_JOURNAL}`;
  }

  private async writeMutationJournal(journal: MutationJournal): Promise<void> {
    const path = await this.mutationJournalPath();
    await writeDurableJson(path, journal);
  }

  private async removeMutationJournal(): Promise<void> {
    const path = await this.mutationJournalPath();
    await removeDurableFile(path);
    await removeDurableFile(`${path}.tmp`);
  }

  private async recoverInterruptedMutation(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(await this.mutationJournalPath(), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await removeDurableFile(`${await this.mutationJournalPath()}.tmp`);
        return;
      }
      throw new ControlRecoveryError(`invalid ordinary mutation recovery journal: ${errorMessage(err)}`);
    }
    const journal = parseMutationJournal(raw);
    const entries = journal.entries.map((entry) => ({
      ...entry,
      absolutePath: mutationPath(this.dir, entry.path),
    }));
    const state = await this.mutationCommitState(journal);
    if (state === 'conflict') {
      throw new ControlRecoveryError(
        'ordinary mutation recovery conflict: HEAD or declared bytes are ambiguous',
      );
    }
    let restoredCount = 0;
    for (const entry of entries) {
      const current = await readOptionalBytes(entry.absolutePath);
      const currentBase64 = current?.toString('base64') ?? null;
      if (state === 'committed') {
        if (currentBase64 !== entry.proposedBase64) {
          throw new ControlRecoveryError('ordinary mutation recovery found concurrent declared-path work');
        }
        continue;
      }
      if (currentBase64 !== entry.originalBase64 && currentBase64 !== entry.proposedBase64) {
        throw new ControlRecoveryError('ordinary mutation rollback found concurrent declared-path work');
      }
      await restoreJournalBytes(entry.absolutePath, entry.originalBase64);
      if (entry.originalBase64 === null) await this.git.removePathFromIndex(entry.path);
      else await this.git.resetPath(entry.path);
      await this.syncControlIndex();
      restoredCount += 1;
      if ((await this.opts.afterMutationRecoveryRestore?.(
        entry.path,
        restoredCount,
      )) === 'interrupt') {
        throw new SimulatedControlInterruption('interrupted during ordinary mutation recovery');
      }
    }
    if (state === 'committed') {
      if (!(await this.git.isClean())) {
        throw new ControlRecoveryError('ordinary mutation adoption found a dirty control tree');
      }
    } else {
      await this.assertMutationRestored(journal);
    }
    await this.cleanupSuccessionTemps(entries.map((entry) => entry.path));
    await this.removeMutationJournal();
  }

  private async assertMutationRestored(journal: MutationJournal): Promise<void> {
    if (await this.git.headHash() !== journal.beforeHead) {
      throw new ControlRecoveryError('ordinary mutation rollback changed control HEAD');
    }
    for (const entry of journal.entries) {
      const current = await readOptionalBytes(mutationPath(this.dir, entry.path));
      if ((current?.toString('base64') ?? null) !== entry.originalBase64 ||
          mutationBytesHash(current) !== entry.originalSha256) {
        throw new ControlRecoveryError('ordinary mutation rollback did not restore exact original bytes');
      }
    }
    if (!(await this.git.isClean())) {
      throw new ControlRecoveryError('ordinary mutation rollback left a dirty control tree');
    }
  }

  private async syncControlIndex(): Promise<void> {
    const gitDirectory = await this.git.gitDir();
    await syncMutationPaths([`${gitDirectory}/index`]);
  }

  private async mutationCommitState(
    journal: MutationJournal,
  ): Promise<'before' | 'committed' | 'conflict'> {
    const head = await this.git.headHash();
    if (head === journal.beforeHead) return 'before';
    if (head === null) return 'conflict';
    const revision = journal.beforeHead === null
      ? head
      : (await this.git.firstParentAfter(journal.beforeHead, head))[0];
    if (revision === undefined) return 'conflict';
    const metadata = await this.git.commitMetadata(revision);
    const paths = journal.entries
      .filter((entry) => entry.originalBase64 !== entry.proposedBase64)
      .map((entry) => entry.path)
      .sort();
    if (metadata.parent !== journal.beforeHead || metadata.message !== journal.message ||
        JSON.stringify(metadata.paths) !== JSON.stringify(paths)) return 'conflict';
    for (const entry of journal.entries) {
      const revisionText = await this.git.readPathAtRevision(revision, entry.path);
      const headBytes = revisionText === null ? null : Buffer.from(revisionText, 'utf8');
      if ((headBytes?.toString('base64') ?? null) !== entry.proposedBase64 ||
          mutationBytesHash(headBytes) !== entry.proposedSha256) return 'conflict';
    }
    return 'committed';
  }

  private async cleanupSuccessionTemps(paths: readonly string[]): Promise<void> {
    const repoKeys = paths
      .filter((path) => path.startsWith('successions/') && path.endsWith('.json'))
      .map((path) => path.slice('successions/'.length, -'.json'.length));
    if (repoKeys.length === 0) return;
    const directory = `${this.dir}/successions`;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const repoKey of repoKeys) {
      for (const name of names.filter((candidate) =>
        candidate.startsWith(`.${repoKey}.`) && candidate.endsWith('.tmp'))) {
        await removeDurableFile(`${directory}/${name}`);
      }
    }
  }

  rewireDependenciesCommitted(
    changes: readonly DependencyRewireChange[],
    message: string,
  ): Promise<CommitResult> {
    return this.exclusive(async () => {
      const snapshot = await buildSnapshot(this.dir);
      const validated = validateDependencyRewire(snapshot.tasks, changes);
      if (!validated.ok) {
        throw new ControlMutationConflictError(validated.reason);
      }
      const replacements = validated.tasks;
      if (!(await this.git.isClean())) {
        throw new ControlMutationConflictError(
          'control repo is dirty before atomic dependency rewire',
        );
      }
      const originals = await Promise.all(replacements.map(async (task) => ({
        path: taskPathFor(this.dir, task.id),
        relativePath: `tasks/${task.id}.md`,
        bytes: await readFile(taskPathFor(this.dir, task.id)),
      })));
      const paths = originals.map((entry) => entry.relativePath);
      const journal: RewireJournal = {
        version: 1,
        beforeHead: await this.git.headHash(),
        entries: replacements.map((replacement, index) => ({
          path: paths[index]!,
          originalBase64: originals[index]!.bytes.toString('base64'),
          proposedBase64: Buffer.from(serializeTask(replacement), 'utf8').toString('base64'),
        })),
      };
      const shadowDeliveryId = await this.prepareShadow(
        message,
        originals.map((original, index) => ({
          path: original.relativePath,
          original: original.bytes,
          proposed: Buffer.from(serializeTask(replacements[index]!), 'utf8'),
        })),
        replacements,
        [],
      );
      try {
        // Journal precedes every task write. A restart can distinguish rollback
        // (HEAD unchanged) from roll-forward (HEAD contains every proposal).
        await this.writeRewireJournal(journal);
        for (const replacement of replacements) await writeTaskFile(this.dir, replacement);
        if ((await this.opts.afterRewireWrites?.()) === 'interrupt') {
          throw new SimulatedControlInterruption('interrupted after dependency writes');
        }
        const result = await this.git.commitPaths(paths, message);
        if (!result.committed) throw new ControlRecoveryError('dependency rewire produced no commit');
        if ((await this.opts.afterRewireCommit?.()) === 'interrupt') {
          throw new SimulatedControlInterruption('interrupted after dependency commit');
        }
        await this.removeRewireJournal();
        await this.finishShadow(shadowDeliveryId, result);
        return result;
      } catch (err) {
        if (err instanceof SimulatedControlInterruption) throw err;
        const commitState = await this.rewireCommitState(journal);
        if (commitState === 'committed') {
          throw new ControlRecoveryError(
            `dependency rewire committed durably but cleanup failed: ${errorMessage(err)}`,
          );
        }
        if (commitState === 'conflict') {
          throw new ControlRecoveryError(
            'dependency rewire recovery conflict: HEAD advanced without the audited batch',
          );
        }
        for (const original of originals) {
          await writeFile(original.path, original.bytes);
          await this.git.resetPath(original.relativePath);
        }
        await this.removeRewireJournal();
        if (shadowDeliveryId !== null) {
          await (await this.shadowOutbox!).discardUncommitted(shadowDeliveryId);
        }
        if (err instanceof ControlConflictError) {
          throw new ControlMutationConflictError(err.message);
        }
        throw err;
      }
    });
  }

  private async rewireJournalPath(): Promise<string> {
    return `${await this.git.gitDir()}/${REWIRE_JOURNAL}`;
  }

  private async writeRewireJournal(journal: RewireJournal): Promise<void> {
    const path = await this.rewireJournalPath();
    const temp = `${path}.tmp`;
    await mkdir(await this.git.gitDir(), { recursive: true });
    await writeFile(temp, JSON.stringify(journal), 'utf8');
    const handle = await open(temp, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  }

  private async removeRewireJournal(): Promise<void> {
    try {
      await unlink(await this.rewireJournalPath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private async recoverInterruptedRewire(): Promise<void> {
    let parsed: RewireJournal;
    try {
      parsed = JSON.parse(
        await readFile(await this.rewireJournalPath(), 'utf8'),
      ) as RewireJournal;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new ControlRecoveryError('invalid dependency rewire recovery journal');
    }
    const recoveredEntries = parsed.entries.map((entry) => ({
      ...entry,
      absolutePath: journalTaskPath(this.dir, entry.path),
    }));
    const commitState = await this.rewireCommitState(parsed);
    if (commitState === 'conflict') {
      throw new ControlRecoveryError('dependency rewire recovery conflict: HEAD advanced without the audited batch');
    }
    const committed = commitState === 'committed';
    for (const entry of recoveredEntries) {
      await writeFile(
        entry.absolutePath,
        Buffer.from(committed ? entry.proposedBase64 : entry.originalBase64, 'base64'),
      );
      if (!committed) await this.git.resetPath(entry.path);
    }
    await this.removeRewireJournal();
  }

  private async rewireCommitState(
    journal: RewireJournal,
  ): Promise<'before' | 'committed' | 'conflict'> {
    const head = await this.git.headHash();
    if (head === journal.beforeHead) return 'before';
    const committed = (await Promise.all(journal.entries.map(async (entry) => {
      try {
        return Buffer.from(await this.git.readPathAtHead(entry.path), 'utf8').toString('base64') ===
          entry.proposedBase64;
      } catch {
        return false;
      }
    }))).every(Boolean);
    return committed ? 'committed' : 'conflict';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function journalTaskPath(dir: string, path: string): string {
  if (!path.startsWith('tasks/') || !path.endsWith('.md')) {
    throw new ControlRecoveryError('invalid task path in dependency rewire recovery journal');
  }
  const id = path.slice('tasks/'.length, -'.md'.length);
  const absolute = taskPathFor(dir, id);
  if (relative(dir, absolute) !== path) {
    throw new ControlRecoveryError('non-canonical task path in dependency rewire recovery journal');
  }
  return absolute;
}

function mutationBytesHash(bytes: Buffer | null): string {
  return bytes === null
    ? 'absent'
    : `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function mutationJournalIntegrity(journal: Omit<MutationJournal, 'integrity'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(journal)).digest('hex')}`;
}

function parseMutationJournal(raw: unknown): MutationJournal {
  if (!raw || typeof raw !== 'object') {
    throw new ControlRecoveryError('invalid ordinary mutation recovery journal');
  }
  const value = raw as Record<string, unknown>;
  if (value['version'] !== 2 ||
      !(value['beforeHead'] === null ||
        (typeof value['beforeHead'] === 'string' && /^[0-9a-f]{40}$/.test(value['beforeHead']))) ||
      typeof value['message'] !== 'string' || !Array.isArray(value['entries']) ||
      value['entries'].length === 0 || typeof value['integrity'] !== 'string') {
    throw new ControlRecoveryError('invalid ordinary mutation recovery journal');
  }
  const paths = new Set<string>();
  const entries = value['entries'].map((rawEntry): MutationJournal['entries'][number] => {
    if (!rawEntry || typeof rawEntry !== 'object') {
      throw new ControlRecoveryError('invalid ordinary mutation recovery entry');
    }
    const entry = rawEntry as Record<string, unknown>;
    const path = entry['path'];
    const originalBase64 = entry['originalBase64'];
    const originalSha256 = entry['originalSha256'];
    const proposedBase64 = entry['proposedBase64'];
    const proposedSha256 = entry['proposedSha256'];
    if (typeof path !== 'string' || paths.has(path) ||
        !(originalBase64 === null || isCanonicalBase64(originalBase64)) ||
        !(proposedBase64 === null || isCanonicalBase64(proposedBase64)) ||
        typeof originalSha256 !== 'string' || typeof proposedSha256 !== 'string') {
      throw new ControlRecoveryError('invalid ordinary mutation recovery entry');
    }
    const original = originalBase64 === null ? null : Buffer.from(originalBase64, 'base64');
    const proposed = proposedBase64 === null ? null : Buffer.from(proposedBase64, 'base64');
    if (mutationBytesHash(original) !== originalSha256) {
      throw new ControlRecoveryError('ordinary mutation original hash mismatch');
    }
    if (mutationBytesHash(proposed) !== proposedSha256) {
      throw new ControlRecoveryError('ordinary mutation proposal hash mismatch');
    }
    paths.add(path);
    return { path, originalBase64, originalSha256, proposedBase64, proposedSha256 };
  });
  const payload: Omit<MutationJournal, 'integrity'> = {
    version: 2,
    beforeHead: value['beforeHead'] as string | null,
    message: value['message'],
    entries,
  };
  if (mutationJournalIntegrity(payload) !== value['integrity']) {
    throw new ControlRecoveryError('ordinary mutation journal integrity mismatch');
  }
  return { ...payload, integrity: value['integrity'] };
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function mutationPath(dir: string, path: string): string {
  if (path === 'repos.yaml') return `${dir}/repos.yaml`;
  if (path.startsWith('tasks/') && path.endsWith('.md')) {
    return journalTaskPath(dir, path);
  }
  if (path.startsWith('releases/') && path.endsWith('.md')) {
    const key = path.slice('releases/'.length, -'.md'.length);
    const absolute = releasePathFor(dir, key);
    if (relative(dir, absolute) === path) return absolute;
  }
  if (path.startsWith('successions/') && path.endsWith('.json')) {
    const key = path.slice('successions/'.length, -'.json'.length);
    const absolute = successionPathFor(dir, key);
    if (relative(dir, absolute) === path) return absolute;
  }
  throw new ControlRecoveryError('non-canonical path in ordinary mutation recovery journal');
}

async function readOptionalBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function restoreJournalBytes(path: string, base64: string | null): Promise<void> {
  const temp = `${path}.hercules-restore.tmp`;
  if (base64 === null) {
    await removeDurableFile(path);
    await removeDurableFile(temp);
    return;
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  await writeFile(temp, Buffer.from(base64, 'base64'), { mode: 0o600 });
  const file = await open(temp, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const dirHandle = await open(directory, 'r');
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

async function syncMutationPaths(paths: readonly string[]): Promise<void> {
  const directories = new Set<string>();
  for (const path of paths) {
    directories.add(dirname(path));
    try {
      const file = await open(path, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  for (const directoryPath of directories) {
    let directory;
    try {
      directory = await open(directoryPath, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  const file = await open(temp, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const dirHandle = await open(directory, 'r');
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

export interface DurableRemovalOperations {
  readonly unlink: (path: string) => Promise<void>;
  readonly openDirectory: (path: string) => Promise<{
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
}

const durableRemovalOperations: DurableRemovalOperations = {
  unlink,
  openDirectory: (path) => open(path, 'r'),
};

export async function removeDurableFile(
  path: string,
  operations: DurableRemovalOperations = durableRemovalOperations,
): Promise<void> {
  try {
    await operations.unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let directory: Awaited<ReturnType<DurableRemovalOperations['openDirectory']>>;
  try {
    directory = await operations.openDirectory(dirname(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
