/**
 * L1 rework packet must force fix of attributed gate probes (dogfood task-7).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyGateFailAttribution,
  formatGateFailAttributionMarkdown,
  formatAttributedGateReworkRequirement,
  type BaseTestResult,
} from '../../src/domain/gateFailAttribution.js';
import {
  assembleReviewPacket,
  renderPacketMarkdown,
} from '../../src/verification/packet.js';
import type { GateResult } from '../../src/domain/verification.js';

function baseResults(
  rows: ReadonlyArray<{ id: string; failed: boolean; cache?: boolean }>,
): BaseTestResult[] {
  return rows.map((r) => ({
    testId: r.id,
    failedOnBase: r.failed,
    fromCache: r.cache === true,
  }));
}

describe('attributed L1 rework requirement', () => {
  it('branch-introduced novel probe is named in rework instructions + packet', () => {
    const probe = 'test/web/appSplit.test.ts > App.tsx line budget';
    const cmd = 'pnpm exec vitest run test/web/appSplit.test.ts';
    const report = classifyGateFailAttribution({
      gateName: 'test',
      originalCommand: 'pnpm test',
      mergeBase: 'aaaaaaaaaaaa',
      failedTests: [probe],
      baseResults: baseResults([{ id: probe, failed: false }]),
      filesTouched: ['src/web/App.tsx'],
      rerunCommand: cmd,
    });
    expect(report.outcome).toBe('branch_introduced');
    expect(report.novelTests).toEqual([probe]);
    const requirement = formatAttributedGateReworkRequirement(report);
    const reqText = requirement.join('|');
    expect(reqText).toMatch(/MUST fix attributed L1 probe first/i);
    expect(reqText).toContain(probe);
    expect(reqText).toContain(cmd);
    const md = formatGateFailAttributionMarkdown(report).join('|');
    expect(md).toMatch(/MUST fix attributed L1 probe first/i);
    expect(md).toContain(probe);
    expect(md).toContain(cmd);

    const gates: GateResult[] = [
      { name: 'test', command: 'pnpm test', passed: false, output: 'FAIL ' + probe },
    ];
    const packet = assembleReviewPacket({
      taskId: 'T-appSplit',
      branch: 'hercules/T-appSplit',
      filesTouched: ['src/web/App.tsx'],
      diffSummary: '1 file changed',
      cheatFindings: [],
      selfAssessment: 'fixed something else',
      gates,
      reviewerVerdict: null,
      gateFailAttribution: report,
    });
    expect(packet.autoRework).toBe(true);
    const packetMd = renderPacketMarkdown(packet);
    expect(packetMd).toMatch(/MUST fix attributed L1 probe first/i);
    expect(packetMd).toContain(probe);
    expect(packetMd).toContain(cmd);
  });

  it('trunk-inherited does not bloat rework with MUST-fix-probe', () => {
    const report = classifyGateFailAttribution({
      gateName: 'held-out-smoke',
      originalCommand: 'cargo test',
      mergeBase: '7dbb9a39deadbeef',
      failedTests: ['structural_guards::count'],
      baseResults: baseResults([{ id: 'structural_guards::count', failed: true }]),
      filesTouched: ['web/a.tsx'],
      rerunCommand: 'cargo test structural_guards::count -- --exact',
    });
    expect(formatAttributedGateReworkRequirement(report)).toEqual([]);
    const md2 = formatGateFailAttributionMarkdown(report).join('|');
    expect(md2).not.toMatch(/MUST fix attributed L1 probe first/i);
  });

  it('no named probes yields empty rework requirement', () => {
    const report = classifyGateFailAttribution({
      gateName: 'test',
      originalCommand: 'pnpm test',
      mergeBase: 'cccccccccccc',
      failedTests: [],
      baseResults: [],
      filesTouched: [],
      rerunCommand: null,
      probeFailed: true,
      probeError: 'could not extract',
    });
    expect(formatAttributedGateReworkRequirement(report)).toEqual([]);
  });
});
