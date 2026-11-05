/**
 * Task list: chip bar filters cards by repo (click → visible set).
 */
import './setup.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StateDto, Task, TaskState } from '../../../src/web/api.js';
import { TasksPanel } from '../../../src/web/TasksPanel.js';
import { REPO_FILTER_KEY } from '../../../src/web/taskUi.js';
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

function stateWith(tasks: Task[]): StateDto {
  const byState = emptyByState();
  for (const t of tasks) {
    byState[t.state].push(t);
  }
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

describe('TasksPanel repo filter', () => {
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

  it('shows All + repo chips and filters cards when a repo is selected', async () => {
    const user = userEvent.setup();
    const tasks = [
      makeTask({ id: 't-app', title: 'App task', repo: 'app', state: 'todo' }),
      makeTask({ id: 't-ops', title: 'Ops task', repo: 'ops', state: 'todo' }),
      makeTask({ id: 't-app-2', title: 'App review', repo: 'app', state: 'review' }),
    ];

    render(
      <TasksPanel
        state={stateWith(tasks)}
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

    const bar = screen.getByRole('toolbar', { name: /filter by repo/i });
    expect(bar).toHaveAttribute('data-evidence', 'repo-filter');
    expect(within(bar).getByRole('button', { name: 'All' })).toHaveAttribute(
      'data-evidence',
      'repo-filter-all',
    );

    // Default: all cards visible.
    expect(screen.getByText('App task')).toBeInTheDocument();
    expect(screen.getByText('Ops task')).toBeInTheDocument();
    expect(screen.getByText('App review')).toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: 'ops' }));

    expect(screen.queryByText('App task')).not.toBeInTheDocument();
    expect(screen.queryByText('App review')).not.toBeInTheDocument();
    expect(screen.getByText('Ops task')).toBeInTheDocument();
    expect(localStorage.getItem(REPO_FILTER_KEY)).toBe('ops');

    await user.click(within(bar).getByRole('button', { name: 'All' }));
    expect(screen.getByText('App task')).toBeInTheDocument();
    expect(screen.getByText('Ops task')).toBeInTheDocument();
    expect(localStorage.getItem(REPO_FILTER_KEY)).toBeNull();
  });

  it('hides the filter bar when only one repo is present', () => {
    render(
      <TasksPanel
        state={stateWith([
          makeTask({ id: 'only', title: 'Solo', repo: 'app', state: 'todo' }),
        ])}
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

    expect(screen.queryByRole('toolbar', { name: /filter by repo/i })).toBeNull();
    expect(screen.getByText('Solo')).toBeInTheDocument();
  });
});
