import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, type Task } from '../../src/web/api.js';

describe('createTask exact candidate input', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes exact branch and path lease declarations through as JSON', async () => {
    const base = 'a'.repeat(40);
    const tip = 'b'.repeat(40);
    const input = {
      title: 'Exact candidate',
      repo: 'guardian',
      plannedBaseRevision: base,
      affectedPaths: ['WORKFLOW.md'],
      protectedPathsSnapshot: [],
      expectedBaseRevision: base,
      expectedRemoteTip: tip,
    } satisfies Parameters<typeof createTask>[0];
    const response = { id: 'exact-candidate' } as Task;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('localStorage', { getItem: () => 'token' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createTask(input)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(input),
    }));
  });

  it('serialises slug in the POST body', async () => {
    const input = {
      title: 'Sort tasks',
      repo: 'hercules',
      slug: 'x-y',
    } satisfies Parameters<typeof createTask>[0];
    const response = { id: '1-x-y' } as Task;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('localStorage', { getItem: () => 'token' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createTask(input)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(input),
    }));
    expect(JSON.stringify(input)).toContain('"slug":"x-y"');
  });
});
