/**
 * Client-side UI preferences (localStorage). Not daemon config — language and
 * preferred agent for new tasks live on the device only.
 *
 * Uses a minimal StorageLike so this module typechecks under the root (Node)
 * tsconfig as well as the web DOM tsconfig (tests import it from test/web/).
 */

export type Lang = 'en' | 'zh';

export const LANG_KEY = 'hercules_lang';
export const PREFERRED_AGENT_KEY = 'hercules_preferred_agent';
/** Voice dock: collapsed mini-dot + free position (viewport fractions). */
export const VOICE_DOCK_KEY = 'hercules_voice_dock';
/** Assistant co-pilot modality: Realtime voice vs agent text session. */
export const ASSISTANT_MODE_KEY = 'hercules_assistant_mode';
/** Device-local selection between the legacy and outcome-first review surfaces. */
export const REVIEW_EXPERIENCE_KEY = 'hercules_review_experience';

export type AssistantMode = 'voice' | 'text';
export type ReviewExperiencePreference = 'legacy' | 'outcome_v2' | 'control_v2';

export interface VoiceDockPrefs {
  /** true = compact aesthetic dot (does not cover compose/FABs). */
  readonly collapsed: boolean;
  /** 0–1 horizontal: 0 = left edge, 1 = right edge (dock anchor). */
  readonly x: number;
  /** 0–1 vertical: 0 = top, 1 = bottom. */
  readonly y: number;
}

export const DEFAULT_VOICE_DOCK: VoiceDockPrefs = {
  collapsed: true,
  x: 0.92,
  y: 0.82,
};

/** Default text — cheaper; voice is opt-in Realtime. */
export const DEFAULT_ASSISTANT_MODE: AssistantMode = 'text';

/** Same shape as domain isValidIdentifier — keep prefs free of outer imports. */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'zh';
}

export function loadLang(): Lang {
  const s = storage();
  if (!s) return 'en';
  try {
    const raw = s.getItem(LANG_KEY);
    if (isLang(raw)) return raw;
  } catch {
    /* private mode / unavailable */
  }
  return 'en';
}

export function saveLang(lang: Lang): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(LANG_KEY, lang);
  } catch {
    /* ignore quota */
  }
}

/**
 * Preferred adapter for new tasks (create form seed). Empty/null = inherit
 * repo → daemon default (same as leaving the create form on "Default").
 */
export function loadPreferredAgent(): string | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFERRED_AGENT_KEY);
    if (raw === null || raw === '') return null;
    if (!IDENT.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function savePreferredAgent(agent: string | null): void {
  const s = storage();
  if (!s) return;
  try {
    if (agent === null || agent === '') {
      s.removeItem(PREFERRED_AGENT_KEY);
      return;
    }
    if (!IDENT.test(agent)) return;
    s.setItem(PREFERRED_AGENT_KEY, agent);
  } catch {
    /* ignore quota */
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export function loadVoiceDock(): VoiceDockPrefs {
  const s = storage();
  if (!s) return DEFAULT_VOICE_DOCK;
  try {
    const raw = s.getItem(VOICE_DOCK_KEY);
    if (!raw) return DEFAULT_VOICE_DOCK;
    const parsed = JSON.parse(raw) as Partial<VoiceDockPrefs>;
    return {
      collapsed: parsed.collapsed !== false, // default collapsed
      x: clamp01(typeof parsed.x === 'number' ? parsed.x : DEFAULT_VOICE_DOCK.x),
      y: clamp01(typeof parsed.y === 'number' ? parsed.y : DEFAULT_VOICE_DOCK.y),
    };
  } catch {
    return DEFAULT_VOICE_DOCK;
  }
}

export function saveVoiceDock(prefs: VoiceDockPrefs): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(
      VOICE_DOCK_KEY,
      JSON.stringify({
        collapsed: prefs.collapsed === true,
        x: clamp01(prefs.x),
        y: clamp01(prefs.y),
      }),
    );
  } catch {
    /* ignore quota */
  }
}

export function isAssistantMode(v: unknown): v is AssistantMode {
  return v === 'voice' || v === 'text';
}

export function loadAssistantMode(): AssistantMode {
  const s = storage();
  if (!s) return DEFAULT_ASSISTANT_MODE;
  try {
    const raw = s.getItem(ASSISTANT_MODE_KEY);
    if (isAssistantMode(raw)) return raw;
  } catch {
    /* private mode */
  }
  return DEFAULT_ASSISTANT_MODE;
}

export function saveAssistantMode(mode: AssistantMode): void {
  const s = storage();
  if (!s) return;
  try {
    if (!isAssistantMode(mode)) return;
    s.setItem(ASSISTANT_MODE_KEY, mode);
  } catch {
    /* ignore quota */
  }
}

function isReviewExperiencePreference(
  value: unknown,
): value is ReviewExperiencePreference {
  return value === 'legacy' || value === 'outcome_v2' || value === 'control_v2';
}

export function loadReviewExperiencePreference(): ReviewExperiencePreference {
  const s = storage();
  if (!s) return 'legacy';
  try {
    const raw = s.getItem(REVIEW_EXPERIENCE_KEY);
    return isReviewExperiencePreference(raw) ? raw : 'legacy';
  } catch {
    return 'legacy';
  }
}

export function saveReviewExperiencePreference(
  preference: ReviewExperiencePreference,
): void {
  if (!isReviewExperiencePreference(preference)) return;
  const s = storage();
  if (!s) return;
  try {
    s.setItem(REVIEW_EXPERIENCE_KEY, preference);
  } catch {
    /* ignore unavailable or quota-limited storage */
  }
}
