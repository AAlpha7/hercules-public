/**
 * M12 capability-proof suite builder.
 *
 * Assembles exactly one proof per archetype (code, browser, bounded-non-code)
 * against a trusted main SHA via the pure `assembleCapabilityProofSuite`, and
 * derives the glanceable `summarizeCapabilityProofSuite` projection. Every proof
 * is built by driving the real M6/M9/M10/M11 decision engines over a seeded
 * spine (see `engineChain`); the M8 receipt is constructed and the browser
 * evidence self-seeded (owner decisions m12-evaluation-construction and
 * m12-browser-evidence-seeding). Deterministic for a fixed injected `now`.
 */

import {
  assembleCapabilityProofSuite,
  summarizeCapabilityProofSuite,
  type CapabilityProofSuiteV1,
  type CapabilityProofSummaryV1,
} from '../domain/capabilityProof.js';
import { buildBoundedNonCodeCapabilityProof } from './archetypes/boundedNonCode.js';
import { buildBrowserCapabilityProof } from './archetypes/browser.js';
import { buildCodeCapabilityProof } from './archetypes/code.js';

/**
 * Build the full three-archetype capability-proof suite against the given
 * trusted main SHA (40-hex). Proofs are assembled from the real engine chain
 * and sorted by archetype inside `assembleCapabilityProofSuite`.
 */
export function buildCapabilityProofSuite(
  now: string,
  builtAgainstMainSha: string,
): CapabilityProofSuiteV1 {
  const proofs = [
    buildCodeCapabilityProof(now),
    buildBrowserCapabilityProof(now),
    buildBoundedNonCodeCapabilityProof(now),
  ];
  return assembleCapabilityProofSuite(proofs, builtAgainstMainSha, now);
}

/**
 * Build the glanceable Web-review summary of the full suite — a pure projection
 * over the assembled suite.
 */
export function buildCapabilityProofSummary(
  now: string,
  builtAgainstMainSha: string,
): CapabilityProofSummaryV1 {
  return summarizeCapabilityProofSuite(
    buildCapabilityProofSuite(now, builtAgainstMainSha),
  );
}
