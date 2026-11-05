/**
 * Grok (xAI) Speech-to-Text — server-side only.
 *
 * Credential order:
 *   1. XAI_API_KEY / GROK_API_KEY (console.x.ai)
 *   2. Grok CLI OAuth in ~/.grok/auth.json (same login as headless `grok` agents)
 *      unless HERCULES_XAI_USE_CLI_TOKEN=0
 *
 * Composer also supports free browser Web Speech when this is unset.
 * Never expose the key to the SPA.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { XAI_STT_URL } from './xaiApi.js';

export class SttError extends Error {
  constructor(
    readonly code: 'not_configured' | 'bad_request' | 'upstream' | 'empty',
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

export interface SttResult {
  readonly text: string;
  readonly duration?: number;
  readonly language?: string;
}

export interface SttInput {
  readonly data: Buffer;
  readonly filename: string;
  readonly mime: string;
  /** Optional ISO-ish language code for formatting (e.g. en, ja). */
  readonly language?: string;
}

/** True when the daemon has a key that can call xAI STT. */
export function isSttConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveSttApiKey(env));
}

export function resolveSttApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const a = env['XAI_API_KEY']?.trim();
  if (a) return a;
  const b = env['GROK_API_KEY']?.trim();
  if (b) return b;
  // Same machine login as coding agents. Opt out: HERCULES_XAI_USE_CLI_TOKEN=0.
  if (env['HERCULES_XAI_USE_CLI_TOKEN']?.trim() === '0') return null;
  return readGrokCliAccessToken(env);
}

/**
 * Grok Build CLI login token (OAuth) from ~/.grok/auth.json.
 */
export function readGrokCliAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env['HOME']?.trim() || homedir();
  const path = join(home, '.grok', 'auth.json');
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Shape: { "https://auth.x.ai::<id>": { key, expires_at, ... } }
    for (const v of Object.values(parsed)) {
      if (!v || typeof v !== 'object') continue;
      const entry = v as Record<string, unknown>;
      const key = entry['key'];
      if (typeof key !== 'string' || key.length < 20) continue;
      const exp = entry['expires_at'];
      if (typeof exp === 'string') {
        const t = Date.parse(exp);
        if (Number.isFinite(t) && t < Date.now() - 60_000) continue; // expired
      }
      return key;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Transcribe a short audio clip via Grok STT REST.
 * `file` must be the last multipart field (xAI requirement).
 */
export async function transcribeAudio(
  input: SttInput,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<SttResult> {
  const key = resolveSttApiKey(env);
  if (!key) {
    throw new SttError(
      'not_configured',
      'Voice needs XAI_API_KEY, or a logged-in Grok CLI (~/.grok/auth.json).',
      503,
    );
  }
  if (input.data.length === 0) {
    throw new SttError('bad_request', 'Empty audio', 400);
  }
  // Cap ~2 minutes of 16 kHz mono PCM (~4 MB) or compressed clips.
  if (input.data.length > 8 * 1024 * 1024) {
    throw new SttError('bad_request', 'Audio too large (max 8 MB)', 400);
  }

  const form = new FormData();
  // Optional formatting — only for languages xAI documents.
  const lang = normalizeSttLanguage(input.language);
  if (lang) {
    form.append('format', 'true');
    form.append('language', lang);
  }
  // file last
  form.append(
    'file',
    new Blob([new Uint8Array(input.data)], { type: input.mime || 'application/octet-stream' }),
    input.filename || 'voice.wav',
  );

  let res: Response;
  try {
    res = await fetchImpl(XAI_STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch (err) {
    throw new SttError(
      'upstream',
      `STT network error: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { error?: string | { message?: string }; message?: string };
      if (typeof j.error === 'string') detail = j.error;
      else if (j.error && typeof j.error === 'object' && j.error.message) detail = j.error.message;
      else if (typeof j.message === 'string') detail = j.message;
    } catch {
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
    }
    const code = res.status === 401 || res.status === 403 ? 'not_configured' : 'upstream';
    throw new SttError(code, `Grok STT failed (${res.status}): ${detail}`, res.status === 401 ? 503 : 502);
  }

  const body = (await res.json()) as {
    text?: string;
    duration?: number;
    language?: string;
  };
  const text = (body.text ?? '').trim();
  if (!text) {
    throw new SttError('empty', 'No speech detected — try again closer to the mic.', 422);
  }
  return {
    text,
    ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
    ...(typeof body.language === 'string' ? { language: body.language } : {}),
  };
}

/** Languages that enable xAI inverse text normalization when format=true. */
const FORMAT_LANGS = new Set([
  'ar', 'cs', 'da', 'nl', 'en', 'fil', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko',
  'mk', 'ms', 'fa', 'pl', 'pt', 'ro', 'ru', 'es', 'sv', 'th', 'tr', 'vi',
]);

export function normalizeSttLanguage(raw?: string): string | undefined {
  if (!raw) return undefined;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  if (!base || !FORMAT_LANGS.has(base)) return undefined;
  return base;
}
