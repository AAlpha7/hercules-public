/**
 * Pure pull-to-refresh gesture math + list refresh merge (no DOM / no IO).
 * Used by PullToRefresh.tsx for phase + rubber-band offset, and by App to
 * reconcile selected task status after a full /api/state re-fetch.
 */

import type { StateDto, Task } from './api.js';
import { findTask, resolveTaskDetail } from './taskDetail.js';

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing';

/**
 * Apply a refreshed /api/state snapshot: keep list + running/activity payload,
 * and reconcile (or clear) the open selected task so status chips stay honest.
 */
export function applyTaskListRefresh(
  next: StateDto,
  selected: Task | null,
): { state: StateDto; selected: Task | null } {
  if (!selected) return { state: next, selected: null };
  if (!findTask(next, selected.id)) {
    return { state: next, selected: null };
  }
  return { state: next, selected: resolveTaskDetail(next, selected) };
}

/** Finger travel (damped) past this → armed; release triggers refresh. */
export const PULL_THRESHOLD = 64;

/** Cap on the visual pull offset (px). */
export const PULL_MAX = 120;

/** Rubber-band factor: visual offset = rawDy * DAMPING (clamped). */
export const PULL_DAMPING = 0.45;

/**
 * Map raw downward finger travel (px) to a damped visual offset.
 * Negative / zero input → 0.
 */
export function dampenPull(rawDy: number): number {
  if (rawDy <= 0) return 0;
  return Math.min(PULL_MAX, rawDy * PULL_DAMPING);
}

/**
 * Derive the indicator phase from current pull distance and refresh lock.
 * While refreshing, phase stays `refreshing` regardless of distance.
 */
export function phaseForDistance(distance: number, isRefreshing: boolean): PullPhase {
  if (isRefreshing) return 'refreshing';
  if (distance <= 0) return 'idle';
  if (distance >= PULL_THRESHOLD) return 'armed';
  return 'pulling';
}

/**
 * Whether a downward finger move may start / continue a pull gesture.
 * Must be at scroll top, not disabled, not already refreshing, and dy > 0.
 */
export function canBeginPull(opts: {
  disabled: boolean;
  isRefreshing: boolean;
  scrollTop: number;
  /** Positive = finger moved down. */
  deltaY: number;
}): boolean {
  if (opts.disabled || opts.isRefreshing) return false;
  if (opts.scrollTop > 0) return false;
  return opts.deltaY > 0;
}

/** True only when the user releases while past the arm threshold. */
export function shouldTriggerOnRelease(phase: PullPhase): boolean {
  return phase === 'armed';
}
