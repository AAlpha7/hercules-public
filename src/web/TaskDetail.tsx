/**
 * Task detail sheet: decide / live activity / agent / body / chat / actions.
 */
import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type SyntheticEvent,
} from 'react';
import { ConfirmButton } from './ConfirmButton.js';
import { copyToClipboard } from './clipboard.js';
import { Markdown } from './Markdown.js';
import { failureBrief } from './failureBrief.js';
import { QueueFrontButton } from './QueueFrontButton.js';
import { extractDecisionSummary } from './decisionSummary.js';
import { extractTaskPurpose, failingGatesZh } from './decideCard.js';
import {
  buildReviewVerdict,
  reviewPrimaryDisabledReason,
} from './reviewVerdict.js';
import {
  explainBoundaryBadges,
  normalizeBoundaries,
  parseDecisionCard,
  type BoundaryBadgeKey,
} from '../domain/decisionCard.js';
import {
  matchHumanAcAction,
  resolveHumanAcGuidance,
  type HumanAcGuidance,
} from '../domain/humanAcGuidance.js';
import {
  bodyHasMergeGateFailure,
  parseMergeFailureReceipt,
} from '../domain/mergeFailureReceipt.js';
import { MergeGateFailureBanner } from './mergeGateFailureBanner.js';
import { RunTimelinePanel } from './RunTimeline.js';
import { EvidenceFirstSection } from './EvidenceGallery.js';
import {
  buildCredibilityChips,
  evidenceEmptyNote,
  extractAgentReport,
  extractEvidenceMedia,
  packetProvenance,
  splitTaskBody,
} from './taskBodySplit.js';
import {
  defaultOpen,
  isRecentSummaryGesture,
  loadSheetHabits,
  rankSections,
  recordSectionEvent,
  type SheetHabits,
  type SheetSectionId,
} from './sheetHabits.js';
import {
  ApiError,
  editRepo,
  fetchPrSummary,
  fetchTaskFile,
  fetchTaskFiles,
  type AdapterKind,
  type LiveRunMeta,
  type PrSummary,
  type SchedulingHoldReasonDto,
  type Task,
  type VerificationRunMeta,
} from './api.js';

const EVIDENCE_FIRST_STATIC_ORDER: readonly SheetSectionId[] = [
  'run-timeline',
  'live-activity',
  'machine-details',
  'packet-details',
  'agent-report',
  'task-body',
  'files',
  'dependencies',
  'agent-picker',
  'chat',
  'actions',
];

/** Neutral operator labels for boundary / anti-cheat facts (no warn colour). */
const BOUNDARY_FACT_LABEL: Record<string, { ok: string; warn: string }> = {
  branch: { ok: '仅任务分支', warn: '仅任务分支' },
  protected: { ok: '未碰受保护路径', warn: '改了受保护路径' },
  tests: { ok: '未改测试文件', warn: '改了测试文件' },
  cross: { ok: '无其他任务提交', warn: '分支含其他任务的提交' },
};

/** Chinese one-liner for a per-task scheduling hold (todo/retrying banner). */
export function dispatchHoldZh(reason: SchedulingHoldReasonDto): string {
  switch (reason.code) {
    case 'plan_pending':
      return '计划待批准：请先点「批准计划」后才会调度。';
    case 'host_approval_pending':
      return '主机操作/部署待批准：需要人工批准并填写命令范围后才会调度。';
    case 'already_running':
      return '任务已在运行集合中（调度侧视为占用中）。';
    case 'excluded':
      return '本轮被软排除（例如路径租约争用），稍后会自动重试。';
    case 'unknown_repo':
      return '仓库未在 repos.yaml 中登记：无法调度。请先添加仓库配置。';
    case 'repo_readiness_incomplete':
      return (
        `仓库 ${reason.repo} 未标记就绪（readiness incomplete）：` +
        '只有 onboarding/readiness 标签的任务会被调度。到仓库页完成就绪检查并标记就绪。'
      );
    case 'dependency_gate_merge':
      return (
        `依赖未合并入主干：等待 ${reason.waitingOn.join('、') || '（未知）'} ` +
        '经 Merge Selected（gate）合并后才会调度。'
      );
    case 'dependency_completion':
      return (
        `依赖未完成：等待 ${reason.waitingOn.join('、') || '（未知）'} ` +
        '进入 done 后才会调度。'
      );
    case 'retry_backoff':
      return `重试退避中：约到 ${new Date(reason.untilMs).toLocaleString()} 才可再次调度。`;
    case 'provision_failed':
      return (
        `工作区准备失败，退避到 ${new Date(reason.untilMs).toLocaleString()} 再试：${reason.detail}` +
        '（通常是分支尖端与租约不一致或种子提交缺失；修正后 Cancel 并重建任务）'
      );
    case 'adapter_crashing':
      return (
        `执行器 ${reason.adapter} 进程连续崩溃，已暂停派发到 ` +
        `${new Date(reason.untilMs).toLocaleString()}：${reason.detail}` +
        '（多为执行器二进制自动升级后损坏；先在主机上验证一次 headless 调用，再恢复派发）'
      );
    case 'capacity':
      return reason.scope === 'repo'
        ? `仓库 ${reason.repo ?? ''} 并发已满：等待同仓库任务结束后再调度。`
        : '全局并发已满：等待空闲槽位后再调度。';
  }
}
import {
  bodyHasSuccessfulPacket,
  countDodCriteria,
  extractTaskSummary,
  formatDodChip,
  isVerificationInfraFailure,
  packetCostChip,
  packetStatusChip,
  areHumanCriteriaChecked,
  parseHumanCriteria,
  TaskBodyView,
  thrashBrakeStillActive,
} from './taskBody.js';
import { listAfterDeployCriteriaTexts } from '../domain/acceptance.js';
import { hasOpenPr } from '../domain/task.js';
import { loadLang } from './prefs.js';
import { t } from './i18n.js';
import {
  fmtDur,
  githubOpenHref,
  liveStatusPill,
  looksNoChange,
  parseMs,
  STATE_LABEL,
  verificationStatusLabel,
  verifyStatusPill,
} from './taskUi.js';
import {
  outcomeReviewOwnsPresentation,
  ReviewPresentationBoundary,
  type ReviewPresentationConfig,
} from './review/ReviewPresentationBoundary.js';

/** zh labels for common repo areas (generic classifier falls back to raw dir). */
const AREA_ZH: Record<string, string> = {
  'src/web': '手机界面',
  'src/orchestrator': '编排调度',
  'src/domain': '核心逻辑',
  'src/adapters': 'agent 适配',
  'src/server': '服务端',
  'src/isolation': '隔离层',
  'src/verification': '验证层',
  'src/control': '控制仓 IO',
  'src/sessions': '会话',
  scripts: '脚本',
  docs: '文档',
  test: '测试',
  core: '核心(Rust)',
  webapp: '前端应用',
  '(root)': '根目录文件',
};

/** zh state words for inline sentences (banners) — labels elsewhere use STATE_LABEL. */
const STATE_ZH: Record<string, string> = {
  todo: '排队中',
  in_progress: '进行中',
  retrying: '重试中',
  review: '待批准',
  done: '已完成',
};

function TaskTiming({ task, now }: { task: Task; now: number }): JSX.Element | null {
  const created = parseMs(task.createdAt);
  const started = parseMs(task.startedAt);
  const ended = parseMs(task.endedAt);
  const rows: [string, string][] = [];
  if (created !== null) rows.push(['Created', new Date(created).toLocaleString()]);
  if (started !== null) {
    // started/ended can straddle different runs after park/retry cycles —
    // a "ran 19h 40m" figure is bookkeeping garbage, not a runtime (a single
    // run is hard-killed at 2h). Beyond 4h, show — instead of nonsense.
    const ran = ended !== null ? ended - started : null;
    rows.push([
      task.state === 'in_progress' ? 'Agent running' : 'Agent ran',
      task.state === 'in_progress'
        ? fmtDur(now - started)
        : ran !== null && ran > 0 && ran <= 4 * 3600_000
          ? fmtDur(ran)
          : '—',
    ]);
  }
  if (task.state === 'review' && ended !== null) rows.push(['Awaiting your review', fmtDur(now - ended)]);
  if (rows.length === 0) return null;
  return (
    <div className="timing timing-panel">
      {rows.map(([k, v]) => (
        <div key={k} className="timing-cell">
          <span className="timing-k muted">{k}</span>
          <span className="timing-v">{v}</span>
        </div>
      ))}
    </div>
  );
}


export function TaskDetail({
  task,
  now,
  activity,
  pendingChat,
  liveRun,
  verificationRun = null,
  brokenDeps = [],
  pendingDeps = [],
  mergeBlockedDeps = [],
  dispatchHoldReason = null,
  busy,
  pending,
  stopping,
  agentLabel,
  inheritAgent,
  availableAgents,
  closeLabel = 'Close',
  onClose,
  onAction,
  onForceAbort,
  onDelete,
  onClone,
  onSalvageFork,
  onQueueFront,
  onSetAdapter,
  onRewireDependencies,
  onChat,
  chatOutcome = null,
  onOpenLive,
  onOpenPr,
  onApprovePr,
  onSteerFromPr,
  onApprovePlan,
  onApproveHostOperation,
  onReverify,
  reviewExperience,
}: {
  task: Task;
  now: number;
  activity: string[];
  pendingChat: string[];
  liveRun: LiveRunMeta | null;
  /** Post-agent verification overlay (phase/stage). */
  verificationRun?: VerificationRunMeta | null;
  /** Failed/cancelled/missing blocked_by deps holding this task (todo/retrying). */
  brokenDeps?: readonly { id: string; state: string }[];
  /** Healthy-but-unfinished deps — neutral waiting hint, not an alarm. */
  pendingDeps?: readonly { id: string; state: string }[];
  /**
   * Upstream done/approved but gate-merge barrier still holds (Merge Selected /
   * provenance / ancestry). Concise phone remediation per dep.
   */
  mergeBlockedDeps?: readonly {
    id: string;
    code: string;
    remediation: string;
  }[];
  /** Why this todo/retrying task is not dispatching (from /api/state holds). */
  dispatchHoldReason?: SchedulingHoldReasonDto | null;
  busy: boolean;
  pending: string | null;
  stopping: boolean;
  agentLabel: string;
  /** What runs if task.adapter is cleared (repo or daemon default). */
  inheritAgent: string;
  availableAgents: readonly string[];
  /** Close button label — "← Chat" when opened from a session. */
  closeLabel?: string;
  onClose: () => void;
  onAction: (
    action: 'approve' | 'reject' | 'cancel' | 'retry',
    opts?: { humanAcknowledged?: readonly string[]; overrideNote?: string },
  ) => void;
  onForceAbort: () => void;
  onDelete: (cleanup: boolean) => void;
  onClone: () => void;
  /** Explicit clean-salvage fork from a failed or cancelled (attempts > 0) task. */
  onSalvageFork?: () => void;
  /** Push todo/retrying task to the front of the dispatch queue. */
  onQueueFront?: () => void;
  onSetAdapter: (
    adapter: AdapterKind | null,
    opts?: { switchNow?: boolean },
  ) => void;
  onRewireDependencies?: (change: {
    id: string;
    expectedBlockedBy: string[];
    blockedBy: string[];
    dependencyMode: 'gate_merge' | 'completion_only';
  }) => void;
  onChat: (message: string) => void | Promise<void>;
  /** Last Remote Control chat outcome label (queued / pending / steer / already delivered). */
  chatOutcome?: string | null;
  onOpenLive: () => void;
  onOpenPr: () => void;
  onApprovePr: (opts?: { humanAcknowledged?: readonly string[] }) => void;
  onSteerFromPr: () => void;
  onApprovePlan: () => void;
  /** Human authorizes host_operation / deploy with bounded command scope. */
  onApproveHostOperation?: (commandScope: readonly string[]) => void;
  onReverify: () => void;
  /** Optional M7 presentation boundary. Omission preserves the legacy surface. */
  reviewExperience?: ReviewPresentationConfig;
}): JSX.Element {
  const selectValue = task.adapter ?? '';
  const [chatText, setChatText] = useState('');
  const [idCopied, setIdCopied] = useState(false);
  const [overrideNote, setOverrideNote] = useState('');
  /** One named host command per line for host_operation / deploy approval. */
  const [hostScopeDraft, setHostScopeDraft] = useState('');
  const approvedHostScope = (task.hostCommandScope ?? []).join('\n');
  useEffect(
    () => setHostScopeDraft(approvedHostScope),
    [task.id, task.hostApprovedAt, approvedHostScope],
  );
  const hostAlreadyApproved =
    Boolean(task.hostApprovedAt) && (task.hostCommandScope?.length ?? 0) > 0;
  const brief = task.state === 'failed' ? failureBrief(task.body, task.attempts) : null;
  const evidenceFirst =
    task.state === 'review' || task.state === 'done' || task.state === 'failed';
  // Parse for review decide + evidence chips on done/failed too.
  const decisionCard =
    task.state === 'review' || task.state === 'done' || task.state === 'failed'
      ? parseDecisionCard(task.body)
      : null;
  const mergeGateReceipt =
    task.state === 'review' ? parseMergeFailureReceipt(task.body) : null;
  const [habits, setHabits] = useState<SheetHabits>(() => loadSheetHabits());
  /** Once the user toggles a section, keep that open/closed until remount. */
  const [openOverrides, setOpenOverrides] = useState<
    Partial<Record<SheetSectionId, boolean>>
  >({});
  const noteHabit = (id: SheetSectionId, kind: 'open' | 'close' | 'click'): void => {
    setHabits(recordSectionEvent(id, kind, Date.now()));
  };
  /** Summary gesture timestamps — programmatic <details> toggles must not record. */
  const lastSummaryGestureAt = useRef<Partial<Record<SheetSectionId, number>>>({});
  const markSummaryGesture = (id: SheetSectionId): void => {
    lastSummaryGestureAt.current[id] = Date.now();
  };
  /** Consume a recent summary gesture once; second toggle without a new gesture is ignored. */
  const consumeSummaryGesture = (id: SheetSectionId): boolean => {
    if (!isRecentSummaryGesture(lastSummaryGestureAt.current[id])) return false;
    lastSummaryGestureAt.current[id] = undefined;
    return true;
  };
  const habitDetailsProps = (id: SheetSectionId, staticDefault: boolean) => {
    const open =
      openOverrides[id] !== undefined
        ? openOverrides[id]!
        : defaultOpen(id, habits, staticDefault);
    return {
      // Controlled so habit defaultOpen survives the first paint in jsdom/React 19.
      open,
      'data-section': id,
      'data-habit-open': open ? '1' : '0',
      onPointerDownCapture: (e: SyntheticEvent<HTMLDetailsElement>) => {
        const t = e.target;
        if (t instanceof Element && t.closest('summary')) markSummaryGesture(id);
      },
      onClickCapture: (e: SyntheticEvent<HTMLDetailsElement>) => {
        const t = e.target;
        if (t instanceof Element && t.closest('summary')) markSummaryGesture(id);
      },
      onKeyDownCapture: (e: SyntheticEvent<HTMLDetailsElement>) => {
        const ke = e.nativeEvent as KeyboardEvent;
        if (ke.key !== 'Enter' && ke.key !== ' ') return;
        const t = e.target;
        if (t instanceof Element && t.closest('summary')) markSummaryGesture(id);
      },
      onToggle: (e: SyntheticEvent<HTMLDetailsElement>) => {
        if (e.target !== e.currentTarget) return;
        const next = e.currentTarget.open;
        setOpenOverrides((prev) => ({ ...prev, [id]: next }));
        // Native toggle also fires for programmatic `open` — record only real gestures.
        if (!consumeSummaryGesture(id)) return;
        noteHabit(id, next ? 'open' : 'close');
      },
      onClick: (e: SyntheticEvent<HTMLDetailsElement>) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('summary')) return;
        // jsdom never sets isTrusted for Testing Library userEvent; real
        // clicks and userEvent set detail >= 1, while el.click() / bare
        // dispatchEvent default to detail 0.
        const detail = (e.nativeEvent as MouseEvent).detail;
        if (!e.nativeEvent.isTrusted && !(detail > 0)) return;
        noteHabit(id, 'click');
      },
    };
  };
  const hasMergeGateFailure = bodyHasMergeGateFailure(task.body);
  const decisionSummary =
    task.state === 'review' && !decisionCard ? extractDecisionSummary(task.body) : null;
  const taskPurpose =
    task.state === 'review' && !decisionCard ? extractTaskPurpose(task.body) : null;
  const failingGates = task.state === 'review' ? failingGatesZh(task.body) : [];
  // Browse-files: lazy list + one open file at a time (phone screen).
  const [taskFiles, setTaskFiles] = useState<string[] | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  /** Human-AC ref / action feedback (in-place, never navigates away). */
  const [humanAcDocPath, setHumanAcDocPath] = useState<string | null>(null);
  const [humanAcDocContent, setHumanAcDocContent] = useState<string | null>(null);
  const [humanAcActionErr, setHumanAcActionErr] = useState<string | null>(null);
  const [humanAcActionBusy, setHumanAcActionBusy] = useState(false);
  /** Draft adapter while in_progress — confirm soft set vs switch-now. */
  const [pendingAdapter, setPendingAdapter] = useState<string | null>(null);
  const [dependencyDraft, setDependencyDraft] = useState(task.blockedBy.join(', '));
  const [dependencyModeDraft, setDependencyModeDraft] = useState<'gate_merge' | 'completion_only'>(
    task.dependencyMode === 'completion_only' ? 'completion_only' : 'gate_merge',
  );
  /** Which boundary badge detail is expanded (green + yellow are both tappable). */
  const [openBoundary, setOpenBoundary] = useState<BoundaryBadgeKey | null>(null);
  /** Lightbox index driven by needs-you evidence links (and gallery taps). */
  const [evidenceOpenIndex, setEvidenceOpenIndex] = useState<number | null>(null);
  const humanACs = parseHumanCriteria(task.body);
  const afterDeployACs = listAfterDeployCriteriaTexts(task.body);
  const lang = loadLang();
  const [humanChecked, setHumanChecked] = useState<Record<string, boolean>>({});
  // Reset checklist / file browser when switching tasks.
  useEffect(() => {
    setHumanChecked({});
    setHumanAcDocPath(null);
    setHumanAcDocContent(null);
    setHumanAcActionErr(null);
    setTaskFiles(null);
    setActiveFile(null);
    setFileContent(null);
    setOpenBoundary(null);
    setEvidenceOpenIndex(null);
    setDependencyDraft(task.blockedBy.join(', '));
    setDependencyModeDraft(task.dependencyMode === 'completion_only' ? 'completion_only' : 'gate_merge');
  }, [task.id]);
  const boundaryBadges = decisionCard
    ? explainBoundaryBadges(normalizeBoundaries(decisionCard.boundaries))
    : [];
  const openBoundaryExplain =
    openBoundary !== null
      ? boundaryBadges.find((b) => b.key === openBoundary) ?? null
      : null;
  const humanAllChecked = areHumanCriteriaChecked(task.body, humanChecked);
  const acknowledgedHumanTexts = humanACs
    .filter((c) => humanChecked[c.id] === true)
    .map((c) => c.text);

  // Prefetch verified file list when human ACs need checklist path discovery (c).
  useEffect(() => {
    if (task.state !== 'review' || !task.verifiedSha || humanACs.length === 0) return;
    if (taskFiles !== null) return;
    void fetchTaskFiles(task.id)
      .then((r) => setTaskFiles([...r.files]))
      .catch(() => setTaskFiles([]));
  }, [task.id, task.state, task.verifiedSha, humanACs.length, taskFiles]);

  /** Prefer card-embedded how; merge refs with live file-list discovery (c). */
  const guidanceForHuman = (text: string): HumanAcGuidance => {
    const fromCard = decisionCard?.criteria.find(
      (c) => (c.kind === 'human' || c.kind === 'checkpoint') && c.text === text,
    );
    const live = resolveHumanAcGuidance({
      criterionText: text,
      taskBody: task.body,
      evidence: fromCard?.why ?? '',
      // Verified file list when loaded; empty still allows how from (a)/(b).
      files: taskFiles ?? [],
    });
    const how = fromCard?.how ?? live.how;
    const refSet = new Set<string>([...(fromCard?.refs ?? []), ...live.refs]);
    return { how, refs: [...refSet] };
  };

  const openHumanAcRef = (path: string): void => {
    if (humanAcDocPath === path) {
      setHumanAcDocPath(null);
      setHumanAcDocContent(null);
      return;
    }
    setHumanAcDocPath(path);
    setHumanAcDocContent(null);
    // Keep browse-files panel in sync when the same path is open there.
    setActiveFile(path);
    setFileContent(null);
    void fetchTaskFile(task.id, path)
      .then((r) => {
        const body = r.truncated ? `${r.content}\n\n…(truncated)` : r.content;
        setHumanAcDocContent(body);
        setFileContent(body);
      })
      .catch((e) => {
        const msg = `(failed to load: ${e instanceof Error ? e.message : String(e)})`;
        setHumanAcDocContent(msg);
        setFileContent(msg);
      });
  };

  const runMarkReadyAction = (criterionId: string): void => {
    setHumanAcActionBusy(true);
    setHumanAcActionErr(null);
    void editRepo(task.repo, { readiness: 'ready' })
      .then(() => {
        setHumanChecked((prev) => ({ ...prev, [criterionId]: true }));
      })
      .catch((e) => {
        setHumanAcActionErr(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => {
        setHumanAcActionBusy(false);
      });
  };
  const packetOpts = { nonce: task.packetNonce ?? null };
  const autoOk = bodyHasSuccessfulPacket(task.body, packetOpts);
  const verifyCrashed = isVerificationInfraFailure(task.body, packetOpts);
  /** Critical L5 still on the packet (should not park in review; block Approve if it does). */
  const criticalBlock =
    /❌ Critical L5/i.test(task.body) ||
    /\*\*❌ Critical L5\*\*/i.test(task.body);
  // Block Approve when system did not produce a real green packet or human ACs open.
  const approveBlocked =
    task.state === 'review' &&
    (!humanAllChecked || criticalBlock || verifyCrashed || !autoOk);

  const [prSummary, setPrSummary] = useState<PrSummary | null>(null);
  const [prSummaryErr, setPrSummaryErr] = useState<string | null>(null);
  const [prSummaryLoading, setPrSummaryLoading] = useState(false);
  /** Live activity log — keep pinned to latest lines while the agent streams. */
  const activityLogRef = useRef<HTMLPreElement | null>(null);
  const activityTail = activity.length > 0 ? activity[activity.length - 1] : '';
  useEffect(() => {
    const el = activityLogRef.current;
    if (!el) return;
    // Stick to bottom unless the user scrolled up to read history.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom || el.scrollTop === 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [activity.length, activityTail, task.id]);
  useEffect(() => {
    if (!task.prUrl) {
      setPrSummary(null);
      setPrSummaryErr(null);
      return;
    }
    let cancelled = false;
    setPrSummaryLoading(true);
    setPrSummaryErr(null);
    void fetchPrSummary(task.id)
      .then((s) => {
        if (!cancelled) setPrSummary(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPrSummary(null);
          setPrSummaryErr(err instanceof ApiError ? err.message : 'failed to load PR summary');
        }
      })
      .finally(() => {
        if (!cancelled) setPrSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.prUrl, task.prStatus]);

  const canPr =
    (task.state === 'review' || task.state === 'done') && !looksNoChange(task.body);
  // Packet chip is for review/done judgment ONLY. A historical packet must
  // not speak for a queued/failed/running task (R3 showed QUEUED + NEEDS
  // REVIEW together, 2026-07-23), and it must not duplicate the state pill
  // (review sheets showed NEEDS REVIEW twice).
  const rawStatusChip =
    task.state === 'review' || task.state === 'done'
      ? packetStatusChip(task.body, packetOpts)
      : null;
  const statusChip =
    rawStatusChip &&
    rawStatusChip.label.trim().toLowerCase() === STATE_LABEL[task.state].trim().toLowerCase()
      ? null
      : rawStatusChip;
  const costChip =
    task.state === 'in_progress' ? null : packetCostChip(task.body, packetOpts);
  const prOpen = hasOpenPr(task);
  const canChat =
    task.state === 'in_progress' ||
    task.state === 'review' ||
    task.state === 'failed' ||
    task.state === 'done' ||
    task.state === 'todo' ||
    task.state === 'retrying';
  const canSalvageFork =
    onSalvageFork !== undefined &&
    (task.state === 'failed' ||
      (task.state === 'cancelled' && task.attempts > 0));
  const outcomeReviewOwnsTask =
    task.state === 'review' &&
    reviewExperience !== undefined &&
    outcomeReviewOwnsPresentation(reviewExperience);

  const bodyText = task.body || '';
  const evidenceItems = evidenceFirst
    ? extractEvidenceMedia(bodyText, task.id, packetOpts)
    : [];
  const evidenceChips = evidenceFirst
    ? buildCredibilityChips(bodyText, decisionCard, packetOpts)
    : [];
  const evidenceNote = evidenceFirst
    ? evidenceEmptyNote(bodyText, decisionCard, packetOpts)
    : '';
  const agentReportText = evidenceFirst
    ? extractAgentReport(bodyText, packetOpts)
    : null;
  const packetDetailsText = evidenceFirst
    ? (packetProvenance(bodyText, packetOpts)?.region ?? null)
    : null;
  const briefText = evidenceFirst ? splitTaskBody(bodyText).brief : '';
  const showAdaptiveLive = evidenceFirst && Boolean(verificationRun);
  const showAdaptiveTimeline =
    evidenceFirst &&
    (task.state === 'failed' || task.state === 'review' || task.state === 'done');

  const reviewVerdict =
    task.state === 'review' && !outcomeReviewOwnsTask
      ? buildReviewVerdict({
          task,
          decisionCard,
          autoOk,
          verifyCrashed,
          humanACs,
          media: evidenceItems,
          afterDeployTexts: afterDeployACs,
        })
      : null;
  const primaryDisabledReason = reviewVerdict
    ? reviewPrimaryDisabledReason({
        actionKind: reviewVerdict.action.kind,
        humanAllChecked,
        approveBlocked,
        verifyCrashed,
        autoOk,
      })
    : null;

  const adaptivePresent = new Set<SheetSectionId>();
  if (showAdaptiveTimeline) adaptivePresent.add('run-timeline');
  if (showAdaptiveLive) adaptivePresent.add('live-activity');
  if (task.state === 'review' && !outcomeReviewOwnsTask) {
    adaptivePresent.add('machine-details');
  }
  if (packetDetailsText) adaptivePresent.add('packet-details');
  if (agentReportText) adaptivePresent.add('agent-report');
  if (evidenceFirst) adaptivePresent.add('task-body');
  if (evidenceFirst && task.verifiedSha) adaptivePresent.add('files');
  if (evidenceFirst && task.state !== 'in_progress' && onRewireDependencies) {
    adaptivePresent.add('dependencies');
  }
  if (evidenceFirst) adaptivePresent.add('agent-picker');
  if (evidenceFirst && canChat && task.state !== 'in_progress') {
    adaptivePresent.add('chat');
  }
  if (evidenceFirst && !outcomeReviewOwnsTask) adaptivePresent.add('actions');

  const adaptiveRank = evidenceFirst
    ? rankSections(
        EVIDENCE_FIRST_STATIC_ORDER.filter((id) => adaptivePresent.has(id)),
        habits,
        Date.now(),
        EVIDENCE_FIRST_STATIC_ORDER,
      )
    : [];
  const adaptiveOrder = new Map(adaptiveRank.map((id, i) => [id, i]));
  const orderStyle = (
    id: SheetSectionId,
  ): { style?: { order: number } } => {
    if (!evidenceFirst) return {};
    const order = adaptiveOrder.get(id);
    return order === undefined ? {} : { style: { order } };
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className={`sheet sheet-state-${task.state}${prOpen ? ' sheet-pr-open' : ''}${outcomeReviewOwnsTask ? ' sheet-outcome-v2' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" />
        {/* Long packets bury the bottom Close — keep a return control visible
            while scrolling (phone report 2026-07-17). */}
        <button
          type="button"
          className="sheet-back"
          onClick={onClose}
          data-evidence="task-detail-close"
        >
          {closeLabel}
        </button>
        <div className="sheet-hero">
          <div className="sheet-kicker">
            <span className={`pill pill-${task.state}`}>{STATE_LABEL[task.state]}</span>
            {statusChip ? (
              <span className={`pill pill-tone-${statusChip.tone}`}>{statusChip.label}</span>
            ) : null}
            {costChip ? (
              <span className={`pill pill-cost pill-cost-${costChip.tone}`}>{costChip.label}</span>
            ) : null}
            {/* Agent LIVE only — verification uses the live-panel VERIFYING pill. */}
            {task.state === 'in_progress' && !verificationRun ? (
              <span className="pill pill-live">● LIVE</span>
            ) : null}
            {prOpen ? <span className="pill pill-pr-open">PR open</span> : null}
            {task.prStatus === 'merged' ? <span className="pill pill-tone-ok">PR merged</span> : null}
            {task.prStatus === 'closed' ? <span className="pill pill-failed">PR closed</span> : null}
            {task.verifiedSha ? (
              <span className="pill pill-tone-ok" data-evidence="lane-verification">
                verified
              </span>
            ) : null}
            {task.mergedSha ? (
              <span className="pill pill-tone-ok" data-evidence="lane-merge-eligibility">
                merged
              </span>
            ) : task.state === 'done' && task.verifiedSha ? (
              <span className="pill pill-tone-warn" data-evidence="lane-merge-eligibility">
                mergeable
              </span>
            ) : null}
            {task.projectStateClosureStatus &&
            task.projectStateClosureStatus !== 'not_applicable' ? (
              <span
                className={
                  task.projectStateClosureStatus === 'passed'
                    ? 'pill pill-tone-ok'
                    : task.projectStateClosureStatus === 'failed'
                      ? 'pill pill-failed'
                      : 'pill pill-tone-warn'
                }
                data-evidence="lane-project-state-closure"
                title={
                  task.projectStateClosureDigest
                    ? `policy ${task.projectStateClosureDigest.slice(0, 12)}`
                    : 'project-state closure'
                }
              >
                closure:{task.projectStateClosureStatus}
              </span>
            ) : null}
          </div>
          <h2>{task.title}</h2>
          {task.state === 'review' && hasMergeGateFailure ? (
            <MergeGateFailureBanner receipt={mergeGateReceipt} />
          ) : null}
          <div className="meta muted sheet-meta">
            <code
              className={`id id-copy${idCopied ? ' id-copied' : ''}`}
              title="Tap to copy id"
              onClick={() => {
                void copyToClipboard(task.id).then((ok) => {
                  if (!ok) return;
                  setIdCopied(true);
                  window.setTimeout(() => setIdCopied(false), 1500);
                });
              }}
            >
              {idCopied ? '✓ copied' : task.id}
            </code>
            <span>{task.repo}</span>
            <span>agent {agentLabel}</span>
            {task.attempts > 0 ? <span>attempt {task.attempts}</span> : null}
          </div>
          {/* ReviewPresentationBoundary sits after evidence-first (not in hero). */}
          {(task.state === 'todo' || task.state === 'retrying') && dispatchHoldReason ? (
            <div className="banner waiting-deps" data-evidence="dispatch-hold">
              {dispatchHoldZh(dispatchHoldReason)}
            </div>
          ) : null}
          {(task.state === 'todo' || task.state === 'retrying') &&
          brokenDeps.length === 0 &&
          mergeBlockedDeps.length === 0 &&
          pendingDeps.length > 0 ? (
            <div className="banner waiting-deps" data-evidence="waiting-deps">
              等待上游 {pendingDeps.map((d) => `${d.id}(${STATE_ZH[d.state] ?? d.state})`).join('、')} 完成后自动开始 — 无需操作。
            </div>
          ) : null}
          {(task.state === 'todo' || task.state === 'retrying') && mergeBlockedDeps.length > 0 ? (
            <div className="banner banner-warn" data-evidence="merge-blocked-deps">
              <strong>Held — waiting for gate merge.</strong>{' '}
              {mergeBlockedDeps.map((d, i) => (
                <span key={d.id} data-evidence={`dep-hold-${d.code}`}>
                  {i > 0 ? ' · ' : ''}
                  {d.remediation}
                </span>
              ))}
            </div>
          ) : null}
          {(task.state === 'todo' || task.state === 'retrying') && brokenDeps.length > 0 ? (
            <div className="banner banner-danger" data-evidence="blocked-deps">
              <strong>Held — dependency not successful.</strong>{' '}
              {brokenDeps.map((d) => `${d.id} (${d.state})`).join(', ')} — this task will not
              dispatch until each dependency is done. Retry the failed dependency, or edit this
              task&apos;s blocked_by to release it.
            </div>
          ) : null}
          {task.state === 'failed' && brief ? (
            <div className="banner failure-brief" data-evidence="failure-brief">
              <strong>{brief.kindZh}</strong>(已尝试 {brief.attempts} 次)
              <div className="muted">{brief.adviceZh}</div>
            </div>
          ) : null}
          {task.state === 'failed' ? (
            <div className="banner banner-danger" data-evidence="task-failed-banner">
              <strong>
                {task.labels.some((l) => /onboarding|readiness/i.test(l))
                  ? 'Onboarding failed.'
                  : /\*\*Thrash:\*\*/i.test(task.body)
                    ? 'Parked for thrash (same crash repeating).'
                    : !/##\s+Review packet\b/i.test(task.body)
                      ? 'Failed without a review packet.'
                      : 'Task failed.'}
              </strong>{' '}
              {!/##\s+Review packet\b/i.test(task.body) ? (
                <>
                  The agent exited before L1/L2/L3 — no gate/DoD axes. Open{' '}
                  <em>Run timeline</em> / failure / Salvage. <strong>Retry</strong> is primary
                  (resets attempts, reuses <code>hercules/{task.id}</code>). Also:{' '}
                  <strong>Steer</strong> / switch agent / <strong>Clean salvage</strong> (new
                  task from preserved tip).
                </>
              ) : (
                <>
                  See packet + Salvage. <strong>Retry</strong> reuses the preserved branch;
                  <strong> Steer</strong> for a narrower fix; <strong>Clean salvage</strong>{' '}
                  forks a new audited task from the tip (no manual diffs).
                </>
              )}
              {task.attempts > 0 ? ` (attempts ${task.attempts})` : ''}
            </div>
          ) : null}
          {/* Run timeline: keep in hero for retrying only. review/done/failed
              move to the habit-adaptive band below evidence + decide. */}
          {task.state === 'retrying' ? (
            <RunTimelinePanel body={bodyText} defaultOpen={false} />
          ) : null}

          {(task.state === 'review' || task.state === 'done') &&
          thrashBrakeStillActive(task.body, packetOpts) ? (
            <div className="banner banner-warn" data-evidence="pr-thrash">
              <strong>PR CONFLICTING thrash brake.</strong> Auto re-queue stopped. Fix conflicts
              only on <code>hercules/{task.id}</code> (do not dual-write main), then re-verify.
            </div>
          ) : null}
          {task.prUrl ? (
            <div className="pr-detail-row">
              <a
                className="pr-detail-link"
                href={githubOpenHref({ url: task.prUrl })}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {prOpen ? 'Open active PR on GitHub →' : 'PR on GitHub →'}
              </a>
              {(task.state === 'done' || task.state === 'review' || task.state === 'failed') && (
                <button
                  type="button"
                  className="pr-steer-btn"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSteerFromPr();
                  }}
                >
                  {pending === 'steerPr' ? <span className="spinner" /> : 'Steer from PR comments'}
                </button>
              )}
            </div>
          ) : null}
          {task.prUrl ? (
            <div className="pr-summary-panel">
              <div className="body-label">PR summary</div>
              {prSummaryLoading && <div className="muted">Loading CI & comments…</div>}
              {prSummaryErr && <div className="pr-summary-err">{prSummaryErr}</div>}
              {prSummary && !prSummaryLoading ? (
                <div className="pr-summary-grid">
                  <span className={`pr-ci pr-ci-${prSummary.ciStatus}`}>
                    CI · {prSummary.ciStatus}
                  </span>
                  <span className="muted">{prSummary.ciSummary}</span>
                  <span>
                    Reviews {prSummary.reviewCount}
                    {prSummary.reviewDecision ? ` · ${prSummary.reviewDecision}` : ''}
                  </span>
                  <span>Comments {prSummary.commentCount}</span>
                  {prSummary.mergeable ? (
                    <span className="muted">Mergeable · {prSummary.mergeable}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {/* Evidence-first sheets keep timing below decide so the phone first
            viewport can hold evidence + the decision action. */}
        {!evidenceFirst ? <TaskTiming task={task} now={now} /> : null}

        {/* Running or mid-verification on non-evidence-first states. When a
            review/done/failed task is verifying, live-activity lives in the
            habit-adaptive band instead. */}
        {(task.state === 'in_progress' || (verificationRun && !evidenceFirst)) && (
          <>
            <div className="run-brief-panel" data-evidence="run-brief">
              <div className="body-label">What this run is for</div>
              <div className="run-brief-text">
                <Markdown text={extractTaskSummary(task.body)} />
              </div>
              <div className="run-brief-meta muted">
                <span>{formatDodChip(countDodCriteria(task.body))}</span>
                <span>
                  attempt {task.attempts}
                  {liveRun?.runKind === 'steer' ? ' · steer' : ' · full run'}
                </span>
                <span>
                  tip{' '}
                  <code>
                    {liveRun?.branchTip
                      ? liveRun.branchTip.slice(0, 12)
                      : 'pending…'}
                  </code>
                </span>
                <span>{verificationRun ? 'verification active' : 'agent active'}</span>
                {verificationRun ? (
                  <span data-evidence="verification-stage">
                    {verificationStatusLabel(verificationRun)}
                    {verificationRun.processAlive ? ' · process alive' : ''}
                    {verificationRun.cancelRequested ? ' · cancel requested' : ''}
                    {` · ${fmtDur(verificationRun.elapsedMs)}`}
                    {verificationRun.lastCompletedStage
                      ? ` · last ${verificationRun.lastCompletedStage}`
                      : ''}
                  </span>
                ) : null}
                {liveRun?.lastEventAt ? (
                  <span>
                    last event {fmtDur(Math.max(0, now - Date.parse(liveRun.lastEventAt)))} ago
                  </span>
                ) : null}
                {!verificationRun && liveRun?.processAlive === true ? (
                  <span>
                    process alive
                    {liveRun.aliveHint?.trim() ? ` · ${liveRun.aliveHint.trim()}` : ''}
                    {typeof liveRun.procCpuPct === 'number'
                      ? ` · CPU ${liveRun.procCpuPct}%`
                      : ''}
                    {typeof liveRun.procRssMb === 'number' && liveRun.procRssMb >= 1
                      ? liveRun.procRssMb >= 1024
                        ? ` · ${(liveRun.procRssMb / 1024).toFixed(1)}GB`
                        : ` · ${liveRun.procRssMb}MB`
                      : ''}
                  </span>
                ) : null}
                {liveRun?.runMs !== undefined && liveRun.maxRunMs !== undefined ? (
                  <span>
                    run {fmtDur(liveRun.runMs)} / hard kill {fmtDur(liveRun.maxRunMs)}
                  </span>
                ) : null}
              </div>
            </div>
            <div
              className={`activity activity-panel activity-panel-live${
                !verificationRun &&
                liveRun?.processAlive === true &&
                (liveRun.silenceMs ?? 0) >= 30_000
                  ? ' activity-panel-quiet'
                  : ''
              }`}
              data-evidence="live-activity"
            >
              <div className="body-label activity-live-head">
                <span>{verificationRun ? 'Verification' : 'Live activity'}</span>
                {(() => {
                  const verifyPill = verifyStatusPill(verificationRun);
                  const pill = verifyPill ?? liveStatusPill(liveRun);
                  return (
                    <span className={pill.className} data-evidence="live-status-pill">
                      {pill.label}
                    </span>
                  );
                })()}
              </div>
              <pre className="activity-log" ref={activityLogRef} data-evidence="live-activity-log">
                {verificationRun
                  ? [
                      `Verifying: ${verificationRun.stage} (${verificationRun.phase})`,
                      verificationRun.processAlive
                        ? 'Gate/process is alive — cancel aborts the active command group.'
                        : 'Between gates / assembling packet…',
                      verificationRun.cancelRequested
                        ? 'Cancel requested — aborting verification…'
                        : 'Cancel or force-abort stops verification without waiting for cargo to finish.',
                      verificationRun.lastCompletedStage
                        ? `Last completed: ${verificationRun.lastCompletedStage}`
                        : null,
                      `Elapsed ${fmtDur(verificationRun.elapsedMs)}`,
                    ]
                      .filter(Boolean)
                      .join('\n')
                  : activity.length > 0
                    ? activity.join('\n')
                    : liveRun?.processAlive === true
                      ? `Agent process is alive${liveRun.aliveHint?.trim() ? ` (${liveRun.aliveHint.trim()})` : ''}. Stream quiet is normal during long tools (cargo, pnpm, tests) — not a hang.\nHard kill at ${fmtDur(liveRun.maxRunMs ?? 2 * 60 * 60_000)}. Open live session for full chat if needed.`
                      : 'Agent is running. Grok often stays quiet while tools/API work — not always stuck.\nOpen live session for full chat if needed.'}
              </pre>
              <div className="live-quick-actions" data-evidence="live-quick-actions">
                <button type="button" className="primary" disabled={busy} onClick={onOpenLive}>
                  {pending === 'live' ? <span className="spinner" /> : 'Open live session'}
                </button>
                {stopping || (verificationRun?.cancelRequested === true) ? (
                  <ConfirmButton
                    className="danger"
                    label="Force abort"
                    confirmLabel="Confirm force-abort?"
                    onConfirm={onForceAbort}
                    disabled={busy}
                    loading={pending === 'forceAbort'}
                    data-evidence="verify-force-abort"
                  />
                ) : (
                  <ConfirmButton
                    className="danger"
                    label="Cancel"
                    confirmLabel="Confirm cancel?"
                    onConfirm={() => onAction('cancel')}
                    disabled={busy}
                    loading={pending === 'cancel'}
                    data-evidence="verify-cancel"
                  />
                )}
              </div>
            </div>
          </>
        )}

        {task.planPending && (
          <div className="decide-panel plan-pending-panel">
            <div className="body-label">Plan awaiting your sign-off</div>
            <p className="muted">
              Edit the body if needed, then approve the plan so an agent can run. Vision stays
              with you; execution waits.
            </p>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={onApprovePlan}
              aria-busy={pending === 'approvePlan'}
            >
              {pending === 'approvePlan' ? <span className="spinner" /> : 'Approve plan → queue'}
            </button>
          </div>
        )}

        {canApproveHostOperation(task) && onApproveHostOperation && (
          <div
            className="decide-panel host-op-approval-panel"
            data-evidence="host-op-approval"
          >
            <div className="body-label">
              {hostAlreadyApproved
                ? 'Revise host operation approval'
                : 'Host operation — command scope required'}
            </div>
            <p className="muted">
              This task is <code>{task.executionClass}</code>. It will not dispatch until you
              approve its exact host commands, one per line.
            </p>
            <label className="settings-field">
              <span className="body-label">Named command scope</span>
              <textarea
                data-evidence="host-op-scope-input"
                rows={3}
                value={hostScopeDraft}
                onChange={(e) => setHostScopeDraft(e.target.value)}
                placeholder={'systemctl restart hercules\ncurl -sf http://localhost:8787/'}
                disabled={busy}
              />
            </label>
            <button
              type="button"
              className="primary"
              data-evidence="host-op-approve-btn"
              disabled={busy || hostScopeDraft.trim().length === 0}
              onClick={() => {
                const scope = hostScopeDraft
                  .split('\n')
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0);
                if (scope.length === 0) return;
                onApproveHostOperation(scope);
              }}
              aria-busy={pending === 'approveHostOp'}
            >
              {pending === 'approveHostOp' ? (
                <span className="spinner" />
              ) : (
                hostAlreadyApproved ? 'Update host approval' : 'Approve host operation → queue'
              )}
            </button>
          </div>
        )}

        {task.hostApprovedAt && (task.hostCommandScope?.length ?? 0) > 0 && (
          <div className="muted host-op-approved-chip" data-evidence="host-op-approved">
            Host scope approved {task.hostApprovedAt.slice(0, 19)}:{' '}
            {(task.hostCommandScope ?? []).map((c) => (
              <code key={c} style={{ marginRight: 4 }}>
                {c}
              </code>
            ))}
          </div>
        )}

        {evidenceFirst ? (
          <EvidenceFirstSection
            items={evidenceItems}
            chips={evidenceChips}
            emptyNote={evidenceNote}
            openIndex={evidenceOpenIndex}
            onOpenIndexChange={setEvidenceOpenIndex}
          />
        ) : null}

        {task.state === 'review' && reviewExperience ? (
          <ReviewPresentationBoundary
            taskId={task.id}
            config={reviewExperience}
            taskBody={task.body}
          />
        ) : null}

        {task.state === 'review' && !outcomeReviewOwnsTask && reviewVerdict && (
          <div className="decide-panel decide-panel--operator" data-evidence="review-decide">
            <section className="review-verdict" data-evidence="review-verdict">
              <p className="review-verdict-headline">{reviewVerdict.headline}</p>
              {(() => {
                const kind = reviewVerdict.action.kind;
                const isApproveFamily =
                  kind === 'approve' ||
                  kind === 'watch_then_approve' ||
                  kind === 'confirm_items';
                const isReverify = kind === 'reverify';
                const isReject = kind === 'reject_or_override';
                const disabledLabel = primaryDisabledReason;
                const primaryLabel =
                  isApproveFamily && disabledLabel
                    ? disabledLabel
                    : reviewVerdict.action.label;
                const onPrimary = (): void => {
                  if (isReverify) {
                    onReverify();
                    return;
                  }
                  if (isReject) {
                    onAction('reject');
                    return;
                  }
                  if (isApproveFamily) {
                    onAction('approve', { humanAcknowledged: acknowledgedHumanTexts });
                  }
                };
                return (
                  <button
                    type="button"
                    className="primary review-primary-action"
                    data-evidence="review-primary-action"
                    data-action-kind={kind}
                    disabled={
                      busy ||
                      (isApproveFamily && approveBlocked)
                    }
                    title={
                      isApproveFamily && approveBlocked
                        ? verifyCrashed
                          ? 'Re-verify first — no review packet'
                          : !autoOk
                            ? 'Automated proof incomplete'
                            : 'Check all human acceptance criteria first'
                        : undefined
                    }
                    onClick={onPrimary}
                  >
                    {pending === 'approve' || pending === 'reverify' || pending === 'reject' ? (
                      <span className="spinner" />
                    ) : (
                      primaryLabel
                    )}
                  </button>
                );
              })()}
            </section>
            {canPr &&
            (reviewVerdict.action.kind === 'approve' ||
              reviewVerdict.action.kind === 'watch_then_approve' ||
              reviewVerdict.action.kind === 'confirm_items') ? (
              <button
                type="button"
                className="review-secondary-action"
                disabled={busy || approveBlocked}
                title={
                  approveBlocked
                    ? verifyCrashed
                      ? 'Re-verify first — no review packet'
                      : !autoOk
                        ? 'Automated proof incomplete'
                        : 'Check all human acceptance criteria first'
                    : undefined
                }
                onClick={() =>
                  onApprovePr({ humanAcknowledged: acknowledgedHumanTexts })
                }
              >
                {pending === 'approvePr' ? <span className="spinner" /> : 'Approve & PR'}
              </button>
            ) : null}
            <div className="review-secondary-row">
              {reviewVerdict.action.kind !== 'reject_or_override' ? (
                <button type="button" disabled={busy} onClick={() => onAction('reject')}>
                  {pending === 'reject' ? <span className="spinner" /> : 'Reject'}
                </button>
              ) : null}
              {reviewVerdict.action.kind !== 'reverify' ? (
                <button
                  type="button"
                  className={verifyCrashed || !autoOk ? 'primary' : undefined}
                  disabled={busy}
                  onClick={onReverify}
                  title="Re-run L1/L2/L3/L5 only (recreates worktree from branch)"
                >
                  {pending === 'reverify' ? <span className="spinner" /> : 'Re-verify'}
                </button>
              ) : null}
            </div>

            {reviewVerdict.needsYou.length > 0 && (
              <section className="review-needs-you" data-evidence="review-needs-you">
                <div className="body-label">需要你确认</div>
                <ul className="review-needs-you-list">
                  {reviewVerdict.needsYou.map((item) => {
                    const humanRow =
                      item.kind === 'human'
                        ? humanACs.find((c) => c.id === item.id)
                        : undefined;
                    const g = humanRow ? guidanceForHuman(humanRow.text) : null;
                    const action = humanRow ? matchHumanAcAction(humanRow.text) : null;
                    const fromCard = humanRow
                      ? decisionCard?.criteria.find(
                          (row) =>
                            (row.kind === 'human' || row.kind === 'checkpoint') &&
                            row.text === humanRow.text,
                        )
                      : undefined;
                    return (
                      <li
                        key={item.id}
                        className={
                          item.kind === 'unverified'
                            ? 'review-needs-you-item review-needs-you-item--unverified'
                            : item.kind === 'override'
                              ? 'review-needs-you-item review-needs-you-item--failed'
                              : 'review-needs-you-item'
                        }
                        data-needs-kind={item.kind}
                      >
                        <div className="review-needs-you-head">
                          {item.kind === 'unverified' ? (
                            <span className="review-needs-you-mark" aria-hidden>
                              ❔
                            </span>
                          ) : item.kind === 'override' ? (
                            <span className="review-needs-you-mark" aria-hidden>
                              ❌
                            </span>
                          ) : null}
                          {humanRow ? (
                            <label className="human-ac-item">
                              <input
                                type="checkbox"
                                checked={humanChecked[humanRow.id] === true}
                                onChange={(e) =>
                                  setHumanChecked((prev) => ({
                                    ...prev,
                                    [humanRow.id]: e.target.checked,
                                  }))
                                }
                              />
                              <span>{item.text}</span>
                            </label>
                          ) : (
                            <strong>{item.text}</strong>
                          )}
                        </div>
                        <div className="review-needs-you-why muted">{item.why}</div>
                        <div className="review-needs-you-rec">{item.recommendation}</div>
                        {item.evidence ? (
                          <button
                            type="button"
                            className="review-needs-you-evidence"
                            data-evidence="review-needs-you-evidence"
                            onClick={() => {
                              if (
                                item.evidence &&
                                item.evidence.mediaIndex !== undefined &&
                                evidenceItems[item.evidence.mediaIndex]
                              ) {
                                setEvidenceOpenIndex(item.evidence.mediaIndex);
                                return;
                              }
                              if (item.evidence?.kind === 'cli') {
                                const el = document.querySelector(
                                  '[data-evidence="cli-evidence-receipt"]',
                                );
                                if (el instanceof HTMLElement) {
                                  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                }
                              }
                            }}
                          >
                            {item.evidence.label}
                          </button>
                        ) : null}
                        {fromCard?.unprovenUiWarning ? (
                          <div
                            className="human-ac-unproven"
                            data-evidence="human-ac-unproven"
                            role="status"
                          >
                            {fromCard.unprovenUiWarning}
                            {fromCard.unprovenUiReason ? (
                              <span className="muted"> — {fromCard.unprovenUiReason}</span>
                            ) : null}
                          </div>
                        ) : null}
                        {g?.how ? (
                          <div className="human-ac-how muted" data-evidence="human-ac-how">
                            核验: {g.how}
                          </div>
                        ) : null}
                        {g && g.refs.length > 0 ? (
                          <div className="human-ac-refs">
                            {g.refs.map((path) => (
                              <button
                                key={path}
                                type="button"
                                className="human-ac-ref-btn"
                                data-evidence="human-ac-ref"
                                onClick={() => openHumanAcRef(path)}
                              >
                                {path}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {action?.kind === 'mark-ready' && humanRow ? (
                          <button
                            type="button"
                            className="human-ac-action-btn"
                            data-evidence="human-ac-action"
                            disabled={
                              busy || humanAcActionBusy || humanChecked[humanRow.id] === true
                            }
                            onClick={() => runMarkReadyAction(humanRow.id)}
                          >
                            {humanAcActionBusy ? <span className="spinner" /> : action.label}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {humanAcDocPath !== null && (
              <div className="human-ac-doc" data-evidence="human-ac-doc">
                <div className="human-ac-doc-head">
                  <span className="body-label">{humanAcDocPath}</span>
                  <button
                    type="button"
                    className="seg-action"
                    onClick={() => {
                      setHumanAcDocPath(null);
                      setHumanAcDocContent(null);
                    }}
                  >
                    Close
                  </button>
                </div>
                {humanAcDocContent === null ? (
                  <span className="muted">Loading…</span>
                ) : humanAcDocPath.endsWith('.md') ? (
                  <Markdown text={humanAcDocContent} />
                ) : (
                  <pre className="task-file-pre">{humanAcDocContent}</pre>
                )}
              </div>
            )}
            {humanAcActionErr && (
              <div className="human-ac-action-err" data-evidence="human-ac-action-err">
                {humanAcActionErr}
              </div>
            )}
            {afterDeployACs.length > 0 && (
              <div className="human-ac-after-deploy muted" data-evidence="human-ac-after-deploy">
                <div className="body-label">{t(lang, 'humanAcAfterDeploy')}</div>
                <ul>
                  {afterDeployACs.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </div>
            )}

            {(verifyCrashed || !autoOk) && !criticalBlock && humanAllChecked && (
              <details
                className="proof-details override-approve"
                data-evidence="override-approve" open
              >
                <summary className="body-label">覆盖批准(操作员决定)</summary>
                <div className="muted">
                  机器检查未全绿时常规批准已锁定。写明理由后可覆盖批准（信任链会记录）。
                </div>
                <textarea
                  rows={2}
                  value={overrideNote}
                  placeholder="为什么在验证未全绿的情况下这个改动是安全的?(≥10 字)"
                  onChange={(e) => setOverrideNote(e.target.value)}
                />
                <button
                  className="danger"
                  disabled={busy || overrideNote.trim().length < 10}
                  onClick={() =>
                    onAction('approve', {
                      humanAcknowledged: acknowledgedHumanTexts,
                      overrideNote: overrideNote.trim(),
                    })
                  }
                >
                  覆盖批准 — 我对此负责
                </button>
                {overrideNote.trim().length < 10 && (
                  <span className="muted override-hint">输入 ≥10 字理由后按钮可用</span>
                )}
              </details>
            )}
          </div>
        )}

        {evidenceFirst ? (
          <div className="sheet-adaptive-band" data-evidence="sheet-adaptive-band">
            <TaskTiming task={task} now={now} />
            {showAdaptiveTimeline ? (
              <div {...orderStyle('run-timeline')}>
                <RunTimelinePanel
                  body={bodyText}
                  defaultOpen={defaultOpen('run-timeline', habits, false)}
                  dataSection="run-timeline"
                  onUserToggle={(open) => noteHabit('run-timeline', open ? 'open' : 'close')}
                  onContentClick={() => noteHabit('run-timeline', 'click')}
                />
              </div>
            ) : null}

            {showAdaptiveLive ? (
              <div
                className={`activity activity-panel activity-panel-live${
                  !verificationRun &&
                  liveRun?.processAlive === true &&
                  (liveRun.silenceMs ?? 0) >= 30_000
                    ? ' activity-panel-quiet'
                    : ''
                }`}
                data-evidence="live-activity"
                data-section="live-activity"
                {...orderStyle('live-activity')}
                onClick={() => noteHabit('live-activity', 'click')}
              >
                <div className="body-label activity-live-head">
                  <span>{verificationRun ? 'Verification' : 'Live activity'}</span>
                  {(() => {
                    const verifyPill = verifyStatusPill(verificationRun);
                    const pill = verifyPill ?? liveStatusPill(liveRun);
                    return (
                      <span className={pill.className} data-evidence="live-status-pill">
                        {pill.label}
                      </span>
                    );
                  })()}
                </div>
                <pre className="activity-log" ref={activityLogRef} data-evidence="live-activity-log">
                  {verificationRun
                    ? [
                        `Verifying: ${verificationRun.stage} (${verificationRun.phase})`,
                        verificationRun.processAlive
                          ? 'Gate/process is alive — cancel aborts the active command group.'
                          : 'Between gates / assembling packet…',
                        verificationRun.cancelRequested
                          ? 'Cancel requested — aborting verification…'
                          : 'Cancel or force-abort stops verification without waiting for cargo to finish.',
                        verificationRun.lastCompletedStage
                          ? `Last completed: ${verificationRun.lastCompletedStage}`
                          : null,
                        ...activity.slice(-40),
                      ]
                        .filter((line): line is string => Boolean(line))
                        .join('\n')
                    : activity.length > 0
                      ? activity.join('\n')
                      : 'Waiting for agent output…'}
                </pre>
                <div className="live-quick-actions" data-evidence="live-quick-actions">
                  {stopping ? (
                    <ConfirmButton
                      className="danger"
                      label="Force abort"
                      confirmLabel="Confirm force-abort?"
                      onConfirm={onForceAbort}
                      disabled={busy}
                      loading={pending === 'forceAbort'}
                      data-evidence="verify-force-abort"
                    />
                  ) : (
                    <ConfirmButton
                      className="danger"
                      label="Cancel"
                      confirmLabel="Confirm cancel?"
                      onConfirm={() => onAction('cancel')}
                      disabled={busy}
                      loading={pending === 'cancel'}
                      data-evidence="verify-cancel"
                    />
                  )}
                </div>
              </div>
            ) : null}

            {task.state === 'review' && !outcomeReviewOwnsTask ? (
              <details
                className="proof-details machine-details"
                data-evidence="machine-details"
                {...habitDetailsProps('machine-details', false)}
                {...orderStyle('machine-details')}
              >
                <summary className="body-label">机器检查明细</summary>
                {decisionCard ? (
                  <div className="decision-summary decision-card" data-evidence="decision-card">
                    {decisionCard.purpose && (
                      <div className="ds-row">
                        <span className="ds-k">目的</span>
                        {decisionCard.purpose}
                      </div>
                    )}
                    {decisionCard.reviewer.summaryZh && (
                      <div className="ds-row">
                        <span className="ds-k">改动</span>
                        {decisionCard.reviewer.summaryZh}
                      </div>
                    )}
                    <div className="ds-row">
                      <span className="ds-k">层面</span>
                      <span className="ds-chips">
                        {decisionCard.areas.map((a) => (
                          <span key={a.area} className="pill ds-area">
                            {AREA_ZH[a.area] ?? a.area} ×{a.count}
                          </span>
                        ))}
                        <span className="muted">共 {decisionCard.filesTouched} 文件</span>
                      </span>
                    </div>
                    <div className="ds-row ds-boundaries">
                      <span className="ds-k">边界</span>
                      <span className="ds-chips">
                        {boundaryBadges.map((b) => {
                          const labels = BOUNDARY_FACT_LABEL[b.key];
                          const fact = labels
                            ? b.warn
                              ? labels.warn
                              : labels.ok
                            : b.label;
                          return (
                            <button
                              key={b.key}
                              type="button"
                              className="pill ds-fact ds-badge-btn"
                              data-evidence={`boundary-badge-${b.key}`}
                              aria-expanded={openBoundary === b.key}
                              onClick={() =>
                                setOpenBoundary((prev) => (prev === b.key ? null : b.key))
                              }
                            >
                              {fact}
                            </button>
                          );
                        })}
                      </span>
                    </div>
                    {openBoundaryExplain && (
                      <div
                        className="ds-badge-detail ds-badge-detail-neutral"
                        data-evidence="boundary-badge-detail"
                      >
                        <div className="ds-badge-what">
                          <strong>判什么</strong>:{openBoundaryExplain.what}
                        </div>
                        <div className="ds-badge-actual">
                          <strong>本任务</strong>:
                          {openBoundaryExplain.actual.includes('\n') ? (
                            <pre className="ds-badge-commits">{openBoundaryExplain.actual}</pre>
                          ) : (
                            openBoundaryExplain.actual
                          )}
                        </div>
                      </div>
                    )}
                    {(decisionCard.reviewOnlyFlags?.length ?? 0) > 0 && (
                      <div className="ds-row" data-evidence="review-only-flags">
                        <span className="ds-k">反作弊</span>
                        <span className="ds-flags">
                          {decisionCard.reviewOnlyFlags.map((f) => {
                            const fact =
                              f.kind === 'test-edit'
                                ? '改了测试文件'
                                : f.kind === 'cross-task-commits'
                                  ? '分支含其他任务的提交'
                                  : f.meaningZh;
                            return (
                              <span key={f.kind} className="pill ds-fact">
                                {fact}
                              </span>
                            );
                          })}
                        </span>
                      </div>
                    )}
                    <div className="ds-row">
                      <span className="ds-k">验证</span>
                      <span className="ds-chips">
                        {(() => {
                          const counted = decisionCard.gates.filter((g) => !g.outcome);
                          const gatesOk = counted.every((g) => g.passed);
                          const pill =
                            counted.length === 0
                              ? 'pill ds-off'
                              : gatesOk
                                ? 'pill ds-ok'
                                : 'pill ds-warn';
                          return (
                            <span className={pill}>
                              门禁 {counted.filter((g) => g.passed).length}/{counted.length}
                            </span>
                          );
                        })()}
                        <span
                          className={
                            decisionCard.reviewer.approved
                              ? 'pill ds-ok'
                              : decisionCard.reviewer.ran
                                ? 'pill ds-fail'
                                : 'pill ds-off'
                          }
                        >
                          审稿{' '}
                          {decisionCard.reviewer.approved
                            ? '✓'
                            : decisionCard.reviewer.ran
                              ? '✗'
                              : '—'}
                        </span>
                        <span
                          className={
                            decisionCard.evidence.ok
                              ? 'pill ds-ok'
                              : decisionCard.evidence.ran
                                ? 'pill ds-fail'
                                : 'pill ds-off'
                          }
                        >
                          证据{' '}
                          {decisionCard.evidence.ok
                            ? `✓${decisionCard.evidence.steps}步`
                            : decisionCard.evidence.ran
                              ? '✗'
                              : '—'}
                        </span>
                      </span>
                    </div>
                    {costChip ? (
                      <div className="ds-row">
                        <span className="ds-k">成本</span>
                        <span className={`pill pill-cost pill-cost-${costChip.tone}`}>
                          {costChip.label}
                        </span>
                      </div>
                    ) : null}
                    {task.packetNonce ? (
                      <div className="ds-row">
                        <span className="ds-k">nonce</span>
                        <code className="muted">{task.packetNonce.slice(0, 12)}…</code>
                      </div>
                    ) : null}
                    <div className="ds-criteria">
                      <span className="ds-k">验收条件</span>
                      {decisionCard.criteria.map((c, i) => {
                        const kindLabel =
                          c.kind === 'checkpoint'
                            ? '检查点'
                            : c.kind === 'mechanical'
                              ? '机检'
                              : c.kind === 'reviewer'
                                ? '审稿'
                                : '人工';
                        return (
                          <div
                            key={i}
                            className={`ds-criterion ds-${c.status}${
                              c.kind === 'checkpoint' ? ' ds-human' : ''
                            }`}
                          >
                            {c.status === 'pass'
                              ? '✅'
                              : c.status === 'fail'
                                ? '❌'
                                : c.status === 'unverified'
                                  ? '❔'
                                  : '⏳'}{' '}
                            <span className="muted ds-kind">{kindLabel}</span>{' '}
                            <strong>{c.text}</strong>
                            {c.status === 'unverified' ? (
                              <span className="muted ds-unverified-label">
                                {' '}
                                无法自动核验，请人工确认
                              </span>
                            ) : null}
                            <div className="muted ds-why">
                              {c.status === 'pass'
                                ? `依据:${c.why}`
                                : c.status === 'unverified'
                                  ? c.why || '无法自动核验，请人工确认'
                                  : `未满足:${c.why}`}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {(decisionSummary || taskPurpose) && (
                  <div className="decision-summary" data-evidence="decision-summary">
                    {taskPurpose && (
                      <div className="ds-row">
                        <span className="ds-k">目的</span>
                        {taskPurpose}
                      </div>
                    )}
                    {decisionSummary && (
                      <>
                        <div className="ds-row">
                          <span className="ds-k">改动</span>
                          {decisionSummary.change}
                        </div>
                        <div className="ds-row">
                          <span className="ds-k">可信度</span>
                          {decisionSummary.trust}
                        </div>
                        <div className="ds-row">
                          <span className="ds-k">风险</span>
                          {decisionSummary.risk}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {failingGates.length > 0 && (
                  <div className="decide-why" data-evidence="decide-why">
                    <div className="ds-k">没全过的原因</div>
                    {failingGates.map((g) => (
                      <div key={g.name} className="decide-why-row">
                        <strong>{g.nameZh}</strong>:{g.reasonZh}
                      </div>
                    ))}
                    <div className="decide-why-options muted">
                      你的选项:<strong>覆盖批准</strong>(以你的判断放行,信任链记录)·
                      <strong>发一条 steer</strong>(让 agent 补齐缺项,再等一轮)·
                      <strong>Re-verify</strong>(环境性失败时重跑验证)。
                      批准 ≠ 部署:批准只是把改动送入待合并;上生产还需 staging
                      全机验证通过 + 你按 Promote。
                    </div>
                  </div>
                )}
                <div className="decide-status">
                  {statusChip ? (
                    <span className={`pill pill-tone-${statusChip.tone}`}>{statusChip.label}</span>
                  ) : null}
                  {costChip ? (
                    <span className={`pill pill-cost pill-cost-${costChip.tone}`}>
                      {costChip.label}
                    </span>
                  ) : null}
                </div>
              </details>
            ) : null}

            {packetDetailsText ? (
              <details
                className="proof-details"
                data-evidence="packet-details"
                {...habitDetailsProps('packet-details', false)}
                {...orderStyle('packet-details')}
              >
                <summary className="body-label">完整审核包</summary>
                <Markdown text={packetDetailsText} />
              </details>
            ) : null}

            {agentReportText ? (
              <details
                className="proof-details"
                data-evidence="agent-report"
                {...habitDetailsProps('agent-report', false)}
                {...orderStyle('agent-report')}
              >
                <summary className="body-label">Agent 报告</summary>
                <Markdown text={agentReportText} />
              </details>
            ) : null}

            <details
              className="proof-details"
              data-evidence="task-body"
              {...habitDetailsProps('task-body', false)}
              {...orderStyle('task-body')}
            >
              <summary className="body-label">任务说明</summary>
              {briefText.trim().length > 0 ? (
                <Markdown text={briefText} />
              ) : (
                <span className="muted">无任务说明</span>
              )}
            </details>

            {task.verifiedSha ? (
              <details
                className="proof-details"
                data-evidence="task-files"
                {...habitDetailsProps('files', false)}
                {...orderStyle('files')}
                onToggle={(e) => {
                  habitDetailsProps('files', false).onToggle(e);
                  if ((e.target as HTMLDetailsElement).open && taskFiles === null) {
                    void fetchTaskFiles(task.id)
                      .then((r) => setTaskFiles([...r.files]))
                      .catch(() => setTaskFiles([]));
                  }
                }}
              >
                <summary className="body-label">Browse changed files</summary>
                {taskFiles === null ? (
                  <span className="muted">Loading…</span>
                ) : taskFiles.length === 0 ? (
                  <span className="muted">No verified files to show.</span>
                ) : (
                  <div className="task-files-list">
                    {taskFiles.map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`task-file-row${activeFile === f ? ' is-active' : ''}`}
                        onClick={() => {
                          if (activeFile === f) {
                            setActiveFile(null);
                            return;
                          }
                          setActiveFile(f);
                          setFileContent(null);
                          void fetchTaskFile(task.id, f)
                            .then((r) =>
                              setFileContent(r.truncated ? `${r.content}\n\n…(truncated)` : r.content),
                            )
                            .catch((err) =>
                              setFileContent(
                                `(failed to load: ${err instanceof Error ? err.message : err})`,
                              ),
                            );
                        }}
                      >
                        {f}
                      </button>
                    ))}
                    {activeFile !== null && (
                      <div className="task-file-view" data-evidence="task-file-view">
                        {fileContent === null ? (
                          <span className="muted">Loading {activeFile}…</span>
                        ) : activeFile.endsWith('.md') ? (
                          <Markdown text={fileContent} />
                        ) : (
                          <pre className="task-file-pre">{fileContent}</pre>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </details>
            ) : null}

            {onRewireDependencies ? (
              <details
                className="task-secondary-details"
                data-evidence="dependency-rewire"
                data-testid="dependency-rewire"
                {...habitDetailsProps('dependencies', false)}
                {...orderStyle('dependencies')}
              >
                <summary className="body-label">Dependencies</summary>
                <label>
                  Dependency task IDs
                  <input
                    value={dependencyDraft}
                    disabled={busy}
                    placeholder="task-a, task-b (empty clears)"
                    onChange={(event) => setDependencyDraft(event.target.value)}
                  />
                </label>
                <label>
                  Dependency mode
                  <select
                    value={dependencyModeDraft}
                    disabled={busy}
                    onChange={(event) =>
                      setDependencyModeDraft(
                        event.target.value === 'completion_only'
                          ? 'completion_only'
                          : 'gate_merge',
                      )
                    }
                  >
                    <option value="gate_merge">Gate merge</option>
                    <option value="completion_only">Completion only</option>
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onRewireDependencies({
                      id: task.id,
                      expectedBlockedBy: [...task.blockedBy],
                      blockedBy: dependencyDraft
                        .split(',')
                        .map((id) => id.trim())
                        .filter(Boolean),
                      dependencyMode: dependencyModeDraft,
                    })
                  }
                >
                  {pending === 'dependencies' ? <span className="spinner" /> : 'Replace dependencies'}
                </button>
              </details>
            ) : null}

            <details
              className="task-secondary-details"
              {...habitDetailsProps('agent-picker', false)}
              {...orderStyle('agent-picker')}
            >
              <summary className="body-label">Agent for this task</summary>
              <label className="task-agent-field">
                Agent
                <select
                  value={pendingAdapter ?? selectValue}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPendingAdapter(null);
                    onSetAdapter(v === '' ? null : (v as AdapterKind));
                  }}
                >
                  <option value="">Inherit → {inheritAgent}</option>
                  {availableAgents.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <span className="muted task-agent-hint">
                  Applies on the next dispatch of this task.
                </span>
              </label>
            </details>

            {canChat ? (
              <div
                className="task-chat-panel"
                data-evidence="task-chat-panel"
                data-section="chat"
                {...orderStyle('chat')}
                onClick={() => noteHabit('chat', 'click')}
              >
                <div className="body-label">Remote Control</div>
                {chatOutcome ? (
                  <div className="muted chat-outcome" data-evidence="chat-outcome">
                    {chatOutcome}
                  </div>
                ) : null}
                {pendingChat.length > 0 && (
                  <div className="muted chat-queued" data-evidence="chat-queued">
                    Queued ({pendingChat.length}): will auto-send when this turn ends
                    {pendingChat.map((q, i) => (
                      <div key={i} className="chat-text">
                        → {q.slice(0, 120)}
                        {q.length > 120 ? '…' : ''}
                      </div>
                    ))}
                  </div>
                )}
                <button type="button" className="primary" disabled={busy} onClick={onOpenLive}>
                  {pending === 'live' ? (
                    <span className="spinner" />
                  ) : (
                    'Open session (steer / attach / voice)'
                  )}
                </button>
                <span className="muted task-agent-hint">
                  Full Session UI: multiline, attachments, voice, task refs, diff. Messages queue or
                  steer this task.
                </span>
                <details className="task-chat-quick">
                  <summary className="muted">Quick text (optional)</summary>
                  <label>
                    <textarea
                      value={chatText}
                      disabled={busy}
                      rows={3}
                      placeholder="Short follow-up without opening session…"
                      onChange={(e) => setChatText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          const m = chatText.trim();
                          if (m) {
                            setChatText('');
                            onChat(m);
                          }
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || chatText.trim().length === 0}
                    onClick={() => {
                      const m = chatText.trim();
                      setChatText('');
                      onChat(m);
                    }}
                  >
                    {pending === 'chat' ? <span className="spinner" /> : 'Send quick'}
                  </button>
                </details>
              </div>
            ) : null}

            {!outcomeReviewOwnsTask ? (
              <div
                className="actions"
                data-evidence="legacy-task-actions"
                data-section="actions"
                {...orderStyle('actions')}
                onClick={() => noteHabit('actions', 'click')}
              >
                {task.state === 'review' && canPr && (
                  <button disabled={busy} onClick={onOpenPr} data-evidence="task-open-pr">
                    {pending === 'pr' ? <span className="spinner" /> : 'Open PR only'}
                  </button>
                )}
                {task.state === 'failed' && (
                  <button disabled={busy} onClick={onReverify} title="Re-run verification only">
                    {pending === 'reverify' ? <span className="spinner" /> : 'Re-verify'}
                  </button>
                )}
                {task.state === 'done' && canPr && (
                  <button className="primary" disabled={busy} onClick={onOpenPr}>
                    {pending === 'pr' ? <span className="spinner" /> : 'Open PR'}
                  </button>
                )}
                {task.state === 'failed' && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => onAction('retry')}
                    data-evidence="task-retry"
                    title="Reset attempts and reuse the preserved hercules/<id> branch"
                  >
                    {pending === 'retry' ? <span className="spinner" /> : 'Retry'}
                  </button>
                )}
                {canSalvageFork && onSalvageFork ? (
                  <ConfirmButton
                    className="secondary"
                    label="Clean salvage"
                    confirmLabel="Fork new task from tip?"
                    onConfirm={onSalvageFork}
                    disabled={busy}
                    loading={pending === 'salvageFork'}
                    data-evidence="salvage-fork"
                  />
                ) : null}
                {stopping ? (
                  <>
                    <span className="muted">stopping…</span>
                    <ConfirmButton
                      className="danger"
                      label="Force abort"
                      confirmLabel="Confirm force-abort?"
                      onConfirm={onForceAbort}
                      disabled={busy}
                      loading={pending === 'forceAbort'}
                    />
                  </>
                ) : null}
                {(task.state === 'done' || task.state === 'cancelled') && (
                  <button disabled={busy} onClick={onClone}>
                    Clone
                  </button>
                )}
                <QueueFrontButton
                  task={task}
                  busy={busy}
                  pending={pending}
                  onQueueFront={onQueueFront}
                />
                <div className="delete-task-block">
                  <span className="muted task-agent-hint delete-hint">
                    Delete file only, or clean PR / branch / worktree / screenshots too.
                  </span>
                  <div className="delete-actions-row">
                    <ConfirmButton
                      className="danger"
                      label="Delete"
                      confirmLabel="Delete file only?"
                      onConfirm={() => onDelete(false)}
                      disabled={busy}
                      loading={pending === 'delete'}
                    />
                    <ConfirmButton
                      className="danger"
                      label="Delete & clean"
                      confirmLabel="Delete + clean artifacts?"
                      onConfirm={() => onDelete(true)}
                      disabled={busy}
                      loading={pending === 'delete'}
                    />
                  </div>
                </div>
                <button type="button" onClick={onClose}>
                  {closeLabel}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <>
        {/* Agent picker: secondary while running (live is primary). */}
        <details className="task-secondary-details" open={task.state !== 'in_progress'}>
          <summary className="body-label">
            {task.state === 'in_progress' ? 'Agent / controls (expand)' : 'Agent for this task'}
          </summary>
          <label className="task-agent-field">
            Agent
            <select
              value={pendingAdapter ?? selectValue}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value;
                if (task.state === 'in_progress') {
                  setPendingAdapter(v);
                  return;
                }
                setPendingAdapter(null);
                onSetAdapter(v === '' ? null : (v as AdapterKind));
              }}
            >
              <option value="">Inherit → {inheritAgent}</option>
              {availableAgents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            {task.state === 'in_progress' && pendingAdapter !== null ? (
              <div className="switch-timing">
                <span className="muted task-agent-hint">
                  Switch to{' '}
                  <strong>
                    {pendingAdapter === '' ? `inherit (${inheritAgent})` : pendingAdapter}
                  </strong>
                  . Live agent keeps running until you pick:
                </span>
                <div className="switch-timing-row">
                  <button
                    type="button"
                    className="seg-action"
                    disabled={busy}
                    onClick={() => {
                      const v = pendingAdapter;
                      setPendingAdapter(null);
                      onSetAdapter(v === '' ? null : (v as AdapterKind));
                    }}
                  >
                    {pending === 'adapter' ? <span className="spinner" /> : 'Later'}
                    <span className="seg-action-hint">next dispatch</span>
                  </button>
                  <ConfirmButton
                    className="primary seg-action-confirm"
                    label={
                      <>
                        Now
                        <span className="seg-action-hint">stop & re-queue</span>
                      </>
                    }
                    confirmLabel="Stop live & re-queue?"
                    disabled={busy}
                    loading={pending === 'switchNow'}
                    onConfirm={() => {
                      const v = pendingAdapter;
                      setPendingAdapter(null);
                      onSetAdapter(v === '' ? null : (v as AdapterKind), { switchNow: true });
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() => setPendingAdapter(null)}
                >
                  Revert selection
                </button>
              </div>
            ) : (
              <span className="muted task-agent-hint">
                {task.state === 'in_progress'
                  ? 'Change agent → Later (soft) or Now (stop live + re-queue).'
                  : 'Applies on the next dispatch of this task.'}
              </span>
            )}
          </label>
        </details>

        {task.state !== 'in_progress' && onRewireDependencies && (
          <details className="task-secondary-details" data-evidence="dependency-rewire" data-testid="dependency-rewire" data-section="dependencies">
            <summary className="body-label">Dependencies</summary>
            <label>
              Dependency task IDs
              <input
                value={dependencyDraft}
                disabled={busy}
                placeholder="task-a, task-b (empty clears)"
                onChange={(event) => setDependencyDraft(event.target.value)}
              />
            </label>
            <label>
              Dependency mode
              <select
                value={dependencyModeDraft}
                disabled={busy}
                onChange={(event) => setDependencyModeDraft(
                  event.target.value === 'completion_only' ? 'completion_only' : 'gate_merge',
                )}
              >
                <option value="gate_merge">Gate merge</option>
                <option value="completion_only">Completion only</option>
              </select>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => onRewireDependencies({
                id: task.id,
                expectedBlockedBy: [...task.blockedBy],
                blockedBy: dependencyDraft.split(',').map((id) => id.trim()).filter(Boolean),
                dependencyMode: dependencyModeDraft,
              })}
            >
              {pending === 'dependencies' ? <span className="spinner" /> : 'Replace dependencies'}
            </button>
          </details>
        )}

        {/* Browse what the run actually produced (trusted mirror @ verified
            sha). Human ACs like "spot-check docs quality" need readable
            content, not just a files list. */}
        {task.verifiedSha ? (
          <details
            className="proof-details"
            data-evidence="task-files"
            data-section="files"
            onToggle={(e) => {
              if ((e.target as HTMLDetailsElement).open && taskFiles === null) {
                void fetchTaskFiles(task.id)
                  .then((r) => setTaskFiles([...r.files]))
                  .catch(() => setTaskFiles([]));
              }
            }}
          >
            <summary className="body-label">Browse changed files</summary>
            {taskFiles === null ? (
              <span className="muted">Loading…</span>
            ) : taskFiles.length === 0 ? (
              <span className="muted">No verified files to show.</span>
            ) : (
              <div className="task-files-list">
                {taskFiles.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`task-file-row${activeFile === f ? ' is-active' : ''}`}
                    onClick={() => {
                      if (activeFile === f) {
                        setActiveFile(null);
                        return;
                      }
                      setActiveFile(f);
                      setFileContent(null);
                      void fetchTaskFile(task.id, f)
                        .then((r) =>
                          setFileContent(r.truncated ? `${r.content}\n\n…(truncated)` : r.content),
                        )
                        .catch((e) =>
                          setFileContent(`(failed to load: ${e instanceof Error ? e.message : e})`),
                        );
                    }}
                  >
                    {f}
                  </button>
                ))}
                {activeFile !== null && (
                  <div className="task-file-view" data-evidence="task-file-view">
                    {fileContent === null ? (
                      <span className="muted">Loading {activeFile}…</span>
                    ) : activeFile.endsWith('.md') ? (
                      <Markdown text={fileContent} />
                    ) : (
                      <pre className="task-file-pre">{fileContent}</pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </details>
        ) : null}

        {/* Body: collapsed while running/review so the primary surface stays on screen. */}
        <details
          className="proof-details"
          open={task.state !== 'review' && task.state !== 'in_progress'}
        >
          <summary className="body-label">
            {task.state === 'review'
              ? 'Proof (expand)'
              : task.state === 'in_progress'
                ? 'Task body (expand)'
                : 'Task body'}
          </summary>
          <TaskBodyView body={task.body || ''} packetNonce={task.packetNonce} />
        </details>

        {canChat && task.state !== 'in_progress' && (
          <div className="task-chat-panel" data-evidence="task-chat-panel" data-section="chat">
            <div className="body-label">Remote Control</div>
            {chatOutcome ? (
              <div className="muted chat-outcome" data-evidence="chat-outcome">
                {chatOutcome}
              </div>
            ) : null}
            {pendingChat.length > 0 && (
              <div className="muted chat-queued" data-evidence="chat-queued">
                Queued ({pendingChat.length}): will auto-send when this turn ends
                {pendingChat.map((q, i) => (
                  <div key={i} className="chat-text">
                    → {q.slice(0, 120)}
                    {q.length > 120 ? '…' : ''}
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="primary" disabled={busy} onClick={onOpenLive}>
              {pending === 'live' ? (
                <span className="spinner" />
              ) : (
                'Open session (steer / attach / voice)'
              )}
            </button>
            <span className="muted task-agent-hint">
              Full Session UI: multiline, attachments, voice, task refs, diff. Messages queue or
              steer this task.
            </span>
            <details className="task-chat-quick">
              <summary className="muted">Quick text (optional)</summary>
              <label>
                <textarea
                  value={chatText}
                  disabled={busy}
                  rows={3}
                  placeholder="Short follow-up without opening session…"
                  onChange={(e) => setChatText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      const m = chatText.trim();
                      if (m) {
                        setChatText('');
                        onChat(m);
                      }
                    }
                  }}
                />
              </label>
              <button
                type="button"
                disabled={busy || chatText.trim().length === 0}
                onClick={() => {
                  const m = chatText.trim();
                  setChatText('');
                  onChat(m);
                }}
              >
                {pending === 'chat' ? <span className="spinner" /> : 'Send quick'}
              </button>
            </details>
          </div>
        )}

        {/* While running: queued chat + quick steer under live (not buried). */}
        {task.state === 'in_progress' && (
          <div className="task-chat-panel task-chat-while-live" data-evidence="task-chat-panel" data-section="chat">
            {chatOutcome ? (
              <div className="muted chat-outcome" data-evidence="chat-outcome">
                {chatOutcome}
              </div>
            ) : null}
            {pendingChat.length > 0 && (
              <div className="muted chat-queued" data-evidence="chat-queued">
                Queued ({pendingChat.length}): auto-send when this turn ends
                {pendingChat.map((q, i) => (
                  <div key={i} className="chat-text">
                    → {q.slice(0, 120)}
                    {q.length > 120 ? '…' : ''}
                  </div>
                ))}
              </div>
            )}
            <details className="task-chat-quick">
              <summary className="muted">Queue a follow-up while running</summary>
              <label>
                <textarea
                  value={chatText}
                  disabled={busy}
                  rows={2}
                  placeholder="Will send when this turn ends…"
                  onChange={(e) => setChatText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      const m = chatText.trim();
                      if (m) {
                        setChatText('');
                        onChat(m);
                      }
                    }
                  }}
                />
              </label>
              <button
                type="button"
                disabled={busy || chatText.trim().length === 0}
                onClick={() => {
                  const m = chatText.trim();
                  setChatText('');
                  onChat(m);
                }}
              >
                {pending === 'chat' ? <span className="spinner" /> : 'Queue'}
              </button>
            </details>
          </div>
        )}

        {!outcomeReviewOwnsTask ? (
          <div className="actions" data-evidence="legacy-task-actions" data-section="actions">
          {task.state === 'review' && canPr && (
            <button disabled={busy} onClick={onOpenPr} data-evidence="task-open-pr">
              {pending === 'pr' ? <span className="spinner" /> : 'Open PR only'}
            </button>
          )}
          {task.state === 'failed' && (
            <button disabled={busy} onClick={onReverify} title="Re-run verification only">
              {pending === 'reverify' ? <span className="spinner" /> : 'Re-verify'}
            </button>
          )}
          {task.state === 'done' && canPr && (
            <button className="primary" disabled={busy} onClick={onOpenPr}>
              {pending === 'pr' ? <span className="spinner" /> : 'Open PR'}
            </button>
          )}
          {task.state === 'failed' && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => onAction('retry')}
              data-evidence="task-retry"
              title="Reset attempts and reuse the preserved hercules/<id> branch"
            >
              {pending === 'retry' ? <span className="spinner" /> : 'Retry'}
            </button>
          )}
          {canSalvageFork && onSalvageFork ? (
            <ConfirmButton
              className="secondary"
              label="Clean salvage"
              confirmLabel="Fork new task from tip?"
              onConfirm={onSalvageFork}
              disabled={busy}
              loading={pending === 'salvageFork'}
              data-evidence="salvage-fork"
            />
          ) : null}
          {/* Cancel/Force for running tasks live in the sticky Live panel (not buried). */}
          {task.state !== 'in_progress' && stopping ? (
            <>
              <span className="muted">stopping…</span>
              <ConfirmButton
                className="danger"
                label="Force abort"
                confirmLabel="Confirm force-abort?"
                onConfirm={onForceAbort}
                disabled={busy}
                loading={pending === 'forceAbort'}
              />
            </>
          ) : null}
          {task.state !== 'in_progress' &&
            !stopping &&
            ['todo', 'retrying'].includes(task.state) && (
              <ConfirmButton
                className="danger"
                label="Cancel"
                confirmLabel="Confirm cancel?"
                onConfirm={() => onAction('cancel')}
                disabled={busy}
                loading={pending === 'cancel'}
              />
            )}
          {(task.state === 'done' || task.state === 'cancelled') && (
            <button disabled={busy} onClick={onClone}>
              Clone
            </button>
          )}
          <QueueFrontButton task={task} busy={busy} pending={pending} onQueueFront={onQueueFront} />
          {task.state !== 'in_progress' && task.state !== 'retrying' && (
            <div className="delete-task-block">
              <span className="muted task-agent-hint delete-hint">
                Delete file only, or clean PR / branch / worktree / screenshots too.
              </span>
              <div className="delete-actions-row">
                <ConfirmButton
                  className="danger"
                  label="Delete"
                  confirmLabel="Delete file only?"
                  onConfirm={() => onDelete(false)}
                  disabled={busy}
                  loading={pending === 'delete'}
                />
                <ConfirmButton
                  className="danger"
                  label="Delete & clean"
                  confirmLabel="Delete + clean artifacts?"
                  onConfirm={() => onDelete(true)}
                  disabled={busy}
                  loading={pending === 'delete'}
                />
              </div>
            </div>
          )}
          <button type="button" onClick={onClose}>
            {closeLabel}
          </button>
          </div>
        ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** States where a human may create or revise host/deploy command approval. */
function canApproveHostOperation(task: Task): boolean {
  const klass = task.executionClass;
  if (klass !== 'host_operation' && klass !== 'deploy') return false;
  if (task.state !== 'todo' && task.state !== 'retrying' && task.state !== 'failed') {
    return false;
  }
  return true;
}
