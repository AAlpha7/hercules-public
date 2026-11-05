/**
 * Task list text search: type query -> cards filter; empty state.
 */
import './setup.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

describe('TasksPanel task search', () => {
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

  it('exposes data-evidence=task-search and filters cards by query', async () => {
    const user = userEvent.setup();
    const tasks = [
      makeTask({ id: 't-dark', title: 'Add dark mode', repo: 'app', state: 'todo' }),
      makeTask({ id: 't-ops', title: 'Ops cleanup', repo: 'ops', state: 'todo' }),
      makeTask({ id: 't-light', title: 'Light theme polish', repo: 'app', state: 'review' }),
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

    const search = screen.getByRole('searchbox', { name: /search tasks/i });
    expect(search).toHaveAttribute('data-evidence', 'task-search');

    expect(screen.getByText('Add dark mode')).toBeInTheDocument();
    expect(screen.getByText('Ops cleanup')).toBeInTheDocument();
    expect(screen.getByText('Light theme polish')).toBeInTheDocument();

    await user.type(search, 'dark');

    expect(screen.getByText('Add dark mode')).toBeInTheDocument();
    expect(screen.queryByText('Ops cleanup')).not.toBeInTheDocument();
    expect(screen.queryByText('Light theme polish')).not.toBeInTheDocument();
  });

  it('shows empty state when no tasks match the query', async () => {
    const user = userEvent.setup();
    render(
      <TasksPanel
        state={stateWith([
          makeTask({ id: 'only', title: 'Solo task', repo: 'app', state: 'todo' }),
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

    await user.type(screen.getByRole('searchbox', { name: /search tasks/i }), 'zzz');
    expect(screen.queryByText('Solo task')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-evidence', 'task-search-empty');
  });
});
