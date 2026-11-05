import { describe, it, expect } from 'vitest';
import {
  shouldPreserveHumanRunState,
  honorPendingSteerOnReview,
  isConcurrentAgentSwitch,
  isStuckReviewWithPendingSteer,
  buildStuckReviewSteerHealSection,
  extractReviewPacketContent,
  combinePendingChatMessages,
  MAX_COMBINED_PENDING_STEER_CHARS,
  STUCK_REVIEW_PENDING_STEER_MS,
} from '../../src/domain/runFinalize.js';
import { withReviewPacket } from '../../src/orchestrator/orchestrator.js';
import type { Task, TaskState } from '../../src/domain/task.js';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'A',
    title: 'A',
    repo: 'app',
    state: 'review' as TaskState,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: 'sess',
    pendingSteer: 'fix the assertion',
    attempts: 1,
    lastEventAt: '2026-07-31T04:20:00.000Z',
    createdAt: '2026-07-31T04:00:00.000Z',
    startedAt: '2026-07-31T04:07:00.000Z',
    endedAt: '2026-07-31T04:21:00.000Z',
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: 'body',
    ...over,
  };
}

describe('shouldPreserveHumanRunState', () => {
  it('preserves todo when finalize wanted review (steer/reject race)', () => {
    expect(
      shouldPreserveHumanRunState({
        currentState: 'todo',
        expectedFrom: 'in_progress',
        intendedTo: 'review',
      }),
    ).toBe(true);
  });

  it('preserves todo when finalize wanted retrying (auto-rework race)', () => {
    expect(
      shouldPreserveHumanRunState({
        currentState: 'todo',
        expectedFrom: 'in_progress',
        intendedTo: 'retrying',
      }),
    ).toBe(true);
  });

  it('preserves cancelled / deleted / done', () => {
    for (const currentState of ['cancelled', 'deleted', 'done'] as const) {
      expect(
        shouldPreserveHumanRunState({
          currentState,
          expectedFrom: 'in_progress',
          intendedTo: 'review',
        }),
      ).toBe(true);
    }
  });

  it('does not preserve when disk still in_progress (normal complete)', () => {
    expect(
      shouldPreserveHumanRunState({
        currentState: 'in_progress',
        expectedFrom: 'in_progress',
        intendedTo: 'review',
      }),
    ).toBe(false);
  });

  it('does not preserve retrying→review recovery path', () => {
    expect(
      shouldPreserveHumanRunState({
        currentState: 'retrying',
        expectedFrom: 'in_progress',
        intendedTo: 'review',
      }),
    ).toBe(false);
  });

  it('preserves retrying only for an explicit concurrent switch-now marker', () => {
    const switched = task({
      state: 'retrying',
      body: 'body\n\n## Agent switch (2026-08-02T00:00:00.000Z)\n\nchanged agent\n',
      agentSession: null,
    });
    expect(isConcurrentAgentSwitch('body', switched)).toBe(true);
    expect(
      shouldPreserveHumanRunState({
        currentState: switched.state,
        expectedFrom: 'in_progress',
        intendedTo: 'review',
        preserveRetrying: isConcurrentAgentSwitch('body', switched),
      }),
    ).toBe(true);
    expect(isConcurrentAgentSwitch('body', { ...switched, body: 'body' })).toBe(false);
  });

  it('preserves when caller snapshot is already todo (stale complete thrash)', () => {
    expect(
      shouldPreserveHumanRunState({
        currentState: 'todo',
        expectedFrom: 'todo',
        intendedTo: 'retrying',
      }),
    ).toBe(true);
  });

  it('preserves when caller snapshot is already cancelled', () => {
    expect(
      shouldPreserveHumanRunState({
        currentState: 'cancelled',
        expectedFrom: 'cancelled',
        intendedTo: 'retrying',
      }),
    ).toBe(true);
  });

  it('does not apply to non-finalize transitions (dispatch)', () => {
    expect(
      shouldPreserveHumanRunState({
        currentState: 'todo',
        expectedFrom: 'todo',
        intendedTo: 'in_progress',
      }),
    ).toBe(false);
  });

  it('does not preserve legal todo to review park', () => {
    expect(
      shouldPreserveHumanRunState({
        currentState: 'todo',
        expectedFrom: 'todo',
        intendedTo: 'review',
      }),
    ).toBe(false);
  });
});

describe('honorPendingSteerOnReview', () => {
  it('redirects review → todo when pendingSteer is set', () => {
    expect(
      honorPendingSteerOnReview({
        intendedTo: 'review',
        pendingSteer: 'please rework the flaky assert',
      }),
    ).toBe('todo');
  });

  it('keeps review when no pendingSteer', () => {
    expect(
      honorPendingSteerOnReview({ intendedTo: 'review', pendingSteer: null }),
    ).toBe('review');
    expect(
      honorPendingSteerOnReview({ intendedTo: 'review', pendingSteer: '  ' }),
    ).toBe('review');
  });

  it('does not redirect non-review targets', () => {
    expect(
      honorPendingSteerOnReview({
        intendedTo: 'retrying',
        pendingSteer: 'steer text',
      }),
    ).toBe('retrying');
  });
});

describe('isStuckReviewWithPendingSteer', () => {
  const ended = Date.parse('2026-07-31T04:21:00.000Z');

  it('detects dead state after threshold (incident shape)', () => {
    const t = task();
    expect(isStuckReviewWithPendingSteer(t, ended + STUCK_REVIEW_PENDING_STEER_MS)).toBe(
      true,
    );
    expect(isStuckReviewWithPendingSteer(t, ended + STUCK_REVIEW_PENDING_STEER_MS - 1)).toBe(
      false,
    );
  });

  it('ignores review without pendingSteer', () => {
    expect(
      isStuckReviewWithPendingSteer(
        task({ pendingSteer: null }),
        ended + STUCK_REVIEW_PENDING_STEER_MS * 2,
      ),
    ).toBe(false);
  });

  it('ignores todo + pendingSteer (healthy re-queue)', () => {
    expect(
      isStuckReviewWithPendingSteer(
        task({ state: 'todo' }),
        ended + STUCK_REVIEW_PENDING_STEER_MS * 2,
      ),
    ).toBe(false);
  });

  it('heals immediately when no anchor timestamps', () => {
    expect(
      isStuckReviewWithPendingSteer(
        task({ endedAt: null, lastEventAt: null, createdAt: null }),
        ended,
      ),
    ).toBe(true);
  });
});

describe('buildStuckReviewSteerHealSection + extractReviewPacketContent', () => {
  it('renders a durable timeline note', () => {
    const s = buildStuckReviewSteerHealSection({
      stamp: '2026-07-31T05:10:00.000Z',
      pendingSteerPreview: 'fix failfast negation',
      stuckForMs: 49 * 60_000,
    });
    expect(s).toContain('## Self-heal (stuck review+steer)');
    expect(s).toContain('todo');
    expect(s).toContain('fix failfast negation');
    expect(s).toMatch(/49m/);
  });

  it('extracts packet payload for body fold without losing human trail', () => {
    const once = withReviewPacket('## Task\nDo the thing', '### packet ONE\nreport A');
    const withSteer =
      once.trimEnd() +
      '\n\n## Human steer (2026-07-31T04:15:00.000Z)\n\nplease rework\n';
    const staleFinalize = withReviewPacket('## Task\nDo the thing', '### packet TWO\nreport B');
    const extracted = extractReviewPacketContent(staleFinalize);
    expect(extracted).toContain('### packet TWO');
    const folded = withReviewPacket(withSteer, extracted!);
    expect(folded).toContain('### packet TWO');
    expect(folded).not.toContain('### packet ONE');
    expect(folded).toContain('## Human steer (2026-07-31T04:15:00.000Z)');
    expect(folded).toContain('please rework');
  });

  it('honours packet-end when agent report embeds ## Human steer (writeFinalizePacketOnly fold)', () => {
    const nonce = 'd'.repeat(32);
    // Finalize body: fenced packet whose report prose contains a trail-looking H2
    // BEFORE packet-end — must keep packet-end + decision-card for the fold.
    const finalizeBody = [
      '## Task',
      'Do the thing',
      '',
      '## Review packet',
      '',
      '<!-- hercules:cli-evidence-authority -->',
      `### T-fold — \`hercules/T-fold\``,
      `<!-- hercules:packet v1 nonce=${nonce} -->`,
      '**✅ automated proof complete**',
      '## 决策摘要',
      '- **可信度**:门禁 1/1 绿',
      '<!-- hercules:machine',
      '{"schemaVersion":1,"taskId":"T-fold"}',
      '-->',
      '',
      "**Agent's report**",
      `<!-- hercules:prose-begin kind=report nonce=${nonce} -->`,
      '## Human steer (2026-01-01T00:00:00.000Z)',
      'agent pretended to write a steer inside the report',
      `<!-- hercules:prose-end nonce=${nonce} -->`,
      `<!-- hercules:packet-end nonce=${nonce} -->`,
      '',
      '## Human steer (2026-01-01T01:00:00.000Z)',
      '',
      'real operator note',
    ].join('\n');
    const extracted = extractReviewPacketContent(finalizeBody);
    expect(extracted).not.toBeNull();
    expect(extracted).toContain(`<!-- hercules:packet-end nonce=${nonce} -->`);
    expect(extracted).toContain('hercules:machine');
    expect(extracted).toContain('## Human steer (2026-01-01T00:00:00.000Z)');
    // Real trail after packet-end is not part of the extracted packet.
    expect(extracted).not.toContain('real operator note');

    // Same call sequence writeFinalizePacketOnly uses: extract → withReviewPacket.
    const humanOwned =
      '## Task\nDo the thing\n\n## Human steer (2026-01-01T01:00:00.000Z)\n\nreal operator note\n';
    const folded = withReviewPacket(humanOwned, extracted!);
    expect(folded).toContain(`<!-- hercules:packet-end nonce=${nonce} -->`);
    expect(folded).toContain('hercules:machine');
    expect(folded).toContain('real operator note');
  });
});

describe('combinePendingChatMessages', () => {
  it('returns empty for blank-only queues', () => {
    expect(combinePendingChatMessages([])).toEqual({ text: '', count: 0 });
    expect(combinePendingChatMessages(['  ', ''])).toEqual({ text: '', count: 0 });
  });

  it('preserves a single message as-is', () => {
    expect(combinePendingChatMessages(['  fix the flaky gate  '])).toEqual({
      text: 'fix the flaky gate',
      count: 1,
    });
  });

  it('joins multiple messages in order with index labels', () => {
    const out = combinePendingChatMessages(['first', 'second', 'third']);
    expect(out.count).toBe(3);
    expect(out.text).toBe('[1/3] first\n\n[2/3] second\n\n[3/3] third');
    expect(out.text.indexOf('first')).toBeLessThan(out.text.indexOf('second'));
    expect(out.text.indexOf('second')).toBeLessThan(out.text.indexOf('third'));
  });

  it('hard-bounds total length', () => {
    const out = combinePendingChatMessages(['aaa', 'bbb', 'ccc'], 20);
    expect(out.count).toBe(3);
    expect(out.text.length).toBeLessThanOrEqual(20);
    expect(out.text.endsWith('…')).toBe(true);
    expect(MAX_COMBINED_PENDING_STEER_CHARS).toBe(8000);
  });
});

describe('applyQueuedChatOnFinalize (via chatDelivery)', () => {
  it('merges queue into auto-steer pending_steer and body', async () => {
    const { applyQueuedChatOnFinalize } = await import('../../src/domain/chatDelivery.js');
    const out = applyQueuedChatOnFinalize({
      stamp: '2026-07-31T16:00:00.000Z',
      body: '## Task\nDo it',
      autoPendingSteer: 'L3: fix assertion',
      queueText: 'also fix the title',
      queueCount: 1,
      setPendingSteer: true,
    });
    expect(out.body).toContain('also fix the title');
    expect(out.body).toContain('## Human steer');
    expect(out.pendingSteer).toContain('L3: fix assertion');
    expect(out.pendingSteer).toContain('also fix the title');
  });
});
