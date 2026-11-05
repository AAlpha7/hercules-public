/**
 * Domain layer — isolation allocation types (SPEC §8.2, §8.3).
 *
 * Pure types + the branch-naming chokepoint. The daemon owns *allocation*
 * (slug, port, scratch dir); the repo's boot hook consumes it to stand up an
 * isolated instance. No IO here.
 */
import { isValidIdentifier, IdentifierError } from './task.js';
import type { TaskBranchLease } from './taskBranchLease.js';

/** All per-task branches live under this prefix. */
export const BRANCH_PREFIX = 'hercules/';

/**
 * The branch a task's worktree runs on. The task id is the single chokepoint
 * for path/branch safety (SPEC §10), so validate it here too.
 */
export function branchFor(taskId: string): string {
  if (!isValidIdentifier(taskId)) {
    throw new IdentifierError(`task id '${taskId}' is not a safe identifier`);
  }
  return `${BRANCH_PREFIX}${taskId}`;
}

/**
 * The isolation contract handed to a repo's boot hook (SPEC §8.3). The boot hook
 * uses these to stand up an isolated instance: unique port, isolated ephemeral
 * DB/schema under the scratch dir, etc.
 */
export interface AllocationContext {
  /** Unique per worktree (the task id). */
  readonly slug: string;
  /** Allocated port (base) so booted apps don't collide. */
  readonly port: number;
  /** Per-worktree writable temp dir. */
  readonly scratchDir: string;
}

/** A fully provisioned, isolated workspace for one task (SPEC §8.2). */
export interface Workspace {
  readonly taskId: string;
  readonly repo: string;
  /** The git worktree path; MUST resolve inside the isolation root (§10). */
  readonly dir: string;
  /** The task's branch, e.g. hercules/ABC-12. */
  readonly branch: string;
  readonly allocation: AllocationContext;
  /** Exact ownership returned before any task or session process can spawn. */
  readonly branchLease: TaskBranchLease;
}

const REMOTE_FACTORY_BASE = '0'.repeat(40);

/**
 * Logical workspace for a remote Cursor Cloud factory run.
 * No directory, port, or branch lease is allocated on the host.
 */
export function remoteFactoryWorkspace(input: {
  readonly taskId: string;
  readonly repo: string;
}): Workspace {
  if (!isValidIdentifier(input.repo)) {
    throw new IdentifierError(`repo key '${input.repo}' is not a safe identifier`);
  }
  const branch = branchFor(input.taskId);
  const dir = `/cursor-cloud/${input.repo}/${input.taskId}`;
  return {
    taskId: input.taskId,
    repo: input.repo,
    dir,
    branch,
    allocation: { slug: input.taskId, port: 0, scratchDir: `${dir}/.scratch` },
    branchLease: {
      expectedBaseRevision: REMOTE_FACTORY_BASE,
      expectedRemoteTip: null,
    },
  };
}
