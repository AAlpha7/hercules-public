/**
 * Staging auto-unlock handoff (operator request 2026-07-17): the production
 * SPA mints a one-time short-lived code; the staging SPA redeems it for the
 * staging UI token. The full token never rides in a URL — only the code, in
 * a fragment, single-use and TTL-bound.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintHandoffCode,
  redeemHandoffCode,
  HANDOFF_TTL_MS,
} from '../../src/server/stagingHandoff.js';

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-'));
  return join(dir, 'staging-handoff.json');
}

describe('mint + redeem', () => {
  it('round-trips a freshly minted code exactly once', async () => {
    const file = await tmpFile();
    const code = await mintHandoffCode({ file, now: 1_000 });
    expect(code).toMatch(/^[a-f0-9]{64}$/);
    expect(await redeemHandoffCode({ file, code, now: 2_000 })).toBe(true);
    // Single-use: second redeem of the same code fails.
    expect(await redeemHandoffCode({ file, code, now: 3_000 })).toBe(false);
  });

  it('stores only a hash on disk — never the plaintext code', async () => {
    const file = await tmpFile();
    const code = await mintHandoffCode({ file, now: 1_000 });
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(code);
  });

  it('rejects expired and wrong codes', async () => {
    const file = await tmpFile();
    const code = await mintHandoffCode({ file, now: 1_000 });
    expect(
      await redeemHandoffCode({ file, code, now: 1_000 + HANDOFF_TTL_MS + 1 }),
    ).toBe(false);
    const code2 = await mintHandoffCode({ file, now: 5_000 });
    expect(
      await redeemHandoffCode({ file, code: 'f'.repeat(64), now: 5_100 }),
    ).toBe(false);
    // A failed guess must not consume the valid code.
    expect(await redeemHandoffCode({ file, code: code2, now: 5_200 })).toBe(true);
  });

  it('redeem against a missing file fails quietly', async () => {
    const file = await tmpFile();
    expect(
      await redeemHandoffCode({ file, code: 'a'.repeat(64), now: 1 }),
    ).toBe(false);
  });
});
