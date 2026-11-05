/**
 * CEO outcome digest — pure derivation from state the client already holds:
 * done/failed tasks (endedAt), release promote history, live costSummary.
 * Honest by construction: counts only recorded facts.
 */
import type { Task } from './api.js';

export interface Digest {
  readonly shipped: number;
  readonly firstPass: number;
  readonly failed: number;
  readonly promotes: number;
  readonly rollbacks: number;
  /** Today's recorded spend (null when cost caps disabled / unknown). */
  readonly costTodayUsd: number | null;
  readonly windowDays: number;
}

export function buildDigest(
  tasks: readonly Task[],
  releases: readonly { history?: readonly { at?: string; outcome?: string }[] }[],
  costSummary: { day?: { costUsd?: number } } | undefined,
  nowMs: number,
  windowDays: number,
): Digest {
  const cutoff = nowMs - windowDays * 86400_000;
  const inWindow = (iso: string | null | undefined): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= cutoff && t <= nowMs;
  };

  const done = tasks.filter((t) => t.state === 'done' && inWindow(t.endedAt));
  const failed = tasks.filter((t) => t.state === 'failed' && inWindow(t.endedAt));
  let promotes = 0;
  let rollbacks = 0;
  for (const r of releases) {
    for (const h of r.history ?? []) {
      if (!inWindow(h.at)) continue;
      if (h.outcome === 'ok') promotes += 1;
      else if (h.outcome === 'rolled_back') rollbacks += 1;
    }
  }
  const costTodayUsd =
    typeof costSummary?.day?.costUsd === 'number' ? costSummary.day.costUsd : null;

  return {
    shipped: done.length,
    firstPass: done.filter((t) => t.attempts === 0).length,
    failed: failed.length,
    promotes,
    rollbacks,
    costTodayUsd,
    windowDays,
  };
}

/** Compact inbox digest line (zh default; pass lang for en). */
export function formatDigestLine(g: Digest, lang: 'en' | 'zh' = 'zh'): string {
  if (lang === 'en') {
    const bits = [
      `Last ${g.windowDays}d: shipped ${g.shipped}`,
      `first-pass ${g.firstPass}/${g.shipped}`,
      `promotes ${g.promotes}${g.rollbacks > 0 ? ` (rollback ${g.rollbacks})` : ''}`,
    ];
    if (g.failed > 0) bits.push(`parked ${g.failed}`);
    if (g.costTodayUsd !== null) bits.push(`today $${g.costTodayUsd.toFixed(2)}`);
    return bits.join(' · ');
  }
  const bits = [
    `近 ${g.windowDays} 天:上线 ${g.shipped} 项`,
    `一次通过 ${g.firstPass}/${g.shipped}`,
    `发布 ${g.promotes} 次${g.rollbacks > 0 ? `(回滚 ${g.rollbacks})` : ''}`,
  ];
  if (g.failed > 0) bits.push(`停靠 ${g.failed}`);
  if (g.costTodayUsd !== null) bits.push(`今日成本 $${g.costTodayUsd.toFixed(2)}`);
  return bits.join(' · ');
}
