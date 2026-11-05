/**
 * Wrap a {@link ControlPort} so every committed mutation re-reads the control
 * snapshot into the live runtime view (SSE + GET /api/state).
 *
 * Phone/API actions go through ActionService out-of-band from the tick loop.
 * Without this, the UI can flash pre-mutation state for up to one tick
 * (Approve plan planPending regression case study).
 */
import type { ControlPort } from './orchestrator.js';
import type { Task } from '../domain/task.js';
import type { ReposConfig } from '../domain/repos.js';
import type { Release } from '../domain/release.js';
import type { WorkspaceSuccessionLedger } from '../domain/workspaceSuccession.js';

export function withControlSnapshotRefresh(
  control: ControlPort,
  refresh: () => Promise<void>,
): ControlPort {
  return {
    sync: (): Promise<void> => control.sync(),
    read: () => control.read(),
    ...(control.mutateCommitted
      ? {
          mutateCommitted: async (...args: Parameters<
            NonNullable<ControlPort['mutateCommitted']>
          >) => {
            const result = await control.mutateCommitted!(...args);
            await refresh();
            return result;
          },
        }
      : {}),
    writeTask: (task: Task): Promise<void> => control.writeTask(task),
    ...(control.createTaskCommitted
      ? {
          createTaskCommitted: async (task: Task, message: string) => {
            const result = await control.createTaskCommitted!(task, message);
            await refresh();
            return result;
          },
        }
      : {}),
    ...(control.rewireDependenciesCommitted
      ? {
          rewireDependenciesCommitted: async (...args: Parameters<
            NonNullable<ControlPort['rewireDependenciesCommitted']>
          >) => {
            const result = await control.rewireDependenciesCommitted!(...args);
            if (result.committed) await refresh();
            return result;
          },
        }
      : {}),
    ...(control.compareAndSetTaskCommitted
      ? {
          compareAndSetTaskCommitted: async (...args: Parameters<
            NonNullable<ControlPort['compareAndSetTaskCommitted']>
          >) => {
            const result = await control.compareAndSetTaskCommitted!(...args);
            if (result.committed) await refresh();
            return result;
          },
        }
      : {}),
    deleteTask: (id: string): Promise<void> => control.deleteTask(id),
    writeRepos: (config: ReposConfig): Promise<void> => control.writeRepos(config),
    commit: async (message: string) => {
      const result = await control.commit(message);
      // Always refresh after an action commit attempt. Even when git reports
      // no-op (identical tree), callers may have intended a view sync.
      await refresh();
      return result;
    },
    // Forward the OPTIONAL release methods (receiver-bound). Dropping them made
    // the Releases panel read emptyRelease while the file said ready
    // (2026-07-17). Any future optional ControlPort method must be added here.
    ...(control.readRelease
      ? { readRelease: (repoKey: string) => control.readRelease!(repoKey) }
      : {}),
    ...(control.writeRelease
      ? { writeRelease: (release: Release) => control.writeRelease!(release) }
      : {}),
    ...(control.readSuccession
      ? { readSuccession: (repoKey: string) => control.readSuccession!(repoKey) }
      : {}),
    ...(control.writeSuccession
      ? {
          writeSuccession: (ledger: WorkspaceSuccessionLedger) =>
            control.writeSuccession!(ledger),
        }
      : {}),
  };
}
