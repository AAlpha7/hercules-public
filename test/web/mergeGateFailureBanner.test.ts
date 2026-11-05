import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMergeGateFailureReceipt } from '../../src/domain/mergeFailureReceipt.js';

describe('merge gate failure UI surface', () => {
  it('TaskDetail wires merge-gate banner for review tasks', async () => {
    const src = await readFile(join(process.cwd(), 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/MergeGateFailureBanner/);
    expect(src).toMatch(/hasMergeGateFailure/);
    expect(src).toMatch(/parseMergeFailureReceipt/);
  });

  it('banner exposes stable data-evidence hooks and next action', async () => {
    const src = await readFile(
      join(process.cwd(), 'src/web/mergeGateFailureBanner.tsx'),
      'utf8',
    );
    expect(src).toMatch(/data-evidence=\{'merge-gate-failure-receipt'\}/);
    expect(src).toMatch(/data-evidence=\{'merge-gate-failure-summary'\}/);
    expect(src).toMatch(/data-evidence=\{'merge-gate-next-action'\}/);
    expect(src).toMatch(/verification had succeeded/i);
    expect(src).toMatch(/Default branch/);

    const receipt = buildMergeGateFailureReceipt({
      operationId: 'mf-ui',
      createdAt: '2026-08-03T12:00:00.000Z',
      repoKey: 'app',
      taskIds: ['T-1'],
      failedGate: 'test',
      exitStatus: 1,
      rawOutput: 'FAIL boom\n',
    });
    expect(receipt.nextAction.length).toBeGreaterThan(10);
  });
});
