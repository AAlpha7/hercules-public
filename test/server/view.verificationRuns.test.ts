import { describe, it, expect } from 'vitest';
import { serializeState } from '../../src/server/view.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import type { VerificationRunMeta } from '../../src/domain/verificationRun.js';

const agents = { default: 'grok', available: ['grok', 'codex', 'claude', 'fake'] as const };

function baseView(over: Partial<RuntimeView> = {}): RuntimeView {
  return {
    snapshot: null,
    running: [],
    stopping: [],
    lastReport: null,
    activity: {},
    pendingChat: {},
    liveRuns: {},
    verificationRuns: {},
    agents: { default: agents.default, available: [...agents.available] },
    ...over,
  };
}

describe('serializeState — verificationRuns', () => {
  it('exposes bounded verificationRuns metadata', () => {
    const run: VerificationRunMeta = {
      taskId: 'T-1',
      phase: 'l1',
      stage: 'test',
      startedAt: '2026-07-31T07:56:00.000Z',
      elapsedMs: 12_345,
      processAlive: true,
      cancelRequested: false,
      lastCompletedStage: 'lint',
    };
    const dto = serializeState(
      baseView({
        running: ['T-1'],
        verificationRuns: { 'T-1': run },
      }),
    );
    expect(dto.verificationRuns['T-1']).toEqual(run);
    // No command/output fields on the public DTO.
    expect(dto.verificationRuns['T-1']).not.toHaveProperty('command');
    expect(dto.verificationRuns['T-1']).not.toHaveProperty('output');
  });

  it('redacts secret-like stage labels on the wire', () => {
    const run: VerificationRunMeta = {
      taskId: 'T-1',
      phase: 'l1',
      stage: 'Bearer sk-live-secret',
      startedAt: '2026-07-31T07:56:00.000Z',
      elapsedMs: 1,
      processAlive: false,
      cancelRequested: true,
      lastCompletedStage: 'HERCULES_TOKEN=demo',
    };
    const dto = serializeState(baseView({ verificationRuns: { 'T-1': run } }));
    expect(dto.verificationRuns['T-1']!.stage).toBe('redacted');
    expect(dto.verificationRuns['T-1']!.lastCompletedStage).toBe('redacted');
    expect(dto.verificationRuns['T-1']!.cancelRequested).toBe(true);
  });

  it('defaults verificationRuns to empty object', () => {
    const dto = serializeState(baseView());
    expect(dto.verificationRuns).toEqual({});
  });
});
