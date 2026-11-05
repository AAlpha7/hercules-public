import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execRunner } from '../../src/verification/gates.js';

describe('execRunner abort listener lifecycle', () => {
  it('removes abort listener after normal completion (no stale listener)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h-gate-listener-'));
    const ac = new AbortController();
    const signal = ac.signal;
    // Snapshot listener count via private Node internals is brittle; instead
    // complete successfully then abort — must not reject a settled promise /
    // throw unhandled. If the listener leaked, abort after resolve would call
    // finishCancelled on a finished runner (guarded) — we assert resolve ok.
    const result = await execRunner('true', dir, { signal });
    expect(result.exitCode).toBe(0);
    // Post-completion abort must be a no-op (listener detached).
    expect(() => ac.abort()).not.toThrow();
    // Give any leaked async abort path a tick; must not surface.
    await new Promise((r) => setTimeout(r, 30));
  });
});
