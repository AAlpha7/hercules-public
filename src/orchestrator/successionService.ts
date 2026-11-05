/** Assemble the sealed post-merge receipt; persistence stays in ControlPort's atomic mutation. */
import type { RepoConfig } from '../domain/repos.js';
import type { Task } from '../domain/task.js';
import {
  appendSuccessionReceipt,
  buildSuccessionReceipt,
  type WorkspaceSuccessionLedger,
} from '../domain/workspaceSuccession.js';
import { observeRegisteredCheckouts } from '../isolation/checkoutObserve.js';
import type { ControlPort } from './orchestrator.js';

export class SuccessionServiceError extends Error {
  override readonly name = 'SuccessionServiceError';
}

export async function prepareSuccessionLedger(input: {
  readonly control: ControlPort;
  readonly repo: RepoConfig;
  readonly priorDefaultRevision: string;
  readonly gateMergeSha: string;
  readonly canonicalDefaultRevision: string;
  readonly candidates: readonly {
    readonly task: Task;
    readonly verifiedSha: string;
    readonly tipSha: string;
    /**
     * Exact remote-tip lease proven at precheck. Set when the persisted lease
     * was null but origin held exactly the verified tip (C3.55) — the task
     * record itself stays untouched so the stamp CAS still matches disk.
     */
    readonly remoteTipLease?: string | null;
  }[];
  readonly managedDisposition: (taskId: string) => Promise<import('../domain/workspaceSuccession.js').ManagedDisposition>;
  readonly createdAt: string;
}): Promise<{
  readonly expected: WorkspaceSuccessionLedger | null;
  readonly next: WorkspaceSuccessionLedger;
}> {
  if (!input.control.readSuccession) {
    throw new SuccessionServiceError('succession receipt store is unavailable');
  }
  const expected = await input.control.readSuccession(input.repo.key);
  const base: WorkspaceSuccessionLedger = expected ?? {
    version: 2,
    repoKey: input.repo.key,
    receipts: [],
  };
  const external = await observeRegisteredCheckouts(
    input.repo.ownerCheckouts ?? [],
    input.canonicalDefaultRevision,
  );
  const managed = await Promise.all(input.candidates.map(async ({ task }) => ({
    taskId: task.id,
    disposition: await input.managedDisposition(task.id),
  })));
  const receipt = buildSuccessionReceipt({
    repoKey: input.repo.key,
    createdAt: input.createdAt,
    priorDefaultRevision: input.priorDefaultRevision,
    gateMergeSha: input.gateMergeSha,
    canonicalDefaultRevision: input.canonicalDefaultRevision,
    candidates: input.candidates.map(({ task, verifiedSha, remoteTipLease }) => ({
      taskId: task.id,
      verifiedSha,
      lease: {
        branch: `hercules/${task.id}`,
        expectedBaseRevision: task.expectedBaseRevision ?? '',
        expectedRemoteTip: remoteTipLease ?? task.expectedRemoteTip ?? '',
      },
    })),
    managed,
    external,
  });
  return { expected, next: appendSuccessionReceipt(base, receipt) };
}
