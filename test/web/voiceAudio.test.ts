import { describe, it, expect } from 'vitest';
import {
  buildRealtimeWsUrl,
  decodeBase64Pcm16,
  isAssistantChannelBusy,
  nearestXaiPcmRate,
  realtimeClientProtocols,
  VOICE_PCM_FALLBACK_RATE,
} from '../../src/web/voiceAudio.js';

describe('nearestXaiPcmRate', () => {
  it('maps common device rates to xAI-supported values', () => {
    expect(nearestXaiPcmRate(48_000)).toBe(48_000);
    expect(nearestXaiPcmRate(44_100)).toBe(44_100);
    expect(nearestXaiPcmRate(24_000)).toBe(24_000);
    expect(nearestXaiPcmRate(16_000)).toBe(16_000);
  });

  it('snaps odd rates to nearest supported', () => {
    expect(nearestXaiPcmRate(47_000)).toBe(48_000);
    expect(nearestXaiPcmRate(22_000)).toBe(22_050);
  });

  it('falls back on invalid input', () => {
    expect(nearestXaiPcmRate(0)).toBe(VOICE_PCM_FALLBACK_RATE);
    expect(nearestXaiPcmRate(Number.NaN)).toBe(VOICE_PCM_FALLBACK_RATE);
  });
});

describe('buildRealtimeWsUrl / realtimeClientProtocols', () => {
  it('adds model query and optional conversation_id', () => {
    const url = buildRealtimeWsUrl('wss://api.x.ai/v1/realtime', {
      model: 'grok-voice-latest',
      conversationId: 'conv-1',
    });
    expect(url).toContain('model=grok-voice-latest');
    expect(url).toContain('conversation_id=conv-1');
  });

  it('builds xai-client-secret subprotocol', () => {
    expect(realtimeClientProtocols('tok-abc')).toEqual(['xai-client-secret.tok-abc']);
    expect(realtimeClientProtocols('')).toEqual([]);
  });
});

describe('decodeBase64Pcm16', () => {
  it('decodes little-endian PCM16', () => {
    // samples: 1, -2 → bytes 01 00 fe ff
    const b64 = btoa(String.fromCharCode(0x01, 0x00, 0xfe, 0xff));
    const pcm = decodeBase64Pcm16(b64);
    expect([...pcm]).toEqual([1, -2]);
  });

  it('returns empty for empty/odd garbage', () => {
    expect(decodeBase64Pcm16('').length).toBe(0);
  });
});

describe('isAssistantChannelBusy (anti phoneme-loop)', () => {
  it('is busy during active response even with empty play queue', () => {
    expect(
      isAssistantChannelBusy({
        activeResponses: 1,
        ctxCurrentTime: 10,
        nextPlayTime: 0,
        muteUntil: 0,
      }),
    ).toBe(true);
  });

  it('is busy while TTS is scheduled or in mute tail', () => {
    expect(
      isAssistantChannelBusy({
        activeResponses: 0,
        ctxCurrentTime: 1,
        nextPlayTime: 2,
        muteUntil: 0,
      }),
    ).toBe(true);
    expect(
      isAssistantChannelBusy({
        activeResponses: 0,
        ctxCurrentTime: 1.1,
        nextPlayTime: 0,
        muteUntil: 1.5,
      }),
    ).toBe(true);
  });

  it('is free when idle', () => {
    expect(
      isAssistantChannelBusy({
        activeResponses: 0,
        ctxCurrentTime: 5,
        nextPlayTime: 0,
        muteUntil: 0,
      }),
    ).toBe(false);
  });
});
