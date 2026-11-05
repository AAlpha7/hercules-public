/**
 * Minimal fs.stat wrapper (device id only) so store.ts stays injectable/testable
 * without importing node:fs into the pure-ish check.
 */
import { statSync as nodeStatSync } from 'node:fs';

export type StatFn = (path: string) => { dev: number };

export const statSync: StatFn = (path) => {
  const s = nodeStatSync(path);
  return { dev: s.dev };
};
