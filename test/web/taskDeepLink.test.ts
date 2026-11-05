import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { taskIdFromSearch } from '../../src/web/taskDeepLink.js';

describe('task deep links', () => {
  it('reads a safe task id from the query string', () => {
    expect(taskIdFromSearch('?task=guardian-repo-onboarding')).toBe(
      'guardian-repo-onboarding',
    );
    expect(taskIdFromSearch('?view=tasks&task=guardian-repo-onboarding-v3')).toBe(
      'guardian-repo-onboarding-v3',
    );
  });

  it('ignores missing, empty, or unsafe task ids', () => {
    expect(taskIdFromSearch('')).toBeNull();
    expect(taskIdFromSearch('?task=')).toBeNull();
    expect(taskIdFromSearch('?task=..')).toBeNull();
    expect(taskIdFromSearch('?task=guardian%2Frepo')).toBeNull();
  });

  it('wires the parsed id into the one-time task selection path', async () => {
    const app = await readFile(new URL('../../src/web/App.tsx', import.meta.url), 'utf8');
    expect(app).toMatch(/taskIdFromSearch\(window\.location\.search\)/);
    expect(app).toMatch(/const task = findTask\(state, id\)/);
    expect(app).toMatch(/if \(task\) setSelected\(task\)/);
  });
});
