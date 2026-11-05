/**
 * Failed tasks: run timeline is present (kinds for phone diagnosis), collapsed default.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOnboardFailureTimeline,
  renderRunTimelineSection,
  resolveRunTimeline,
} from '../../src/domain/runTimeline.js';
import { buildRunFailureSection } from '../../src/domain/runFailure.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('run timeline layout (failed tasks)', () => {
  it('TaskDetail mounts RunTimelinePanel for failed tasks with data-evidence hooks', async () => {
    // Task detail moved out of App.tsx in the maint-split-app refactor.
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    const panel = await readFile(join(ROOT, 'src/web/RunTimeline.tsx'), 'utf8');
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');

    expect(src).toMatch(/RunTimelinePanel/);
    expect(src).toMatch(/task\.state === 'failed'/);
    // Must start CLOSED: live host evidenceDrive is plain el.click() (no
    // force-open). defaultOpen for 降级 made L2's summary click *close* the
    // panel so Death cause|xAI 502 left document.body.innerText
    // (2026-07-30 prune-latch-honesty L2 screenshots: ▶ Run timeline closed).
    expect(src).toMatch(/defaultOpen=\{false\}/);
    expect(src).not.toMatch(/adapter\\s\*降级|##\\s\*Adapter failover/);

    expect(panel).toMatch(/data-evidence="run-timeline"/);
    expect(panel).toMatch(/data-evidence="run-timeline-list"/);
    expect(panel).toMatch(/data-evidence=\{`run-timeline-kind-\$\{e\.kind\}`\}/);
    // Failover dispatch detail is phone-visible via a stable evidence hook.
    expect(panel).toMatch(/adapter-failover-timeline/);
    // agent_exit summary carries the precise death cause for L2 assert/screenshot.
    expect(panel).toMatch(/agent-death-cause/);
    expect(panel).toMatch(/resolveRunTimeline/);
    // Death cause also on the always-visible summary hint so text= asserts
    // survive a closed <details> (innerText omits closed content).
    expect(panel).toMatch(/deathHint/);
    expect(panel).toMatch(/terminal\.summary/);
    // Do not bind open={defaultOpen} (controlled-without-onToggle stuck closed).
    expect(panel).not.toMatch(/open=\{defaultOpen/);

    expect(css).toMatch(/\.run-timeline-panel/);
    expect(css).toMatch(/\.run-timeline-list/);
  });

  it('timeline resolves kinds for orbit-class agent_exit failure body', () => {
    const failure = buildRunFailureSection({
      stamp: '2026-07-15T04:08:16.667Z',
      kind: 'agent_exit',
      attempt: 3,
      maxAttempts: 3,
      exitCode: 1,
      adapter: 'grok',
      activityTail: ['cargo build', 'error: link failed'],
      taskId: 'orbit-repo-readiness-onboarding',
    });
    const timeline = renderRunTimelineSection(
      buildOnboardFailureTimeline({
        stamp: '2026-07-15T04:08:16.667Z',
        kind: 'agent_exit',
        startedAt: '2026-07-15T03:50:00.000Z',
        adapter: 'grok',
        activityTail: ['cargo build', 'error: link failed'],
        exitCode: 1,
      }),
    );
    const body = `${failure}\n${timeline}`;
    const events = resolveRunTimeline(body);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('dispatch');
    expect(kinds).toContain('agent_activity');
    expect(kinds).toContain('agent_exit');
    expect(events.at(-1)?.ok).toBe(false);
  });

  it('timeline derives kinds from Run failure alone (legacy sheets)', () => {
    const body = buildRunFailureSection({
      stamp: 't',
      kind: 'provision',
      attempt: 2,
      maxAttempts: 3,
      activityTail: ['provision error: clone refused'],
    });
    const events = resolveRunTimeline(body);
    expect(events.some((e) => e.kind === 'provision')).toBe(true);
    expect(events.some((e) => e.kind === 'dispatch')).toBe(true);
  });

  it('L2 resilience fixture body parses 降级 failover detail + death cause summary', () => {
    const failoverNote =
      'adapter 降级: fake 不健康(3 次异常退出), 本轮使用 claude';
    const timeline = renderRunTimelineSection(
      buildOnboardFailureTimeline({
        stamp: '2026-07-30T04:00:00.000Z',
        kind: 'agent_exit',
        adapter: 'claude',
        deathCause: 'xAI 502 mid-stream',
        exitCode: 1,
        failoverNote,
        activityTail: ['fake: mid-turn tool call'],
      }),
    );
    const failure = buildRunFailureSection({
      stamp: '2026-07-30T04:00:00.000Z',
      kind: 'agent_exit',
      attempt: 1,
      maxAttempts: 3,
      deathCause: 'xAI 502 mid-stream',
      exitCode: 1,
      adapter: 'claude',
    });
    const body = `${failure}\n${timeline}`;
    const events = resolveRunTimeline(body);
    const dispatch = events.find((e) => e.kind === 'dispatch');
    expect(dispatch?.detail).toMatch(/降级/);
    const exit = events.find((e) => e.kind === 'agent_exit');
    expect(exit?.summary).toMatch(/502|mid-stream/i);
    expect(body).toMatch(/Death cause:\*\* xAI 502 mid-stream/);
  });
});
