/**
 * Domain — failure mini-packet when an agent run dies without a review packet.
 *
 * Case study: orbit-repo-readiness-onboarding failed 3× with only front-matter
 * `state: failed` — no packet, so the phone sheet looked empty of causes.
 *
 * The mini-packet is the human-facing artifact for crashes: kind, attempt,
 * exit code, workspace/branch, activity tail, attempt accounting, next-eligible,
 * and next actions.
 */
import { thrashNoteForRunFailure } from './thrash.js';
import { agentDeathSignalName } from './agentDeath.js';
import {
  isRunFailureKind,
  type FailureKind,
  type ParkedReason,
  type RunFailureKind,
} from './retryPolicy.js';
import { shortLeaseSha } from './taskBranchLease.js';
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';

export type { RunFailureKind, FailureKind } from './retryPolicy.js';

export interface RunFailureInput {
  readonly stamp: string;
  readonly kind: RunFailureKind;
  /** Attempts value after policy decision (may be unchanged on soft stall). */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly activityTail?: readonly string[];
  readonly finalMessage?: string;
  /** Process exit code when known (null = unknown / signal / non-process). */
  readonly exitCode?: number | null;
  /** OS signal when the process was killed (e.g. SIGTERM). */
  readonly exitSignal?: string | null;
  /** One-line death cause (e.g. `xAI 502 mid-stream`) — not bare exit unknown. */
  readonly deathCause?: string;
  /** Bounded stderr tail (~2KB) for diagnosis. */
  readonly stderrTail?: string;
  readonly adapter?: string;
  readonly workspaceDir?: string;
  readonly branchTip?: string | null;
  readonly taskId?: string;
  readonly expectedBaseRevision?: string;
  readonly expectedRemoteTip?: string | null;
  /** When true, include thrash early-park note. */
  readonly thrashParked?: boolean;
  readonly thrashConsecutive?: number;
  /** Human-readable attempt burn line from retry policy. */
  readonly accounting?: string;
  /** ISO next-eligible timestamp, or null when parked. */
  readonly nextEligibleAt?: string | null;
  readonly policySummary?: string;
  readonly parkedReason?: ParkedReason | null;
  readonly burnedAttempt?: boolean;
}

function kindDetail(kind: RunFailureKind): string {
  if (kind === 'stall') {
    return 'No agent events within the stall timeout — process was killed as stuck.';
  }
  if (kind === 'provision') {
    return 'Worktree / repo provisioning failed before the agent could start.';
  }
  return (
    'Agent process exited without a successful **done** event (non-zero exit, ' +
    'stream error, or crash). **No verification packet** was produced — this is not an L1/L2/L3 fail.'
  );
}

function parkedLabel(reason: ParkedReason | null | undefined, thrashParked: boolean): string | null {
  if (reason === 'hard_infra') return 'hard infra (permanent — not auto-retried)';
  if (reason === 'global_ceiling') return 'global failure ceiling';
  if (reason === 'max_attempts') return 'max attempts';
  if (reason === 'thrash' || thrashParked) return 'thrash';
  return null;
}

export function buildRunFailureSection(input: RunFailureInput): string {
  const lines: string[] = [
    `## Run failure (${input.stamp})`,
    '',
    `**Kind:** \`${input.kind}\``,
    `**Attempt:** ${input.attempt} / ${input.maxAttempts}`,
  ];

  if (input.accounting && input.accounting.trim().length > 0) {
    lines.push(
      `**Attempt accounting:** ${neutralizeUntrustedPacketText(input.accounting.trim())}`,
    );
  } else if (input.burnedAttempt === false) {
    lines.push('**Attempt accounting:** soft (no burn)');
  } else if (input.burnedAttempt === true) {
    lines.push('**Attempt accounting:** burn');
  }

  const next =
    input.nextEligibleAt === null
      ? 'n/a'
      : input.nextEligibleAt && input.nextEligibleAt.trim().length > 0
        ? input.nextEligibleAt.trim()
        : null;
  if (next !== null) {
    lines.push(`**Next eligible:** \`${next}\``);
  }

  if (input.policySummary && input.policySummary.trim().length > 0) {
    lines.push(
      `**Policy:** ${neutralizeUntrustedPacketText(input.policySummary.trim())}`,
    );
  }

  const park = parkedLabel(input.parkedReason ?? null, input.thrashParked === true);
  if (park) {
    lines.push(`**Parked:** ${park}`);
  }

  if (input.deathCause && input.deathCause.trim().length > 0) {
    lines.push(
      `**Death cause:** ${neutralizeUntrustedPacketText(input.deathCause.trim())}`,
    );
  }
  if (input.exitCode !== undefined) {
    lines.push(
      `**Exit code:** ${input.exitCode === null ? 'unknown' : String(input.exitCode)}`,
    );
  }
  if (input.exitSignal && input.exitSignal.trim().length > 0) {
    lines.push(`**Signal:** \`${input.exitSignal.trim()}\``);
  }
  if (input.adapter && input.adapter.trim().length > 0) {
    lines.push(`**Adapter:** \`${input.adapter.trim()}\``);
  }
  if (input.workspaceDir && input.workspaceDir.trim().length > 0) {
    lines.push(
      `**Workspace:** \`${neutralizeUntrustedPacketText(input.workspaceDir.trim())}\``,
    );
  }
  if (input.taskId) {
    const tip = input.branchTip?.trim();
    lines.push(
      tip
        ? `**Branch:** \`hercules/${input.taskId}\` @ \`${tip.slice(0, 12)}\``
        : `**Branch:** \`hercules/${input.taskId}\` (tip unknown — may be empty)`,
    );
  }
  if (input.expectedBaseRevision !== undefined) {
    lines.push(`**Branch lease base:** \`${shortLeaseSha(input.expectedBaseRevision)}\``);
  }
  if (input.expectedRemoteTip !== undefined) {
    lines.push(`**Branch lease expected tip:** \`${shortLeaseSha(input.expectedRemoteTip)}\``);
  }
  lines.push(`**Detail:** ${kindDetail(input.kind)}`);
  lines.push('');

  if (input.thrashParked || input.parkedReason === 'thrash') {
    const n = input.thrashConsecutive ?? input.attempt;
    lines.push(thrashNoteForRunFailure(input.kind, n));
    lines.push('');
  }

  const neutOpts =
    input.taskId !== undefined ? { taskId: input.taskId } : {};
  const tail = (input.activityTail ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  if (tail.length > 0) {
    lines.push('### Last agent activity');
    lines.push('```');
    for (const line of tail.slice(-24)) {
      lines.push(neutralizeUntrustedPacketText(line.slice(0, 400), neutOpts));
    }
    lines.push('```');
    lines.push('');
  }

  const stderr = (input.stderrTail ?? '').trim();
  if (stderr.length > 0) {
    lines.push('### Stderr tail');
    lines.push('```');
    // Already bounded at capture (~2KB); still hard-cap packet lines.
    const clipped = stderr.length > 2400 ? `…${stderr.slice(-2400)}` : stderr;
    lines.push(neutralizeUntrustedPacketText(clipped, neutOpts));
    lines.push('```');
    lines.push('');
  }

  const final = (input.finalMessage ?? '').trim();
  if (final.length > 0) {
    lines.push('### Final agent text (truncated)');
    const clipped = final.length > 2000 ? `${final.slice(0, 2000)}…` : final;
    lines.push(neutralizeUntrustedPacketText(clipped, neutOpts));
    lines.push('');
  }

  // Compact next-actions even before full salvage (retrying path).
  lines.push('### Next actions');
  // C3.59: a signal death is a crash of the adapter process — env / API /
  // quota / WORKFLOW advice is actively misleading there.
  const crashSignal =
    input.exitCode === undefined || input.exitCode === null
      ? null
      : agentDeathSignalName(input.exitCode);
  if (crashSignal !== null) {
    lines.push(
      "0. **Adapter crash** — the process was killed by `" + crashSignal + "`" +
        (stderr.length === 0 ? ' and wrote no stderr' : '') +
        '; check the adapter binary/runtime (version, host resources) before assuming a task problem. ' +
        'Retry is still worth one attempt — the same tip often runs clean.',
    );
  }
  lines.push(
    '1. **Retry** — primary: reset attempts and reuse the preserved branch after env / API / quota / WORKFLOW fixes',
  );
  lines.push('2. **Steer** — narrower instruction if partial branch work exists');
  lines.push('3. **Switch agent** — different adapter on the preserved branch');
  if (input.taskId) {
    lines.push(
      `4. **Clean salvage fork** — new task from \`hercules/${input.taskId}\` tip (explicit API/UI; not automatic)`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

/** Next actions when max attempts exhausted or thrash-parked without a review packet. */
export function buildAgentCrashSalvage(input: {
  readonly taskId: string;
  readonly maxAttempts: number;
  readonly kind: RunFailureKind | FailureKind;
  readonly thrashParked?: boolean;
  readonly parkedReason?: ParkedReason | null;
  readonly workspaceDir?: string;
}): string {
  const park = input.parkedReason;
  let headline: string;
  if (park === 'hard_infra') {
    headline = `Parked for **hard infra** (\`${input.kind}\`) — permanent error surfaced without burning the full retry budget on a hopeless loop.`;
  } else if (park === 'global_ceiling') {
    headline = `Parked at **global failure ceiling** (mixed soft + hard failures). No silent infinite retry.`;
  } else if (park === 'thrash' || input.thrashParked) {
    headline = `Parked early for **thrash** (same \`${input.kind}\` death repeating). No review packet.`;
  } else {
    headline = `Reached **max attempts (${input.maxAttempts})** with **no review packet** (agent never finished cleanly).`;
  }

  const lines = [
    '## Salvage brief',
    '',
    headline,
    `Branch \`hercules/${input.taskId}\` is preserved if any commits were made.`,
    '',
  ];
  if (input.workspaceDir) {
    lines.push(`Last workspace (may be reclaimed): \`${input.workspaceDir}\``);
    lines.push('');
  }
  lines.push(
    '### What failed',
    `- run kind: \`${input.kind}\` (not L1/L2/L3 axes — verify never ran)`,
    '',
    '### Suggested next actions',
    '1. **Retry** — primary recovery: reset attempts; reuses the preserved ' +
      `\`hercules/${input.taskId}\` branch`,
    '2. **Steer** — narrower instruction if the agent was mid-change',
    '3. **Switch agent** — try a different adapter on the preserved branch',
    '4. **Clean salvage fork** — explicit phone/API action opens a fresh task ' +
      'seeded from the preserved tip (audited; not automatic adoption)',
    '5. **Mark repo ready** only if onboarding artifacts already landed offline',
    '',
  );
  return lines.join('\n');
}

/** Parse the latest Run failure block for phone UI summary chips. */
export function parseLatestRunFailure(body: string): {
  kind: RunFailureKind | null;
  thrashParked: boolean;
  hasActivity: boolean;
  nextEligibleAt: string | null;
  accounting: string | null;
} {
  const idx = body.toLowerCase().lastIndexOf('## run failure');
  if (idx < 0) {
    return {
      kind: null,
      thrashParked: false,
      hasActivity: false,
      nextEligibleAt: null,
      accounting: null,
    };
  }
  const slice = body.slice(idx, idx + 2500);
  const kindM = /\*\*Kind:\*\*\s*`([^`]+)`/i.exec(slice);
  const raw = kindM?.[1]?.trim() ?? '';
  const kind: RunFailureKind | null = isRunFailureKind(raw) ? raw : null;
  const nextM = /\*\*Next eligible:\*\*\s*`([^`]+)`/i.exec(slice);
  const nextRaw = nextM?.[1]?.trim() ?? null;
  const nextEligibleAt =
    nextRaw && nextRaw.toLowerCase() !== 'n/a' ? nextRaw : null;
  const accM = /\*\*Attempt accounting:\*\*\s*(.+)$/im.exec(slice);
  return {
    kind,
    thrashParked: /\*\*Thrash:\*\*/i.test(slice) || /\*\*Parked:\*\*\s*thrash/i.test(slice),
    hasActivity: /###\s+Last agent activity/i.test(slice),
    nextEligibleAt,
    accounting: accM?.[1]?.trim() ?? null,
  };
}

/**
 * Accounting block for Auto-rework (L1/L2/L3) so verify failures share the same
 * human-visible kind + next-eligible contract as Run failure.
 */
export function buildReworkAccountingLines(input: {
  readonly kind: FailureKind;
  readonly accounting: string;
  readonly nextEligibleAt: string | null;
  readonly policySummary?: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}): string {
  const lines = [
    `**Failure kind:** \`${input.kind}\``,
    `**Attempt:** ${input.attempt} / ${input.maxAttempts}`,
    `**Attempt accounting:** ${input.accounting}`,
    `**Next eligible:** \`${input.nextEligibleAt ?? 'n/a'}\``,
  ];
  if (input.policySummary) {
    lines.push(`**Policy:** ${input.policySummary}`);
  }
  return lines.join('\n');
}
