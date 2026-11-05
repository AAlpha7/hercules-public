/** Bounded, read-only proof for the empty exact-lease first-dispatch window. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isValidIdentifier } from '../domain/task.js';
import { isFullCommitSha } from '../domain/taskBranchLease.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_HASH_PATHS = 1_024;
const MAX_UNTRACKED_PATH_BYTES = 512 * 1024;
const READ_ONLY_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'credential.helper=',
  '-c', 'submodule.recurse=false',
  '-c', 'status.submoduleSummary=false',
] as const;

export type EmptyTaskLeaseProofResult =
  | { readonly kind: 'empty'; readonly remoteTip: string | null }
  | {
      readonly kind: 'held';
      readonly code:
        | 'base_moved'
        | 'remote_candidate'
        | 'unique_work'
        | 'dirty_worktree'
        | 'concurrent_change'
        | 'ambiguous_git'
        | 'proof_unavailable';
      readonly detail: string;
    };

export interface EmptyTaskLeaseObservationInput {
  readonly mirrorDir: string;
  readonly workspaceDir: string;
  readonly defaultBranch: string;
  readonly taskId: string;
  readonly expectedBaseRevision: string;
  /** Deterministic race seam between two complete observations. */
  readonly beforeFinalObservation?: () => Promise<void>;
  readonly commandTimeoutMs?: number;
  /** Test seam for a blocking or malformed executable; production uses Git. */
  readonly gitBinary?: string;
}

class AmbiguousGitOutputError extends Error {
  override readonly name = 'AmbiguousGitOutputError';
}

function gitReadOnly(
  cwd: string,
  args: readonly string[],
  input: EmptyTaskLeaseObservationInput,
): Promise<Buffer> {
  const timeout = input.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    return Promise.reject(new AmbiguousGitOutputError('invalid timeout'));
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
    LC_ALL: 'C',
  };
  return new Promise((resolve, reject) => {
    execFile(
      input.gitBinary ?? 'git',
      [...READ_ONLY_CONFIG, ...args],
      {
        cwd,
        env,
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        encoding: 'buffer',
      },
      (error, stdout) => error ? reject(error) : resolve(stdout),
    );
  });
}

function fullSha(output: Buffer): string {
  const value = output.toString('utf8').trim().toLowerCase();
  if (!isFullCommitSha(value)) throw new AmbiguousGitOutputError('invalid commit output');
  return value;
}

function remoteTip(output: Buffer): string | null {
  const text = output.toString('utf8');
  if (text.length === 0) return null;
  const rows = text.split('\n').filter((row) => row.length > 0);
  const fields = rows[0]?.split('\t') ?? [];
  const tip = fields[0]?.toLowerCase() ?? '';
  if (rows.length !== 1 || fields.length !== 2 || !isFullCommitSha(tip)) {
    throw new AmbiguousGitOutputError('invalid remote ref output');
  }
  return tip;
}

interface Observation {
  readonly trustedTip: string;
  readonly localTip: string;
  readonly remoteTip: string | null;
  readonly branch: string;
  readonly dirty: boolean;
  readonly fingerprint: string;
}

async function observeOnce(
  input: EmptyTaskLeaseObservationInput,
  branch: string,
): Promise<Observation> {
  const trustedTip = fullSha(await gitReadOnly(
    input.mirrorDir,
    ['rev-parse', '--verify', `refs/heads/${input.defaultBranch}^{commit}`],
    input,
  ));
  const localTip = fullSha(await gitReadOnly(
    input.mirrorDir,
    ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
    input,
  ));
  const exactRemoteTip = remoteTip(await gitReadOnly(
    input.mirrorDir,
    ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    input,
  ));
  const head = fullSha(await gitReadOnly(
    input.workspaceDir,
    ['rev-parse', '--verify', 'HEAD'],
    input,
  ));
  const checkedOutBranch = (await gitReadOnly(
    input.workspaceDir,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    input,
  )).toString('utf8').trim();
  if (checkedOutBranch.length === 0 || checkedOutBranch.includes('\n')) {
    throw new AmbiguousGitOutputError('invalid checked-out branch');
  }
  const status = await gitReadOnly(input.workspaceDir, [
    'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all',
  ], input);
  const diff = await gitReadOnly(input.workspaceDir, [
    'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--ignore-submodules=all', 'HEAD', '--',
  ], input);
  const untracked = (await gitReadOnly(input.workspaceDir, [
    'ls-files', '--others', '--exclude-standard', '-z',
  ], input)).toString('utf8').split('\0').filter((path) => path.length > 0);
  if (
    untracked.length > MAX_UNTRACKED_HASH_PATHS ||
    untracked.reduce((total, path) => total + Buffer.byteLength(path), 0) >
      MAX_UNTRACKED_PATH_BYTES
  ) {
    throw new AmbiguousGitOutputError('untracked fingerprint exceeds bounds');
  }
  const untrackedHashes = untracked.length === 0
    ? Buffer.alloc(0)
    : await gitReadOnly(
        input.workspaceDir,
        ['hash-object', '--no-filters', '--', ...untracked],
        input,
      );
  return {
    trustedTip,
    localTip,
    remoteTip: exactRemoteTip,
    branch: checkedOutBranch,
    dirty: status.length > 0,
    fingerprint: createHash('sha256')
      .update(head).update('\0')
      .update(checkedOutBranch).update('\0')
      .update(status).update('\0')
      .update(diff).update('\0')
      .update(untrackedHashes)
      .digest('hex'),
  };
}

/**
 * Prove that a crash retained only an empty first-dispatch lease. Every Git
 * command is bounded and read-only; no fetch, checkout, index refresh, or ref
 * mutation occurs. Fixed diagnostics keep receipts bounded and path-free.
 */
export async function observeEmptyTaskLease(
  input: EmptyTaskLeaseObservationInput,
): Promise<EmptyTaskLeaseProofResult> {
  if (
    !isValidIdentifier(input.taskId) ||
    input.defaultBranch.length === 0 ||
    input.defaultBranch.includes('\0') ||
    !isFullCommitSha(input.expectedBaseRevision)
  ) {
    return { kind: 'held', code: 'ambiguous_git', detail: 'empty-lease proof input is invalid' };
  }
  const expected = input.expectedBaseRevision.toLowerCase();
  const branch = `hercules/${input.taskId}`;
  try {
    const initial = await observeOnce(input, branch);
    if (initial.trustedTip !== expected) {
      return { kind: 'held', code: 'base_moved', detail: 'trusted default tip no longer equals the durable lease base' };
    }
    if (initial.localTip !== expected || initial.branch !== branch) {
      return { kind: 'held', code: 'unique_work', detail: 'managed task branch or workspace contains unique work' };
    }
    if (initial.remoteTip !== null && initial.remoteTip !== expected) {
      return { kind: 'held', code: 'remote_candidate', detail: 'exact remote task ref contains or moved to a candidate' };
    }
    if (initial.dirty) {
      return { kind: 'held', code: 'dirty_worktree', detail: 'managed task workspace contains uncommitted work' };
    }
    await input.beforeFinalObservation?.();
    const final = await observeOnce(input, branch);
    if (
      final.trustedTip !== initial.trustedTip ||
      final.localTip !== initial.localTip ||
      final.remoteTip !== initial.remoteTip ||
      final.branch !== initial.branch ||
      final.fingerprint !== initial.fingerprint
    ) {
      return { kind: 'held', code: 'concurrent_change', detail: 'empty-lease evidence changed during observation' };
    }
    return { kind: 'empty', remoteTip: initial.remoteTip };
  } catch (error) {
    return error instanceof AmbiguousGitOutputError
      ? { kind: 'held', code: 'ambiguous_git', detail: 'Git returned malformed or over-bounds empty-lease evidence' }
      : { kind: 'held', code: 'proof_unavailable', detail: 'bounded read-only empty-lease evidence is unavailable' };
  }
}
