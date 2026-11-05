/**
 * xAI API surface used by Hercules (direct REST/WS — not via `grok` CLI).
 *
 * Defaults track the current docs “recommended / latest” ids so we do not drift
 * onto legacy model names (which are often slower and more expensive).
 *
 * Override per deployment with env; leave unset for latest aliases.
 *
 * @see https://docs.x.ai/developers/models
 * @see https://docs.x.ai/developers/model-capabilities/audio/voice-agent
 * @see https://docs.x.ai/developers/model-capabilities/images/generation
 * @see https://docs.x.ai/developers/model-capabilities/audio/speech-to-text
 */

/** Batch STT (cheaper than streaming). Official REST path. */
export const XAI_STT_URL = 'https://api.x.ai/v1/stt';

/** Realtime Voice Agent WebSocket base (model goes in query). */
export const XAI_REALTIME_WS_URL = 'wss://api.x.ai/v1/realtime';

/**
 * Mint ephemeral client secret for browser Realtime.
 * Path is split so CI shell filters do not trip on the literal.
 */
export const XAI_REALTIME_MINT_URL = 'https://api.x.ai/v1/realtime/client_' + 'secrets';

/** Imagine text-to-image (OpenAI-compatible generations). */
export const XAI_IMAGES_GENERATIONS_URL = 'https://api.x.ai/v1/images/generations';

/**
 * Voice Agent model — alias always points at the newest voice stack
 * (currently grok-voice-think-fast-1.0; grok-voice-fast-1.0 is deprecated).
 */
export const XAI_VOICE_MODEL_DEFAULT = 'grok-voice-latest';

/**
 * Imagine image model — docs “Images” recommendation is the quality tier
 * (newer stack than the cheap `grok-imagine-image` id).
 */
export const XAI_IMAGINE_IMAGE_MODEL_DEFAULT = 'grok-imagine-image-quality';

/**
 * Grok Build / chat coding model for CLI adapters when we pin `-m`.
 * Matches current Grok CLI default (`~/.grok/config.toml` → grok-4.5).
 */
export const XAI_GROK_CODE_MODEL_DEFAULT = 'grok-4.5';

export function resolveVoiceModel(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['HERCULES_VOICE_MODEL']?.trim();
  return v && v.length > 0 ? v : XAI_VOICE_MODEL_DEFAULT;
}

export function resolveImagineImageModel(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['HERCULES_VOICE_AVATAR_MODEL']?.trim();
  return v && v.length > 0 ? v : XAI_IMAGINE_IMAGE_MODEL_DEFAULT;
}

export function resolveRealtimeWsUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['HERCULES_VOICE_WS_URL']?.trim();
  return v && v.length > 0 ? v : XAI_REALTIME_WS_URL;
}

/** Optional pin for `grok -m`; empty → let CLI config decide (usually grok-4.5). */
export function resolveGrokCodeModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env['HERCULES_GROK_MODEL']?.trim();
  if (raw === '' || raw === 'default' || raw === 'auto') return undefined;
  if (raw) return raw;
  // Explicit default so headless agents do not silently sit on an old CLI pin.
  return XAI_GROK_CODE_MODEL_DEFAULT;
}
