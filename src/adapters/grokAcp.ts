/**
 * Grok ACP transport for Remote Control free sessions.
 *
 * Spawns `grok agent stdio` **without** process-level always-approve so
 * permission modes (default / acceptEdits / bypass) are enforced client-side
 * and hot-switchable. Autonomous headless tasks use a separate fail-closed
 * execution-class policy (see buildGrokArgs / executionClass).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { AcpClient, type AcpSpawnFn } from './acpClient.js';
import type { PermissionMode } from '../domain/session.js';

export interface GrokAcpOptions {
  readonly spawn?: AcpSpawnFn;
  readonly grokBin?: string;
  readonly model?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly setupTimeoutMs?: number;
  readonly promptTimeoutMs?: number;
  readonly permissionMode?: PermissionMode;
  readonly permissionTimeoutMs?: number;
}

const defaultSpawn: AcpSpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    // No process.env fallback: AcpClient always supplies the filtered env, and
    // a silent full-inheritance escape hatch here would defeat that boundary.
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ReturnType<AcpSpawnFn>;

/**
 * Build argv for `grok agent … stdio`.
 * Does **not** pass --always-approve: Hercules AcpClient owns permissions.
 */
export function buildGrokAcpArgs(opts: GrokAcpOptions = {}): string[] {
  const args = ['agent'];
  if (opts.model) args.push('-m', opts.model);
  args.push('stdio');
  return args;
}

/**
 * Connect a Grok ACP client in the given worktree cwd.
 */
export async function connectGrokAcp(
  cwd: string,
  opts: GrokAcpOptions = {},
): Promise<AcpClient> {
  const client = new AcpClient({
    command: opts.grokBin ?? 'grok',
    args: buildGrokAcpArgs(opts),
    cwd,
    // Explicit provider selection: xAI names only (XAI_API_KEY / GROK_API_KEY).
    // Operator `grok login` auth still works via HOME (~/.grok/auth.json).
    // opts.env is an optional source for AcpClient's filter, never a final env.
    authProvider: 'xai',
    spawn: opts.spawn ?? defaultSpawn,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.setupTimeoutMs !== undefined ? { setupTimeoutMs: opts.setupTimeoutMs } : {}),
    ...(opts.promptTimeoutMs !== undefined ? { promptTimeoutMs: opts.promptTimeoutMs } : {}),
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.permissionTimeoutMs !== undefined
      ? { permissionTimeoutMs: opts.permissionTimeoutMs }
      : {}),
  });
  await client.connect();
  return client;
}
