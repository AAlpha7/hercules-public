/** Trusted default-revision build preparation followed by isolated CLI evidence. */
import type { WorkflowCliEvidenceStatus } from '../domain/guardianReadiness.js';
import { homedir } from 'node:os';
import type { EffectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';
import type { MergeWorktreeHandle } from '../isolation/worktree.js';
import {
  CLI_EVIDENCE_VERSION,
  MAX_CLI_EVIDENCE_MAX_OUTPUT_BYTES,
  type CliEvidencePlan,
  type CliEvidenceReceipt,
} from '../domain/cliEvidence.js';
import {
  isVerificationAborted,
  throwIfVerificationAborted,
} from '../domain/verificationRun.js';
import { runCliEvidence } from './cliEvidence.js';
import type { Gate } from './gates.js';

const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const RUST_BUILD_COMMAND = /(?:^|[\s;&|()])(?:cargo|rustc|rustup|rustfmt)(?=$|[\s;&|()])/;

export interface ReadinessCliEvidenceInput {
  readonly handle: MergeWorktreeHandle;
  readonly revision: string;
  readonly plan: CliEvidencePlan;
  readonly buildGate: Gate | undefined;
  readonly executionPolicy: EffectiveRepoExecutionPolicy;
  readonly buildTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly buildRunner?: typeof runCliEvidence;
  readonly cliRunner?: typeof runCliEvidence;
}

async function exactAndClean(
  handle: MergeWorktreeHandle,
  revision: string,
): Promise<'ok' | 'stale' | 'mutated'> {
  if ((await handle.headSha()).toLowerCase() !== revision.toLowerCase()) return 'stale';
  if (!handle.isTrackedAndUntrackedClean) return 'mutated';
  return (await handle.isTrackedAndUntrackedClean()) ? 'ok' : 'mutated';
}

/**
 * Executes only commands parsed from the trusted default-branch WORKFLOW.
 * Persistent diagnostics are status-only: command output and environment values never escape.
 */
export async function verifyPreparedCliEvidence(
  input: ReadinessCliEvidenceInput,
): Promise<WorkflowCliEvidenceStatus> {
  throwIfVerificationAborted(input.signal);
  if (!input.buildGate) return 'build_missing';

  const before = await exactAndClean(input.handle, input.revision);
  if (before !== 'ok') return before === 'stale' ? 'stale' : 'workspace_mutated';

  const buildPlan: CliEvidencePlan = {
    version: CLI_EVIDENCE_VERSION,
    source: 'workflow',
    steps: [{
      id: 'trusted-build',
      // WORKFLOW build gates are trusted shell commands. User-authored CLI
      // evidence remains argv-only and still rejects shell wrappers at parse time.
      argv: ['sh', '-c', input.buildGate.command],
      cwd: '.',
      timeoutMs: input.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      maxOutputBytes: MAX_CLI_EVIDENCE_MAX_OUTPUT_BYTES,
      expect: { exitCode: 0 },
      optional: false,
    }],
  };
  try {
    const buildReceipt = await (input.buildRunner ?? runCliEvidence)({
      plan: buildPlan,
      workspaceDir: input.handle.dir,
      executionPolicy: input.executionPolicy,
      overflowMode: 'truncate',
      ...(RUST_BUILD_COMMAND.test(input.buildGate.command)
        ? { rustToolchainHome: homedir() }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!buildReceipt.ok) return 'build_failed';
  } catch (err) {
    if (isVerificationAborted(err)) throw err;
    return 'build_failed';
  }

  const afterBuild = await exactAndClean(input.handle, input.revision);
  if (afterBuild !== 'ok') {
    return afterBuild === 'stale' ? 'stale' : 'workspace_mutated';
  }

  let receipt: CliEvidenceReceipt;
  try {
    receipt = await (input.cliRunner ?? runCliEvidence)({
      plan: input.plan,
      workspaceDir: input.handle.dir,
      executionPolicy: input.executionPolicy,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (err) {
    if (isVerificationAborted(err)) throw err;
    return 'unknown';
  }

  const afterCli = await exactAndClean(input.handle, input.revision);
  if (afterCli !== 'ok') {
    return afterCli === 'stale' ? 'stale' : 'workspace_mutated';
  }
  return receipt.ok ? 'verified' : 'failed';
}
