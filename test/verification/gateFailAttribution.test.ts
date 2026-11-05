/**
 * Merge-base gate-fail probe: cache hits skip re-run; checkout cleaned.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  attributeFailedGate,
  GateFailAttributionCache,
  clearDefaultAttributionCache,
} from '../../src/verification/gateFailAttribution.js';
import type { GateResult } from '../../src/domain/verification.js';
import {
  isVerificationAborted,
  VerificationAbortedError,
} from '../../src/domain/verificationRun.js';

beforeEach(() => {
  clearDefaultAttributionCache();
});

async function makeRepo(): Promise<{
  dir: string;
  mergeBase: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'hercules-gfa-'));
  const git = simpleGit(dir);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 't@h.local');
  await git.addConfig('user.name', 'T');
  await writeFile(join(dir, 'a.txt'), 'base\n');
  await git.add('.');
  await git.commit('base');
  const mergeBase = (await git.raw(['rev-parse', 'HEAD'])).trim();
  await writeFile(join(dir, 'a.txt'), 'branch\n');
  await git.add('.');
  await git.commit('branch change');
  return {
    dir,
    mergeBase,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const failedHeldOut: GateResult = {
  name: 'held-out-smoke',
  command: 'pnpm exec vitest run test/invariants --config vitest.unit.config.ts',
  passed: false,
  output: `
 FAIL  test/invariants/report-hygiene.test.ts > rejects polluted final messages
AssertionError: expected 1 to be 0

failures:
`,
};

describe('attributeFailedGate', () => {
  it('returns null for non-attributable gates (setup/build)', async () => {
    const { dir, mergeBase, cleanup } = await makeRepo();
    try {
      const r = await attributeFailedGate({
        failedGate: {
          name: 'build',
          command: 'pnpm build',
          passed: false,
          output: 'error',
        },
        mergeBase,
        repoKey: 'app',
        filesTouched: ['src/x.ts'],
        worktreeDir: dir,
        probeRoot: join(dir, '.probe'),
        run: async () => ({ exitCode: 1, output: 'fail' }),
      });
      expect(r).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('cache hit does not re-run the probe command', async () => {
    const { dir, mergeBase, cleanup } = await makeRepo();
    const cache = new GateFailAttributionCache();
    let runs = 0;
    const run = async () => {
      runs += 1;
      return {
        exitCode: 1,
        output:
          'FAIL  test/invariants/report-hygiene.test.ts > rejects polluted final messages\n',
      };
    };
    try {
      const first = await attributeFailedGate({
        failedGate: failedHeldOut,
        mergeBase,
        repoKey: 'app',
        filesTouched: ['src/web/App.tsx'],
        worktreeDir: dir,
        probeRoot: join(dir, '.probe'),
        run,
        cache,
      });
      expect(first?.outcome).toBe('trunk_inherited');
      expect(runs).toBe(1);

      const second = await attributeFailedGate({
        failedGate: failedHeldOut,
        mergeBase,
        repoKey: 'app',
        filesTouched: ['src/web/App.tsx'],
        worktreeDir: dir,
        probeRoot: join(dir, '.probe'),
        run,
        cache,
      });
      expect(second?.outcome).toBe('trunk_inherited');
      expect(second?.cacheHits.length).toBeGreaterThan(0);
      // Second call fully cache-served — no extra run.
      expect(runs).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('not reproduced on merge-base → branch_introduced', async () => {
    const { dir, mergeBase, cleanup } = await makeRepo();
    try {
      const r = await attributeFailedGate({
        failedGate: failedHeldOut,
        mergeBase,
        repoKey: 'app',
        filesTouched: ['src/foo.ts'],
        worktreeDir: dir,
        probeRoot: join(dir, '.probe'),
        run: async () => ({ exitCode: 0, output: 'ok all passed' }),
        cache: new GateFailAttributionCache(),
      });
      expect(r?.outcome).toBe('branch_introduced');
    } finally {
      await cleanup();
    }
  });

  it('removes merge-base checkout after probe (no disk residue)', async () => {
    const { dir, mergeBase, cleanup } = await makeRepo();
    const probeRoot = join(dir, '.probe');
    try {
      await attributeFailedGate({
        failedGate: failedHeldOut,
        mergeBase,
        repoKey: 'app',
        filesTouched: ['src/x.ts'],
        worktreeDir: dir,
        probeRoot,
        run: async () => ({ exitCode: 1, output: 'FAIL x\n' }),
        cache: new GateFailAttributionCache(),
      });
      // Checkout dir under probeRoot/<short-sha> must be gone.
      const short = mergeBase.slice(0, 12);
      await expect(access(join(probeRoot, short))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it('builds a minimal re-run (not full suite) for vitest held-out', async () => {
    const { dir, mergeBase, cleanup } = await makeRepo();
    let seenCmd = '';
    try {
      await attributeFailedGate({
        failedGate: failedHeldOut,
        mergeBase,
        repoKey: 'app',
        filesTouched: [],
        worktreeDir: dir,
        probeRoot: join(dir, '.probe'),
        run: async (cmd) => {
          seenCmd = cmd;
          return { exitCode: 1, output: 'FAIL rejects polluted final messages\n' };
        },
        cache: new GateFailAttributionCache(),
      });
      expect(seenCmd).toMatch(/vitest/);
      expect(seenCmd).toMatch(/-t/);
      // Must not be a bare full `pnpm test` with no filter.
      expect(seenCmd).not.toBe('pnpm test');
    } finally {
      await cleanup();
    }
  });

  it('forwards cancellation to the merge-base probe command', async () => {
    const { dir, mergeBase, cleanup } = await makeRepo();
    const ac = new AbortController();
    let seenSignal: AbortSignal | undefined;
    try {
      await expect(
        attributeFailedGate({
          failedGate: failedHeldOut,
          mergeBase,
          repoKey: 'app',
          filesTouched: ['src/foo.ts'],
          worktreeDir: dir,
          probeRoot: join(dir, '.probe'),
          signal: ac.signal,
          run: async (_cmd, _cwd, opts) => {
            seenSignal = opts?.signal;
            ac.abort();
            throw new VerificationAbortedError('probe cancelled');
          },
          cache: new GateFailAttributionCache(),
        }),
      ).rejects.toSatisfy((err: unknown) => isVerificationAborted(err));
      expect(seenSignal).toBe(ac.signal);
    } finally {
      await cleanup();
    }
  });
});
