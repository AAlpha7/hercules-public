import { describe, it, expect } from 'vitest';
import {
  draftOnboardingPlan,
  draftReadinessPipeline,
  isOnboardingLabel,
  taskHasOnboardingLabel,
} from '../../src/domain/onboarding.js';
import { selectEligible } from '../../src/domain/scheduling.js';
import type { Task } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    id: over.id,
    title: over.title ?? over.id,
    repo: over.repo ?? 'orbit',
    state: over.state ?? 'todo',
    priority: over.priority ?? 50,
    blockedBy: [],
    labels: over.labels ?? [],
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
    planPending: over.planPending ?? false,
    body: over.body ?? '',
  };
}

describe('draftOnboardingPlan', () => {
  it('emits plan-pending body with onboarding labels and SPEC checklist', () => {
    const d = draftOnboardingPlan('orbit');
    expect(d.planPending).toBe(true);
    expect(d.labels).toEqual(expect.arrayContaining(['onboarding', 'readiness', 'needs-plan']));
    expect(d.title).toMatch(/orbit/i);
    expect(d.body).toMatch(/AGENTS\.md/);
    expect(d.body).toMatch(/WORKFLOW\.md/);
    expect(d.body).toMatch(/ready/);
    expect(d.body).toMatch(/## Definition of Done/);
    expect(d.body).toMatch(/\(mechanical\)/);
    expect(d.body).toMatch(/\(human\)/);
  });

  it('onboarding-labeled todo is eligible on incomplete repo', () => {
    const repos: ReposConfig = {
      repos: {
        orbit: {
          key: 'orbit',
          url: 'https://example.com/orbit.git',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'incomplete',
        },
      },
    };
    const onboard = task({
      id: 'ONB-1',
      repo: 'orbit',
      labels: ['onboarding', 'readiness'],
      planPending: false,
    });
    const normal = task({
      id: 'FEAT-1',
      repo: 'orbit',
      labels: ['ui'],
      planPending: false,
    });
    const admitted = selectEligible({
      tasks: [onboard, normal],
      repos,
      runningTaskIds: new Set(),
      globalCap: 2,
      backoffBaseMs: 1000,
      now: Date.now(),
    });
    expect(admitted.map((t) => t.id)).toEqual(['ONB-1']);
  });
});

describe('draftReadinessPipeline', () => {
  it('emits a 4-stage linear chain with onboarding labels on every stage', () => {
    const d = draftReadinessPipeline('orbit');
    expect(d.repo).toBe('orbit');
    expect(d.title).toMatch(/orbit/i);
    expect(d.idPrefix).toBe('orbit-ready');
    expect(d.priority).toBe(20);
    expect(d.stages).toHaveLength(4);

    const titles = d.stages.map((s) => s.title);
    expect(titles[0]).toMatch(/AGENTS|map/i);
    expect(titles[1]).toMatch(/WORKFLOW/i);
    expect(titles[2]).toMatch(/L1|gate|boot/i);
    expect(titles[3]).toMatch(/ready|checklist|human/i);

    for (const stage of d.stages) {
      expect(stage.labels).toEqual(
        expect.arrayContaining(['onboarding', 'readiness']),
      );
      expect(stage.body).toMatch(/## Definition of Done/);
      expect(stage.body).toMatch(/\(mechanical\)|\(reviewer\)|\(human\)/);
    }
  });

  it('R2 does not require gates green; R3 proves L1 + boot', () => {
    const d = draftReadinessPipeline('heavy');
    const r2 = d.stages[1]!;
    const r3 = d.stages[2]!;
    expect(r2.body).toMatch(/not require|need not be green|broken baseline|without requiring/i);
    expect(r3.body).toMatch(/L1|Layer-1|@gate:test/i);
    expect(r3.body).toMatch(/boot|isolation/i);
  });

  it('R4 is human-gated mark-ready (agent cannot flip readiness)', () => {
    const d = draftReadinessPipeline('bookshelf');
    const r4 = d.stages[3]!;
    expect(r4.body).toMatch(/\(human\)/);
    expect(r4.body).toMatch(/Mark ready|readiness.*ready/i);
    // Forbid instructing the agent to flip readiness; "do not auto-flip" is ok.
    expect(r4.body).toMatch(/Do not.*(?:auto-flip|flip).*readiness|only a human marks ready/i);
    expect(r4.body).not.toMatch(/automatically mark ready|agent (?:must|should) mark ready/i);
  });

  it('pipeline stages remain eligible on incomplete repo via onboarding labels', () => {
    const repos: ReposConfig = {
      repos: {
        heavy: {
          key: 'heavy',
          url: 'https://example.com/heavy.git',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'incomplete',
        },
      },
    };
    const draft = draftReadinessPipeline('heavy');
    const stage1 = task({
      id: `${draft.idPrefix}-1`,
      repo: 'heavy',
      labels: [...draft.stages[0]!.labels],
      planPending: false,
    });
    const normal = task({
      id: 'FEAT-9',
      repo: 'heavy',
      labels: ['feature'],
      planPending: false,
    });
    const admitted = selectEligible({
      tasks: [stage1, normal],
      repos,
      runningTaskIds: new Set(),
      globalCap: 2,
      backoffBaseMs: 1000,
      now: Date.now(),
    });
    expect(admitted.map((t) => t.id)).toEqual([stage1.id]);
  });
});

describe('onboarding labels', () => {
  it('recognizes onboarding and readiness only', () => {
    expect(isOnboardingLabel('onboarding')).toBe(true);
    expect(isOnboardingLabel('Readiness')).toBe(true);
    expect(isOnboardingLabel('ui')).toBe(false);
    expect(taskHasOnboardingLabel(['ui', 'onboarding'])).toBe(true);
  });
});
