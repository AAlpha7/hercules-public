/**
 * TasksPanel Done section preserves StateDto last-activity order.
 */
import './setup.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import type { StateDto, Task, TaskState } from '../../../src/web/api.js';
import { TasksPanel } from '../../../src/web/TasksPanel.js';
import { makeTask } from './fixtures.js';

function emptyByState(): Record<TaskState, Task[]> {
  return {
    todo: [],
    in_progress: [],
    review: [],
    done: [],
    cancelled: [],
    retrying: [],
    failed: [],
    deleted: [],
  };
}

function stateWithDone(tasks: Task[]): StateDto {
  const byState = emptyByState();
  byState.done = tasks;
  return {
    ready: true,
    running: [],
    stopping: [],
    repos: [],
    problems: [],
    byState,
    activity: {},
    lastReport: null,
    agents: { default: 'grok', available: ['grok'] },
  };
}

describe('TasksPanel activity sort', () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => {
          map.set(k, String(v));
        },
        removeItem: (k: string) => {
          map.delete(k);
        },
      },
      configurable: true,
      writable: true,
    });
  });

  it('Done section lists more recently active tasks above older ones', () => {
    // StateDto.byState.done is already activity-sorted (newer first). Priority
    // would reverse that — TasksPanel must keep StateDto order.
    const newer = makeTask({
      id: 'done-newer',
      title: 'Recent done',
      state: 'done',
      priority: 50,
      lastEventAt: '2026-06-01T00:00:00.000Z',
      prUrl: null,
      prStatus: null,
    });
    const older = makeTask({
      id: 'done-older',
      title: 'Older done',
      state: 'done',
      priority: 1,
      lastEventAt: '2026-01-01T00:00:00.000Z',
      prUrl: null,
      prStatus: null,
    });

    render(
      <TasksPanel
        state={stateWithDone([newer, older])}
        lang="en"
        now={Date.now()}
        collapsed={{}}
        running={new Set()}
        bulkPending={null}
        pending={null}
        onToggleSection={() => {}}
        onBulkDelete={() => {}}
        onSelectTask={() => {}}
      />,
    );

    const doneHeading = screen.getByRole('heading', { name: /Done/i });
    const section = doneHeading.closest('section');
    expect(section).not.toBeNull();
    const cards = within(section!).getAllByRole('button').filter(
      (el) => el.getAttribute('data-evidence') === 'task-card',
    );
    expect(cards.map((c) => c.getAttribute('data-task-id'))).toEqual([
      'done-newer',
      'done-older',
    ]);
  });
});
