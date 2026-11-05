/**
 * Client prefs: language (en/zh) and preferred default agent in localStorage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  LANG_KEY,
  PREFERRED_AGENT_KEY,
  VOICE_DOCK_KEY,
  ASSISTANT_MODE_KEY,
  DEFAULT_VOICE_DOCK,
  DEFAULT_ASSISTANT_MODE,
  loadLang,
  saveLang,
  loadPreferredAgent,
  savePreferredAgent,
  loadVoiceDock,
  saveVoiceDock,
  loadAssistantMode,
  saveAssistantMode,
  isLang,
  type Lang,
} from '../../src/web/prefs.js';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  clear(): void;
  key(index: number): string | null;
}

/** Minimal localStorage for node unit tests. */
function installMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  const store: StorageLike = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: store,
    configurable: true,
    writable: true,
  });
  return store;
}

describe('client prefs', () => {
  let store: StorageLike;

  beforeEach(() => {
    store = installMemoryStorage();
  });

  it('isLang accepts only en|zh', () => {
    expect(isLang('en')).toBe(true);
    expect(isLang('zh')).toBe(true);
    expect(isLang('fr')).toBe(false);
    expect(isLang('')).toBe(false);
  });

  it('loadLang defaults to en and round-trips', () => {
    expect(loadLang()).toBe('en');
    saveLang('zh');
    expect(store.getItem(LANG_KEY)).toBe('zh');
    expect(loadLang()).toBe('zh');
    saveLang('en');
    expect(loadLang()).toBe('en');
  });

  it('ignores corrupt language values', () => {
    store.setItem(LANG_KEY, 'nope');
    expect(loadLang()).toBe('en');
  });

  it('preferred agent is null when unset or empty', () => {
    expect(loadPreferredAgent()).toBeNull();
    savePreferredAgent(null);
    expect(loadPreferredAgent()).toBeNull();
    savePreferredAgent('');
    expect(loadPreferredAgent()).toBeNull();
  });

  it('preferred agent round-trips valid adapter ids', () => {
    savePreferredAgent('codex');
    expect(store.getItem(PREFERRED_AGENT_KEY)).toBe('codex');
    expect(loadPreferredAgent()).toBe('codex');
    savePreferredAgent('grok');
    expect(loadPreferredAgent()).toBe('grok');
  });

  it('rejects non-identifier preferred agents', () => {
    store.setItem(PREFERRED_AGENT_KEY, '../evil');
    expect(loadPreferredAgent()).toBeNull();
    store.setItem(PREFERRED_AGENT_KEY, 'bad agent');
    expect(loadPreferredAgent()).toBeNull();
  });

  it('Lang type is en | zh', () => {
    const en: Lang = 'en';
    const zh: Lang = 'zh';
    expect(en).toBe('en');
    expect(zh).toBe('zh');
  });

  it('voice dock defaults to collapsed mini-dot and round-trips position', () => {
    expect(loadVoiceDock()).toEqual(DEFAULT_VOICE_DOCK);
    saveVoiceDock({ collapsed: false, x: 0.2, y: 0.4 });
    expect(store.getItem(VOICE_DOCK_KEY)).toContain('"collapsed":false');
    expect(loadVoiceDock()).toEqual({ collapsed: false, x: 0.2, y: 0.4 });
  });

  it('voice dock clamps fractions and rejects corrupt JSON', () => {
    saveVoiceDock({ collapsed: true, x: 2, y: -1 });
    expect(loadVoiceDock()).toEqual({ collapsed: true, x: 1, y: 0 });
    store.setItem(VOICE_DOCK_KEY, '{not json');
    expect(loadVoiceDock()).toEqual(DEFAULT_VOICE_DOCK);
  });

  it('assistant mode defaults to text and round-trips', () => {
    expect(loadAssistantMode()).toBe(DEFAULT_ASSISTANT_MODE);
    expect(DEFAULT_ASSISTANT_MODE).toBe('text');
    saveAssistantMode('voice');
    expect(store.getItem(ASSISTANT_MODE_KEY)).toBe('voice');
    expect(loadAssistantMode()).toBe('voice');
    saveAssistantMode('text');
    expect(loadAssistantMode()).toBe('text');
  });
});
