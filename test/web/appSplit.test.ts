/**
 * Regression: App.tsx is a thin shell; route panels live in dedicated modules.
 * Prevents re-accumulation of task/session/settings/repos UI into the god module.
 */
import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

async function lineCount(rel: string): Promise<number> {
  const text = await readFile(join(ROOT, rel), 'utf8');
  return text.split('\n').length;
}

describe('App route-level split', () => {
  it('exports route panels as modules (tasks, sessions, settings, repos)', async () => {
    for (const rel of [
      'src/web/TasksPanel.tsx',
      'src/web/TaskDetail.tsx',
      'src/web/CreateForm.tsx',
      'src/web/SessionsPanel.tsx',
      'src/web/SettingsPanel.tsx',
      'src/web/ReposPanel.tsx',
    ]) {
      const st = await stat(join(ROOT, rel));
      expect(st.isFile(), rel).toBe(true);
    }

    const tasks = await readFile(join(ROOT, 'src/web/TasksPanel.tsx'), 'utf8');
    expect(tasks).toMatch(/export function TasksPanel/);
    expect(tasks).toMatch(/SectionClearControl|section-clear-affordance/);
    expect(tasks).toMatch(/TaskCard|card-state-/);
    // Real TaskCard hook for L2 (not a disabled placeholder host).
    expect(tasks).toMatch(/data-evidence=["']task-card["']/);

    const detail = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(detail).toMatch(/export function TaskDetail/);
    expect(detail).toMatch(/data-evidence=["']live-activity["']/);
    expect(detail).toMatch(/data-evidence=["']review-decide["']/);

    const create = await readFile(join(ROOT, 'src/web/CreateForm.tsx'), 'utf8');
    expect(create).toMatch(/export function CreateForm/);
    expect(create).toMatch(/SegmentedControl/);
  });

  it('App imports route panels and no longer defines TaskDetail/CreateForm/TaskCard', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/from ['"]\.\/TasksPanel\.js['"]/);
    expect(app).toMatch(/from ['"]\.\/TaskDetail\.js['"]/);
    expect(app).toMatch(/from ['"]\.\/CreateForm\.js['"]/);
    expect(app).toMatch(/from ['"]\.\/SessionsPanel\.js['"]/);
    expect(app).toMatch(/from ['"]\.\/SettingsPanel\.js['"]/);
    expect(app).toMatch(/from ['"]\.\/ReposPanel\.js['"]/);

    // Definitions must not remain in the shell.
    expect(app).not.toMatch(/^function TaskDetail\(/m);
    expect(app).not.toMatch(/^function CreateForm\(/m);
    expect(app).not.toMatch(/^function TaskCard\(/m);
    expect(app).not.toMatch(/^function SectionClearControl\(/m);
  });

  it('App.tsx is substantially smaller than the pre-split god module (~3.4k lines)', async () => {
    const n = await lineCount('src/web/App.tsx');
    // Shell retains orchestration + voice + host-op approval + create/plan
    // notices + live draft-job SSE/inbox wiring.
    expect(n).toBeLessThan(2400);
    // Sanity: not empty / over-deleted.
    expect(n).toBeGreaterThan(400);
  });
});

describe('App hooks order (staging black-screen regression 2026-07-17)', () => {
  it('calls no hooks after the token-gate early return', async () => {
    // A stale token 401s → signOut() → token=null → early return renders
    // fewer hooks than the authed render → React #300 → blank screen.
    const src = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    const gate = src.indexOf('\n  if (!token) {');
    expect(gate, 'token gate early return present').toBeGreaterThan(0);
    // End of the App component: the next top-level function declaration.
    const rest = src.slice(gate);
    const endRel = rest.search(/\nfunction /);
    const appTail = endRel > 0 ? rest.slice(0, endRel) : rest;
    expect(appTail).not.toMatch(/use(State|Effect|Ref|Callback|Memo|Context)\(/);
  });
});
