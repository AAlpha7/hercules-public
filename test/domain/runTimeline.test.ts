import { describe, it, expect } from 'vitest';
import {
  buildOnboardFailureTimeline,
  buildVerifyTimeline,
  parseRunTimeline,
  renderRunTimelineSection,
  resolveRunTimeline,
  type RunTimelineEvent,
} from '../../src/domain/runTimeline.js';
import { buildRunFailureSection } from '../../src/domain/runFailure.js';

describe('runTimeline', () => {
  it('buildOnboardFailureTimeline: provision failure sequence', () => {
    const events = buildOnboardFailureTimeline({
      stamp: '2026-07-17T12:00:00.000Z',
      kind: 'provision',
      startedAt: null,
      adapter: 'grok',
      activityTail: ['provision error: clone failed'],
    });
    expect(events.map((e) => e.kind)).toEqual(['dispatch', 'provision']);
    expect(events.at(-1)?.ok).toBe(false);
    expect(events.at(-1)?.summary).toMatch(/provision|clone/i);
  });

  it('buildOnboardFailureTimeline: stall after activity', () => {
    const events = buildOnboardFailureTimeline({
      stamp: '2026-07-17T12:10:00.000Z',
      kind: 'stall',
      startedAt: '2026-07-17T12:00:00.000Z',
      adapter: 'grok',
      activityTail: [
        'edit src/main.rs',
        'Bash: cargo build',
        'quiet: cargo (process alive)',
        'stall: no events for 10m',
      ],
    });
    expect(events[0]?.kind).toBe('dispatch');
    expect(events.some((e) => e.kind === 'agent_activity')).toBe(true);
    expect(events.at(-1)?.kind).toBe('stall');
    expect(events.at(-1)?.ok).toBe(false);
  });

  it('buildOnboardFailureTimeline: agent_exit', () => {
    const events = buildOnboardFailureTimeline({
      stamp: 't',
      kind: 'agent_exit',
      startedAt: 's',
      exitCode: 1,
      activityTail: ['error: boom'],
    });
    expect(events.map((e) => e.kind)).toContain('agent_exit');
    expect(events.at(-1)?.detail).toMatch(/exit/i);
  });

  it('buildOnboardFailureTimeline: prefers deathCause over bare exit unknown', () => {
    const events = buildOnboardFailureTimeline({
      stamp: 't',
      kind: 'agent_exit',
      exitCode: null,
      deathCause: 'xAI 502 mid-stream',
    });
    const terminal = events.at(-1)!;
    expect(terminal.kind).toBe('agent_exit');
    expect(terminal.summary).toBe('xAI 502 mid-stream');
    expect(terminal.summary).not.toBe('exit unknown');
  });


  it('buildVerifyTimeline: L1/L2/L3 + packet_finalize', () => {
    const events = buildVerifyTimeline({
      stamp: '2026-07-17T13:00:00.000Z',
      startedAt: '2026-07-17T12:00:00.000Z',
      adapter: 'grok',
      activityTail: ['edit a.ts', 'pnpm test'],
      gates: [
        { name: 'typecheck', passed: true, output: 'ok' },
        { name: 'lint', passed: false, output: 'error in a.ts' },
        { name: 'behavioral', passed: true, output: 'ok' },
      ],
      evidenceRun: { ok: true },
      reviewerRan: true,
      reviewerVerdict: { approved: false, summary: 'missing test' },
      green: false,
      autoRework: true,
    });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('dispatch');
    expect(kinds).toContain('agent_activity');
    expect(kinds).toContain('l1');
    expect(kinds).toContain('l2');
    expect(kinds).toContain('l3');
    expect(kinds).toContain('packet_finalize');
    const l1 = events.find((e) => e.kind === 'l1');
    expect(l1?.ok).toBe(false);
    expect(l1?.summary).toMatch(/lint/i);
    const l3 = events.find((e) => e.kind === 'l3');
    expect(l3?.ok).toBe(false);
  });

  it('emits no L2 event when neither evidenceRun.ok nor behavioral.passed is known', () => {
    const events = buildVerifyTimeline({
      stamp: '2026-07-17T13:00:00.000Z',
      startedAt: '2026-07-17T12:00:00.000Z',
      adapter: 'grok',
      activityTail: [],
      gates: [{ name: 'typecheck', passed: true, output: 'ok' }],
      green: true,
      autoRework: false,
    });
    expect(events.some((e) => e.kind === 'l2')).toBe(false);
  });

  it('render + parse round-trip preserves kinds', () => {
    const events: RunTimelineEvent[] = buildOnboardFailureTimeline({
      stamp: '2026-07-17T12:00:00.000Z',
      kind: 'stall',
      startedAt: '2026-07-17T11:50:00.000Z',
      adapter: 'grok',
      activityTail: ['cargo build', 'stall timeout'],
    });
    const md = renderRunTimelineSection(events);
    expect(md).toMatch(/^## Run timeline/m);
    const parsed = parseRunTimeline(md);
    expect(parsed.map((e) => e.kind)).toEqual(events.map((e) => e.kind));
    expect(parsed.every((e) => e.summary.length > 0)).toBe(true);
  });

  it('resolveRunTimeline prefers explicit section over derivation', () => {
    const events = buildOnboardFailureTimeline({
      stamp: 't',
      kind: 'provision',
      activityTail: ['provision error: boom'],
    });
    const body =
      '## Task\n\nx\n\n' +
      buildRunFailureSection({
        stamp: 't',
        kind: 'stall', // different — derivation would use this
        attempt: 1,
        maxAttempts: 3,
      }) +
      '\n' +
      renderRunTimelineSection(events);
    const resolved = resolveRunTimeline(body);
    expect(resolved.map((e) => e.kind)).toEqual(events.map((e) => e.kind));
    expect(resolved.some((e) => e.kind === 'provision')).toBe(true);
  });

  it('resolveRunTimeline derives from Run failure when no timeline section', () => {
    const body = buildRunFailureSection({
      stamp: '2026-07-15T04:08:16.667Z',
      kind: 'agent_exit',
      attempt: 3,
      maxAttempts: 3,
      exitCode: 1,
      adapter: 'grok',
      activityTail: ['error: boom', 'max turns reached'],
      taskId: 'orbit-repo-readiness-onboarding',
    });
    const resolved = resolveRunTimeline(body);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.map((e) => e.kind)).toContain('agent_exit');
    expect(resolved.some((e) => e.kind === 'agent_activity' || e.kind === 'dispatch')).toBe(
      true,
    );
  });

  it('empty body yields empty timeline', () => {
    expect(resolveRunTimeline('')).toEqual([]);
    expect(parseRunTimeline('no timeline here')).toEqual([]);
  });

  it('parseRunTimeline / resolveRunTimeline select the latest section (multi-attempt)', () => {
    // Phone diagnosis for re-dispatched tasks: body may accumulate one
    // timeline per attempt. First attempt stalled; latest died agent_exit.
    const stallEvents = buildOnboardFailureTimeline({
      stamp: '2026-07-17T10:00:00.000Z',
      kind: 'stall',
      startedAt: '2026-07-17T09:50:00.000Z',
      adapter: 'grok',
      activityTail: ['cargo build', 'stall: no events for 10m'],
    });
    const exitEvents = buildOnboardFailureTimeline({
      stamp: '2026-07-17T12:00:00.000Z',
      kind: 'agent_exit',
      startedAt: '2026-07-17T11:50:00.000Z',
      adapter: 'grok',
      exitCode: 1,
      activityTail: ['edit src/main.rs', 'error: boom'],
    });
    const body =
      '## Task\n\nretry after stall\n\n' +
      renderRunTimelineSection(stallEvents) +
      '\n## Run failure (2026-07-17T10:00:00.000Z)\n\n**Kind:** `stall`\n\n' +
      renderRunTimelineSection(exitEvents) +
      '\n## Run failure (2026-07-17T12:00:00.000Z)\n\n**Kind:** `agent_exit`\n';

    const parsed = parseRunTimeline(body);
    expect(parsed.map((e) => e.kind)).toEqual(exitEvents.map((e) => e.kind));
    expect(parsed.at(-1)?.kind).toBe('agent_exit');

    const resolved = resolveRunTimeline(body);
    expect(resolved.at(-1)?.kind).toBe('agent_exit');
    expect(resolved.some((e) => e.kind === 'stall')).toBe(false);
  });

  it('resolveRunTimeline prefers latest verify timeline over earlier onboard failure', () => {
    // Fail-then-packet history: onboard stall section first, then a later
    // verify/packet section after re-dispatch — phone should show gates.
    const stallEvents = buildOnboardFailureTimeline({
      stamp: '2026-07-17T10:00:00.000Z',
      kind: 'stall',
      startedAt: '2026-07-17T09:50:00.000Z',
      activityTail: ['stall: no events'],
    });
    const verifyEvents = buildVerifyTimeline({
      stamp: '2026-07-17T14:00:00.000Z',
      startedAt: '2026-07-17T13:00:00.000Z',
      adapter: 'grok',
      activityTail: ['pnpm test'],
      gates: [
        { name: 'typecheck', passed: true, output: 'ok' },
        { name: 'behavioral', passed: true, output: 'ok' },
      ],
      evidenceRun: { ok: true },
      reviewerRan: true,
      reviewerVerdict: { approved: false, summary: 'use latest timeline' },
      green: false,
      autoRework: true,
    });
    const body =
      renderRunTimelineSection(stallEvents) +
      '\n' +
      renderRunTimelineSection(verifyEvents);

    const resolved = resolveRunTimeline(body);
    const kinds = resolved.map((e) => e.kind);
    expect(kinds).toContain('l1');
    expect(kinds).toContain('l2');
    expect(kinds).toContain('l3');
    expect(kinds).toContain('packet_finalize');
    expect(resolved.at(-1)?.kind).toBe('packet_finalize');
    expect(kinds).not.toContain('stall');
  });
});
