import { describe, it, expect } from 'vitest';
import type { Task } from '../../src/domain/task.js';
import {
  aggregatePlatformRemediation,
  buildBootstrapEscalationSection,
  buildDefaultRemediationBody,
  buildPlatformRemediationSection,
  hasBootstrapEscalation,
  isPlatformRemediationKind,
  isPlatformRemediationOriginal,
  isPlatformRemediationResumedOutcome,
  isPlatformRemediationTask,
  parsePlatformRemediationInput,
  planPlatformRemediationReconcile,
  planResumedOutcomeUpdate,
  resumedOutcomeForRemediationState,
  stampBootstrapEscalation,
  stampOpenChain,
  validatePlatformRemediationRequest,
} from '../../src/domain/platformRemediation.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.title ?? over.id,
    repo: over.repo ?? 'app',
    state: over.state ?? 'failed',
    priority: over.priority ?? 100,
    blockedBy: over.blockedBy ?? [],
    labels: over.labels ?? [],
    adapter: over.adapter ?? null,
    agentSession: over.agentSession ?? null,
    pendingSteer: over.pendingSteer ?? null,
    attempts: over.attempts ?? 0,
    lastEventAt: over.lastEventAt ?? null,
    createdAt: over.createdAt ?? null,
    startedAt: over.startedAt ?? null,
    endedAt: over.endedAt ?? null,
    prUrl: over.prUrl ?? null,
    prStatus: over.prStatus ?? null,
    planPending: over.planPending ?? false,
    body: over.body ?? '',
    ...over,
  };
}

describe('platform remediation kinds + guards', () => {
  it('accepts only the three durable kinds', () => {
    expect(isPlatformRemediationKind('bug')).toBe(true);
    expect(isPlatformRemediationKind('capability_gap')).toBe(true);
    expect(isPlatformRemediationKind('platform_limit')).toBe(true);
    expect(isPlatformRemediationKind('retry')).toBe(false);
    expect(isPlatformRemediationKind('review')).toBe(false);
    expect(isPlatformRemediationKind(null)).toBe(false);
  });

  it('accepts resumed outcomes including bootstrap_escalation', () => {
    expect(isPlatformRemediationResumedOutcome('pending')).toBe(true);
    expect(isPlatformRemediationResumedOutcome('bootstrap_escalation')).toBe(true);
    expect(isPlatformRemediationResumedOutcome('rework')).toBe(false);
  });

  it('maps terminal remediation states; leaves open states null', () => {
    expect(resumedOutcomeForRemediationState('done')).toBe('remediation_done');
    expect(resumedOutcomeForRemediationState('cancelled')).toBe(
      'remediation_cancelled',
    );
    expect(resumedOutcomeForRemediationState('failed')).toBe('remediation_failed');
    expect(resumedOutcomeForRemediationState('review')).toBeNull();
    expect(resumedOutcomeForRemediationState('todo')).toBeNull();
    expect(resumedOutcomeForRemediationState('in_progress')).toBeNull();
  });
});

describe('parsePlatformRemediationInput', () => {
  it('requires kind and accepts a well-typed payload', () => {
    expect(parsePlatformRemediationInput(null).ok).toBe(false);
    expect(parsePlatformRemediationInput({}).ok).toBe(false);
    const r = parsePlatformRemediationInput({
      kind: 'bug',
      id: 'fix-hercules',
      title: 'Fix thrash',
      body: '## Goal\n',
      repo: 'hercules',
      externalAction: 'deploy fix',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('bug');
      expect(r.value.id).toBe('fix-hercules');
      expect(r.value.repo).toBe('hercules');
    }
  });

  it('refuses unsafe ids, unknown kinds, and oversize fields', () => {
    expect(parsePlatformRemediationInput({ kind: 'retry' }).ok).toBe(false);
    expect(parsePlatformRemediationInput({ kind: 'bug', id: '../x' }).ok).toBe(false);
    expect(
      parsePlatformRemediationInput({ kind: 'bug', title: 'x'.repeat(501) }).ok,
    ).toBe(false);
    expect(parsePlatformRemediationInput({ kind: 'bug', repo: 'a/b' }).ok).toBe(
      false,
    );
  });
});

describe('validatePlatformRemediationRequest', () => {
  const base = {
    sourceId: 'ORIG-1',
    remediationId: 'FIX-1',
    kind: 'bug' as const,
    sourceState: 'failed' as const,
    remediationExists: false,
    sourceAlreadyLinked: false,
    sourceIsRemediation: false,
    sourceAlreadyEscalated: false,
    remediationRepoKnown: true,
  };

  it('opens a chain for a failed original with a free remediation id', () => {
    expect(validatePlatformRemediationRequest(base)).toEqual({
      ok: true,
      mode: 'open_chain',
    });
  });

  it('refuses non-failed states (retries/review are not platform remediation)', () => {
    for (const state of ['todo', 'review', 'retrying', 'in_progress', 'done'] as const) {
      const r = validatePlatformRemediationRequest({ ...base, sourceState: state });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/failed|retry|review/i);
    }
  });

  it('refuses arbitrary self-link and collisions', () => {
    expect(
      validatePlatformRemediationRequest({ ...base, remediationId: 'ORIG-1' }).ok,
    ).toBe(false);
    expect(
      validatePlatformRemediationRequest({ ...base, remediationExists: true }).ok,
    ).toBe(false);
    expect(
      validatePlatformRemediationRequest({ ...base, sourceAlreadyLinked: true }).ok,
    ).toBe(false);
    expect(
      validatePlatformRemediationRequest({ ...base, remediationRepoKnown: false }).ok,
    ).toBe(false);
  });

  it('routes remediation-of-remediation to bootstrap_escalation', () => {
    const r = validatePlatformRemediationRequest({
      ...base,
      sourceIsRemediation: true,
    });
    expect(r).toEqual({ ok: true, mode: 'bootstrap_escalation' });
  });

  it('refuses double escalation', () => {
    const r = validatePlatformRemediationRequest({
      ...base,
      sourceIsRemediation: true,
      sourceAlreadyEscalated: true,
    });
    expect(r.ok).toBe(false);
  });
});

describe('stamp + resumed outcome integrity', () => {
  it('stamps bidirectional causal fields without blocked_by', () => {
    const stamp = stampOpenChain({
      originalId: 'ORIG-1',
      remediationId: 'FIX-1',
      kind: 'capability_gap',
      recordedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(stamp.original.platformRemediationTask).toBe('FIX-1');
    expect(stamp.original.platformRemediationResumedOutcome).toBe('pending');
    expect(stamp.remediation.platformRemediationOf).toBe('ORIG-1');
    expect(stamp.remediation.platformRemediationKind).toBe('capability_gap');
  });

  it('updates original only when causal link matches', () => {
    const rem = task({
      id: 'FIX-1',
      state: 'done',
      platformRemediationOf: 'ORIG-1',
      platformRemediationKind: 'bug',
    });
    const original = task({
      id: 'ORIG-1',
      platformRemediationTask: 'FIX-1',
      platformRemediationKind: 'bug',
      platformRemediationResumedOutcome: 'pending',
    });
    expect(planResumedOutcomeUpdate({ remediation: rem, original })).toEqual({
      originalId: 'ORIG-1',
      resumedOutcome: 'remediation_done',
    });
    expect(
      planResumedOutcomeUpdate({
        remediation: rem,
        original: { ...original, platformRemediationTask: 'OTHER' },
      }),
    ).toBeNull();
    expect(
      planResumedOutcomeUpdate({
        remediation: { ...rem, state: 'cancelled' },
        original,
      })?.resumedOutcome,
    ).toBe('remediation_cancelled');
    expect(
      planResumedOutcomeUpdate({
        remediation: { ...rem, state: 'failed' },
        original,
      })?.resumedOutcome,
    ).toBe('remediation_failed');
  });

  it('does not overwrite bootstrap_escalation with remediator terminal', () => {
    const rem = task({
      id: 'FIX-1',
      state: 'failed',
      platformRemediationOf: 'ORIG-1',
      platformRemediationKind: 'bug',
      bootstrapEscalation: true,
    });
    const original = task({
      id: 'ORIG-1',
      platformRemediationTask: 'FIX-1',
      platformRemediationKind: 'bug',
      platformRemediationResumedOutcome: 'bootstrap_escalation',
    });
    expect(planResumedOutcomeUpdate({ remediation: rem, original })).toBeNull();
  });

  it('bootstrap stamp sets external action + original outcome', () => {
    const s = stampBootstrapEscalation({
      externalAction: 'Merge and deploy Hercules fix manually',
      recordedAt: '2026-08-03T01:00:00.000Z',
    });
    expect(s.remediation.bootstrapEscalation).toBe(true);
    expect(s.remediation.bootstrapEscalationAction).toMatch(/Merge and deploy/);
    expect(s.original.platformRemediationResumedOutcome).toBe(
      'bootstrap_escalation',
    );
  });
});

describe('role predicates', () => {
  it('distinguishes original vs remediation vs ordinary tasks', () => {
    const ordinary = task({ id: 'T1' });
    expect(isPlatformRemediationOriginal(ordinary)).toBe(false);
    expect(isPlatformRemediationTask(ordinary)).toBe(false);
    expect(hasBootstrapEscalation(ordinary)).toBe(false);

    const original = task({
      id: 'ORIG',
      platformRemediationKind: 'platform_limit',
      platformRemediationTask: 'FIX',
      platformRemediationResumedOutcome: 'pending',
    });
    expect(isPlatformRemediationOriginal(original)).toBe(true);
    expect(isPlatformRemediationTask(original)).toBe(false);

    const rem = task({
      id: 'FIX',
      platformRemediationOf: 'ORIG',
      platformRemediationKind: 'platform_limit',
    });
    expect(isPlatformRemediationTask(rem)).toBe(true);
  });
});

describe('aggregates', () => {
  it('counts only tasks with durable remediation fields', () => {
    const tasks = [
      task({ id: 'retry-me', state: 'failed', attempts: 3 }),
      task({ id: 'in-review', state: 'review' }),
      task({
        id: 'ORIG-A',
        platformRemediationKind: 'bug',
        platformRemediationTask: 'FIX-A',
        platformRemediationResumedOutcome: 'pending',
        platformRemediationRecordedAt: '2026-08-01T00:00:00.000Z',
      }),
      task({
        id: 'FIX-A',
        state: 'todo',
        platformRemediationOf: 'ORIG-A',
        platformRemediationKind: 'bug',
      }),
      task({
        id: 'ORIG-B',
        platformRemediationKind: 'capability_gap',
        platformRemediationTask: 'FIX-B',
        platformRemediationResumedOutcome: 'remediation_done',
      }),
      task({
        id: 'ORIG-C',
        platformRemediationKind: 'platform_limit',
        platformRemediationTask: 'FIX-C',
        platformRemediationResumedOutcome: 'bootstrap_escalation',
      }),
      task({
        id: 'FIX-C',
        platformRemediationOf: 'ORIG-C',
        platformRemediationKind: 'platform_limit',
        bootstrapEscalation: true,
        bootstrapEscalationAction: 'manual deploy',
      }),
    ];
    const agg = aggregatePlatformRemediation(tasks);
    expect(agg.openChains).toBe(1);
    expect(agg.resolvedDone).toBe(1);
    expect(agg.bootstrapEscalations).toBe(1);
    expect(agg.byKind.bug).toBe(1);
    expect(agg.byKind.capability_gap).toBe(1);
    expect(agg.byKind.platform_limit).toBe(1);
    for (const c of agg.chains) {
      expect(c).not.toHaveProperty('body');
      expect(JSON.stringify(c)).not.toMatch(/\/home\/|secret|token/i);
    }
    expect(agg.chains.some((c) => c.originalTaskId === 'ORIG-A')).toBe(true);
  });

  it('legacy tasks without fields remain valid (zero aggregates)', () => {
    const agg = aggregatePlatformRemediation([
      task({ id: 'legacy-1', state: 'done' }),
      task({ id: 'legacy-2', state: 'failed' }),
    ]);
    expect(agg.openChains).toBe(0);
    expect(agg.resolvedDone).toBe(0);
    expect(agg.bootstrapEscalations).toBe(0);
    expect(agg.chains).toEqual([]);
  });
});

describe('reconcile recovery', () => {
  it('plans outcome sync when remediator is terminal but original still pending', () => {
    const plans = planPlatformRemediationReconcile([
      task({
        id: 'ORIG',
        platformRemediationKind: 'bug',
        platformRemediationTask: 'FIX',
        platformRemediationResumedOutcome: 'pending',
      }),
      task({
        id: 'FIX',
        state: 'failed',
        platformRemediationOf: 'ORIG',
        platformRemediationKind: 'bug',
      }),
    ]);
    expect(plans).toEqual([
      {
        originalId: 'ORIG',
        resumedOutcome: 'remediation_failed',
        remediationId: 'FIX',
      },
    ]);
  });

  it('plans bootstrap outcome when remediator escalated but original lagging', () => {
    const plans = planPlatformRemediationReconcile([
      task({
        id: 'ORIG',
        platformRemediationKind: 'bug',
        platformRemediationTask: 'FIX',
        platformRemediationResumedOutcome: 'pending',
      }),
      task({
        id: 'FIX',
        state: 'failed',
        platformRemediationOf: 'ORIG',
        platformRemediationKind: 'bug',
        bootstrapEscalation: true,
      }),
    ]);
    expect(plans[0]?.resumedOutcome).toBe('bootstrap_escalation');
  });
});

describe('body sections', () => {
  it('builds auditable sections without filesystem paths', () => {
    const a = buildPlatformRemediationSection({
      kind: 'bug',
      remediationTaskId: 'FIX-1',
      recordedAt: '2026-08-03T00:00:00.000Z',
      role: 'original',
      peerTaskId: 'FIX-1',
    });
    expect(a).toMatch(/## Platform remediation/);
    expect(a).toMatch(/FIX-1/);
    expect(a).not.toMatch(/\/home\//);

    const b = buildBootstrapEscalationSection({
      originalTaskId: 'ORIG',
      remediationTaskId: 'FIX',
      kind: 'bug',
      externalAction: 'Apply hotfix on the host',
      recordedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(b).toMatch(/Bootstrap escalation/);
    expect(b).toMatch(/Recursive self-remediation/);
    expect(b).toMatch(/Apply hotfix/);

    const c = buildDefaultRemediationBody({
      originalId: 'ORIG',
      originalTitle: 'Ship feature',
      kind: 'capability_gap',
    });
    expect(c).toMatch(/platform remediation/i);
    expect(c).toMatch(/ORIG/);
  });
});
