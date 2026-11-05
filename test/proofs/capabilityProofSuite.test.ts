/**
 * M12 slice 3 — browser archetype + full three-archetype suite and summary.
 */

import { describe, expect, it } from 'vitest';

import { canonicalSerialize } from '../../src/domain/canonicalJson.js';
import {
  CAPABILITY_ARCHETYPES,
  assertCapabilityProofSummaryV1,
  assertCapabilityProofSuiteV1,
  assertCapabilityProofV1,
} from '../../src/domain/capabilityProof.js';
import {
  buildBrowserCapabilityProof,
  buildBrowserCapabilityProofInputs,
} from '../../src/proofs/archetypes/browser.js';
import { buildCodeCapabilityProofInputs } from '../../src/proofs/archetypes/code.js';
import {
  PROOF_BROWSER_EVIDENCE_DIGEST,
  PROOF_BROWSER_MEDIA_TYPE,
  PROOF_BROWSER_SURFACE,
} from '../../src/proofs/spine.js';
import {
  buildCapabilityProofSuite,
  buildCapabilityProofSummary,
} from '../../src/proofs/capabilityProofSuite.js';

const NOW = '2026-09-01T00:00:00.000Z';
const MAIN_SHA = 'a'.repeat(40);

describe('M12 proofs — browser archetype', () => {
  it('drives the real engines and binds a seeded L2 browser artifact', () => {
    const inputs = buildBrowserCapabilityProofInputs(NOW);
    expect(inputs.archetype).toBe('browser');
    expect(inputs.routingDecision).toBeNull();
    expect(inputs.routedEvaluationReceipt).toBeNull();
    expect(inputs.browserEvidenceRef).not.toBeNull();
    // the bound browser artifact is a member of the M5 manifest AND matches the
    // M6 evidence projection digest for that artifactRefId
    const ref = inputs.browserEvidenceRef!;
    expect(
      inputs.evidenceManifest.entries.some(
        (entry) => entry.artifactRefId === ref.artifactRefId,
      ),
    ).toBe(true);
    const projected = inputs.reviewPackage.evidence.find(
      (summary) => summary.artifactRefId === ref.artifactRefId,
    );
    expect(projected?.sha256).toBe(ref.sha256);
    // the bound artifact is a GENUINE browser-surface render — distinct surface
    // and digest from the code archetype's JSON evidence (media type text/html
    // is seeded on the artifact; the M6 projection exposes the browser surface)
    expect(PROOF_BROWSER_MEDIA_TYPE).toBe('text/html');
    expect(ref.sha256).toBe(PROOF_BROWSER_EVIDENCE_DIGEST);
    expect(projected?.surface).toBe(PROOF_BROWSER_SURFACE);
    expect(
      inputs.evidenceManifest.entries.some(
        (entry) => entry.surface === PROOF_BROWSER_SURFACE,
      ),
    ).toBe(true);
    const codeInputs = buildCodeCapabilityProofInputs(NOW);
    expect(ref.sha256).not.toBe(codeInputs.reviewPackage.evidence[0]?.sha256);
    expect(inputs.resultAdmission.outcome).toBe('admitted');

    const proof = buildBrowserCapabilityProof(NOW);
    expect(() => assertCapabilityProofV1(proof)).not.toThrow();
    expect(proof.archetype).toBe('browser');
    expect(proof.browserEvidenceRef).not.toBeNull();
    expect(proof.repairExercised).toBe(false);
  });
});

describe('M12 proofs — full suite and summary', () => {
  it('assembles exactly one proof per archetype against the main SHA', () => {
    const suite = buildCapabilityProofSuite(NOW, MAIN_SHA);
    expect(() => assertCapabilityProofSuiteV1(suite)).not.toThrow();
    expect(suite.builtAgainstMainSha).toBe(MAIN_SHA);
    expect(suite.proofs.map((proof) => proof.archetype)).toEqual([
      ...CAPABILITY_ARCHETYPES,
    ]);
    expect(suite.archetypeCoverage).toEqual([...CAPABILITY_ARCHETYPES]);
    // the code archetype exercised repair; the browser one bound browser evidence
    const browser = suite.proofs.find((proof) => proof.archetype === 'browser');
    const code = suite.proofs.find((proof) => proof.archetype === 'code');
    expect(browser?.browserEvidenceRef).not.toBeNull();
    expect(code?.repairExercised).toBe(true);
  });

  it('summarizes the suite as a faithful glanceable projection', () => {
    const suite = buildCapabilityProofSuite(NOW, MAIN_SHA);
    const summary = buildCapabilityProofSummary(NOW, MAIN_SHA);
    expect(() => assertCapabilityProofSummaryV1(summary)).not.toThrow();
    expect(summary.suiteHash).toBe(suite.suiteHash);
    expect(summary.rows).toHaveLength(3);
    expect(summary.rows.map((row) => row.archetype)).toEqual([
      ...CAPABILITY_ARCHETYPES,
    ]);
    for (const row of summary.rows) {
      expect(row.metricsProvenance).toBe('fixture_declared');
      expect(row.totalCriteria).toBeGreaterThan(0);
    }
  });

  it('is deterministic for a fixed now + main SHA', () => {
    const a = buildCapabilityProofSuite(NOW, MAIN_SHA);
    const b = buildCapabilityProofSuite(NOW, MAIN_SHA);
    expect(canonicalSerialize(a)).toBe(canonicalSerialize(b));
    expect(a.suiteHash).toBe(b.suiteHash);
  });
});
