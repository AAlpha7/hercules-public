import { describe, it, expect, vi } from 'vitest';
import {
  startWebSpeechDictation,
  webSpeechAvailability,
  webSpeechLang,
  WebSpeechError,
} from '../../src/web/webSpeechDictation.js';

describe('webSpeechLang', () => {
  it('prefers Chinese when any preferred locale is zh', () => {
    expect(webSpeechLang('en-US', ['en-US', 'zh-CN'])).toBe('zh-CN');
    expect(webSpeechLang('zh-TW')).toBe('zh-CN');
  });

  it('maps ja/ko/en', () => {
    expect(webSpeechLang('ja-JP')).toBe('ja-JP');
    expect(webSpeechLang('ko-KR')).toBe('ko-KR');
    expect(webSpeechLang('en-GB')).toBe('en-US');
  });
});

describe('webSpeechAvailability', () => {
  it('reports unsupported without SpeechRecognition', () => {
    const g = { isSecureContext: true } as unknown as typeof globalThis;
    expect(webSpeechAvailability(g, true)).toBe('unsupported');
  });

  it('reports available when webkitSpeechRecognition exists', () => {
    class Fake {}
    const g = {
      isSecureContext: true,
      webkitSpeechRecognition: Fake,
    } as unknown as typeof globalThis;
    expect(webSpeechAvailability(g, true)).toBe('available');
  });
});

describe('startWebSpeechDictation', () => {
  it('collects final transcripts on stop', async () => {
    type Handlers = {
      onresult: ((ev: unknown) => void) | null;
      onerror: ((ev: unknown) => void) | null;
      onend: (() => void) | null;
    };
    const h: Handlers = { onresult: null, onerror: null, onend: null };
    const rec = {
      lang: '',
      continuous: false,
      interimResults: false,
      maxAlternatives: 1,
      start: vi.fn(),
      stop: vi.fn(() => {
        h.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: '你好世界' } }],
        });
        h.onend?.();
      }),
      abort: vi.fn(),
      set onresult(fn: Handlers['onresult']) {
        h.onresult = fn;
      },
      get onresult() {
        return h.onresult;
      },
      set onerror(fn: Handlers['onerror']) {
        h.onerror = fn;
      },
      get onerror() {
        return h.onerror;
      },
      set onend(fn: Handlers['onend']) {
        h.onend = fn;
      },
      get onend() {
        return h.onend;
      },
    };

    // Force available path by injecting createRecognition.
    const orig = globalThis as typeof globalThis & {
      webkitSpeechRecognition?: unknown;
      SpeechRecognition?: unknown;
    };
    const prev = orig.SpeechRecognition ?? orig.webkitSpeechRecognition;
    orig.webkitSpeechRecognition = class {};
    try {
      const session = startWebSpeechDictation({
        lang: 'zh-CN',
        createRecognition: () => rec as never,
      });
      expect(rec.start).toHaveBeenCalledOnce();
      const text = await session.stop();
      expect(text).toBe('你好世界');
    } finally {
      if (prev) orig.webkitSpeechRecognition = prev;
      else delete orig.webkitSpeechRecognition;
    }
  });

  it('throws unsupported when no engine', () => {
    const g = globalThis as typeof globalThis & {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    const a = g.SpeechRecognition;
    const b = g.webkitSpeechRecognition;
    delete g.SpeechRecognition;
    delete g.webkitSpeechRecognition;
    try {
      expect(() => startWebSpeechDictation()).toThrow(WebSpeechError);
    } finally {
      if (a) g.SpeechRecognition = a;
      if (b) g.webkitSpeechRecognition = b;
    }
  });
});
