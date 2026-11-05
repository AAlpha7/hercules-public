/**
 * Isolation — deny ordinary provider worktree publication of remote task refs.
 *
 * Hercules exact-CAS (from the bare mirror with an explicit URL) remains the
 * only normal remote task-ref writer. Provider worktrees get:
 *   1. worktreeConfig + worktree-local core.bare=false (linked-worktree usable)
 *   2. worktree-local remote.origin.pushurl denied
 *   3. worktree-local pre-push hook that always fails closed
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

/** pushurl that cannot publish anywhere. */
export const PROVIDER_DENY_PUSH_URL = 'disabled://hercules-provider-push-denied';

/** Marker comment inside the installed pre-push hook. */
export const PROVIDER_PRE_PUSH_MARKER = 'hercules-provider-push-boundary';

const PRE_PUSH_HOOK = `#!/bin/sh
# ${PROVIDER_PRE_PUSH_MARKER}
# Provider worktrees must not publish remote hercules/<id> refs.
# Hercules exact-CAS (mirror + explicit URL) is the sole normal writer.
echo "hercules: provider worktree push denied (exact-CAS only)" >&2
exit 1
`;

export class ProviderPushBoundaryError extends Error {
  override readonly name = 'ProviderPushBoundaryError';
}

/**
 * Make a linked worktree usable after enabling worktree-local config:
 * extensions.worktreeConfig=true on the common dir, then core.bare=false
 * in worktree config (bare mirrors otherwise leave linked trees bare=true).
 */
export async function ensureLinkedWorktreeUsable(worktreeDir: string): Promise<void> {
  const git = simpleGit(worktreeDir);
  let commonDir: string;
  try {
    commonDir = (await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir']))
      .trim();
  } catch (err) {
    throw new ProviderPushBoundaryError(
      `could not resolve git common dir: ${(err as Error).message}`,
    );
  }
  if (!commonDir) {
    throw new ProviderPushBoundaryError('git common dir is empty');
  }
  // Common-dir config: enable per-worktree config files.
  const commonConfig = join(commonDir, 'config');
  try {
    await git.raw([
      'config',
      '--file',
      commonConfig,
      'extensions.worktreeConfig',
      'true',
    ]);
  } catch (err) {
    throw new ProviderPushBoundaryError(
      `could not enable worktreeConfig: ${(err as Error).message}`,
    );
  }
  try {
    await git.raw(['config', '--worktree', 'core.bare', 'false']);
  } catch (err) {
    throw new ProviderPushBoundaryError(
      `could not set worktree core.bare=false: ${(err as Error).message}`,
    );
  }
}

/** Install deny-pushurl + pre-push fail-closed on a provider worktree. */
export async function applyProviderPushBoundary(worktreeDir: string): Promise<void> {
  await ensureLinkedWorktreeUsable(worktreeDir);
  // simple-git refuses core.hooksPath unless explicitly opted in (same pattern
  // as control-repo test fixtures). Provider hooks are intentional and local.
  const git = simpleGit({
    baseDir: worktreeDir,
    unsafe: { allowUnsafeHooksPath: true },
  });

  try {
    await git.raw([
      'config',
      '--worktree',
      'remote.origin.pushurl',
      PROVIDER_DENY_PUSH_URL,
    ]);
  } catch (err) {
    throw new ProviderPushBoundaryError(
      `could not set deny pushurl: ${(err as Error).message}`,
    );
  }

  let gitDir: string;
  try {
    gitDir = (await git.raw(['rev-parse', '--path-format=absolute', '--git-dir'])).trim();
  } catch (err) {
    throw new ProviderPushBoundaryError(
      `could not resolve git-dir: ${(err as Error).message}`,
    );
  }
  if (!gitDir) {
    throw new ProviderPushBoundaryError('git-dir is empty');
  }

  // Worktree-private hooks dir so the bare mirror's push path is untouched.
  const hooksDir = join(gitDir, 'hercules-provider-hooks');
  try {
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-push');
    await writeFile(hookPath, PRE_PUSH_HOOK, { encoding: 'utf8' });
    await chmod(hookPath, 0o755);
    await git.raw(['config', '--worktree', 'core.hooksPath', hooksDir]);
  } catch (err) {
    throw new ProviderPushBoundaryError(
      `could not install provider pre-push hook: ${(err as Error).message}`,
    );
  }
}
