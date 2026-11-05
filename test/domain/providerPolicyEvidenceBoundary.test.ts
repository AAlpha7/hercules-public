import { describe, it, expect } from 'vitest';
import {
  classifyFeature,
  evidenceStepsForFeature,
  hasAuthUiIntent,
} from '../../src/domain/featureType.js';
import { resolveEvidencePlan } from '../../src/domain/evidence.js';

describe('provider-policy evidence boundary', () => {
  it('authorized Codex + Settings provider-policy brief is not auth L2', () => {
    const brief = [
      '## Problem',
      'An authorized Codex gpt-5.6-sol/medium agent pre-seeded this exact task branch.',
      '## Required behavior',
      'API and phone Settings expose Codex model/reasoning and Claude enabled state.',
      'No credentials or rejected raw env values enter logs.',
      '## Acceptance criteria',
      '- [ ] (mechanical) State DTO and real Settings render tests show effective provider policy',
    ].join('\n');

    expect(hasAuthUiIntent(brief)).toBe(false);
    expect(classifyFeature(brief)).toBe('settings');

    const wf = evidenceStepsForFeature('settings');
    expect(wf).not.toBeNull();
    const plan = resolveEvidencePlan({ taskBody: brief, workflowEvidence: wf ?? [] });
    expect(plan.source).toBe('workflow');
    expect(plan.steps.some((s) => s.selector?.includes('login'))).toBe(false);
    expect(plan.steps.some((s) => s.selector?.includes('settings-panel'))).toBe(true);
  });
});
