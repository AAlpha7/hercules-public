import { describe, it, expect } from 'vitest';
import {
  evaluateDependency,
  dependencyHolds,
  dependenciesSatisfiedForSchedule,
  firstUnsatisfiedDependency,
  resolveDependencyMode,
  parseDependencyMode,
  toShaAncestryFact,
  isObservedFactoryMerge,
  type DependencyAncestryFacts,
} from '../../src/domain/dependencyGate.js';
import type { Task, TaskState } from '../../src/domain/task.js';

const MERGED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VERIFIED = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TIP = 'cccccccccccccccccccccccccccccccccccccccc';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state: 'todo' as TaskState,
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
    ...over,
  };
}

function gateMergedDep(id = 'DEP'): Task {
  return task(id, {
    state: 'done',
    mergedSha: MERGED,
    mergedVia: 'gate',
    verifiedSha: VERIFIED,
  });
}

const ancestryOk: DependencyAncestryFacts = {
  defaultBranchTip: TIP,
  mergedSha: 'reachable',
  verifiedSha: 'reachable',
};

describe('parseDependencyMode / resolveDependencyMode', () => {
  it('parses known modes and rejects junk', () => {
    expect(parseDependencyMode('gate_merge')).toBe('gate_merge');
    expect(parseDependencyMode('completion_only')).toBe('completion_only');
    expect(parseDependencyMode('GATE_MERGE')).toBe('gate_merge');
    expect(parseDependencyMode('')).toBeNull();
    expect(parseDependencyMode('maybe')).toBeNull();
  });

  it('explicit gate_merge wins; same-repo implement cannot override to completion_only', () => {
    const dep = task('DEP', { repo: 'app' });
    // Same-repo code consumers always gate_merge — completion_only is rejected.
    for (const executionClass of [
      'implement',
      'verify',
      'host_operation',
      'deploy',
    ] as const) {
      expect(
        resolveDependencyMode(
          { repo: 'app', dependencyMode: 'completion_only', executionClass },
          dep,
        ),
        `same-repo ${executionClass}`,
      ).toBe('gate_merge');
    }
    // Cross-repo explore may force gate_merge explicitly.
    expect(
      resolveDependencyMode(
        { repo: 'other', dependencyMode: 'gate_merge', executionClass: 'explore' },
        dep,
      ),
    ).toBe('gate_merge');
  });

  it('completion_only is legitimate for explore and cross-repo only', () => {
    const dep = task('DEP', { repo: 'app' });
    expect(
      resolveDependencyMode(
        { repo: 'app', dependencyMode: 'completion_only', executionClass: 'explore' },
        dep,
      ),
    ).toBe('completion_only');
    expect(
      resolveDependencyMode(
        { repo: 'other', dependencyMode: 'completion_only', executionClass: 'implement' },
        dep,
      ),
    ).toBe('completion_only');
  });

  it('readiness/onboarding/pipeline labels default to completion_only (even same-repo implement)', () => {
    const dep = task('DEP', { repo: 'app' });
    for (const labels of [
      ['onboarding', 'readiness'],
      ['pipeline', 'pipeline:Demo-ready', 'stage:3', 'onboarding', 'readiness'],
      ['readiness'],
    ] as const) {
      expect(
        resolveDependencyMode(
          { repo: 'app', executionClass: 'implement', labels: [...labels] },
          dep,
        ),
        labels.join(','),
      ).toBe('completion_only');
    }
    // Explicit gate_merge still wins on a readiness task.
    expect(
      resolveDependencyMode(
        {
          repo: 'app',
          dependencyMode: 'gate_merge',
          executionClass: 'implement',
          labels: ['onboarding', 'readiness'],
        },
        dep,
      ),
    ).toBe('gate_merge');
  });

  it('readiness implement unblocks on done without gate merge stamps', () => {
    const dep = task('Demo-ready-2', {
      state: 'done',
      mergedVia: 'operator',
      mergedSha: MERGED,
      verifiedSha: VERIFIED,
    });
    const r3 = task('Demo-ready-3', {
      blockedBy: ['Demo-ready-2'],
      executionClass: 'implement',
      labels: ['pipeline', 'pipeline:Demo-ready', 'stage:3', 'onboarding', 'readiness'],
    });
    expect(dependenciesSatisfiedForSchedule(r3, [dep, r3])).toBe(true);
    const evalResult = evaluateDependency(r3, 'Demo-ready-2', dep);
    expect(evalResult).toEqual({ ok: true, mode: 'completion_only' });
  });

  it('legacy same-repo implement/verify/host require gate_merge', () => {
    const dep = task('DEP', { repo: 'app' });
    expect(resolveDependencyMode({ repo: 'app', executionClass: 'implement' }, dep)).toBe(
      'gate_merge',
    );
    expect(resolveDependencyMode({ repo: 'app', executionClass: 'verify' }, dep)).toBe(
      'gate_merge',
    );
    expect(
      resolveDependencyMode({ repo: 'app', executionClass: 'host_operation' }, dep),
    ).toBe('gate_merge');
    // Legacy omit execution_class -> implement.
    expect(resolveDependencyMode({ repo: 'app' }, dep)).toBe('gate_merge');
  });

  it('legacy explore and cross-repo use completion_only', () => {
    const dep = task('DEP', { repo: 'app' });
    expect(resolveDependencyMode({ repo: 'app', executionClass: 'explore' }, dep)).toBe(
      'completion_only',
    );
    expect(
      resolveDependencyMode({ repo: 'other', executionClass: 'implement' }, dep),
    ).toBe('completion_only');
  });
});

describe('evaluateDependency — completion_only', () => {
  it('unlocks explore dependents on done without merge metadata', () => {
    const dependent = task('A', {
      blockedBy: ['DEP'],
      dependencyMode: 'completion_only',
      executionClass: 'explore',
    });
    const dep = task('DEP', { state: 'done' });
    const r = evaluateDependency(dependent, 'DEP', dep);
    expect(r).toEqual({ ok: true, mode: 'completion_only' });
  });

  it('still holds on failed / missing', () => {
    const dependent = task('A', {
      blockedBy: ['DEP'],
      dependencyMode: 'completion_only',
      executionClass: 'explore',
    });
    expect(evaluateDependency(dependent, 'DEP', task('DEP', { state: 'failed' }))).toMatchObject({
      code: 'dep_failed',
      kind: 'broken',
    });
    expect(evaluateDependency(dependent, 'GONE', undefined)).toMatchObject({
      code: 'dep_missing',
    });
  });
});

describe('evaluateDependency — gate_merge metadata', () => {
  const dependent = task('A', { blockedBy: ['DEP'], executionClass: 'implement' });

  it('blocks when upstream is only approved (done, no merge) with dep_awaiting_merge', () => {
    const r = evaluateDependency(dependent, 'DEP', task('DEP', { state: 'done' }));
    expect(r).toMatchObject({
      code: 'dep_awaiting_merge',
      kind: 'awaiting_merge',
    });
    expect('ok' in r && r.ok).toBeFalsy();
    expect('remediation' in r && r.remediation).toMatch(/Merge Selected/);
  });

  it('reports dep_missing_merged_sha when merged_via=gate but merged_sha absent', () => {
    const r = evaluateDependency(
      dependent,
      'DEP',
      task('DEP', {
        state: 'done',
        mergedVia: 'gate',
        mergedSha: null,
        verifiedSha: VERIFIED,
      }),
    );
    expect(r).toMatchObject({ code: 'dep_missing_merged_sha' });
  });

  it('blocks operator / direct merge stamps with dep_merge_not_gate', () => {
    const r = evaluateDependency(
      dependent,
      'DEP',
      task('DEP', {
        state: 'done',
        mergedSha: MERGED,
        mergedVia: 'operator',
        verifiedSha: VERIFIED,
      }),
    );
    expect(r).toMatchObject({ code: 'dep_merge_not_gate' });
  });

  it('unlocks same-repo implement after an observed factory PR merge (no verified_sha)', () => {
    const dep = task('DEP', {
      state: 'done',
      adapter: 'cursor',
      prStatus: 'merged',
      prUrl: 'https://github.com/example-org/acme/pull/41',
      mergedSha: MERGED,
      mergedVia: 'operator',
      verifiedSha: null,
    });
    expect(isObservedFactoryMerge(dep)).toBe(true);
    const r = evaluateDependency(dependent, 'DEP', dep);
    expect(r).toEqual({ ok: true, mode: 'gate_merge' });
    expect(dependenciesSatisfiedForSchedule(dependent, [dep, dependent])).toBe(true);
  });

  it('recognizes factory identity from agentSessionAdapter when task.adapter is unset', () => {
    const dep = task('DEP', {
      state: 'done',
      adapter: null,
      agentSessionAdapter: 'cursor',
      prStatus: 'merged',
      mergedSha: MERGED,
      mergedVia: 'operator',
      verifiedSha: null,
    });
    expect(isObservedFactoryMerge(dep)).toBe(true);
    expect(evaluateDependency(dependent, 'DEP', dep)).toEqual({
      ok: true,
      mode: 'gate_merge',
    });
  });

  it('still holds local CLI operator merge even with a merge SHA and verified tip', () => {
    const dep = task('DEP', {
      state: 'done',
      adapter: 'grok',
      prStatus: 'merged',
      mergedSha: MERGED,
      mergedVia: 'operator',
      verifiedSha: VERIFIED,
    });
    expect(isObservedFactoryMerge(dep)).toBe(false);
    expect(evaluateDependency(dependent, 'DEP', dep)).toMatchObject({
      code: 'dep_merge_not_gate',
    });
  });

  it('waits for factory merge SHA backfill instead of asking for Merge Selected', () => {
    const dep = task('DEP', {
      state: 'done',
      adapter: 'cursor',
      prStatus: 'merged',
      mergedVia: 'operator',
      mergedSha: null,
      verifiedSha: null,
    });
    expect(evaluateDependency(dependent, 'DEP', dep)).toMatchObject({
      code: 'dep_missing_merged_sha',
    });
  });

  it('does not treat factory Approve-only done as an observed merge', () => {
    const dep = task('DEP', {
      state: 'done',
      adapter: 'cursor',
      prStatus: null,
      verifiedSha: null,
    });
    expect(isObservedFactoryMerge(dep)).toBe(false);
    expect(evaluateDependency(dependent, 'DEP', dep)).toMatchObject({
      code: 'dep_awaiting_merge',
    });
  });

  it('blocks missing merged_via even when merged_sha present', () => {
    const r = evaluateDependency(
      dependent,
      'DEP',
      task('DEP', {
        state: 'done',
        mergedSha: MERGED,
        mergedVia: null,
        verifiedSha: VERIFIED,
      }),
    );
    expect(r).toMatchObject({ code: 'dep_merge_not_gate' });
  });

  it('blocks missing verified_sha provenance', () => {
    const r = evaluateDependency(
      dependent,
      'DEP',
      task('DEP', {
        state: 'done',
        mergedSha: MERGED,
        mergedVia: 'gate',
        verifiedSha: null,
      }),
    );
    expect(r).toMatchObject({ code: 'dep_missing_verified_sha' });
  });

  it('passes metadata when gate stamp + verified tip present (no ancestry yet)', () => {
    const r = evaluateDependency(dependent, 'DEP', gateMergedDep());
    expect(r).toEqual({ ok: true, mode: 'gate_merge' });
  });

  it('same-repo implement with explicit completion_only still requires gate merge', () => {
    const forced = task('A', {
      blockedBy: ['DEP'],
      dependencyMode: 'completion_only',
      executionClass: 'implement',
    });
    const r = evaluateDependency(forced, 'DEP', task('DEP', { state: 'done' }));
    expect(r).toMatchObject({ code: 'dep_awaiting_merge' });
  });
});

describe('evaluateDependency — ancestry recheck', () => {
  const dependent = task('A', { blockedBy: ['DEP'] });
  const dep = gateMergedDep();

  it('blocks stale mirror (no tip / unknown objects)', () => {
    expect(
      evaluateDependency(dependent, 'DEP', dep, {
        defaultBranchTip: null,
        mergedSha: 'unknown',
        verifiedSha: 'unknown',
      }),
    ).toMatchObject({ code: 'dep_stale_mirror' });

    expect(
      evaluateDependency(dependent, 'DEP', dep, {
        defaultBranchTip: TIP,
        mergedSha: 'unknown',
        verifiedSha: 'reachable',
      }),
    ).toMatchObject({ code: 'dep_stale_mirror' });
  });

  it('blocks ancestry mismatch on merged or verified sha', () => {
    expect(
      evaluateDependency(dependent, 'DEP', dep, {
        defaultBranchTip: TIP,
        mergedSha: 'not_reachable',
        verifiedSha: 'reachable',
      }),
    ).toMatchObject({ code: 'dep_ancestry_mismatch' });

    expect(
      evaluateDependency(dependent, 'DEP', dep, {
        defaultBranchTip: TIP,
        mergedSha: 'reachable',
        verifiedSha: 'not_reachable',
      }),
    ).toMatchObject({ code: 'dep_ancestry_mismatch' });
  });

  it('unlocks only when tip contains gate merge and verified tip', () => {
    const r = evaluateDependency(dependent, 'DEP', dep, ancestryOk);
    expect(r).toEqual({ ok: true, mode: 'gate_merge' });
  });

  it('factory observed merge proves merged_sha only (verified_sha may stay unknown)', () => {
    const factoryDep = task('DEP', {
      state: 'done',
      adapter: 'cursor',
      prStatus: 'merged',
      mergedSha: MERGED,
      mergedVia: 'operator',
      verifiedSha: null,
    });
    expect(
      evaluateDependency(dependent, 'DEP', factoryDep, {
        defaultBranchTip: TIP,
        mergedSha: 'reachable',
        verifiedSha: 'unknown',
      }),
    ).toEqual({ ok: true, mode: 'gate_merge' });

    expect(
      evaluateDependency(dependent, 'DEP', factoryDep, {
        defaultBranchTip: TIP,
        mergedSha: 'unknown',
        verifiedSha: 'unknown',
      }),
    ).toMatchObject({ code: 'dep_stale_mirror' });

    expect(
      evaluateDependency(dependent, 'DEP', factoryDep, {
        defaultBranchTip: TIP,
        mergedSha: 'not_reachable',
        verifiedSha: 'unknown',
      }),
    ).toMatchObject({ code: 'dep_ancestry_mismatch' });
  });
});

describe('dependencyHolds / schedule / dispatch helpers', () => {
  it('lists awaiting-merge holds for same-repo implement dependents', () => {
    const all = [
      task('DEP', { state: 'done' }),
      task('A', { blockedBy: ['DEP'] }),
    ];
    const holds = dependencyHolds(all[1]!, all);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.code).toBe('dep_awaiting_merge');
    expect(dependenciesSatisfiedForSchedule(all[1]!, all)).toBe(false);
  });

  it('schedule-satisfies after gate metadata; dispatch still needs ancestry', () => {
    const all = [gateMergedDep(), task('A', { blockedBy: ['DEP'] })];
    expect(dependenciesSatisfiedForSchedule(all[1]!, all)).toBe(true);

    const blocked = firstUnsatisfiedDependency(
      all[1]!,
      all,
      new Map([
        [
          'DEP',
          {
            defaultBranchTip: TIP,
            mergedSha: 'not_reachable',
            verifiedSha: 'reachable',
          },
        ],
      ]),
    );
    expect(blocked?.code).toBe('dep_ancestry_mismatch');

    const ok = firstUnsatisfiedDependency(
      all[1]!,
      all,
      new Map([['DEP', ancestryOk]]),
    );
    expect(ok).toBeNull();
  });

  it('dispatch helper fails closed when ancestry map is absent or incomplete', () => {
    const all = [gateMergedDep(), task('A', { blockedBy: ['DEP'] })];
    // Schedule still green (metadata only).
    expect(dependenciesSatisfiedForSchedule(all[1]!, all)).toBe(true);
    // Dispatch helper without map → stale, never metadata-pass.
    expect(firstUnsatisfiedDependency(all[1]!, all)?.code).toBe('dep_stale_mirror');
    // Map present but missing the gate edge entry → stale.
    expect(
      firstUnsatisfiedDependency(all[1]!, all, new Map())?.code,
    ).toBe('dep_stale_mirror');
  });

  it('dispatch helper unlocks factory merge on merged_sha ancestry only', () => {
    const factoryDep = task('DEP', {
      state: 'done',
      adapter: 'cursor',
      prStatus: 'merged',
      mergedSha: MERGED,
      mergedVia: 'operator',
      verifiedSha: null,
    });
    const all = [factoryDep, task('A', { blockedBy: ['DEP'] })];
    expect(dependenciesSatisfiedForSchedule(all[1]!, all)).toBe(true);
    expect(firstUnsatisfiedDependency(all[1]!, all)?.code).toBe('dep_stale_mirror');
    expect(
      firstUnsatisfiedDependency(
        all[1]!,
        all,
        new Map([
          [
            'DEP',
            {
              defaultBranchTip: TIP,
              mergedSha: 'reachable',
              verifiedSha: 'unknown',
            },
          ],
        ]),
      ),
    ).toBeNull();
  });

  it('completion_only cross-repo does not require merge stamps', () => {
    const all = [
      task('DEP', { state: 'done', repo: 'lib' }),
      task('A', { blockedBy: ['DEP'], repo: 'app' }),
    ];
    expect(dependenciesSatisfiedForSchedule(all[1]!, all)).toBe(true);
    // Dispatch helper: completion_only needs no ancestry map.
    expect(firstUnsatisfiedDependency(all[1]!, all)).toBeNull();
  });

  it('toShaAncestryFact maps probe results', () => {
    expect(toShaAncestryFact(true)).toBe('reachable');
    expect(toShaAncestryFact(false)).toBe('not_reachable');
    expect(toShaAncestryFact(null)).toBe('unknown');
    expect(toShaAncestryFact(undefined)).toBe('unknown');
  });
});
