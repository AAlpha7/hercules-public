/**
 * Session-lifetime cache of the last successful /api/releases payload.
 *
 * The endpoint walks git mirrors server-side (~seconds), and the panel is
 * reopened often from the phone. Painting the previous rows immediately and
 * refreshing in the background turns every reopen after the first into an
 * instant render (phone latency report 2026-07-17).
 */
import type { ReleasePanelEntryDto } from './api.js';

let cached: ReleasePanelEntryDto[] | null = null;

export function getCachedReleases(): ReleasePanelEntryDto[] | null {
  return cached;
}

export function setCachedReleases(rows: ReleasePanelEntryDto[]): void {
  cached = rows;
}
