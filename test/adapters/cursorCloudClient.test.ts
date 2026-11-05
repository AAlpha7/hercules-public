import { describe, it, expect } from 'vitest';
import {
  createCursorCloudClientFromEnv,
  createCursorCloudHttpClient,
  resolveCursorCloudApiKey,
  CursorCloudAuthError,
  CursorCloudRequestError,
  type CursorCloudFetch,
} from '../../src/adapters/cursorCloudClient.js';

const KEY = 'cursor-secret-key-value';

describe('createCursorCloudHttpClient', () => {
  it('POSTs launch with autoCreatePr and returns a PR handle', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchFn: CursorCloudFetch = async (url, init) => {
      calls.push({ url, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'bc_abc',
            status: 'FINISHED',
            target: { prUrl: 'https://github.com/example-org/acme/pull/7', autoCreatePr: true },
            summary: 'Done',
          }),
      };
    };
    const client = createCursorCloudHttpClient({
      apiKey: KEY,
      fetch: fetchFn,
      baseUrl: 'https://api.cursor.test',
    });
    const snap = await client.launch({
      prompt: 'do the thing',
      repository: 'https://github.com/example-org/acme',
      ref: 'main',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.cursor.test/v0/agents');
    expect(calls[0]!.method).toBe('POST');
    const body = JSON.parse(calls[0]!.body ?? '{}') as {
      prompt: { text: string };
      source: { repository: string; ref: string };
      target: { autoCreatePr: boolean };
    };
    expect(body.prompt.text).toBe('do the thing');
    expect(body.source).toEqual({
      repository: 'https://github.com/example-org/acme',
      ref: 'main',
    });
    expect(body.source).not.toHaveProperty('prUrl');
    expect(body.target.autoCreatePr).toBe(true);
    expect('autoBranch' in body.target).toBe(false);
    expect(snap).toEqual({
      id: 'bc_abc',
      status: 'finished',
      pr: { prUrl: 'https://github.com/example-org/acme/pull/7', prNumber: 7 },
      summary: 'Done',
    });
    expect(JSON.stringify(snap)).not.toContain(KEY);
  });

  it('POSTs rework with source.prUrl so autoBranch:false applies', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchFn: CursorCloudFetch = async (url, init) => {
      calls.push({ url, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'bc_rework',
            status: 'FINISHED',
            summary: 'Pushed the existing head.',
          }),
      };
    };
    const client = createCursorCloudHttpClient({
      apiKey: KEY,
      fetch: fetchFn,
      baseUrl: 'https://api.cursor.test',
    });
    const existing = {
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    };
    const snap = await client.launch({
      prompt: 'rebase the open factory PR',
      repository: 'https://github.com/example-org/acme',
      ref: 'cursor/cloud-T-factory-abc',
      existingPr: existing,
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body ?? '{}') as {
      source: { repository?: string; ref?: string; prUrl?: string };
      target: { autoCreatePr: boolean; autoBranch?: boolean };
    };
    expect(body.source).toEqual({
      prUrl: existing.prUrl,
    });
    expect(body.source).not.toHaveProperty('repository');
    expect(body.source).not.toHaveProperty('ref');
    expect(body.target).toEqual({ autoCreatePr: false, autoBranch: false });
    expect(snap).toEqual({
      id: 'bc_rework',
      status: 'finished',
      summary: 'Pushed the existing head.',
    });
  });

  it('GETs agent status without touching the network default', async () => {
    const fetchFn: CursorCloudFetch = async (url) => {
      expect(url).toBe('https://api.cursor.test/v0/agents/bc_1');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'bc_1', status: 'RUNNING' }),
      };
    };
    const client = createCursorCloudHttpClient({
      apiKey: KEY,
      fetch: fetchFn,
      baseUrl: 'https://api.cursor.test',
    });
    const snap = await client.get('bc_1');
    expect(snap.status).toBe('running');
    expect(snap.pr).toBeUndefined();
  });

  it('does not leak the API key in auth or request errors', async () => {
    const denied: CursorCloudFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => `nope ${KEY}`,
    });
    const client = createCursorCloudHttpClient({ apiKey: KEY, fetch: denied });
    await expect(client.get('bc_1')).rejects.toBeInstanceOf(CursorCloudAuthError);
    try {
      await client.get('bc_1');
    } catch (err) {
      expect((err as Error).message).not.toContain(KEY);
    }

    const boom: CursorCloudFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => `server ${KEY}`,
    });
    const failing = createCursorCloudHttpClient({ apiKey: KEY, fetch: boom });
    await expect(failing.get('bc_1')).rejects.toBeInstanceOf(CursorCloudRequestError);
    try {
      await failing.get('bc_1');
    } catch (err) {
      expect((err as Error).message).not.toContain(KEY);
    }
  });
});

describe('createCursorCloudClientFromEnv', () => {
  it('prefers HERCULES_CURSOR_API_KEY then CURSOR_API_KEY', () => {
    expect(resolveCursorCloudApiKey({})).toBeNull();
    expect(resolveCursorCloudApiKey({ CURSOR_API_KEY: 'cursor-only' })).toBe('cursor-only');
    expect(
      resolveCursorCloudApiKey({
        HERCULES_CURSOR_API_KEY: 'hercules-first',
        CURSOR_API_KEY: 'cursor-only',
      }),
    ).toBe('hercules-first');
  });

  it('fails closed without a key (no implicit live client)', async () => {
    const client = createCursorCloudClientFromEnv({});
    await expect(
      client.launch({ prompt: 'x', repository: 'https://github.com/example-org/acme' }),
    ).rejects.toBeInstanceOf(CursorCloudAuthError);
  });

  it('prefers HERCULES_CURSOR_API_KEY over CURSOR_API_KEY', async () => {
    let usedAuth: string | undefined;
    const fetchFn: CursorCloudFetch = async (_url, init) => {
      usedAuth = init.headers['Authorization'];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'bc_env', status: 'CREATING' }),
      };
    };
    const client = createCursorCloudHttpClient({
      apiKey: 'hercules-key',
      fetch: fetchFn,
    });
    await client.launch({ prompt: 'p', repository: 'https://github.com/example-org/acme' });
    expect(usedAuth).toMatch(/^Basic /);
    expect(usedAuth).not.toContain('hercules-key');
    const decoded = Buffer.from((usedAuth ?? '').slice(6), 'base64').toString('utf8');
    expect(decoded).toBe('hercules-key:');
  });
});
