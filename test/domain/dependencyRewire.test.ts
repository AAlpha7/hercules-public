import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/domain/task.js';
import {
  validateDependencyRewire,
  type DependencyRewireChange,
} from '../../src/domain/dependencyRewire.js';

function task(id: string, blockedBy: readonly string[] = [], state: Task['state'] = 'todo'): Task {
  return {
    id, title: id, repo: 'app', state, priority: 1, blockedBy, labels: [], adapter: null,
    agentSession: null, pendingSteer: null, attempts: 0, lastEventAt: null,
    createdAt: null, startedAt: null, endedAt: null, prUrl: null, prStatus: null,
    planPending: false, body: `body-${id}`,
  };
}

const change = (
  id: string,
  expectedBlockedBy: readonly string[],
  blockedBy: readonly string[],
): DependencyRewireChange => ({
  id, expectedBlockedBy, blockedBy, dependencyMode: 'gate_merge',
});

describe('validateDependencyRewire', () => {
  it('validates a multi-task replacement against the final graph', () => {
    const result = validateDependencyRewire(
      [task('A'), task('B', ['A']), task('C', ['B'])],
      [change('B', ['A'], []), change('C', ['B'], ['A'])],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tasks.map((entry) => entry.id)).toEqual(['B', 'C']);
  });

  it.each([
    ['missing selected id', [task('A')], [change('MISSING', [], [])], /missing task/i],
    ['missing dependency id', [task('A')], [change('A', [], ['MISSING'])], /missing dependency/i],
    ['self dependency', [task('A')], [change('A', [], ['A'])], /depend on itself/i],
    ['running selected task', [task('A', [], 'in_progress')], [change('A', [], [])], /running/i],
    ['stale expected set', [task('A', ['B']), task('B')], [change('A', [], [])], /stale/i],
    ['cycle in proposed graph', [task('A'), task('B', ['A'])], [change('A', [], ['B'])], /cycle/i],
    ['unsafe selected id', [task('A')], [change('../A', [], [])], /unsafe task id/i],
    ['unsafe dependency id', [task('A')], [change('A', [], ['../B'])], /unsafe dependency id/i],
  ] as const)('rejects %s before returning replacements', (_name, tasks, changes, pattern) => {
    const result = validateDependencyRewire(tasks, changes);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(pattern) });
  });

  it('treats expected sets as unordered exact sets and rejects duplicates', () => {
    expect(validateDependencyRewire(
      [task('A', ['B', 'C']), task('B'), task('C')],
      [{ ...change('A', ['C', 'B'], []), dependencyMode: 'completion_only' }],
    ).ok).toBe(true);
    expect(validateDependencyRewire(
      [task('A'), task('B')],
      [change('A', [], ['B', 'B'])],
    )).toEqual({ ok: false, reason: expect.stringMatching(/duplicate dependency/i) });
  });
});
