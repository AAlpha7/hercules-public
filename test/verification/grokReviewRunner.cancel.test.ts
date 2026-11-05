import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createGrokReviewRunner } from '../../src/verification/grokReviewRunner.js';
import {
  createVerificationCancelReason,
  isVerificationAborted,
} from '../../src/domain/verificationRun.js';

function fakeChild(pid = 4242): {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    pid,
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return { child, stdout };
}

describe('createGrokReviewRunner cancel', () => {
  it('collects a successful reviewer result from the detached child', async () => {
    const { child, stdout } = fakeChild(1111);
    const run = createGrokReviewRunner({
      grokBin: 'grok',
      timeoutMs: 60_000,
      spawn: () => child,
    });

    const pending = run('review me');
    stdout.write('VERDICT: approved\nSUMMARY: ok\n');
    child.emit('close', 0, null);

    await expect(pending).resolves.toContain('VERDICT: approved');
  });

  it('kills the detached reviewer process group and rejects as cancellation', async () => {
    const ac = new AbortController();
    const { child } = fakeChild();
    const killed: Array<{ pid: number; force: boolean | undefined }> = [];
    const run = createGrokReviewRunner({
      grokBin: 'grok',
      timeoutMs: 60_000,
      spawn: () => child,
      killGroup: async (pid, opts) => {
        killed.push({ pid, force: opts?.force });
      },
    });

    const pending = run('review me', { signal: ac.signal });
    ac.abort(createVerificationCancelReason(false));

    await expect(pending).rejects.toSatisfy((err: unknown) =>
      isVerificationAborted(err),
    );
    expect(killed).toEqual([{ pid: 4242, force: false }]);
  });

  it('force-abort requests immediate process-group kill', async () => {
    const ac = new AbortController();
    const reason = createVerificationCancelReason(false);
    const { child } = fakeChild(9001);
    let forced: boolean | undefined;
    const run = createGrokReviewRunner({
      grokBin: 'grok',
      timeoutMs: 60_000,
      spawn: () => child,
      killGroup: async (_pid, opts) => {
        forced = opts?.force;
      },
    });

    const pending = run('review me', { signal: ac.signal });
    reason.force = true;
    ac.abort(reason);

    await expect(pending).rejects.toSatisfy((err: unknown) =>
      isVerificationAborted(err),
    );
    expect(forced).toBe(true);
  });
});
