/**
 * Execution layer — HTTP Cursor Cloud Agents client (v0).
 *
 * Injected `fetch` so unit tests never hit live Cursor. Auth is env/injected
 * only; the key is never written to disk or interpolated into error text.
 */
import {
  factoryCloudLaunchSource,
  factoryCloudLaunchTarget,
  factoryPrFromUrl,
  mapCursorCloudV0Status,
  type CursorCloudClient,
  type CursorCloudLaunchRequest,
  type CursorCloudSnapshot,
} from '../domain/cursorCloud.js';

export class CursorCloudClientError extends Error {
  override readonly name: string = 'CursorCloudClientError';
}

export class CursorCloudAuthError extends CursorCloudClientError {
  override readonly name = 'CursorCloudAuthError';
}

export class CursorCloudRequestError extends CursorCloudClientError {
  override readonly name = 'CursorCloudRequestError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface CursorCloudHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type CursorCloudFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<CursorCloudHttpResponse>;

export const DEFAULT_CURSOR_CLOUD_API_BASE = 'https://api.cursor.com';

export interface CursorCloudHttpClientOptions {
  readonly apiKey: string;
  readonly fetch?: CursorCloudFetch;
  readonly baseUrl?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function snapshotFromV0Body(value: unknown): CursorCloudSnapshot {
  const obj = asRecord(value);
  if (!obj) throw new CursorCloudClientError('Cursor Cloud response was not an object');
  const id = readString(obj, 'id');
  if (!id || id.trim() === '') {
    throw new CursorCloudClientError('Cursor Cloud response missing agent id');
  }
  const statusRaw = readString(obj, 'status') ?? 'RUNNING';
  const target = asRecord(obj['target']);
  const pr = factoryPrFromUrl(target ? readString(target, 'prUrl') : undefined);
  const summary = readString(obj, 'summary');
  const snapshot: CursorCloudSnapshot = {
    id,
    status: mapCursorCloudV0Status(statusRaw),
    ...(pr ? { pr } : {}),
    ...(summary ? { summary } : {}),
  };
  return snapshot;
}

function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;
}

const defaultFetch: CursorCloudFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  };
};

function redactSecrets(text: string, apiKey: string): string {
  return apiKey.length === 0 ? text : text.split(apiKey).join('[redacted]');
}

export function resolveCursorCloudApiKey(
  env: Readonly<Record<string, string | undefined>> = {},
): string | null {
  const hercules = env['HERCULES_CURSOR_API_KEY']?.trim();
  if (hercules) return hercules;
  const cursor = env['CURSOR_API_KEY']?.trim();
  if (cursor) return cursor;
  return null;
}

export function createCursorCloudHttpClient(
  opts: CursorCloudHttpClientOptions,
): CursorCloudClient {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) {
    throw new CursorCloudAuthError('Cursor Cloud API key is empty');
  }
  const fetchFn = opts.fetch ?? defaultFetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_CURSOR_CLOUD_API_BASE).replace(/\/+$/, '');
  const auth = basicAuthHeader(apiKey);

  const request = async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> => {
    const headers: Record<string, string> = {
      Authorization: auth,
      Accept: 'application/json',
    };
    const init: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string;
    } = {
      method,
      headers:
        body !== undefined
          ? { ...headers, 'Content-Type': 'application/json' }
          : headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    let res: CursorCloudHttpResponse;
    try {
      res = await fetchFn(`${baseUrl}${path}`, init);
    } catch (err) {
      throw new CursorCloudClientError(
        `Cursor Cloud request failed: ${redactSecrets((err as Error).message, apiKey)}`,
      );
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new CursorCloudAuthError('Cursor Cloud authentication failed');
    }
    if (!res.ok) {
      throw new CursorCloudRequestError(
        `Cursor Cloud ${method} ${path} failed (${res.status})`,
        res.status,
      );
    }
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CursorCloudClientError('Cursor Cloud response was not JSON');
    }
  };

  return {
    async launch(input: CursorCloudLaunchRequest): Promise<CursorCloudSnapshot> {
      const target = factoryCloudLaunchTarget(input.existingPr ?? null);
      const payload: Record<string, unknown> = {
        prompt: { text: input.prompt },
        source: factoryCloudLaunchSource({
          repository: input.repository,
          ...(input.ref !== undefined ? { ref: input.ref } : {}),
          ...(input.existingPr ? { existingPr: input.existingPr } : {}),
        }),
        target: target.autoCreatePr
          ? { autoCreatePr: true }
          : { autoCreatePr: false, autoBranch: false },
      };
      return snapshotFromV0Body(await request('POST', '/v0/agents', payload));
    },
    async get(id: string): Promise<CursorCloudSnapshot> {
      return snapshotFromV0Body(await request('GET', `/v0/agents/${encodeURIComponent(id)}`));
    },
    async stop(id: string): Promise<void> {
      await request('POST', `/v0/agents/${encodeURIComponent(id)}/stop`);
    },
  };
}

/** Fail-closed client when no API key is configured. */
export function createMissingCursorCloudClient(): CursorCloudClient {
  const fail = async (): Promise<never> => {
    throw new CursorCloudAuthError(
      'Cursor Cloud API key missing (set HERCULES_CURSOR_API_KEY or CURSOR_API_KEY)',
    );
  };
  return {
    launch: fail,
    get: fail,
    stop: fail,
  };
}

export function createCursorCloudClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CursorCloudClient {
  const key = resolveCursorCloudApiKey(env);
  if (!key) return createMissingCursorCloudClient();
  return createCursorCloudHttpClient({ apiKey: key });
}
