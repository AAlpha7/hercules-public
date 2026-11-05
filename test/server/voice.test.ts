import { describe, it, expect, vi } from 'vitest';
import { isVoiceConfigured, mintVoiceClientSecret, VoiceError } from '../../src/server/voice.js';

describe('voice realtime mint', () => {
  it('is configured when XAI key present', () => {
    expect(isVoiceConfigured({ XAI_API_KEY: 'k', HOME: '/nope' })).toBe(true);
    expect(isVoiceConfigured({ HOME: '/nope-missing' })).toBe(false);
  });

  it('mints from {value} response shape', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: 'ephemeral-token-xyz', expires_at: '2099-01-01' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const minted = await mintVoiceClientSecret({ XAI_API_KEY: 'test-key' }, fetchImpl as unknown as typeof fetch);
    expect(minted.clientSecret).toBe('ephemeral-token-xyz');
    expect(minted.model).toMatch(/grok-voice/);
    expect(minted.wsUrl).toMatch(/realtime/);
    expect(minted.maxSessionSeconds).toBeGreaterThanOrEqual(60);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws not_configured without credential', async () => {
    await expect(mintVoiceClientSecret({ HOME: '/nope-missing' })).rejects.toBeInstanceOf(VoiceError);
  });
});
