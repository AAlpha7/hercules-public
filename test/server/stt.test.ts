import { describe, it, expect, vi } from 'vitest';
import {
  isSttConfigured,
  normalizeSttLanguage,
  resolveSttApiKey,
  SttError,
  transcribeAudio,
} from '../../src/server/stt.js';

describe('stt (Grok xAI)', () => {
  it('resolves XAI_API_KEY over GROK_API_KEY; CLI opt-out with =0', () => {
    expect(resolveSttApiKey({ XAI_API_KEY: 'xai', GROK_API_KEY: 'grok', HOME: '/nope' })).toBe(
      'xai',
    );
    expect(resolveSttApiKey({ GROK_API_KEY: 'grok', HOME: '/nope' })).toBe('grok');
    expect(resolveSttApiKey({ HOME: '/nope-missing-home-for-stt' })).toBeNull();
    expect(
      resolveSttApiKey({
        HOME: '/nope-missing-home-for-stt',
        HERCULES_XAI_USE_CLI_TOKEN: '0',
      }),
    ).toBeNull();
    expect(isSttConfigured({ XAI_API_KEY: 'k' })).toBe(true);
  });

  it('normalizes language codes for formatting only', () => {
    expect(normalizeSttLanguage('en-US')).toBe('en');
    expect(normalizeSttLanguage('ja')).toBe('ja');
    expect(normalizeSttLanguage('zh-CN')).toBeUndefined(); // not in format list
    expect(normalizeSttLanguage(undefined)).toBeUndefined();
  });

  it('throws not_configured without a key', async () => {
    await expect(
      transcribeAudio(
        { data: Buffer.from('x'), filename: 'a.wav', mime: 'audio/wav' },
        { HOME: '/nope-missing-home-for-stt' },
      ),
    ).rejects.toMatchObject({ code: 'not_configured', status: 503 });
  });

  it('posts multipart with file last and returns text', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key');
      const body = init?.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      // file must exist
      expect(body.get('file')).toBeTruthy();
      return new Response(JSON.stringify({ text: 'hello world', duration: 1.2, language: 'English' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await transcribeAudio(
      { data: Buffer.from('RIFF'), filename: 'voice.wav', mime: 'audio/wav', language: 'en-US' },
      { XAI_API_KEY: 'test-key' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.text).toBe('hello world');
    expect(result.duration).toBe(1.2);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('maps empty transcript to empty error', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: '  ' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      transcribeAudio(
        { data: Buffer.from('x'), filename: 'a.wav', mime: 'audio/wav' },
        { XAI_API_KEY: 'k' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(SttError);
  });
});
