/**
 * Free browser dictation (Web Speech API) — no xAI / no API key.
 *
 * Used by the session composer so free installs get push-to-talk without
 * billing. Quality varies by OS (best on Chrome/Android; flaky on some iOS).
 * Server Grok STT remains an optional paid upgrade when XAI_API_KEY is set.
 */

export type WebSpeechAvailability = 'available' | 'unsupported' | 'insecure';

export class WebSpeechError extends Error {
  constructor(
    readonly code: 'unsupported' | 'insecure' | 'denied' | 'failed' | 'empty',
    message: string,
  ) {
    super(message);
    this.name = 'WebSpeechError';
  }
}

export interface WebSpeechDictation {
  /** Stop listening and resolve with the final transcript (may be empty). */
  stop: () => Promise<string>;
  /** Abort without waiting for a final result. */
  abort: () => void;
}

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0?: { transcript?: string };
  }>;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(
  g: typeof globalThis = globalThis,
): SpeechRecognitionCtor | null {
  const w = g as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether free browser dictation can run in this context. */
export function webSpeechAvailability(
  g: typeof globalThis = globalThis,
  isSecure = typeof g.isSecureContext === 'boolean' ? g.isSecureContext : true,
): WebSpeechAvailability {
  if (!isSecure && typeof g.location === 'object') {
    const host = (g.location as Location).hostname;
    // localhost is treated as secure for getUserMedia/speech in modern browsers.
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
      return 'insecure';
    }
  }
  return getSpeechRecognitionCtor(g) ? 'available' : 'unsupported';
}

/**
 * BCP-47 lang for recognition. Prefer Chinese when UI/locale suggests it;
 * otherwise browser default (empty string = UA default).
 */
export function webSpeechLang(
  primary: string,
  preferred: readonly string[] = [],
): string {
  const list = [primary, ...preferred].map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.some((l) => l === 'zh' || l.startsWith('zh-') || l.includes('chinese'))) {
    return 'zh-CN';
  }
  if (list.some((l) => l.startsWith('ja'))) return 'ja-JP';
  if (list.some((l) => l.startsWith('ko'))) return 'ko-KR';
  if (list.some((l) => l.startsWith('en'))) return 'en-US';
  // Empty → let the engine pick (better for mixed locales).
  return primary?.trim() || '';
}

/**
 * Start free push-to-talk dictation. Call stop() on the second tap.
 */
export function startWebSpeechDictation(opts?: {
  readonly lang?: string;
  readonly createRecognition?: () => SpeechRecognitionLike;
}): WebSpeechDictation {
  const avail = webSpeechAvailability();
  if (avail === 'insecure') {
    throw new WebSpeechError(
      'insecure',
      'Browser speech needs HTTPS (or localhost).',
    );
  }
  const Ctor = getSpeechRecognitionCtor();
  if (avail === 'unsupported' || !Ctor) {
    throw new WebSpeechError(
      'unsupported',
      'This browser has no free speech recognition. Type instead, or set XAI_API_KEY for paid STT.',
    );
  }

  const rec = opts?.createRecognition ? opts.createRecognition() : new Ctor();
  rec.lang = opts?.lang?.trim() || webSpeechLang(
    typeof navigator !== 'undefined' ? navigator.language || '' : '',
    typeof navigator !== 'undefined' && Array.isArray(navigator.languages)
      ? navigator.languages
      : [],
  );
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let finalText = '';
  let interim = '';
  let done: ((text: string) => void) | null = null;
  let fail: ((err: Error) => void) | null = null;
  let settled = false;
  let stopping = false;

  const settle = (text: string, err?: Error): void => {
    if (settled) return;
    settled = true;
    if (err && fail) fail(err);
    else if (done) done(text);
    done = null;
    fail = null;
  };

  rec.onresult = (ev) => {
    let interimBuf = '';
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const row = ev.results[i];
      if (!row) continue;
      const piece = row[0]?.transcript?.trim() ?? '';
      if (!piece) continue;
      if (row.isFinal) {
        finalText = finalText ? `${finalText} ${piece}` : piece;
      } else {
        interimBuf = interimBuf ? `${interimBuf} ${piece}` : piece;
      }
    }
    interim = interimBuf;
  };

  rec.onerror = (ev) => {
    const code = ev.error ?? '';
    if (code === 'aborted' || code === 'no-speech') {
      // User stop / silence — resolve with whatever we have.
      if (stopping) settle(pickText(finalText, interim));
      return;
    }
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      settle('', new WebSpeechError('denied', 'Microphone / speech permission denied.'));
      return;
    }
    settle(
      '',
      new WebSpeechError(
        'failed',
        `Browser speech error: ${ev.message || code || 'unknown'}`,
      ),
    );
  };

  rec.onend = () => {
    settle(pickText(finalText, interim));
  };

  try {
    rec.start();
  } catch (err) {
    throw new WebSpeechError(
      'failed',
      `Could not start browser speech: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    stop: () =>
      new Promise<string>((resolve, reject) => {
        if (settled) {
          resolve(pickText(finalText, interim));
          return;
        }
        stopping = true;
        done = resolve;
        fail = reject;
        try {
          rec.stop();
        } catch {
          settle(pickText(finalText, interim));
        }
        // Safety: some engines never fire onend after stop.
        setTimeout(() => settle(pickText(finalText, interim)), 2_500);
      }),
    abort: () => {
      stopping = true;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
      settle('');
    },
  };
}

function pickText(finalText: string, interim: string): string {
  const t = (finalText || interim).replace(/\s+/g, ' ').trim();
  return t;
}
