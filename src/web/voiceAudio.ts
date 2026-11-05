/**
 * Voice Control audio helpers (pure).
 *
 * xAI Realtime accepts discrete PCM rates. Mobile browsers often ignore
 * `new AudioContext({ sampleRate: 24000 })` and run at 44.1/48 kHz — if we
 * still advertise 24 kHz, ASR/VAD hears chipmunk audio and the agent looks dead.
 */

/** Rates documented for audio/pcm on the Voice Agent API. */
export const XAI_PCM_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000] as const;

export type XaiPcmRate = (typeof XAI_PCM_RATES)[number];

/** Preferred default when the device rate is unknown. */
export const VOICE_PCM_FALLBACK_RATE: XaiPcmRate = 24_000;

/** Snap a device sample rate to the nearest xAI-supported PCM rate. */
export function nearestXaiPcmRate(deviceRate: number): XaiPcmRate {
  if (!Number.isFinite(deviceRate) || deviceRate <= 0) return VOICE_PCM_FALLBACK_RATE;
  let best: XaiPcmRate = VOICE_PCM_FALLBACK_RATE;
  let bestDist = Infinity;
  for (const r of XAI_PCM_RATES) {
    const d = Math.abs(r - deviceRate);
    if (d < bestDist) {
      best = r;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Build WebSocket URL for realtime (model + optional conversation resume).
 * Pure so tests can lock query shape without minting.
 */
export function buildRealtimeWsUrl(
  baseWsUrl: string,
  opts: { readonly model: string; readonly conversationId?: string | null },
): string {
  const base = baseWsUrl.trim() || 'wss://api.x.ai/v1/realtime';
  const params = new URLSearchParams({
    model: opts.model.trim() || 'grok-voice-latest',
  });
  if (opts.conversationId && opts.conversationId.trim()) {
    params.set('conversation_id', opts.conversationId.trim());
  }
  const join = base.includes('?') ? '&' : '?';
  return `${base}${join}${params.toString()}`;
}

/** Subprotocol list for browser ephemeral auth. */
export function realtimeClientProtocols(clientSecret: string): string[] {
  const t = clientSecret.trim();
  if (!t) return [];
  // Docs: sec-websocket-protocol = xai-client-secret.<ephemeral token>
  return [`xai-client-secret.${t}`];
}

/**
 * Decode base64 PCM16-LE to Int16 samples (copy into an aligned buffer).
 * Avoids SharedArrayBuffer / odd-offset views that can garble playback.
 */
export function decodeBase64Pcm16(base64: string): Int16Array {
  if (!base64) return new Int16Array(0);
  const binary = atob(base64);
  const byteLen = binary.length - (binary.length % 2);
  if (byteLen <= 0) return new Int16Array(0);
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  // Copy through DataView so we never share a sliced ArrayBuffer incorrectly.
  const out = new Int16Array(byteLen / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, byteLen);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

/**
 * True while the assistant turn owns the channel (response in flight and/or
 * local TTS still queued). Mic uplink and server speech_started must not
 * interrupt — speaker echo otherwise re-triggers VAD mid-phrase and the model
 * loops the last phoneme ("卡住一直重复最后一个字").
 */
export function isAssistantChannelBusy(input: {
  readonly activeResponses: number;
  readonly ctxCurrentTime: number;
  readonly nextPlayTime: number;
  readonly muteUntil: number;
}): boolean {
  if (input.activeResponses > 0) return true;
  if (input.nextPlayTime > input.ctxCurrentTime + 0.02) return true;
  if (input.ctxCurrentTime < input.muteUntil) return true;
  return false;
}
