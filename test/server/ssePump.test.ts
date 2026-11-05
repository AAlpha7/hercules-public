/**
 * Latest-wins SSE pump — the fix for the 2026-07-24 daemon OOM (SIGABRT at
 * 4GB heap): every runtime state change fire-and-forgot a full serialized
 * snapshot into each SSE connection; a stalled client (phone asleep behind
 * cloudflared) accumulated hours of snapshots in the write queue. The pump
 * bounds each connection to one write in flight + one pending view, dropping
 * intermediate snapshots (only the latest matters for a state stream).
 */
import { describe, it, expect } from 'vitest';
import { makeLatestWinsPump } from '../../src/server/ssePump.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('makeLatestWinsPump', () => {
  it('coalesces bursts: only first + latest are written, in order', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const written: number[] = [];
    const pump = makeLatestWinsPump<number>(async (v) => {
      written.push(v);
      await gates[written.length - 1]!.promise;
    });

    pump.push(1); // starts writing 1
    pump.push(2); // queued…
    pump.push(3); // …replaced by 3
    pump.push(4); // …replaced by 4
    expect(written).toEqual([1]);

    gates[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([1, 4]); // 2 and 3 dropped

    gates[1]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([1, 4]); // nothing pending
  });

  it('a stalled writer never accumulates more than one pending view', async () => {
    const never = deferred<void>();
    let calls = 0;
    const pump = makeLatestWinsPump<number>(async () => {
      calls += 1;
      await never.promise; // client never drains
    });
    for (let i = 0; i < 10_000; i += 1) pump.push(i);
    expect(calls).toBe(1); // one in flight, latest kept by reference only
  });

  it('stops after a write error (client gone) and ignores later pushes', async () => {
    let calls = 0;
    const pump = makeLatestWinsPump<number>(async () => {
      calls += 1;
      throw new Error('stream aborted');
    });
    pump.push(1);
    await new Promise((r) => setTimeout(r, 0));
    pump.push(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
  });
});
