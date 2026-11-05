import { describe, expect, it, vi } from 'vitest';
import { parseCliEvidenceConfig, type CliEvidenceReceipt } from '../../src/domain/cliEvidence.js';
import { effectiveRepoExecutionPolicy } from '../../src/domain/repoExecutionPolicy.js';
import { VerificationAbortedError } from '../../src/domain/verificationRun.js';
import type { MergeWorktreeHandle } from '../../src/isolation/worktree.js';
import { verifyPreparedCliEvidence } from '../../src/verification/readinessCliEvidence.js';

const REVISION = 'a'.repeat(40);
const PLAN = parseCliEvidenceConfig({
  version: 1,
  steps: [{ id: 'version', argv: ['guardian', '--version'], expect: { exit_code: 0 } }],
})!;
const POLICY = effectiveRepoExecutionPolicy({ profile: 'guardian' });
const PASSING_RECEIPT: CliEvidenceReceipt = {
  version: 1,
  source: 'workflow',
  status: 'passed',
  ok: true,
  steps: [],
  durationMs: 1,
};
const FAILED_RECEIPT: CliEvidenceReceipt = {
  ...PASSING_RECEIPT,
  status: 'failed',
  ok: false,
};

function handle(input: {
  heads?: readonly string[];
  clean?: readonly boolean[];
} = {}): MergeWorktreeHandle {
  const heads = [...(input.heads ?? [REVISION])];
  const clean = [...(input.clean ?? [true])];
  return {
    dir: '/trusted/exact-worktree',
    headSha: vi.fn(async () => heads.shift() ?? heads.at(-1) ?? REVISION),
    isTrackedAndUntrackedClean: vi.fn(async () => clean.shift() ?? clean.at(-1) ?? true),
    mergeNoFf: vi.fn(async () => ({ ok: true as const })),
    isAncestor: vi.fn(async () => true),
    mergeBase: vi.fn(async () => REVISION),
    pushDefaultBranch: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

function base(overrides: Partial<Parameters<typeof verifyPreparedCliEvidence>[0]> = {}) {
  return {
    handle: handle({ clean: [true, true, true] }),
    revision: REVISION,
    plan: PLAN,
    buildGate: { name: 'build', command: 'cargo build --locked' },
    executionPolicy: POLICY,
    buildRunner: vi.fn(async () => PASSING_RECEIPT),
    cliRunner: vi.fn(async () => PASSING_RECEIPT),
    ...overrides,
  };
}

describe('verifyPreparedCliEvidence', () => {
  it('runs the trusted build before isolated CLI evidence on the exact clean revision', async () => {
    const order: string[] = [];
    const input = base({
      buildRunner: vi.fn(async ({ plan, workspaceDir, executionPolicy }) => {
        order.push('build');
        expect(plan.steps[0]?.argv).toEqual(['sh', '-c', 'cargo build --locked']);
        expect(plan.steps[0]?.timeoutMs).toBe(20 * 60 * 1000);
        expect(plan.steps[0]?.maxOutputBytes).toBe(256 * 1024);
        expect(workspaceDir).toBe('/trusted/exact-worktree');
        expect(executionPolicy).toBe(POLICY);
        return PASSING_RECEIPT;
      }),
      cliRunner: vi.fn(async ({ executionPolicy }) => {
        order.push('cli');
        expect(executionPolicy).toBe(POLICY);
        return PASSING_RECEIPT;
      }),
    });

    await expect(verifyPreparedCliEvidence(input)).resolves.toBe('verified');
    expect(order).toEqual(['build', 'cli']);
    expect(input.handle.headSha).toHaveBeenCalledTimes(3);
    expect(input.handle.isTrackedAndUntrackedClean).toHaveBeenCalledTimes(3);
  });

  it('fails closed without a trusted build gate and executes nothing', async () => {
    const input = base({ buildGate: undefined });
    await expect(verifyPreparedCliEvidence(input)).resolves.toBe('build_missing');
    expect(input.buildRunner).not.toHaveBeenCalled();
    expect(input.cliRunner).not.toHaveBeenCalled();
  });

  it('does not run CLI after a build failure or exception', async () => {
    const failed = base({
      buildRunner: vi.fn(async () => FAILED_RECEIPT),
    });
    await expect(verifyPreparedCliEvidence(failed)).resolves.toBe('build_failed');
    expect(failed.cliRunner).not.toHaveBeenCalled();

    const thrown = base({ buildRunner: vi.fn(async () => { throw new Error('secret'); }) });
    await expect(verifyPreparedCliEvidence(thrown)).resolves.toBe('build_failed');
    expect(thrown.cliRunner).not.toHaveBeenCalled();
  });

  it('passes the bounded build timeout to the sandboxed runner and never runs CLI on timeout', async () => {
    const timed = base({
      buildTimeoutMs: 1,
      buildRunner: vi.fn(async ({ plan }) => {
        expect(plan.steps[0]?.timeoutMs).toBe(1);
        return FAILED_RECEIPT;
      }),
    });
    await expect(verifyPreparedCliEvidence(timed)).resolves.toBe('build_failed');
    expect(timed.cliRunner).not.toHaveBeenCalled();
  });

  it('rejects revision drift before build, after build, and after CLI', async () => {
    for (const heads of [
      ['b'.repeat(40)],
      [REVISION, 'b'.repeat(40)],
      [REVISION, REVISION, 'b'.repeat(40)],
    ]) {
      const input = base({ handle: handle({ heads, clean: [true, true, true] }) });
      await expect(verifyPreparedCliEvidence(input)).resolves.toBe('stale');
    }
  });

  it('rejects tracked or untracked mutation before build, after build, and after CLI', async () => {
    for (const clean of [[false], [true, false], [true, true, false]]) {
      const input = base({ handle: handle({ clean }) });
      await expect(verifyPreparedCliEvidence(input)).resolves.toBe('workspace_mutated');
    }
  });

  it('classifies CLI runner exceptions without leaking their text', async () => {
    const input = base({
      cliRunner: vi.fn(async () => { throw new Error('TOKEN=super-secret'); }),
    });
    const status = await verifyPreparedCliEvidence(input);
    expect(status).toBe('unknown');
    expect(JSON.stringify(status)).not.toContain('super-secret');
  });

  it('propagates lifecycle cancellation from build and CLI instead of caching a verdict', async () => {
    const buildCancelled = base({
      buildRunner: vi.fn(async () => {
        throw new VerificationAbortedError('shutdown');
      }),
    });
    await expect(verifyPreparedCliEvidence(buildCancelled)).rejects.toBeInstanceOf(
      VerificationAbortedError,
    );

    const cliCancelled = base({
      cliRunner: vi.fn(async () => {
        throw new VerificationAbortedError('shutdown');
      }),
    });
    await expect(verifyPreparedCliEvidence(cliCancelled)).rejects.toBeInstanceOf(
      VerificationAbortedError,
    );
  });
});
