/**
 * Staging auto-unlock handoff (operator request 2026-07-17).
 *
 * Problem: the staging UI lives on a rotating tunnel origin, so the phone
 * never has its token in localStorage and the operator had to paste it on
 * every visit. Solution: the production SPA (already Bearer-authenticated)
 * mints a one-time code; the staging SPA redeems that code for the staging
 * UI token. The token itself never appears in a URL — only the code, carried
 * in a location fragment (never sent to servers or logs), single-use and
 * TTL-bound. The file stores a SHA-256 hash, so reading it does not reveal
 * the code either.
 *
 * Role separation is by configuration: the production daemon gets only a
 * mint file (it can create codes but never answers redeems — its token can
 * not be obtained this way); the staging daemon gets only a redeem file.
 * Both point at the same path on this box.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

/** Codes outlive one panel visit but not an afternoon: 10 minutes. */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

const CODE_RE = /^[a-f0-9]{64}$/;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Mint a fresh one-time code, replacing any previous one (a newer panel
 * refresh invalidates older links — last writer wins on purpose).
 */
export async function mintHandoffCode(opts: {
  readonly file: string;
  readonly now?: number;
}): Promise<string> {
  const now = opts.now ?? Date.now();
  const code = randomBytes(32).toString('hex');
  const record = JSON.stringify({ codeHash: hashCode(code), expiresAt: now + HANDOFF_TTL_MS });
  // Write-then-rename so the redeem side never reads a torn file.
  const tmp = `${opts.file}.tmp`;
  await writeFile(tmp, record, { mode: 0o600 });
  await rename(tmp, opts.file);
  return code;
}

/**
 * Redeem a code: true exactly once for the current, unexpired code. The file
 * is consumed on success (and cleared when expired). Wrong guesses do not
 * consume the valid code — single-use plus 32 random bytes makes online
 * guessing useless.
 */
export async function redeemHandoffCode(opts: {
  readonly file: string;
  readonly code: string;
  readonly now?: number;
}): Promise<boolean> {
  if (!CODE_RE.test(opts.code)) return false;
  const now = opts.now ?? Date.now();
  let raw: string;
  try {
    raw = await readFile(opts.file, 'utf8');
  } catch {
    return false;
  }
  let record: { codeHash?: unknown; expiresAt?: unknown };
  try {
    record = JSON.parse(raw) as { codeHash?: unknown; expiresAt?: unknown };
  } catch {
    return false;
  }
  const { codeHash, expiresAt } = record;
  if (typeof codeHash !== 'string' || typeof expiresAt !== 'number') return false;
  if (now > expiresAt) {
    await unlink(opts.file).catch(() => {});
    return false;
  }
  const presented = Buffer.from(hashCode(opts.code), 'hex');
  const stored = Buffer.from(codeHash, 'hex');
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return false;
  }
  await unlink(opts.file).catch(() => {});
  return true;
}
