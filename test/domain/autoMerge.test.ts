import { describe, it, expect } from 'vitest';
import type { Task, TaskState } from '../../src/domain/task.js';
import {
  AUTO_MERGE_DEFAULTS,
  AUTO_MERGE_DWELL_MAX,
  AUTO_MERGE_OPT_OUT_LABEL,
  appendAutoMergeNote,
  evaluateAutoMerge,
  hasAutoMergeNote,
  resolveAutoMergePolicy,
  type AutoMergeDiff,
  type AutoMergePolicy,
} from '../../src/domain/autoMerge.js';
import { renderDecisionCardBlock, type DecisionCard } from '../../src/domain/decisionCard.js';

const ANCHOR = '2026-09-04T03:00:00.000Z';
const POLICY: AutoMergePolicy = {
  enabled: true,
  dwellMinutes: 30,
  maxSize: 'M',
};
const SMALL_DIFF: AutoMergeDiff = {
  files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  insertions: 30,
  deletions: 10,
};

function task(id: string, state: TaskState = 'todo'): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: '',
  };
}

function decisionCard(overrides?: Partial<DecisionCard>): DecisionCard {
  const { boundaries, reviewer, ...rest } = overrides ?? {};
  return {
    v: 1,
    purpose: 'auto-merge fixture',
    areas: [{ area: 'src', count: 3 }],
    filesTouched: 3,
    reviewOnlyFlags: [],
    criteria: [
      {
        text: 'Unit suite passes',
        kind: 'mechanical',
        status: 'pass',
        why: 'ok',
      },
    ],
    gates: [{ name: 'typecheck', passed: true }],
    evidence: { ran: true, ok: true, steps: 1 },
    ...rest,
    boundaries: {
      branch: 'hercules/t1',
      protectedPathsTouched: false,
      testsEdited: false,
      crossTaskIds: [],
      crossTaskCommits: [],
      ...(boundaries ?? {}),
    },
    reviewer: {
      ran: true,
      approved: true,
      summaryZh: 'ok',
      ...(reviewer ?? {}),
    },
  };
}

function greenBody(opts?: {
  readonly timelineOk?: boolean;
  readonly omitTimeline?: boolean;
  readonly omitCard?: boolean;
  readonly card?: DecisionCard;
  readonly humanDod?: boolean;
  readonly note?: boolean;
}): string {
  const dod = opts?.humanDod
    ? '## Definition of Done\n\n- [ ] (mechanical) Unit suite passes\n- [ ] (human) Look at the UI\n'
    : '## Definition of Done\n\n- [ ] (mechanical) Unit suite passes\n';
  const timeline = opts?.omitTimeline
    ? ''
    : opts?.timelineOk === false
      ? `## Run timeline\n\n- \`${ANCHOR}\` **packet_finalize** ❌ — packet finalized — parked for human review\n`
      : `## Run timeline\n\n- \`${ANCHOR}\` **packet_finalize** ✅ — packet finalized — automated proof green\n`;
  const card = opts?.omitCard
    ? ''
    : renderDecisionCardBlock(opts?.card ?? decisionCard());
  const note = opts?.note
    ? '\n## Auto-merge (2026-09-04T04:00:00.000Z)\n\nalready tried\n'
    : '';
  return `${dod}\n${timeline}\n${card}${note}`;
}

function eligibleTask(overrides?: Partial<Task>): Task {
  return {
    ...task('t1', 'review'),
    verifiedSha: 'abc1234',
    endedAt: ANCHOR,
    lastEventAt: ANCHOR,
    body: greenBody(),
    ...overrides,
  };
}

function nowAfter(minutes: number): Date {
  return new Date(Date.parse(ANCHOR) + minutes * 60_000);
}

describe('resolveAutoMergePolicy', () => {
  it('fills dwellMinutes and maxSize from AUTO_MERGE_DEFAULTS', () => {
    expect(resolveAutoMergePolicy({ enabled: true })).toEqual({
      enabled: true,
      dwellMinutes: AUTO_MERGE_DEFAULTS.dwellMinutes,
      maxSize: AUTO_MERGE_DEFAULTS.maxSize,
    });
  });

  it('rejects enabled when not a boolean', () => {
    expect(() => resolveAutoMergePolicy({ enabled: 'yes' })).toThrow(/enabled/);
  });

  it('rejects dwellMinutes outside [0, AUTO_MERGE_DWELL_MAX]', () => {
    expect(() =>
      resolveAutoMergePolicy({ enabled: true, dwellMinutes: -1 }),
    ).toThrow(/dwellMinutes/);
    expect(() =>
      resolveAutoMergePolicy({ enabled: true, dwellMinutes: AUTO_MERGE_DWELL_MAX + 1 }),
    ).toThrow(/dwellMinutes/);
    expect(() =>
      resolveAutoMergePolicy({ enabled: true, dwellMinutes: 1.5 }),
    ).toThrow(/dwellMinutes/);
  });

  it('rejects maxSize when not S|M|L', () => {
    expect(() =>
      resolveAutoMergePolicy({ enabled: true, maxSize: 'XL' }),
    ).toThrow(/maxSize/);
  });

  it('rejects unknown keys', () => {
    expect(() =>
      resolveAutoMergePolicy({ enabled: true, surprise: true }),
    ).toThrow(/unknown/);
  });
});

describe('evaluateAutoMerge', () => {
  it('is eligible for the happy path after dwell', () => {
    const verdict = evaluateAutoMerge({
      task: eligibleTask(),
      policy: POLICY,
      diff: SMALL_DIFF,
      now: nowAfter(31),
    });
    expect(verdict).toEqual({
      eligible: true,
      linesChanged: 40,
      size: 'S',
      dwellMinutes: 31,
    });
  });

  it('rejects when policy is missing or disabled', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask(),
        policy: null,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }).eligible,
    ).toBe(false);
    expect(
      evaluateAutoMerge({
        task: eligibleTask(),
        policy: { ...POLICY, enabled: false },
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'auto-merge disabled for repo' });
  });

  it('rejects when not in review', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask({ state: 'todo' }),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'not in review' });
  });

  it('rejects when opted out via no-auto-merge label', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask({ labels: [AUTO_MERGE_OPT_OUT_LABEL] }),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'opted out (no-auto-merge label)' });
  });

  it('rejects when an Auto-merge note already exists', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask({ body: greenBody({ note: true }) }),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({
      eligible: false,
      reason: 'auto-merge already attempted (needs a human)',
    });
  });

  it('rejects when verifiedSha is missing', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask({ verifiedSha: null }),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'no verified sha' });
  });

  it('rejects when pendingSteer is set', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask({ pendingSteer: 'please fix' }),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'pending steer' });
  });

  it('rejects when the last packet_finalize is not green', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask({ body: greenBody({ timelineOk: false }) }),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'packet not green' });
  });

  it('rejects when protected paths were touched', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask({
          body: greenBody({
            card: decisionCard({
              boundaries: {
                branch: 'hercules/t1',
                protectedPathsTouched: true,
                testsEdited: false,
                crossTaskIds: [],
                crossTaskCommits: [],
              },
            }),
          }),
        }),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'protected paths touched' });
  });

  it('rejects when L3 is not approved', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask({
          body: greenBody({
            card: decisionCard({
              reviewer: { ran: true, approved: false, summaryZh: 'no' },
            }),
          }),
        }),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'L3 not approved' });
  });

  it('rejects when human acceptance criteria are present', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask({ body: greenBody({ humanDod: true }) }),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(31),
      }),
    ).toEqual({
      eligible: false,
      reason: 'human acceptance criteria present (1)',
    });
  });

  it('rejects when dwell has not elapsed', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask(),
        policy: POLICY,
        diff: SMALL_DIFF,
        now: nowAfter(10),
      }),
    ).toEqual({ eligible: false, reason: 'dwell 10/30 min' });
  });

  it('rejects when diff is unavailable', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask(),
        policy: POLICY,
        diff: null,
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'diff unavailable' });
  });

  it('rejects when a sensitive path is in the diff', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask(),
        policy: POLICY,
        diff: {
          files: ['src/a.ts', 'scripts/deploy-x.sh'],
          insertions: 10,
          deletions: 2,
        },
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'sensitive path: scripts/deploy-x.sh' });
  });

  it('rejects when diff size exceeds policy.maxSize', () => {
    expect(
      evaluateAutoMerge({
        task: eligibleTask(),
        policy: POLICY,
        diff: {
          files: ['src/a.ts'],
          insertions: 280,
          deletions: 20,
        },
        now: nowAfter(31),
      }),
    ).toEqual({ eligible: false, reason: 'diff L exceeds M' });
  });
});

describe('appendAutoMergeNote + hasAutoMergeNote', () => {
  it('round-trips the Auto-merge section', () => {
    const body = '## Goal\n\ndo it\n';
    expect(hasAutoMergeNote(body)).toBe(false);
    const next = appendAutoMergeNote(body, '2026-09-04T05:00:00.000Z', 'pilot approved');
    expect(hasAutoMergeNote(next)).toBe(true);
    expect(next).toContain('## Auto-merge (2026-09-04T05:00:00.000Z)');
    expect(next).toContain('pilot approved');
  });
});
