/** Read-only, bounded observation of explicitly registered source-owner checkouts. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isValidIdentifier } from '../domain/task.js';
import { isFullCommitSha } from '../domain/taskBranchLease.js';
import {
  classifyCheckout,
  guidanceForCheckout,
  type OwnerCheckoutRegistration,
  type SuccessionExternalObservation,
} from '../domain/workspaceSuccession.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_HASH_PATHS = 1_024;
const MAX_UNTRACKED_PATH_BYTES = 512 * 1024;
const READ_ONLY_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'submodule.recurse=false',
  '-c', 'status.submoduleSummary=false',
] as const;

export interface CheckoutObservationOptions {
  /** Deterministic race seam; called between the two complete observations. */
  readonly beforeFinalHeadRead?: () => Promise<void>;
  readonly commandTimeoutMs?: number;
  /** Test seam for a blocking executable; production always uses `git`. */
  readonly gitBinary?: string;
}

export class CheckoutObserveError extends Error {
  override readonly name = 'CheckoutObserveError';
}

function unavailable(id: string): SuccessionExternalObservation {
  return {
    registrationId: id, classification: 'unavailable', headSha: null, dirty: false,
    ahead: 0, behind: 0, concurrentChange: false, guidance: guidanceForCheckout('unavailable'),
  };
}

function unknown(id: string, concurrentChange = false): SuccessionExternalObservation {
  return {
    registrationId: id, classification: 'unknown', headSha: null, dirty: false,
    ahead: 0, behind: 0, concurrentChange, guidance: guidanceForCheckout('unknown'),
  };
}

function gitReadOnly(
  cwd: string,
  args: readonly string[],
  options: CheckoutObservationOptions,
): Promise<Buffer> {
  const timeout = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    return Promise.reject(new CheckoutObserveError('git command timeout is invalid'));
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
  return new Promise((resolve, reject) => {
    execFile(
      options.gitBinary ?? 'git',
      [...READ_ONLY_CONFIG, ...args],
      { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: MAX_GIT_OUTPUT_BYTES, encoding: 'buffer' },
      (error, stdout) => error ? reject(error) : resolve(stdout),
    );
  });
}

interface StableObservation {
  readonly headSha: string;
  readonly dirty: boolean;
  readonly fingerprint: string;
}

async function stableObservation(
  cwd: string,
  options: CheckoutObservationOptions,
): Promise<StableObservation> {
  const headSha = (await gitReadOnly(cwd, ['rev-parse', '--verify', 'HEAD'], options))
    .toString('utf8').trim().toLowerCase();
  if (!isFullCommitSha(headSha)) throw new CheckoutObserveError('checkout HEAD is invalid');
  const status = await gitReadOnly(cwd, [
    'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all',
  ], options);
  // HEAD diff binds tracked worktree/index bytes, not merely the dirty bit. The
  // status stream additionally binds untracked identities and modes.
  const diff = await gitReadOnly(cwd, [
    'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--ignore-submodules=all', 'HEAD', '--',
  ], options);
  const untracked = (await gitReadOnly(cwd, [
    'ls-files', '--others', '--exclude-standard', '-z',
  ], options)).toString('utf8').split('\0').filter((path) => path.length > 0);
  if (
    untracked.length > MAX_UNTRACKED_HASH_PATHS ||
    untracked.reduce((total, path) => total + Buffer.byteLength(path), 0) > MAX_UNTRACKED_PATH_BYTES
  ) {
    throw new CheckoutObserveError('untracked worktree fingerprint exceeds observation bounds');
  }
  const untrackedHashes = untracked.length === 0
    ? Buffer.alloc(0)
    : await gitReadOnly(cwd, ['hash-object', '--no-filters', '--', ...untracked], options);
  return {
    headSha,
    dirty: status.length > 0,
    fingerprint: createHash('sha256')
      .update(status).update('\0').update(diff).update('\0').update(untrackedHashes).digest('hex'),
  };
}

export async function observeRegisteredCheckouts(
  registrations: readonly OwnerCheckoutRegistration[],
  canonicalSha: string,
  options: CheckoutObservationOptions = {},
): Promise<SuccessionExternalObservation[]> {
  if (!isFullCommitSha(canonicalSha)) throw new CheckoutObserveError('canonical SHA is invalid');
  if (registrations.length > 16) throw new CheckoutObserveError('too many checkout registrations');
  const seen = new Set<string>();
  const output: SuccessionExternalObservation[] = [];
  for (const registration of registrations) {
    if (!isValidIdentifier(registration.id) || seen.has(registration.id)) {
      throw new CheckoutObserveError('checkout registration id is invalid or duplicated');
    }
    if (!isAbsolute(registration.path)) {
      throw new CheckoutObserveError('checkout registration path must be absolute');
    }
    seen.add(registration.id);
    try {
      await access(registration.path);
    } catch {
      output.push(unavailable(registration.id));
      continue;
    }
    try {
      const initial = await stableObservation(registration.path, options);
      const counts = (await gitReadOnly(registration.path, [
        'rev-list', '--left-right', '--count', `${canonicalSha}...${initial.headSha}`,
      ], options)).toString('utf8').trim().split(/\s+/);
      const behind = Number(counts[0]);
      const ahead = Number(counts[1]);
      if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) {
        output.push(unknown(registration.id));
        continue;
      }
      await options.beforeFinalHeadRead?.();
      const final = await stableObservation(registration.path, options);
      const concurrentChange = final.headSha !== initial.headSha || final.fingerprint !== initial.fingerprint;
      const classification = concurrentChange
        ? 'unknown'
        : classifyCheckout({ available: true, dirty: initial.dirty, ahead, behind });
      output.push({
        registrationId: registration.id,
        classification,
        headSha: initial.headSha,
        dirty: initial.dirty,
        ahead,
        behind,
        concurrentChange,
        guidance: guidanceForCheckout(classification),
      });
    } catch {
      output.push(unknown(registration.id));
    }
  }
  return output;
}
