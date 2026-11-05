/**
 * Domain layer — pre-review base drift / conflict risk (pure).
 *
 * Before a green-looking packet, Hercules compares the task branch tip to the
 * repo default branch (merge-base ancestry). Pure classification + packet
 * wording live here; git IO is in isolation/baseDrift.
 *
 * Auto-rebase is opt-in (default off) — never force-push, never merge to main.
 */
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';

/** How the task branch sits relative to the default branch tip. */
export type BaseDriftStatus =
  | 'current'
  | 'behind'
  | 'ahead'
  | 'diverged'
  | 'unknown';

/**
 * Whether integrating default-branch commits onto HEAD would conflict.
 * - `none` — clean (or not behind)
 * - `conflict` — merge-tree reports content conflicts
 * - `unknown` — could not probe (missing refs / git error)
 */
export type ConflictRisk = 'none' | 'conflict' | 'unknown';

/** Snapshot of task-branch lag vs the default branch at verification time. */
export interface BaseDriftReport {
  readonly defaultBranch: string;
  /** merge-base(HEAD, defaultBranch) SHA, when resolvable. */
  readonly mergeBase: string | null;
  readonly headSha: string | null;
  readonly baseSha: string | null;
  /** Commits on default branch not reachable from HEAD. */
  readonly behind: number;
  /** Commits on HEAD not reachable from default branch. */
  readonly ahead: number;
  readonly status: BaseDriftStatus;
  readonly conflictRisk: ConflictRisk;
  /** Human-readable conflict probe detail (file list / error). */
  readonly conflictDetail: string | null;
  /** True when HERCULES_AUTO_REBASE (or dep) attempted a local rebase. */
  readonly rebaseAttempted: boolean;
  /** null when not attempted. */
  readonly rebaseOk: boolean | null;
  readonly rebaseDetail: string | null;
}

/** Classify ancestry counts into a stable status label. */
export function classifyBaseDrift(behind: number, ahead: number): BaseDriftStatus {
  const b = Number.isFinite(behind) ? Math.max(0, behind) : 0;
  const a = Number.isFinite(ahead) ? Math.max(0, ahead) : 0;
  if (b === 0 && a === 0) return 'current';
  if (b > 0 && a > 0) return 'diverged';
  if (b > 0) return 'behind';
  if (a > 0) return 'ahead';
  return 'unknown';
}

/** True when the packet must not look green (hard conflict with default). */
export function isBaseDriftBlocking(report: BaseDriftReport): boolean {
  return report.conflictRisk === 'conflict';
}

/**
 * Env truthy for HERCULES_AUTO_REBASE (off by default — safety).
 * When on: verify may rebase the task branch onto default and re-run L1.
 * Never force-pushes; never merges into main.
 */
export function isAutoRebaseEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  // Plain record (not NodeJS.ProcessEnv): src/domain is shared with the web
  // tsconfig, which has no node types. Callers pass process.env explicitly.
  const raw = (env['HERCULES_AUTO_REBASE'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Empty / unresolvable report used when the worktree is not a real git repo. */
export function unknownBaseDrift(defaultBranch: string, detail?: string): BaseDriftReport {
  return {
    defaultBranch,
    mergeBase: null,
    headSha: null,
    baseSha: null,
    behind: 0,
    ahead: 0,
    status: 'unknown',
    conflictRisk: 'unknown',
    conflictDetail: detail ?? 'could not resolve base drift',
    rebaseAttempted: false,
    rebaseOk: null,
    rebaseDetail: null,
  };
}

/**
 * Markdown lines for the review packet "Base drift" section.
 * Pure: no IO. Callers join with newlines.
 */
export function formatBaseDriftMarkdown(report: BaseDriftReport): string[] {
  const lines: string[] = [];
  lines.push('**Base drift**');
  const statusIcon =
    report.status === 'current'
      ? '✅'
      : report.conflictRisk === 'conflict'
        ? '❌'
        : report.status === 'behind' || report.status === 'diverged'
          ? '⚠️'
          : 'ℹ️';
  lines.push(
    `${statusIcon} vs \`${report.defaultBranch}\`: **${report.status}**` +
      ` · behind **${report.behind}** · ahead **${report.ahead}**` +
      ` · conflict risk **${report.conflictRisk}**`,
  );
  if (report.mergeBase) {
    lines.push(
      `_merge-base \`${report.mergeBase.slice(0, 12)}\`` +
        (report.baseSha ? ` · base tip \`${report.baseSha.slice(0, 12)}\`` : '') +
        (report.headSha ? ` · HEAD \`${report.headSha.slice(0, 12)}\`` : '') +
        `_`,
    );
  }
  if (report.conflictRisk === 'conflict') {
    lines.push(
      '**Conflict risk:** integrating the default branch would conflict. ' +
        'Rebase/merge the default branch into `hercules/<id>`, resolve, push the **same** task branch — never merge to main from here.',
    );
    if (report.conflictDetail) {
      lines.push('```');
      lines.push(
        neutralizeUntrustedPacketText(
          report.conflictDetail.split('\n').slice(0, 20).join('\n'),
        ),
      );
      lines.push('```');
    }
  } else if (report.behind > 0) {
    lines.push(
      `_Task branch lags default by ${report.behind} commit(s). ` +
        `Packet is still valid against merge-base, but GitHub may report conflicts ` +
        `or review may miss newer main. Opt in: \`HERCULES_AUTO_REBASE=1\` for local rebase + re-L1._`,
    );
  }
  if (report.rebaseAttempted) {
    if (report.rebaseOk === true) {
      lines.push(
        `**Auto-rebase:** ✅ ${neutralizeUntrustedPacketText(report.rebaseDetail ?? 'rebased onto default; L1 re-run')}`,
      );
    } else if (report.rebaseOk === false) {
      lines.push(
        `**Auto-rebase:** ❌ ${neutralizeUntrustedPacketText(report.rebaseDetail ?? 'rebase failed; worktree restored')}`,
      );
    }
  }
  return lines;
}

/** Synthetic L1 gate when conflict risk is hard (mirrors pr-mergeable). */
export function baseDriftConflictGate(report: BaseDriftReport): {
  readonly name: string;
  readonly command: string;
  readonly passed: boolean;
  readonly output: string;
} {
  const detail = report.conflictDetail?.trim() || 'merge-tree reported conflicts';
  return {
    name: 'base-drift',
    command: 'hercules:base-drift',
    passed: false,
    output:
      `Task branch is behind \`${report.defaultBranch}\` with conflict risk ` +
      `(behind ${report.behind}, ahead ${report.ahead}). ${detail}. ` +
      `Rebase onto default on hercules/<id> only — never force-push main, never merge to main.`,
  };
}
