import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('C3 composition-root wiring points', () => {
  const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');

  it('gates the C3 wiring points by their exact env / roster constants', () => {
    expect(main).toMatch(/HERCULES_V2_EVIDENCE_ROOT/);
    expect(main).toMatch(/HERCULES_V2_REVIEW_EVALUATION/);
    expect(main).toMatch(/HERCULES_V2_APPROVAL_BRIDGE/);
    expect(main).toMatch(/HERCULES_V2_DECISION_EFFECTS/);
    expect(main).toMatch(/AUTHORITY_ROSTER_FILE/);
    expect(main).toMatch(/loadAuthorityRoster\(/);
    expect(main).toMatch(/resolveC3EvidenceRoot\(/);
    expect(main).toMatch(/openC3EvidenceStack\(/);
    expect(main).toMatch(/buildBridgeDelivery\(/);
    expect(main).toMatch(/createDecisionEffectDriver\(/);
    expect(main).toMatch(/produceAllVerifiedEvidence/);
    expect(main).toMatch(/evaluateAllAwaiting/);
    expect(main).toMatch(/openArchiveCapabilityIssuerForComposition/);
    expect(main).toMatch(
      /C3 authority roster absent — evidence\/evaluation producers disabled/,
    );
    // Evaluation ports require the dedicated flag (independent of evidence).
    expect(main).toMatch(
      /HERCULES_V2_REVIEW_EVALUATION['"]\s*\]\s*===\s*['"]1['"]/,
    );
    expect(main).toMatch(/C3 review evaluation enabled/);
  });

  it('defers live commits while a projection envelope is incomplete (resume first)', () => {
    expect(main).toMatch(/assertNoIncompleteEnvelopes\(shadowStore!, commit\.deliveryId\);\s*deliverShadowProjection\(shadowStore!, commit\)/);
    expect(main).toMatch(
      /buildBridgeDelivery\(store, authorityRevision\);\s*if \(delivery === null\) return;[\s\S]{0,240}assertNoIncompleteEnvelopes\(store, delivery\.deliveryId\);/,
    );
    // Resume of incomplete envelopes must not be gated on the pending outbox.
    expect(main).toMatch(/let resumed = true;/);
    expect(main).toMatch(/let canAdvance = resumed && !snapshot\.shadowPending;/);
    expect(main).not.toMatch(/let canAdvance = !snapshot\.shadowPending;/);
  });

  it('stages verified evidence with the task screenshot directory (packet screenshots are basenames)', () => {
    expect(main).toMatch(/screenshotDir: join\(execution\.screenshotsRoot, input\.task\.id\)/);
  });

  it('keeps retiredTaskIds: [] on the reconciliation path (no fabricated retirements)', () => {
    expect(main).toContain('retiredTaskIds: []');
    expect(main).not.toContain('shadowStore.listTaskIds().filter');
  });

  it('keeps Control API V2 behind openControlApiV2Deps with the pinned call shape', () => {
    expect(main).toMatch(/openControlApiV2Deps\(\{\s*store: shadowStore,\s*env: process\.env/);
    expect(main).not.toMatch(/\b(?:controlApiV2Reader|controlApiV2Mutator|controlApiV2Events)\b/);
  });

  it('isolates producer failures so the legacy write path cannot fail because of them', () => {
    expect(main).toMatch(/c3 evidence producer crashed/);
    expect(main).toMatch(/c3 evaluation producer crashed/);
    expect(main).toMatch(/c3 bridge delivery failed/);
    expect(main).toMatch(/enqueueC3Producers/);
  });
});
