/**
 * CEO decision inbox — everything that needs the human TODAY, derived purely
 * from existing state (tasks + release panel + system holds), one zh one-liner
 * + one target each. The vision's last mile: review in the operator's language,
 * not the machine's (2026-07-23).
 */
import { bodyHasTrunkInheritedGateFail } from '../domain/gateFailAttribution.js';
import { dependencyHolds } from '../domain/dependencyGate.js';
import type {
  AdapterFailoverDto,
  DispatchHoldDto,
  DraftJobStatus,
  Task,
} from './api.js';
import { bodyHasSuccessfulPacket } from './taskBodySplit.js';

export type InboxKind =
  | 'approve'
  | 'promote'
  | 'plan'
  | 'failed'
  | 'blocked'
  | 'system'
  | 'draft';

export interface InboxItem {
  readonly kind: InboxKind;
  /** One decision-ready zh line. */
  readonly line: string;
  /** Deep-link target: a task… */
  readonly taskId?: string;
  /** …or the releases panel for a repo. */
  readonly repoKey?: string;
  /** Background analyst draft job ready to open in CreateForm. */
  readonly draftJobId?: string;
}

export interface InboxReleaseFacts {
  readonly repoKey: string;
  readonly canPromote: boolean;
  readonly stagingReady: boolean;
  readonly changeCount: number;
}

export interface InboxOptions {
  /** Daemon dispatch pause (disk critical) — system item, no deep-link. */
  readonly dispatchHold?: DispatchHoldDto | null;
  /**
   * Provider failover while an adapter is unhealthy — system item, no deep-link.
   * Detail is already operator-facing (zh one-liner from the domain).
   */
  readonly adapterFailover?: AdapterFailoverDto | null;
  /** Live / finished analyst draft jobs (ready → inbox row). */
  readonly draftJobs?: readonly {
    id: string;
    repo: string;
    intent: string;
    status: DraftJobStatus;
  }[];
}

/** system first; draft next (freshest thing the human asked for). */
const KIND_ORDER: readonly InboxKind[] = [
  'system',
  'draft',
  'approve',
  'promote',
  'plan',
  'failed',
  'blocked',
];

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}
/** Same signal the Decide panel uses for the green path (packet status line). */
function isGreenReview(task: Task): boolean {
  return bodyHasSuccessfulPacket(task.body, { nonce: task.packetNonce ?? null });
}

export function buildDecisionInbox(
  tasks: readonly Task[],
  releases: readonly InboxReleaseFacts[],
  options: InboxOptions = {},
): InboxItem[] {
  const items: InboxItem[] = [];

  if (options.dispatchHold) {
    // No taskId / repoKey — links nowhere; states the action (free disk).
    items.push({
      kind: 'system',
      line: `🛑 调度暂停 — ${options.dispatchHold.detail}`,
    });
  }

  if (options.adapterFailover?.detail) {
    items.push({
      kind: 'system',
      line: options.adapterFailover.detail,
    });
  }

  for (const job of options.draftJobs ?? []) {
    if (job.status !== 'ready') continue;
    items.push({
      kind: 'draft',
      draftJobId: job.id,
      line: `分析完成 · ${job.repo} · ${clip(job.intent, 24)}`,
    });
  }

  const failedIds = new Set(
    tasks.filter((t) => t.state === 'failed' || t.state === 'cancelled').map((t) => t.id),
  );
  const knownIds = new Set(tasks.map((t) => t.id));

  for (const t of tasks) {
    if (t.state === 'review') {
      items.push({
        kind: 'approve',
        taskId: t.id,
        line: isGreenReview(t)
          ? `✅ 待批「${t.title}」— 全绿,勾人工项即批`
          : bodyHasTrunkInheritedGateFail(t.body)
            ? `🟡 待批「${t.title}」— 门禁失败属主干既有问题,需先修 main`
            : `🟡 待批「${t.title}」— 未全绿,需人工判断`,
      });
    } else if (t.planPending && (t.state === 'todo' || t.state === 'retrying')) {
      items.push({
        kind: 'plan',
        taskId: t.id,
        line: `📋 待批计划「${t.title}」— 补验收标准或放行`,
      });
    } else if (t.state === 'failed') {
      items.push({
        kind: 'failed',
        taskId: t.id,
        line: `⛔「${t.title}」${t.attempts} 试未过 — 重试/打回/放弃`,
      });
    } else if (
      (t.state === 'todo' || t.state === 'retrying') &&
      t.blockedBy.some((b) => failedIds.has(b) || !knownIds.has(b))
    ) {
      items.push({
        kind: 'blocked',
        taskId: t.id,
        line: `⏸「${t.title}」— 上游失败/缺失,处理后自动放行`,
      });
    } else if (
      (t.state === 'todo' || t.state === 'retrying') &&
      // Domain holds: Approve-before-Merge / missing gate provenance.
      dependencyHolds(t, tasks).some((h) => h.kind === 'awaiting_merge')
    ) {
      items.push({
        kind: 'blocked',
        taskId: t.id,
        line: `⏸「${t.title}」— 上游已批未合并,先 Merge Selected`,
      });
    }
  }

  for (const r of releases) {
    if (r.canPromote && r.stagingReady) {
      items.push({
        kind: 'promote',
        repoKey: r.repoKey,
        line: `🚀 可发布 ${r.repoKey} — ${r.changeCount} 项已验证,等你 Promote`,
      });
    }
  }

  return items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}
