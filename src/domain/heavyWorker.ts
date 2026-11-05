/**
 * Domain layer — SSH heavy-validation worker types (SPEC §11 escape hatch).
 *
 * Pure: no IO, git, fs, or network. The control plane stays single-process on
 * free-tier; an optional remote host may run L2 only. This is **not** a
 * multi-node mesh (SPEC §17) — one optional heavy endpoint under the existing
 * daemon.
 */
import { isValidIdentifier, IdentifierError } from './task.js';
import type { EvidenceStep } from './evidence.js';

/** Where Layer-2 heavy work executes. */
export type HeavyWorkerMode = 'local' | 'remote';

/** Default remote job root when the operator does not set one. */
export const DEFAULT_HEAVY_REMOTE_ROOT = '/var/hercules-heavy';

/**
 * Operator-configured single heavy host (not a fleet).
 * Real SSH wiring is deferred until human accept of the design spike.
 */
export interface HeavyRemoteEndpoint {
  readonly host: string;
  readonly user: string;
  /** SSH port; default 22 at the config layer. */
  readonly sshPort: number;
  /** Optional identity file path on the control box. */
  readonly identityFile?: string;
  /** Base directory for per-task job trees on the remote. */
  readonly remoteRoot: string;
}

/**
 * Payload for a remote L2 job — mirrors {@link BehavioralRunner} input fields
 * that the remote side needs (no local cwd path semantics beyond sync).
 */
export interface HeavyJobRequest {
  readonly taskId: string;
  readonly baseUrl: string;
  readonly bootCommands: readonly string[];
  readonly healthCommand: string | undefined;
  readonly captures: number;
  readonly localStorage?: Readonly<Record<string, string>>;
  readonly mobile?: boolean;
  readonly smokeFlows?: readonly string[];
  readonly taskBody?: string;
  readonly workflowEvidence?: readonly EvidenceStep[];
}

/** Result of remote exec (before/after syncDown of screenshot files). */
export interface HeavyJobExecResult {
  readonly healthy: boolean;
  /** Basenames only; files still on the remote until syncDown. */
  readonly screenshotBasenames: readonly string[];
  readonly error?: string;
}

/** Full job outcome recorded for packets / debugging. */
export interface HeavyJobResult {
  readonly where: 'remote';
  readonly healthy: boolean;
  readonly screenshots: readonly string[];
  readonly error?: string;
  readonly request: HeavyJobRequest;
}

/**
 * Path chokepoint: remote job directory for a task.
 * Task id MUST pass {@link isValidIdentifier} (SPEC §10).
 */
export function remoteJobDir(remoteRoot: string, taskId: string): string {
  if (!isValidIdentifier(taskId)) {
    throw new IdentifierError(
      `task id '${taskId}' is not a safe identifier for remote heavy job path`,
    );
  }
  const root = remoteRoot.replace(/\/+$/, '');
  return `${root}/${taskId}`;
}
