/**
 * Pull-to-refresh: pure gesture math + SPA wiring for the task list.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PULL_THRESHOLD,
  applyTaskListRefresh,
  canBeginPull,
  dampenPull,
  phaseForDistance,
  shouldTriggerOnRelease,
  type PullPhase,
} from '../../src/web/pullToRefresh.js';
import type { StateDto, Task } from '../../src/web/api.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('pullToRefresh pure gesture math', () => {
  it('exposes a positive release threshold', () => {
    expect(PULL_THRESHOLD).toBeGreaterThan(40);
    expect(PULL_THRESHOLD).toBeLessThanOrEqual(120);
  });

  it('dampenPull maps finger travel to a rubber-band offset', () => {
    expect(dampenPull(0)).toBe(0);
    expect(dampenPull(-10)).toBe(0);
    const small = dampenPull(40);
    const large = dampenPull(200);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(40);
    expect(large).toBeGreaterThan(small);
    // Hard cap so the indicator never flies off-screen.
    expect(large).toBeLessThanOrEqual(160);
  });

  it('phaseForDistance walks idle → pulling → armed; refreshing wins', () => {
    expect(phaseForDistance(0, false)).toBe<PullPhase>('idle');
    expect(phaseForDistance(PULL_THRESHOLD / 2, false)).toBe<PullPhase>('pulling');
    expect(phaseForDistance(PULL_THRESHOLD, false)).toBe<PullPhase>('armed');
    expect(phaseForDistance(PULL_THRESHOLD + 20, false)).toBe<PullPhase>('armed');
    expect(phaseForDistance(0, true)).toBe<PullPhase>('refreshing');
    expect(phaseForDistance(PULL_THRESHOLD + 50, true)).toBe<PullPhase>('refreshing');
  });

  it('canBeginPull only when at top, pulling down, not disabled/refreshing', () => {
    expect(
      canBeginPull({ disabled: false, isRefreshing: false, scrollTop: 0, deltaY: 12 }),
    ).toBe(true);
    expect(
      canBeginPull({ disabled: true, isRefreshing: false, scrollTop: 0, deltaY: 12 }),
    ).toBe(false);
    expect(
      canBeginPull({ disabled: false, isRefreshing: true, scrollTop: 0, deltaY: 12 }),
    ).toBe(false);
    expect(
      canBeginPull({ disabled: false, isRefreshing: false, scrollTop: 8, deltaY: 12 }),
    ).toBe(false);
    expect(
      canBeginPull({ disabled: false, isRefreshing: false, scrollTop: 0, deltaY: -4 }),
    ).toBe(false);
  });

  it('shouldTriggerOnRelease only when armed at finger-up', () => {
    expect(shouldTriggerOnRelease('armed')).toBe(true);
    expect(shouldTriggerOnRelease('pulling')).toBe(false);
    expect(shouldTriggerOnRelease('idle')).toBe(false);
    expect(shouldTriggerOnRelease('refreshing')).toBe(false);
  });
});

describe('applyTaskListRefresh (related task status)', () => {
  function task(over: Partial<Task> & { id: string }): Task {
    return {
      id: over.id,
      title: over.title ?? over.id,
      repo: over.repo ?? 'hercules',
      state: over.state ?? 'todo',
      priority: 100,
      blockedBy: [],
      labels: over.labels ?? [],
      adapter: null,
      agentSession: null,
      pendingSteer: null,
      attempts: 0,
      lastEventAt: over.lastEventAt ?? null,
      createdAt: null,
      startedAt: null,
      endedAt: over.endedAt ?? null,
      prUrl: over.prUrl ?? null,
      prStatus: over.prStatus ?? null,
      planPending: over.planPending ?? false,
      body: '',
    };
  }

  function stateWith(tasks: Task[], running: string[] = []): StateDto {
    const byState: StateDto['byState'] = {
      todo: [],
      in_progress: [],
      review: [],
      done: [],
      cancelled: [],
      retrying: [],
      failed: [],
      deleted: [],
    };
    for (const t of tasks) {
      byState[t.state].push(t);
    }
    return {
      ready: true,
      running,
      stopping: [],
      repos: [],
      problems: [],
      byState,
      activity: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
  }

  it('adopts advanced lifecycle from the refreshed snapshot', () => {
    const selected = task({ id: 'A', state: 'in_progress' });
    const next = stateWith([task({ id: 'A', state: 'review' })], []);
    const out = applyTaskListRefresh(next, selected);
    expect(out.selected?.state).toBe('review');
    expect(out.state.running).toEqual([]);
  });

  it('clears selection when the task vanished after refresh', () => {
    const selected = task({ id: 'gone', state: 'todo' });
    const next = stateWith([task({ id: 'other', state: 'todo' })]);
    const out = applyTaskListRefresh(next, selected);
    expect(out.selected).toBeNull();
    expect(out.state).toBe(next);
  });

  it('keeps null selection and preserves running ids from the snapshot', () => {
    const next = stateWith([task({ id: 'R', state: 'in_progress' })], ['R']);
    const out = applyTaskListRefresh(next, null);
    expect(out.selected).toBeNull();
    expect(out.state.running).toEqual(['R']);
  });
});

describe('PullToRefresh SPA wiring', () => {
  it('exports PullToRefresh with non-passive touchmove and evidence hooks', async () => {
    const src = await readFile(join(ROOT, 'src/web/PullToRefresh.tsx'), 'utf8');
    expect(src).toMatch(/export function PullToRefresh/);
    expect(src).toMatch(/data-evidence=["']pull-to-refresh["']/);
    expect(src).toMatch(/data-evidence=["']pull-indicator["']/);
    expect(src).toMatch(/data-evidence=["']task-list["']/);
    // list feature kind + host-daemon compat (bare 列表 → kind list).
    expect(src).toMatch(/data-evidence=["']list["']/);
    // preventDefault on move requires a non-passive listener.
    expect(src).toMatch(/passive:\s*false/);
    expect(src).toMatch(/touchmove/);
    expect(src).toMatch(/preventDefault/);
    expect(src).toMatch(/onRefresh/);
    expect(src).toMatch(/disabled/);
    // L3: single offset model (indicator height only — no translateY double move).
    expect(src).not.toMatch(/translateY/);
    // L3: refresh failures must not leave unhandled rejections.
    expect(src).toMatch(/catch\s*\{/);
    // Phone a11y: busy + live status while refreshing.
    expect(src).toMatch(/aria-busy/);
    expect(src).toMatch(/aria-live/);
  });

  it('App wraps the task list and reloads full state via refreshAsync/fetchState', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/PullToRefresh/);
    expect(app).toMatch(/refreshAsync/);
    expect(app).toMatch(/fetchState\(\)/);
    // Sheet open must disable the gesture so sheet scroll is not stolen.
    expect(app).toMatch(/disabled=\{sheetOpen\}|disabled=\{[^}]*sheetOpen/);
    // Related task status: pure refresh merge (list + selected + running).
    expect(app).toMatch(/applyTaskListRefresh/);
    expect(app).toMatch(/setState\(/);
  });

  it('styles and i18n cover pull chrome', async () => {
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/pull-to-refresh|ptr-indicator|\.ptr-/);

    const i18n = await readFile(join(ROOT, 'src/web/i18n.ts'), 'utf8');
    expect(i18n).toMatch(/pullRelease|pullRefreshing|pullPull/);
    const { t } = await import('../../src/web/i18n.js');
    for (const key of ['pullPull', 'pullRelease', 'pullRefreshing'] as const) {
      expect(t('en', key).length).toBeGreaterThan(0);
      expect(t('zh', key).length).toBeGreaterThan(0);
      expect(t('zh', key)).not.toBe(t('en', key));
    }
  });
});
