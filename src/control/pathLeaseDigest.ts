import { createHash } from 'node:crypto';
import type { Task } from '../domain/task.js';
import {
  normalizeAffectedPaths,
  normalizeProtectedPathsSnapshot,
} from '../domain/taskPathLease.js';

/** Digest binding a verification packet to its reviewed path declaration. */
export function pathLeaseDeclarationDigest(task: Pick<
  Task,
  'plannedBaseRevision' | 'affectedPaths' | 'protectedPathsSnapshot'
>): string | null {
  if (
    task.plannedBaseRevision === undefined &&
    task.affectedPaths === undefined &&
    task.protectedPathsSnapshot === undefined
  ) return null;
  if (
    !task.plannedBaseRevision ||
    !task.affectedPaths ||
    task.protectedPathsSnapshot === undefined
  ) return null;
  const affected = normalizeAffectedPaths(task.affectedPaths);
  const protectedPaths = normalizeProtectedPathsSnapshot(task.protectedPathsSnapshot);
  if (!affected.ok || !protectedPaths.ok) return null;
  const canonical = JSON.stringify({
    base: task.plannedBaseRevision.toLowerCase(),
    affected: affected.scopes,
    protectedPaths: protectedPaths.paths,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
