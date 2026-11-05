import { beforeEach, describe, expect, it } from 'vitest';
import {
  REVIEW_EXPERIENCE_KEY,
  loadReviewExperiencePreference,
  saveReviewExperiencePreference,
  type ReviewExperiencePreference,
} from '../../src/web/prefs.js';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function installStorage(store: StorageLike): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: store,
    configurable: true,
    writable: true,
  });
}

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe('review experience preference', () => {
  let store: StorageLike;

  beforeEach(() => {
    store = memoryStorage();
    installStorage(store);
  });

  it('defaults missing and invalid stored values to legacy', () => {
    expect(loadReviewExperiencePreference()).toBe('legacy');

    store.setItem(REVIEW_EXPERIENCE_KEY, 'future_review');
    expect(loadReviewExperiencePreference()).toBe('legacy');
  });

  it('round-trips closed preference values including control_v2', () => {
    saveReviewExperiencePreference('outcome_v2');
    expect(store.getItem(REVIEW_EXPERIENCE_KEY)).toBe('outcome_v2');
    expect(loadReviewExperiencePreference()).toBe('outcome_v2');

    saveReviewExperiencePreference('control_v2');
    expect(store.getItem(REVIEW_EXPERIENCE_KEY)).toBe('control_v2');
    expect(loadReviewExperiencePreference()).toBe('control_v2');

    saveReviewExperiencePreference('legacy');
    expect(store.getItem(REVIEW_EXPERIENCE_KEY)).toBe('legacy');
    expect(loadReviewExperiencePreference()).toBe('legacy');
  });

  it('does not persist values outside the closed preference set', () => {
    saveReviewExperiencePreference('outcome_v2');
    saveReviewExperiencePreference(
      'future_review' as unknown as ReviewExperiencePreference,
    );

    expect(store.getItem(REVIEW_EXPERIENCE_KEY)).toBe('outcome_v2');
  });

  it('fails closed when storage reads, writes, or access throw', () => {
    installStorage({
      getItem: () => {
        throw new Error('read unavailable');
      },
      setItem: () => {
        throw new Error('write unavailable');
      },
      removeItem: () => undefined,
    });
    expect(loadReviewExperiencePreference()).toBe('legacy');
    expect(() => saveReviewExperiencePreference('outcome_v2')).not.toThrow();

    Object.defineProperty(globalThis, 'localStorage', {
      get: () => {
        throw new Error('storage unavailable');
      },
      configurable: true,
    });
    expect(loadReviewExperiencePreference()).toBe('legacy');
    expect(() => saveReviewExperiencePreference('outcome_v2')).not.toThrow();
  });
});
