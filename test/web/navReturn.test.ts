import { describe, it, expect } from 'vitest';
import { navCloseLabel, peekNav, popNav, pushNav, type NavReturn } from '../../src/web/navReturn.js';

describe('navReturn', () => {
  it('push/pop restores chat → task → chat', () => {
    let stack: NavReturn[] = [];
    stack = pushNav(stack, { kind: 'session', sessionId: 'logout' });
    expect(peekNav(stack)).toEqual({ kind: 'session', sessionId: 'logout' });
    expect(navCloseLabel(peekNav(stack))).toBe('← Chat');

    // From task, open live session
    stack = pushNav(stack, { kind: 'task', taskId: 'logout' });
    expect(navCloseLabel(peekNav(stack))).toBe('← Task');

    let popped = popNav(stack);
    stack = popped.stack;
    expect(popped.frame).toEqual({ kind: 'task', taskId: 'logout' });
    expect(navCloseLabel(peekNav(stack))).toBe('← Chat');

    popped = popNav(stack);
    expect(popped.frame).toEqual({ kind: 'session', sessionId: 'logout' });
    expect(popped.stack).toEqual([]);
    expect(navCloseLabel(null)).toBe('Close');
  });

  it('caps stack depth', () => {
    let stack: NavReturn[] = [];
    for (let i = 0; i < 12; i += 1) {
      stack = pushNav(stack, { kind: 'task', taskId: `t${i}` });
    }
    expect(stack.length).toBe(8);
    const first = stack[0];
    expect(first?.kind === 'task' && first.taskId).toBe('t4');
  });
});

describe('releases return frame (open task from Releases, come back in place)', () => {
  it('supports a releases frame with scrollTop and a Back label', async () => {
    const { pushNav, popNav, navCloseLabel } = await import('../../src/web/navReturn.js');
    const stack = pushNav([], { kind: 'releases', scrollTop: 420 });
    const { frame } = popNav(stack);
    expect(frame).toEqual({ kind: 'releases', scrollTop: 420 });
    expect(navCloseLabel(frame)).toBe('← Releases');
  });

  it('App wires releases → task → back with scroll restore', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/kind:\s*'releases'/);
    expect(app).toMatch(/releasesSheetRef/);
    const panel = await readFile(join(ROOT, 'src/web/ReleasesPanel.tsx'), 'utf8');
    expect(panel).toMatch(/restoreScrollTop/);
  });
});
