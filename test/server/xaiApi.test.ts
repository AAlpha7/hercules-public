import { describe, it, expect } from 'vitest';
import {
  resolveGrokCodeModel,
  resolveImagineImageModel,
  resolveRealtimeWsUrl,
  resolveVoiceModel,
  XAI_GROK_CODE_MODEL_DEFAULT,
  XAI_IMAGINE_IMAGE_MODEL_DEFAULT,
  XAI_IMAGES_GENERATIONS_URL,
  XAI_REALTIME_MINT_URL,
  XAI_REALTIME_WS_URL,
  XAI_STT_URL,
  XAI_VOICE_MODEL_DEFAULT,
} from '../../src/server/xaiApi.js';

describe('xAI latest API defaults', () => {
  it('pins current docs-recommended endpoints and model aliases', () => {
    expect(XAI_STT_URL).toBe('https://api.x.ai/v1/stt');
    expect(XAI_REALTIME_WS_URL).toBe('wss://api.x.ai/v1/realtime');
    expect(XAI_REALTIME_MINT_URL).toMatch(/\/v1\/realtime\/client_/);
    expect(XAI_IMAGES_GENERATIONS_URL).toBe('https://api.x.ai/v1/images/generations');
    // Voice: latest alias (not deprecated grok-voice-fast-1.0).
    expect(XAI_VOICE_MODEL_DEFAULT).toBe('grok-voice-latest');
    // Imagine: quality tier is the docs Images recommendation.
    expect(XAI_IMAGINE_IMAGE_MODEL_DEFAULT).toBe('grok-imagine-image-quality');
    // Code: current frontier.
    expect(XAI_GROK_CODE_MODEL_DEFAULT).toBe('grok-4.5');
  });

  it('resolvers prefer env overrides then defaults', () => {
    expect(resolveVoiceModel({})).toBe('grok-voice-latest');
    expect(resolveVoiceModel({ HERCULES_VOICE_MODEL: 'grok-voice-think-fast-1.0' })).toBe(
      'grok-voice-think-fast-1.0',
    );
    expect(resolveImagineImageModel({})).toBe('grok-imagine-image-quality');
    expect(resolveImagineImageModel({ HERCULES_VOICE_AVATAR_MODEL: 'grok-imagine-image' })).toBe(
      'grok-imagine-image',
    );
    expect(resolveRealtimeWsUrl({})).toBe(XAI_REALTIME_WS_URL);
    expect(resolveGrokCodeModel({})).toBe('grok-4.5');
    expect(resolveGrokCodeModel({ HERCULES_GROK_MODEL: 'auto' })).toBeUndefined();
    expect(resolveGrokCodeModel({ HERCULES_GROK_MODEL: 'grok-4.3' })).toBe('grok-4.3');
  });
});
