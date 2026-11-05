/**
 * Grok Voice Agent (Realtime) — server-side mint only.
 *
 * Browser never sees credentials. We mint a short-lived client secret; the SPA
 * connects to wss://api.x.ai/v1/realtime with subprotocol `xai-client-secret.{token}`.
 *
 * Credentials: XAI_API_KEY / GROK_API_KEY, else Grok CLI ~/.grok/auth.json
 * (same login as coding agents). Set HERCULES_XAI_USE_CLI_TOKEN=0 to disable CLI fallback.
 *
 * Product scope: operate the phone Remote Control UX via tools — NOT coding.
 */
import { resolveSttApiKey } from './stt.js';
import { resolveRealtimeWsUrl, resolveVoiceModel, XAI_REALTIME_MINT_URL } from './xaiApi.js';

export class VoiceError extends Error {
  constructor(
    readonly code: 'not_configured' | 'upstream',
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'VoiceError';
  }
}

export function isVoiceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveSttApiKey(env));
}

export function voiceAgentModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveVoiceModel(env);
}

/** Hard session cap (seconds) — client enforces; mint response advertises it. */
export function voiceMaxSessionSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['HERCULES_VOICE_MAX_SECONDS'] ?? 600);
  return Number.isFinite(n) && n >= 60 ? Math.min(n, 1800) : 600;
}

export const VOICE_CLIENT_SECRET_TTL_SECONDS = 300;

export interface MintedVoiceSession {
  readonly clientSecret: string;
  readonly expiresInSeconds: number;
  readonly model: string;
  readonly wsUrl: string;
  readonly maxSessionSeconds: number;
}

/**
 * Exchange a real xAI credential for an ephemeral realtime client secret.
 */
export async function mintVoiceClientSecret(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<MintedVoiceSession> {
  const key = resolveSttApiKey(env);
  if (!key) {
    throw new VoiceError(
      'not_configured',
      'Voice Control needs XAI_API_KEY or a logged-in Grok CLI (~/.grok/auth.json).',
      503,
    );
  }

  const expiresSeconds = VOICE_CLIENT_SECRET_TTL_SECONDS;
  const mintUrl = XAI_REALTIME_MINT_URL;

  let res: Response;
  try {
    res = await fetchImpl(mintUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expires_after: { seconds: expiresSeconds } }),
    });
  } catch (err) {
    throw new VoiceError(
      'upstream',
      `Voice mint network error: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new VoiceError(
      res.status === 401 || res.status === 403 ? 'not_configured' : 'upstream',
      `Voice mint failed (${res.status}): ${detail}`,
      res.status === 401 || res.status === 403 ? 503 : 502,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  const secret = extractClientSecret(data);
  if (!secret) {
    throw new VoiceError('upstream', 'Voice mint returned an unrecognized response shape', 502);
  }

  return {
    clientSecret: secret,
    expiresInSeconds: expiresSeconds,
    model: voiceAgentModel(env),
    wsUrl: resolveRealtimeWsUrl(env),
    maxSessionSeconds: voiceMaxSessionSeconds(env),
  };
}

function extractClientSecret(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  if (typeof data['value'] === 'string' && data['value'].trim()) return data['value'].trim();
  const nested = data['client_secret'];
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  if (nested && typeof nested === 'object') {
    const v = (nested as Record<string, unknown>)['value'];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
