/**
 * Delivery pipeline lanes — source + pure derivation for phone UI.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveDeliveryPipelineStages } from '../../src/domain/projectStateClosure.js';

describe('delivery pipeline UI hooks', () => {
  it('TaskDetail exposes separate lane evidence hooks', async () => {
    const src = await readFile(
      join(process.cwd(), 'src/web/TaskDetail.tsx'),
      'utf8',
    );
    expect(src).toMatch(/data-evidence="lane-verification"/);
    expect(src).toMatch(/data-evidence="lane-merge-eligibility"/);
    expect(src).toMatch(/data-evidence="lane-project-state-closure"/);
  });

  it('ReleasesPanel renders four distinct delivery lanes', async () => {
    const src = await readFile(
      join(process.cwd(), 'src/web/ReleasesPanel.tsx'),
      'utf8',
    );
    expect(src).toMatch(/data-evidence="delivery-pipeline"/);
    expect(src).toMatch(/data-evidence="lane-verification"/);
    expect(src).toMatch(/data-evidence="lane-merge-eligibility"/);
    expect(src).toMatch(/data-evidence="lane-project-state-closure"/);
    expect(src).toMatch(/data-evidence="lane-deployment"/);
  });

  it('never equates merge with project-state closure or deployment', () => {
    const stages = deriveDeliveryPipelineStages({
      verifiedSha: 'abc',
      state: 'done',
      mergedSha: 'def',
      projectStateClosureStatus: null,
      hasClosureContract: true,
      hasDeployPolicy: true,
      stagingStatus: null,
      productionSha: null,
    });
    expect(stages.mergeEligibility).toBe('merged');
    expect(stages.projectStateClosure).toBe('pending');
    expect(stages.deployment).toBe('pending');
  });
});
