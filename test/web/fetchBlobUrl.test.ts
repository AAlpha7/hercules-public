import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchBlobUrl } from '../../src/web/api.js';

/** Codex R11 B1: a 206 body is incomplete evidence — the loader must refuse it. */
describe('fetchBlobUrl', () => {
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  // authHeaders() reads the token from localStorage (node test env has none).
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => 'test-token',
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  afterEach(() => {
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
  });
  afterAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
  });

  it('refuses a 206 partial response instead of rendering a truncated blob', async () => {
    const created = vi.fn(() => 'blob:never');
    URL.createObjectURL = created as unknown as typeof URL.createObjectURL;
    globalThis.fetch = vi.fn(async () =>
      new Response(new Uint8Array(8), {
        status: 206,
        headers: { 'content-range': 'bytes 0-7/9440223' },
      }),
    ) as unknown as typeof fetch;
    await expect(fetchBlobUrl('/api/tasks/T/screenshots/big.png')).rejects.toMatchObject({
      status: 206,
    });
    await expect(fetchBlobUrl('/api/tasks/T/screenshots/big.png')).rejects.toBeInstanceOf(ApiError);
    expect(created).not.toHaveBeenCalled();
  });

  it('creates an object URL for a complete 200 response', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:ok') as unknown as typeof URL.createObjectURL;
    globalThis.fetch = vi.fn(async () =>
      new Response(new Uint8Array(8), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchBlobUrl('/api/tasks/T/screenshots/ok.png')).resolves.toBe('blob:ok');
  });
});
