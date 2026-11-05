/**
 * Structural contract: Repos panel L2 hooks + onboarding pure helpers.
 * Mark-ready force/cancel interaction lives in
 * test/web/render/reposMarkReady.render.test.tsx (asserts forceReady body).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('Repos onboarding UI', () => {
  it('ReposPanel keeps L2 evidence hooks and onboarding entry points', async () => {
    const src = await readFile(join(ROOT, 'src/web/ReposPanel.tsx'), 'utf8');
    // Multi-stage readiness pipeline (not monolithic single task).
    expect(src).toMatch(/draftReadinessPipeline/);
    expect(src).toMatch(/createPipeline/);
    expect(src).toMatch(/Start onboarding/);
    expect(src).toMatch(/4-stage readiness pipeline/);
    expect(src).toMatch(/data-evidence=["']repo-start-onboarding["']/);
    expect(src).toMatch(/data-evidence=["']repo-mark-ready["']/);
    // Panel root + real empty state (empty L2 control plane → assert these).
    expect(src).toMatch(/data-evidence=["']repos-panel["']/);
    expect(src).toMatch(/data-evidence=["']repos-empty["']/);
    // No assert-only shell chrome (placeholder Mark ready is forbidden).
    expect(src).not.toMatch(/shellMarkReadyChrome|repos-shell-actions/);
    // Multi-tap / feedback: active plan badge + flash + no second create.
    expect(src).toMatch(/activeOnboardingTask/);
    expect(src).toMatch(/repo-onboarding-active/);
    expect(src).toMatch(/repo-flash/);
    expect(src).toMatch(/Onboarding already open/);
    expect(src).toMatch(/Creating…/);
    // Checklist score probe (SPEC §15) — async job, advisory only.
    expect(src).toMatch(/startRepoReadinessCheck/);
    expect(src).toMatch(/fetchRepoReadinessCheck/);
    expect(src).toMatch(/data-evidence=["']repo-check-readiness["']/);
    expect(src).toMatch(/data-evidence=["']repo-readiness-status["']/);
    expect(src).toMatch(/data-evidence=["']repo-readiness-score["']/);
    expect(src).toMatch(/data-evidence=["']repo-readiness-detail["']/);
    expect(src).toMatch(/data-evidence=["']repo-mark-ready-force["']/);
    expect(src).toMatch(/never mutates readiness|human still marks ready|hard server gate/);
    expect(src).toMatch(/data-evidence=["']repo-guardian-readiness["']/);
    // Fail-closed: never auto forceReady on probe throw/timeout.
    expect(src).not.toMatch(/forceReady = true; \/\/ probe unavailable/);
  });

  it('activeOnboardingTask prefers plan-pending onboarding tasks', async () => {
    const { activeOnboardingTask } = await import('../../src/web/ReposPanel.js');
    const base = {
      title: 'x',
      repo: 'orbit',
      priority: 1,
      blockedBy: [] as string[],
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
      body: '',
    };
    const done = {
      ...base,
      id: 'old',
      state: 'done' as const,
      labels: ['onboarding'],
      planPending: false,
    };
    const plan = {
      ...base,
      id: 'new-plan',
      state: 'todo' as const,
      labels: ['onboarding', 'readiness'],
      planPending: true,
    };
    expect(activeOnboardingTask([done, plan], 'orbit')?.id).toBe('new-plan');
    expect(activeOnboardingTask([done], 'orbit')).toBeNull();
  });

  it('CreateForm can fill onboarding checklist or readiness pipeline for incomplete repos', async () => {
    const app = await readFile(join(ROOT, 'src/web/CreateForm.tsx'), 'utf8');
    expect(app).toMatch(/Fill onboarding checklist/);
    expect(app).toMatch(/create-fill-onboarding/);
    expect(app).toMatch(/Fill readiness pipeline/);
    expect(app).toMatch(/create-fill-readiness-pipeline/);
    expect(app).toMatch(/draftReadinessPipeline/);
    expect(app).toMatch(/labels\.add\('onboarding'\)/);
    expect(app).toMatch(/labels\.add\('readiness'\)/);
  });

  it('editRepo client accepts readiness patch', async () => {
    const api = await readFile(join(ROOT, 'src/web/api.ts'), 'utf8');
    expect(api).toMatch(/readiness\?: 'ready' \| 'incomplete'/);
  });
});
