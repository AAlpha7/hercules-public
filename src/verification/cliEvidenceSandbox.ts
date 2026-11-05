/** Linux host boundary for CLI evidence. Pure invocation construction lives here. */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { EffectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';

export interface CliEvidenceInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly boundary: 'direct' | 'bubblewrap';
}

export class CliEvidenceSandboxError extends Error {
  override readonly name = 'CliEvidenceSandboxError';
  readonly code = 'cli_evidence_sandbox_unavailable' as const;
}

function needsFilesystemBoundary(policy: EffectiveRepoExecutionPolicy): boolean {
  return policy.sandbox === 'workspace' || policy.sandbox === 'read-only' || policy.workspaceWrite;
}

const SENSITIVE_HOST_ROOTS = [
  '/home', '/root', '/opt', '/var', '/run', '/tmp', '/mnt', '/media', '/srv',
] as const;
export const PRIVATE_CLI_TMP = '/tmp/hercules-cli';

function privateWorkspaceParents(workspaceRoot: string): readonly string[] {
  const maskedRoot = SENSITIVE_HOST_ROOTS.find(
    (root) => workspaceRoot === root || workspaceRoot.startsWith(root + '/'),
  );
  if (!maskedRoot || workspaceRoot === maskedRoot) return [];
  const dirs: string[] = [];
  let current = workspaceRoot;
  while (current !== maskedRoot) {
    dirs.push(current);
    current = dirname(current);
  }
  return dirs.reverse();
}

export async function buildCliEvidenceInvocation(input: {
  readonly policy: EffectiveRepoExecutionPolicy;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly bubblewrapPath?: string | null;
  /** Home containing a trusted offline Rust toolchain. Never mounts credentials. */
  readonly rustToolchainHome?: string | null;
  readonly platform?: NodeJS.Platform;
}): Promise<CliEvidenceInvocation> {
  const policy = input.policy;
  if (policy.workspaceWrite && policy.sandbox !== 'workspace') {
    throw new CliEvidenceSandboxError('workspace writes require workspace sandbox enforcement');
  }
  if (policy.network === 'limited') {
    throw new CliEvidenceSandboxError('limited network policy has no CLI evidence enforcer');
  }
  const needsBoundary = needsFilesystemBoundary(policy) || policy.network === 'off';
  if (!needsBoundary) {
    return { file: input.argv[0]!, args: input.argv.slice(1), cwd: input.cwd, boundary: 'direct' };
  }
  if ((input.platform ?? process.platform) !== 'linux') {
    throw new CliEvidenceSandboxError('required CLI evidence sandbox is unavailable on this host');
  }
  const bubblewrap = input.bubblewrapPath === undefined ? '/usr/bin/bwrap' : input.bubblewrapPath;
  if (!bubblewrap) {
    throw new CliEvidenceSandboxError('required bubblewrap boundary is not configured');
  }
  try {
    await access(bubblewrap, constants.X_OK);
  } catch {
    throw new CliEvidenceSandboxError('required bubblewrap boundary is not executable');
  }

  const rustMounts: string[] = [];
  if (input.rustToolchainHome) {
    const home = normalize(input.rustToolchainHome);
    if (!isAbsolute(home) || home === '/' || home !== input.rustToolchainHome) {
      throw new CliEvidenceSandboxError('invalid Rust toolchain home');
    }
    // Deliberately exclude ~/.cargo as a whole, config files, credentials,
    // advisory databases and unrelated home content. These three read-only
    // trees are sufficient for Cargo --offline builds using crates.io cache.
    for (const candidate of [
      join(home, '.cargo', 'bin'),
      join(home, '.cargo', 'registry'),
      join(home, '.rustup'),
    ]) {
      try {
        await access(candidate, constants.R_OK);
        rustMounts.push(candidate);
      } catch {
        // Missing components remain absent inside the sandbox and fail closed
        // as a normal build failure; never broaden the mount to compensate.
      }
    }
  }

  const args = [
    '--die-with-parent',
    '--ro-bind', '/', '/',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--dev', '/dev',
    '--proc', '/proc',
  ];
  // The root bind supplies system binaries/libraries, but host data roots are
  // hidden so connector credentials, production env files and personal data
  // cannot be read. Only the exact verification workspace is reintroduced.
  for (const root of SENSITIVE_HOST_ROOTS) args.push('--tmpfs', root);
  // Create the mountpoint while the private /tmp is writable. The parent is
  // remounted read-only below; only this nested ephemeral mount stays writable.
  args.push('--dir', PRIVATE_CLI_TMP);
  const privateDirs = new Set(privateWorkspaceParents(input.workspaceRoot));
  for (const mount of rustMounts) {
    for (const dir of privateWorkspaceParents(mount)) privateDirs.add(dir);
  }
  for (const dir of privateDirs) args.push('--dir', dir);
  for (const root of SENSITIVE_HOST_ROOTS) args.push('--remount-ro', root);
  args.push('--tmpfs', PRIVATE_CLI_TMP);
  if (policy.sandbox === 'read-only') {
    args.push('--ro-bind', input.workspaceRoot, input.workspaceRoot);
  } else {
    // workspace mode and a network-only boundary preserve their declared
    // writable filesystem semantics, but expose only this exact workspace.
    args.push('--bind', input.workspaceRoot, input.workspaceRoot);
  }
  if (policy.sandbox !== 'read-only') {
    const gitMetadata = join(input.workspaceRoot, '.git');
    try {
      await access(gitMetadata);
      args.push('--ro-bind', gitMetadata, gitMetadata);
    } catch {
      // Non-git fixture workspaces have no metadata mount to protect.
    }
  }
  for (const mount of rustMounts) args.push('--ro-bind', mount, mount);
  if (policy.network === 'off') args.push('--unshare-net');
  args.push('--chdir', input.cwd, '--', ...input.argv);
  return { file: bubblewrap, args, cwd: input.workspaceRoot, boundary: 'bubblewrap' };
}
