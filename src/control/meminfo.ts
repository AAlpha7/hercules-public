/**
 * Control layer — Linux MemAvailable reader for dynamic caps.
 *
 * Pure parse is unit-tested; the file reader is injectable via path so tests
 * never touch the host /proc. Non-Linux / missing file → null (caller keeps base caps).
 */
import { readFile } from 'node:fs/promises';

const MEMAVAILABLE_RE = /^MemAvailable:\s+(\d+)\s+kB\s*$/m;

/** Parse `/proc/meminfo` text → MemAvailable in bytes, or null if absent. */
export function parseMemAvailableBytes(meminfoText: string): number | null {
  const m = MEMAVAILABLE_RE.exec(meminfoText);
  if (!m) return null;
  const kb = Number(m[1]);
  if (!Number.isFinite(kb) || kb < 0) return null;
  return kb * 1024;
}

/**
 * Read MemAvailable from a meminfo-shaped file (default `/proc/meminfo`).
 * Returns null on any IO or parse failure — never throws.
 */
export async function readMemAvailableBytes(
  path = '/proc/meminfo',
): Promise<number | null> {
  try {
    const text = await readFile(path, 'utf8');
    return parseMemAvailableBytes(text);
  } catch {
    return null;
  }
}

/** Injected reader contract for the orchestrator (sync or async). */
export type MemAvailableReader = () => number | null | Promise<number | null>;
