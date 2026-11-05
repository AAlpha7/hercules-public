/**
 * Control — policy digest for project-state closure (sha256 of canonical form).
 */
import { createHash } from 'node:crypto';
import {
  projectStateClosureCanonical,
  type ProjectStateClosureContract,
} from '../domain/projectStateClosure.js';

/** Stable sha256 of the trusted closure contract (hex). */
export function projectStateClosurePolicyDigest(
  contract: ProjectStateClosureContract,
): string {
  const canonical = JSON.stringify(projectStateClosureCanonical(contract));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
