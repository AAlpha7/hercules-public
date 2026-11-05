import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  addRepo,
  checkRepoReadiness,
  createPipeline,
  editRepo,
  fetchRepoDoc,
  fetchRepoDocs,
  fetchRepoReadinessCheck,
  removeRepo,
  startRepoReadinessCheck,
  type AdapterKind,
  type ReadinessCheckDto,
  type ReadinessJobDto,
  type RepoDto,
  type Task,
} from './api.js';
import { draftReadinessPipeline, taskHasOnboardingLabel } from '../domain/onboarding.js';
import {
  filterDocsByQuery,
  splitRepoDocEntrypoints,
} from '../domain/repoDocs.js';
import { ConfirmButton } from './ConfirmButton.js';
import { Markdown } from './Markdown.js';
import { SuccessionPanel } from './SuccessionPanel.js';

/** Mutable so render tests can shrink the poll window without fake timers. */
export const readinessCheckConfig = {
  pollMs: 3_000,
  waitCapMs: 15 * 60_000,
};
const READINESS_FRESH_MS = 10 * 60_000;

function readinessAgeLabel(iso: string | undefined, nowMs: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function isFreshOkResult(
  job: ReadinessJobDto | undefined,
  nowMs: number,
): ReadinessCheckDto | null {
  if (!job || job.status !== 'done' || !job.result?.ok || !job.finishedAt) return null;
  const finished = Date.parse(job.finishedAt);
  if (!Number.isFinite(finished)) return null;
  if (nowMs - finished > READINESS_FRESH_MS) return null;
  return job.result;
}

const ADAPTER_OPTIONS = [
  { value: '', label: 'Default (daemon)' },
  { value: 'grok', label: 'Grok Build' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor Cloud Agent' },
  { value: 'fake', label: 'Fake (dry-run)' },
] as const;

/** Onboarding still in flight (not finished/cancelled/deleted). */
const ACTIVE_ONBOARD_STATES = new Set([
  'todo',
  'in_progress',
  'retrying',
  'review',
  'failed',
]);

interface EditState {
  url: string;
  defaultBranch: string;
  workflow: string;
  maxConcurrent: string;
  /** Empty string = inherit daemon default. */
  adapter: string;
  readiness: 'ready' | 'incomplete';
  policyProfile: 'compatible' | 'guardian';
  autoMergeEnabled: boolean;
  autoMergeDwell: string;
  autoMergeMaxSize: 'S' | 'M' | 'L';
}

function initEdit(r: RepoDto): EditState {
  return {
    url: r.url,
    defaultBranch: r.defaultBranch,
    workflow: r.workflow,
    maxConcurrent: String(r.maxConcurrent),
    adapter: r.adapter ?? '',
    readiness: r.readiness === 'incomplete' ? 'incomplete' : 'ready',
    policyProfile: r.executionPolicy?.profile === 'guardian' ? 'guardian' : 'compatible',
    autoMergeEnabled: r.autoMerge?.enabled ?? false,
    autoMergeDwell: String(r.autoMerge?.dwellMinutes ?? 30),
    autoMergeMaxSize: r.autoMerge?.maxSize ?? 'M',
  };
}

function agentBadge(r: RepoDto): string {
  if (r.adapter) return r.adapter;
  return `default→${r.effectiveAdapter}`;
}

/** Latest active onboarding/readiness task for a repo, if any. */
export function activeOnboardingTask(
  tasks: readonly Task[],
  repoKey: string,
): Task | null {
  const hits = tasks.filter(
    (t) =>
      t.repo === repoKey &&
      ACTIVE_ONBOARD_STATES.has(t.state) &&
      taskHasOnboardingLabel(t.labels),
  );
  if (hits.length === 0) return null;
  // Prefer plan_pending / todo, then newest lastEventAt.
  hits.sort((a, b) => {
    if (a.planPending !== b.planPending) return a.planPending ? -1 : 1;
    const ta = Date.parse(a.lastEventAt ?? a.createdAt ?? '') || 0;
    const tb = Date.parse(b.lastEventAt ?? b.createdAt ?? '') || 0;
    return tb - ta;
  });
  return hits[0] ?? null;
}

export function ReposPanel({
  repos,
  tasks = [],
  defaultAgent,
  availableAgents,
  onClose,
  onError,
  onChanged,
  onOpenTask,
  successionRefreshKey,
}: {
  repos: RepoDto[];
  /** Live tasks — used to show onboarding-in-progress and block multi-create. */
  tasks?: readonly Task[];
  defaultAgent: string;
  availableAgents: readonly string[];
  onClose: () => void;
  onError: (msg: string) => void;
  /** Called after successful mutate so parent can refresh SSE/state. */
  onChanged?: () => void;
  /** Open a task sheet (e.g. after Start onboarding). Prefer passing the task when known. */
  onOpenTask?: (taskId: string, task?: Task) => void;
  /** Runtime sequence; receipt fetches repeat after same-page merge/stamp advances. */
  successionRefreshKey?: string | number;
}): JSX.Element {
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [addAdapter, setAddAdapter] = useState('');
  const [addPolicyProfile, setAddPolicyProfile] = useState<'compatible' | 'guardian'>('compatible');
  /** Per-action busy key so multi-tap on one repo does not re-fire. */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({
    url: '',
    defaultBranch: '',
    workflow: '',
    maxConcurrent: '',
    adapter: '',
    readiness: 'incomplete',
    policyProfile: 'compatible',
    autoMergeEnabled: false,
    autoMergeDwell: '30',
    autoMergeMaxSize: 'M',
  });
  /** Per-repo soft checklist from last completed readiness job (never flips readiness). */
  const [probeByRepo, setProbeByRepo] = useState<Record<string, ReadinessCheckDto>>({});
  const [probeOpenKey, setProbeOpenKey] = useState<string | null>(null);
  /** Per-repo readiness job poll state (does not use page-wide busy). */
  const [jobByRepo, setJobByRepo] = useState<Record<string, ReadinessJobDto>>({});
  /** Show explicit force-ready after check error/timeout (never auto force). */
  const [forceOfferByRepo, setForceOfferByRepo] = useState<Record<string, string>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** Per-repo background poll; stores interval id + generation it belongs to. */
  const readinessPollRef = useRef<
    Map<string, { id: ReturnType<typeof setInterval>; gen: number }>
  >(new Map());
  /** Panel still mounted — gate all readiness async continuations. */
  const mountedRef = useRef(true);
  /** Per-repo generation; bump on new check / unmount to drop stale work. */
  const readinessGenRef = useRef<Map<string, number>>(new Map());
  /** Per-repo abort for in-flight readiness GETs (deadline + unmount). */
  const readinessAbortRef = useRef<Map<string, AbortController>>(new Map());
  /** Mark-ready in flight for a repo (second click is a no-op). */
  const markInFlightRef = useRef<Set<string>>(new Set());
  const [markBusyByRepo, setMarkBusyByRepo] = useState<Record<string, true>>({});
  /** Per-repo docs list (null = not loaded yet for this open session). */
  const [docsByRepo, setDocsByRepo] = useState<Record<string, string[] | null>>({});
  const [docsOpenKey, setDocsOpenKey] = useState<string | null>(null);
  const [activeDoc, setActiveDoc] = useState<{ repo: string; path: string } | null>(null);
  const [docContent, setDocContent] = useState<string | null>(null);
  /** "All docs" section starts collapsed so large repos show entry pins first. */
  const [docsAllExpanded, setDocsAllExpanded] = useState(false);
  const [docsSearch, setDocsSearch] = useState('');
  const docViewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const polls = readinessPollRef.current;
    const aborts = readinessAbortRef.current;
    const gens = readinessGenRef.current;
    return () => {
      mountedRef.current = false;
      for (const entry of polls.values()) clearInterval(entry.id);
      polls.clear();
      for (const ac of aborts.values()) ac.abort();
      aborts.clear();
      for (const key of [...gens.keys()]) {
        gens.set(key, (gens.get(key) ?? 0) + 1);
      }
    };
  }, []);

  const stopReadinessPoll = (repoKey: string): void => {
    const entry = readinessPollRef.current.get(repoKey);
    if (entry !== undefined) {
      clearInterval(entry.id);
      readinessPollRef.current.delete(repoKey);
    }
  };

  const isReadinessCurrent = (repoKey: string, gen: number): boolean =>
    mountedRef.current && readinessGenRef.current.get(repoKey) === gen;

  const applyJobSnapshot = (repoKey: string, job: ReadinessJobDto): void => {
    if (!mountedRef.current) return;
    setJobByRepo((prev) => ({ ...prev, [repoKey]: job }));
    if (job.result) {
      setProbeByRepo((prev) => ({ ...prev, [repoKey]: job.result! }));
      setProbeOpenKey(repoKey);
    }
  };

  const startReadinessPoll = (repoKey: string, gen?: number): void => {
    if (!mountedRef.current) return;
    const pollGen = gen ?? readinessGenRef.current.get(repoKey) ?? 0;
    const existing = readinessPollRef.current.get(repoKey);
    // Only no-op when an interval for THIS generation is already running.
    // A newer generation must replace the old interval synchronously.
    if (existing !== undefined && existing.gen === pollGen) return;
    if (existing !== undefined) stopReadinessPoll(repoKey);

    const tick = (): void => {
      if (!isReadinessCurrent(repoKey, pollGen)) {
        stopReadinessPoll(repoKey);
        return;
      }
      void fetchRepoReadinessCheck(repoKey)
        .then((job) => {
          if (!isReadinessCurrent(repoKey, pollGen)) return;
          applyJobSnapshot(repoKey, job);
          if (job.status === 'done' || job.status === 'error') {
            stopReadinessPoll(repoKey);
            if (job.status === 'done' && job.result) {
              setFlash(
                job.result.ok
                  ? `${repoKey}: ${job.result.summary} (human still marks ready)`
                  : `${repoKey}: ${job.result.summary}`,
              );
            } else if (job.status === 'error') {
              setFlash(`${repoKey}: check failed — ${job.error ?? 'unknown error'}`);
            }
          }
        })
        .catch((err) => {
          if (!isReadinessCurrent(repoKey, pollGen)) return;
          onError(err instanceof Error ? err.message : String(err));
        });
    };
    tick();
    // POST may resolve after unmount — never install an orphan interval.
    if (!mountedRef.current || !isReadinessCurrent(repoKey, pollGen)) return;
    // A concurrent start for the same gen may have won the race.
    const raced = readinessPollRef.current.get(repoKey);
    if (raced !== undefined && raced.gen === pollGen) return;
    if (raced !== undefined) stopReadinessPoll(repoKey);
    readinessPollRef.current.set(repoKey, {
      id: setInterval(tick, readinessCheckConfig.pollMs),
      gen: pollGen,
    });
  };

  type BeginReadinessResult =
    | { kind: 'started'; gen: number; started: { key: string; status: 'running'; startedAt: string } }
    | { kind: 'cancelled' };

  /**
   * POST start (dedupe) + poll; never sets page-wide busy. Returns the
   * generation the POST belonged to so callers wait on THAT run; a failure
   * after unmount / supersession is reported as `cancelled`, never as a
   * synthetic success (round-8c regression).
   */
  const beginReadinessCheck = async (
    repoKey: string,
    opts: { retryCliEvidence?: boolean } = {},
  ): Promise<BeginReadinessResult> => {
    const gen = (readinessGenRef.current.get(repoKey) ?? 0) + 1;
    readinessGenRef.current.set(repoKey, gen);
    let started: { key: string; status: 'running'; startedAt: string };
    try {
      started = await startRepoReadinessCheck(repoKey, {
        ...(opts.retryCliEvidence ? { retryCliEvidence: true } : {}),
      });
    } catch (err) {
      // N3: late POST failure after unmount / superseded gen must not surface.
      if (!mountedRef.current || !isReadinessCurrent(repoKey, gen)) {
        return { kind: 'cancelled' };
      }
      throw err;
    }
    if (!isReadinessCurrent(repoKey, gen)) return { kind: 'cancelled' };
    setJobByRepo((prev) => ({
      ...prev,
      [repoKey]: {
        key: repoKey,
        status: 'running',
        startedAt: started.startedAt,
        ...(prev[repoKey]?.result ? { result: prev[repoKey]!.result } : {}),
        ...(prev[repoKey]?.finishedAt ? { finishedAt: prev[repoKey]!.finishedAt } : {}),
      },
    }));
    setForceOfferByRepo((prev) => {
      if (!prev[repoKey]) return prev;
      const next = { ...prev };
      delete next[repoKey];
      return next;
    });
    startReadinessPoll(repoKey, gen);
    return { kind: 'started', gen, started };
  };

  type WaitReadinessResult = {
    outcome: 'done' | 'error' | 'timeout' | 'cancelled';
    job?: ReadinessJobDto;
  };

  /** Wait until job leaves running, or waitCapMs — even if a GET is stalled. */
  const waitForReadinessJob = async (
    repoKey: string,
    gen: number,
  ): Promise<WaitReadinessResult> => {
    readinessAbortRef.current.get(repoKey)?.abort();
    const ac = new AbortController();
    readinessAbortRef.current.set(repoKey, ac);

    let timedOut = false;
    let resolveDeadline!: () => void;
    const deadlinePromise = new Promise<void>((resolve) => {
      resolveDeadline = resolve;
    });
    const deadlineId = window.setTimeout(() => {
      timedOut = true;
      ac.abort();
      resolveDeadline();
    }, readinessCheckConfig.waitCapMs);

    const finishTimeout = (): WaitReadinessResult => {
      if (isReadinessCurrent(repoKey, gen)) startReadinessPoll(repoKey, gen);
      return { outcome: 'timeout' };
    };

    try {
      for (;;) {
        if (!isReadinessCurrent(repoKey, gen)) return { outcome: 'cancelled' };
        if (timedOut) return finishTimeout();

        type Step =
          | { kind: 'job'; job: ReadinessJobDto }
          | { kind: 'timeout' };

        const fetchStep: Promise<Step> = fetchRepoReadinessCheck(repoKey, {
          signal: ac.signal,
        }).then(
          (job) => ({ kind: 'job' as const, job }),
          (err: unknown) => {
            if (timedOut || ac.signal.aborted) return { kind: 'timeout' as const };
            throw err;
          },
        );
        const deadlineStep: Promise<Step> = deadlinePromise.then(() => ({
          kind: 'timeout' as const,
        }));

        const step = await Promise.race([fetchStep, deadlineStep]);
        if (!isReadinessCurrent(repoKey, gen)) return { outcome: 'cancelled' };
        if (step.kind === 'timeout' || timedOut) {
          // Late completion after the cap may still update displayed job state.
          void fetchStep.then(
            (late) => {
              if (late.kind === 'job' && isReadinessCurrent(repoKey, gen)) {
                applyJobSnapshot(repoKey, late.job);
              }
            },
            () => {
              /* aborted or failed after deadline — ignore */
            },
          );
          return finishTimeout();
        }

        applyJobSnapshot(repoKey, step.job);
        if (step.job.status === 'done') return { outcome: 'done', job: step.job };
        if (step.job.status === 'error') return { outcome: 'error', job: step.job };

        const slept = await new Promise<'ok' | 'timeout' | 'cancelled'>((resolve) => {
          if (!isReadinessCurrent(repoKey, gen)) {
            resolve('cancelled');
            return;
          }
          if (timedOut || ac.signal.aborted) {
            resolve('timeout');
            return;
          }
          const t = window.setTimeout(() => resolve('ok'), readinessCheckConfig.pollMs);
          const onAbort = (): void => {
            window.clearTimeout(t);
            resolve(isReadinessCurrent(repoKey, gen) ? 'timeout' : 'cancelled');
          };
          ac.signal.addEventListener('abort', onAbort, { once: true });
        });
        if (slept === 'cancelled' || !isReadinessCurrent(repoKey, gen)) {
          return { outcome: 'cancelled' };
        }
        if (slept === 'timeout' || timedOut) return finishTimeout();
      }
    } finally {
      window.clearTimeout(deadlineId);
      if (readinessAbortRef.current.get(repoKey) === ac) {
        readinessAbortRef.current.delete(repoKey);
      }
    }
  };

  const onboardByRepo = useMemo(() => {
    const map = new Map<string, Task>();
    for (const r of repos) {
      const t = activeOnboardingTask(tasks, r.key);
      if (t) map.set(r.key, t);
    }
    return map;
  }, [repos, tasks]);

  const busy = busyKey !== null;

  const run = async (actionKey: string, fn: () => Promise<unknown>): Promise<void> => {
    if (busyKey) return;
    setBusyKey(actionKey);
    try {
      await fn();
      onChanged?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const openEdit = (r: RepoDto): void => {
    setEditingKey(r.key);
    setEditState(initEdit(r));
  };

  const closeEdit = (): void => {
    setEditingKey(null);
  };

  const submitEdit = (repoKey: string): void => {
    const {
      url: eUrl,
      defaultBranch: eBranch,
      workflow: eWorkflow,
      maxConcurrent: eMc,
      adapter: eAd,
      readiness: eReady,
      policyProfile,
      autoMergeEnabled,
      autoMergeDwell,
      autoMergeMaxSize,
    } = editState;
    if (!eUrl.trim() || !eBranch.trim() || !eWorkflow.trim()) {
      onError('url, defaultBranch, and workflow are required');
      return;
    }
    const mc = Number(eMc);
    if (!Number.isInteger(mc) || mc < 1) {
      onError('maxConcurrent must be a positive integer');
      return;
    }
    void run(`edit:${repoKey}`, async () => {
      const currentRepo = repos.find((x) => x.key === repoKey);
      const wasIncomplete = currentRepo?.readiness === 'incomplete';
      let forceReady = false;
      if (wasIncomplete && eReady === 'ready') {
        try {
          const check = await checkRepoReadiness(repoKey, { retryCliEvidence: true });
          if (!check.ok) {
            if (check.guardian && check.guardian.applicable && !check.guardian.ok) {
              setFlash(
                repoKey +
                  ' blocked by Guardian B-022: ' +
                  check.guardian.failedCodes.join(', '),
              );
              return;
            }
            const detail = check.checks
              .filter((c) => !c.ok)
              .map((c) => `• ${c.label}: ${c.detail}`)
              .join('\n');
            const ok = window.confirm(
              `${repoKey} soft-check failed:\n\n${detail}\n\nSave as ready anyway?`,
            );
            if (!ok) {
              setFlash(`Save cancelled — ${check.summary}`);
              return;
            }
            forceReady = true;
          }
        } catch (err) {
          setFlash(
            `Save cancelled — readiness check failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return;
        }
      }
      const dwellParsed = Number(autoMergeDwell);
      const dwellMinutes =
        Number.isInteger(dwellParsed) && String(autoMergeDwell).trim() !== ''
          ? dwellParsed
          : (currentRepo?.autoMerge?.dwellMinutes ?? 30);
      const nextAutoMerge = {
        enabled: autoMergeEnabled,
        dwellMinutes,
        maxSize: autoMergeMaxSize,
      };
      const curAuto = currentRepo?.autoMerge;
      const curNorm = {
        enabled: curAuto?.enabled ?? false,
        dwellMinutes: curAuto?.dwellMinutes ?? 30,
        maxSize: curAuto?.maxSize ?? 'M',
      };
      const autoMergeChanged =
        curNorm.enabled !== nextAutoMerge.enabled ||
        curNorm.dwellMinutes !== nextAutoMerge.dwellMinutes ||
        curNorm.maxSize !== nextAutoMerge.maxSize;
      await editRepo(repoKey, {
        url: eUrl.trim(),
        defaultBranch: eBranch.trim(),
        workflow: eWorkflow.trim(),
        maxConcurrent: mc,
        // null clears override; string sets it
        adapter: eAd === '' ? null : (eAd as AdapterKind),
        readiness: eReady,
        ...(currentRepo?.executionPolicy?.profile !== policyProfile
          ? { executionPolicy: { profile: policyProfile } }
          : {}),
        ...(autoMergeChanged ? { autoMerge: nextAutoMerge } : {}),
        ...(forceReady ? { forceReady: true } : {}),
      });
      setFlash(`Saved ${repoKey} (${eReady}${forceReady ? ', forced' : ''})`);
      closeEdit();
    });
  };

  const startOnboarding = (repoKey: string): void => {
    const existing = activeOnboardingTask(tasks, repoKey);
    if (existing) {
      setFlash(`Onboarding already open: ${existing.id} (${existing.state})`);
      onOpenTask?.(existing.id, existing);
      return;
    }
    // Multi-stage SPEC §15 pattern (docs/readiness-pipeline.md) — not one monolithic task.
    const draft = draftReadinessPipeline(repoKey);
    void run(`onboard:${repoKey}`, async () => {
      const created = await createPipeline({
        title: draft.title,
        repo: draft.repo,
        idPrefix: draft.idPrefix,
        priority: draft.priority,
        stages: draft.stages.map((s) => ({
          title: s.title,
          body: s.body,
          labels: [...s.labels],
        })),
      });
      const first = created[0];
      setFlash(
        `Created readiness pipeline ${draft.idPrefix} (${created.length} stages) — R1 runs first`,
      );
      if (first) onOpenTask?.(first.id, first);
    });
  };

  /** Soft probe only — never mutates readiness:ready; never page-wide busy. */
  const runReadinessProbe = (repoKey: string): void => {
    if (jobByRepo[repoKey]?.status === 'running') return;
    void beginReadinessCheck(repoKey, { retryCliEvidence: true }).catch((err) => {
      // beginReadinessCheck already swallows unmount/stale; this is for live failures.
      if (!mountedRef.current) return;
      onError(err instanceof Error ? err.message : String(err));
    });
  };

  /** Mark ready: fail-closed — never auto forceReady on probe failure/timeout. */
  const markRepoReady = (repoKey: string): void => {
    if (markInFlightRef.current.has(repoKey)) return;
    markInFlightRef.current.add(repoKey);
    setMarkBusyByRepo((prev) => ({ ...prev, [repoKey]: true }));
    void (async () => {
      try {
        const existing = jobByRepo[repoKey];
        const fresh = isFreshOkResult(existing, Date.now());
        if (fresh) {
          if (!mountedRef.current) return;
          await editRepo(repoKey, { readiness: 'ready' });
          if (!mountedRef.current) return;
          setFlash(`${repoKey} marked ready — ${fresh.summary}`);
          onChanged?.();
          return;
        }

        // Bind this mark flow to ONE run: the generation and startedAt of the
        // POST we issued (or of the running check we attach to). A newer
        // generation started meanwhile — or a cancelled POST — ends the flow
        // without a decision; an older cached result never counts.
        let gen: number;
        let runStartedAt: string;
        if (existing?.status !== 'running') {
          const begun = await beginReadinessCheck(repoKey, { retryCliEvidence: true });
          if (begun.kind === 'cancelled' || !mountedRef.current) return;
          gen = begun.gen;
          runStartedAt = begun.started.startedAt;
        } else {
          gen = readinessGenRef.current.get(repoKey) ?? 0;
          runStartedAt = existing.startedAt ?? '';
          if (mountedRef.current) {
            // Attach to the running check — do not start a second POST.
            startReadinessPoll(repoKey);
          }
        }

        const waited = await waitForReadinessJob(repoKey, gen);
        if (waited.outcome === 'cancelled' || !mountedRef.current) return;
        if (waited.outcome === 'timeout') {
          const msg = 'Readiness check still running after 15 minutes';
          setForceOfferByRepo((prev) => ({ ...prev, [repoKey]: msg }));
          setFlash(`${repoKey}: ${msg} — use force button to skip, or wait`);
          return;
        }
        if (waited.outcome === 'error') {
          if (!isReadinessCurrent(repoKey, gen)) return;
          // Consume the snapshot the waiter already observed — no post-deadline GET.
          const job = waited.job;
          if (job) applyJobSnapshot(repoKey, job);
          const msg = job?.error ?? 'Readiness check failed';
          setForceOfferByRepo((prev) => ({ ...prev, [repoKey]: msg }));
          setFlash(`${repoKey}: check failed — ${msg}`);
          return;
        }

        if (!isReadinessCurrent(repoKey, gen)) return;
        // B2: use the terminal job the waiter observed; never fetch after the deadline cleared.
        const job = waited.job;
        if (job) applyJobSnapshot(repoKey, job);
        // The terminal job must be the run this flow started/attached to; a
        // completed OLDER run (its startedAt differs) is never a decision basis.
        if (job && runStartedAt !== '' && job.startedAt !== runStartedAt) {
          setForceOfferByRepo((prev) => ({
            ...prev,
            [repoKey]: 'Readiness check was superseded before it finished',
          }));
          setFlash(`${repoKey}: readiness check superseded — run Check readiness again`);
          return;
        }
        const check = job?.result;
        if (!check) {
          setForceOfferByRepo((prev) => ({
            ...prev,
            [repoKey]: 'No readiness result',
          }));
          setFlash(`${repoKey}: check finished without a result`);
          return;
        }
        if (check.ok) {
          if (!isReadinessCurrent(repoKey, gen)) return;
          await editRepo(repoKey, { readiness: 'ready' });
          if (!mountedRef.current) return;
          setFlash(`${repoKey} marked ready — ${check.summary}`);
          onChanged?.();
          return;
        }
        if (check.guardian && check.guardian.applicable && !check.guardian.ok) {
          if (!mountedRef.current) return;
          setFlash(
            repoKey +
              ' blocked by Guardian B-022: ' +
              check.guardian.failedCodes.join(', '),
          );
          return;
        }
        const detail = check.checks
          .filter((c) => !c.ok)
          .map((c) => `• ${c.label}: ${c.detail}`)
          .join('\n');
        const ok = window.confirm(
          `${repoKey} soft-check failed:\n\n${detail}\n\nMark ready anyway? (force override)`,
        );
        if (!ok) {
          if (!mountedRef.current) return;
          setFlash(`Mark ready cancelled — ${check.summary}`);
          return;
        }
        if (!isReadinessCurrent(repoKey, gen)) return;
        await editRepo(repoKey, { readiness: 'ready', forceReady: true });
        if (!mountedRef.current) return;
        setFlash(`${repoKey} marked ready (forced despite soft-check)`);
        onChanged?.();
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setForceOfferByRepo((prev) => ({ ...prev, [repoKey]: msg }));
        onError(msg);
      } finally {
        markInFlightRef.current.delete(repoKey);
        if (mountedRef.current) {
          setMarkBusyByRepo((prev) => {
            if (!prev[repoKey]) return prev;
            const next = { ...prev };
            delete next[repoKey];
            return next;
          });
        }
      }
    })();
  };

  const forceMarkReady = (repoKey: string): void => {
    void run(`ready-force:${repoKey}`, async () => {
      await editRepo(repoKey, { readiness: 'ready', forceReady: true });
      setForceOfferByRepo((prev) => {
        const next = { ...prev };
        delete next[repoKey];
        return next;
      });
      setFlash(`${repoKey} marked ready (forced — check skipped)`);
    });
  };

  /** Load docs list for a repo (trusted mirror default branch). Always API. */
  const openDocs = (repoKey: string): void => {
    if (docsOpenKey === repoKey) {
      setDocsOpenKey(null);
      setActiveDoc(null);
      setDocContent(null);
      setDocsAllExpanded(false);
      setDocsSearch('');
      return;
    }
    setDocsOpenKey(repoKey);
    setActiveDoc(null);
    setDocContent(null);
    setDocsAllExpanded(false);
    setDocsSearch('');
    // Real registry keys always hit fetchRepoDocs — never client-side fixture
    // content (a live key must not be shadowed by empty-state demo data).
    if (docsByRepo[repoKey] !== undefined && docsByRepo[repoKey] !== null) return;
    setDocsByRepo((prev) => ({ ...prev, [repoKey]: null }));
    void fetchRepoDocs(repoKey)
      .then((r) => setDocsByRepo((prev) => ({ ...prev, [repoKey]: [...r.files] })))
      .catch(() => setDocsByRepo((prev) => ({ ...prev, [repoKey]: [] })));
  };

  const closeDocView = (): void => {
    setActiveDoc(null);
    setDocContent(null);
  };

  const openDocFile = (repoKey: string, path: string): void => {
    if (activeDoc?.repo === repoKey && activeDoc.path === path) {
      closeDocView();
      return;
    }
    setActiveDoc({ repo: repoKey, path });
    setDocContent(null);
    void fetchRepoDoc(repoKey, path)
      .then((r) =>
        setDocContent(r.truncated ? `${r.content}\n\n…(truncated)` : r.content),
      )
      .catch((e) =>
        setDocContent(`(failed to load: ${e instanceof Error ? e.message : e})`),
      );
  };

  // Reader-first: when a doc is selected, scroll its body into view (phone).
  useEffect(() => {
    if (activeDoc === null) return;
    // Wait a frame so the view mounts above the list before scrolling.
    const id = requestAnimationFrame(() => {
      docViewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [activeDoc, docContent]);

  /** Shared docs browser chrome for a registry repo (trusted mirror). */
  const renderDocsPanel = (
    repoKey: string,
    branchLabel: string,
    docsList: string[] | null | undefined,
  ): JSX.Element => (
    <div className="repo-docs" data-evidence="repo-docs">
      <div className="body-label">Docs @ {branchLabel} (trusted mirror)</div>
      {docsList === null || docsList === undefined ? (
        <span className="muted">Loading…</span>
      ) : docsList.length === 0 ? (
        <span className="muted">No README / docs markdown found on the mirror yet.</span>
      ) : (
        (() => {
          const groups = splitRepoDocEntrypoints(docsList);
          const restFiltered = filterDocsByQuery(groups.rest, docsSearch);
          const viewing = activeDoc?.repo === repoKey;
          const docRow = (f: string): JSX.Element => (
            <button
              key={f}
              type="button"
              className={`task-file-row${
                viewing && activeDoc.path === f ? ' is-active' : ''
              }`}
              data-evidence="repo-doc-row"
              onClick={() => {
                openDocFile(repoKey, f);
              }}
            >
              {f}
            </button>
          );
          const restOpen = docsAllExpanded || docsSearch.trim().length > 0;
          return (
            <div className="task-files-list">
              {viewing ? (
                <div
                  className="task-file-view repo-doc-reader"
                  data-evidence="repo-doc-view"
                  ref={docViewRef}
                >
                  <div className="repo-doc-reader-head">
                    <span className="repo-doc-reader-path">{activeDoc.path}</span>
                    <button
                      type="button"
                      className="repo-doc-reader-close"
                      onClick={closeDocView}
                    >
                      Back to list
                    </button>
                  </div>
                  {docContent === null ? (
                    <span className="muted">Loading {activeDoc.path}…</span>
                  ) : activeDoc.path.toLowerCase().endsWith('.md') ? (
                    <Markdown text={docContent} />
                  ) : (
                    <pre className="task-file-pre">{docContent}</pre>
                  )}
                </div>
              ) : null}
              <div
                className="repo-docs-entrypoints"
                data-evidence="repo-docs-entrypoints"
              >
                {groups.entrypoints.length > 0 ? (
                  <>
                    <div className="body-label">Entry docs</div>
                    {groups.entrypoints.map(docRow)}
                  </>
                ) : (
                  <span className="muted">No entry docs on this branch.</span>
                )}
              </div>
              {groups.rest.length > 0 ? (
                <div className="repo-docs-all">
                  <button
                    type="button"
                    className="repo-docs-all-toggle"
                    data-evidence="repo-docs-all-toggle"
                    aria-expanded={restOpen}
                    onClick={() => {
                      if (restOpen) {
                        setDocsAllExpanded(false);
                        setDocsSearch('');
                      } else {
                        setDocsAllExpanded(true);
                      }
                    }}
                  >
                    {restOpen ? '▾' : '▸'} All docs ({groups.rest.length})
                  </button>
                  <input
                    type="search"
                    className="repo-docs-search"
                    data-evidence="repo-docs-search"
                    placeholder="Filter by path…"
                    value={docsSearch}
                    onChange={(e) => {
                      setDocsSearch(e.target.value);
                    }}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {restOpen ? (
                    <div className="repo-docs-all-body">
                      {restFiltered.length === 0 ? (
                        <span className="muted">
                          No docs match “{docsSearch.trim()}”.
                        </span>
                      ) : (
                        restFiltered.map(docRow)
                      )}
                    </div>
                  ) : null}
                </div>
              ) : (
                <input
                  type="search"
                  className="repo-docs-search"
                  data-evidence="repo-docs-search"
                  placeholder="Filter by path…"
                  value={docsSearch}
                  onChange={(e) => {
                    setDocsSearch(e.target.value);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Filter docs by path"
                />
              )}
            </div>
          );
        })()
      )}
    </div>
  );

  const adapterSelect = (
    value: string,
    onChange: (v: string) => void,
    disabled: boolean,
  ): JSX.Element => (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {ADAPTER_OPTIONS.filter(
        (o) => o.value === '' || availableAgents.includes(o.value) || o.value === value,
      ).map((o) => (
        <option key={o.value || 'default'} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="repos-panel" data-evidence="repos-panel">
      <div className="repos-panel-header">
        <h2>Repos</h2>
        <button onClick={onClose}>Close</button>
      </div>

      <p className="muted repo-agent-hint">
        Daemon default agent: <strong>{defaultAgent}</strong>. Per-repo override applies on the next
        task dispatch (no restart). New repos start <strong>incomplete</strong> — only
        onboarding/readiness tasks run until you mark them ready.{' '}
        <strong>Start onboarding</strong> creates the 4-stage readiness pipeline (R1 map → R2
        WORKFLOW → R3 gates/boot → R4 human ready). Use <strong>Check readiness</strong> for the
        SPEC §15 checklist score; it never auto-flips ready.
      </p>

      {flash ? (
        <div className="repo-flash" data-evidence="repo-flash" role="status">
          {flash}
          <button type="button" className="link" onClick={() => setFlash(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <ul className="repo-list">
        {repos.map((r) => {
          const onboard = onboardByRepo.get(r.key) ?? null;
          const starting = busyKey === `onboard:${r.key}`;
          const probe = probeByRepo[r.key] ?? null;
          const job = jobByRepo[r.key];
          const readinessBusy = job?.status === 'running';
          const probeOpen = probeOpenKey === r.key && probe !== null;
          const forceOffer = forceOfferByRepo[r.key];
          const docsOpen = docsOpenKey === r.key;
          const docsList = docsByRepo[r.key];
          const runningSec =
            readinessBusy && job?.startedAt
              ? Math.max(0, Math.floor((nowMs - Date.parse(job.startedAt)) / 1000))
              : 0;
          let readinessStatusText: string | null = null;
          if (readinessBusy) {
            readinessStatusText = `检查中… 已 ${runningSec} 秒`;
          } else if (job?.status === 'error' || (forceOffer && !job?.result?.ok)) {
            const errText = job?.status === 'error' ? (job.error ?? 'unknown') : (forceOffer ?? 'unknown');
            const age = readinessAgeLabel(job?.finishedAt, nowMs);
            readinessStatusText = `检查失败: ${errText}${age ? ` (${age})` : ''}`;
          } else if (job?.status === 'done' && job.result) {
            const age = readinessAgeLabel(job.finishedAt, nowMs);
            readinessStatusText = `检查完成 ${job.result.score.passed}/${job.result.score.total}${age ? ` (${age})` : ''}`;
          }
          return (
          <li key={r.key} className="repo-item" data-evidence={`repo-${r.key}`}>
            <div className="repo-key">
              {r.key}{' '}
              <span className="repo-agent-pill" title="Agent for this repo">
                {agentBadge(r)}
              </span>{' '}
              <span
                className={
                  r.readiness === 'incomplete'
                    ? 'repo-ready-pill is-incomplete'
                    : 'repo-ready-pill is-ready'
                }
                title={
                  r.readiness === 'incomplete'
                    ? 'Only onboarding/readiness tasks may dispatch'
                    : 'Full autonomous dispatch allowed'
                }
                data-evidence="repo-readiness"
              >
                {r.readiness === 'incomplete' ? 'incomplete' : 'ready'}
              </span>
              {r.autoMerge?.enabled ? (
                <span
                  className="repo-ready-pill is-ready"
                  data-evidence="repo-auto-merge-badge"
                  title="Auto-merge pilot on"
                >
                  auto-merge ≤{r.autoMerge.maxSize} · {r.autoMerge.dwellMinutes}m
                </span>
              ) : null}
              {probe ? (
                <span
                  className={
                    probe.ok
                      ? 'repo-ready-pill is-probe-ok'
                      : 'repo-ready-pill is-probe-fail'
                  }
                  title={probe.summary}
                  data-evidence="repo-readiness-score"
                >
                  checklist {probe.score.passed}/{probe.score.total}
                </span>
              ) : null}
              {onboard ? (
                <span
                  className={
                    onboard.state === 'failed'
                      ? 'repo-ready-pill is-onboarding-failed'
                      : 'repo-ready-pill is-onboarding'
                  }
                  data-evidence={
                    onboard.state === 'failed'
                      ? 'repo-onboarding-failed'
                      : 'repo-onboarding-active'
                  }
                  title={`${onboard.id} · ${onboard.state}${onboard.planPending ? ' · plan' : ''}`}
                >
                  {onboard.state === 'failed'
                    ? `onboarding failed · ${onboard.id}`
                    : `onboarding · ${onboard.planPending ? 'plan' : onboard.state}`}
                </span>
              ) : null}
            </div>
            {editingKey === r.key ? (
              <div className="repo-edit-form">
                <label>
                  Key (read-only)
                  <div className="repo-edit-key-readonly">{r.key}</div>
                </label>
                <label>
                  URL
                  <input
                    value={editState.url}
                    onChange={(e) => setEditState((s) => ({ ...s, url: e.target.value }))}
                    placeholder="git@host:org/repo.git"
                    disabled={busy}
                  />
                </label>
                <label>
                  Default branch
                  <input
                    value={editState.defaultBranch}
                    onChange={(e) => setEditState((s) => ({ ...s, defaultBranch: e.target.value }))}
                    disabled={busy}
                  />
                </label>
                <label>
                  Workflow file
                  <input
                    value={editState.workflow}
                    onChange={(e) => setEditState((s) => ({ ...s, workflow: e.target.value }))}
                    placeholder="WORKFLOW.md"
                    disabled={busy}
                  />
                </label>
                <label>
                  Max concurrent
                  <input
                    type="number"
                    min={1}
                    value={editState.maxConcurrent}
                    onChange={(e) => setEditState((s) => ({ ...s, maxConcurrent: e.target.value }))}
                    disabled={busy}
                  />
                </label>
                <label>
                  Agent
                  {adapterSelect(editState.adapter, (v) => setEditState((s) => ({ ...s, adapter: v })), busy)}
                </label>
                <label>
                  Readiness
                  <select
                    value={editState.readiness}
                    onChange={(e) =>
                      setEditState((s) => ({
                        ...s,
                        readiness: e.target.value === 'ready' ? 'ready' : 'incomplete',
                      }))
                    }
                    disabled={busy}
                    data-evidence="repo-readiness-select"
                  >
                    <option value="incomplete">incomplete (onboarding only)</option>
                    <option value="ready">ready (full dispatch)</option>
                  </select>
                </label>
                <label>
                  Execution policy
                  <select
                    value={editState.policyProfile}
                    onChange={(e) => setEditState((s) => ({
                      ...s,
                      policyProfile: e.target.value === 'guardian' ? 'guardian' : 'compatible',
                    }))}
                    disabled={busy}
                    data-evidence="repo-execution-policy-select"
                  >
                    <option value="compatible">compatible</option>
                    <option value="guardian">guardian (B-022 hard gate)</option>
                  </select>
                </label>
                <label>
                  Auto-merge
                  <span className="repo-auto-merge-row">
                    <input
                      type="checkbox"
                      checked={editState.autoMergeEnabled}
                      onChange={(e) =>
                        setEditState((s) => ({ ...s, autoMergeEnabled: e.target.checked }))
                      }
                      disabled={busy}
                      data-evidence="repo-auto-merge-enabled"
                    />
                    Auto-approve + merge green tasks
                  </span>
                  <span className="repo-auto-merge-row">
                    after{' '}
                    <input
                      type="number"
                      min={0}
                      max={1440}
                      value={editState.autoMergeDwell}
                      onChange={(e) =>
                        setEditState((s) => ({ ...s, autoMergeDwell: e.target.value }))
                      }
                      disabled={busy || !editState.autoMergeEnabled}
                      data-evidence="repo-auto-merge-dwell"
                    />{' '}
                    min in review
                    <select
                      value={editState.autoMergeMaxSize}
                      onChange={(e) => {
                        const v = e.target.value;
                        setEditState((s) => ({
                          ...s,
                          autoMergeMaxSize: v === 'S' || v === 'L' ? v : 'M',
                        }));
                      }}
                      disabled={busy || !editState.autoMergeEnabled}
                      data-evidence="repo-auto-merge-max-size"
                    >
                      <option value="S">S (≤50 lines)</option>
                      <option value="M">M (≤250 lines)</option>
                      <option value="L">L (any)</option>
                    </select>
                  </span>
                </label>
                <div className="repo-actions repo-edit-actions">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      submitEdit(r.key);
                    }}
                  >
                    Save
                  </button>
                  <button disabled={busy} onClick={closeEdit}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="repo-meta muted">
                  {r.url} · {r.defaultBranch} · ×{r.maxConcurrent}
                  {onboard
                    ? ` · ${onboard.id} (${onboard.planPending ? 'plan pending' : onboard.state})`
                    : ''}
                </div>
                <SuccessionPanel repoKey={r.key} refreshKey={successionRefreshKey} />
                {readinessStatusText ? (
                  <div
                    className="repo-readiness-status muted"
                    data-evidence="repo-readiness-status"
                    role="status"
                  >
                    {readinessStatusText}
                  </div>
                ) : null}
                {probeOpen && probe ? (
                  <div
                    className="repo-readiness-detail"
                    data-evidence="repo-readiness-detail"
                  >
                    <div className="repo-readiness-detail-head">
                      <strong>
                        Checklist {probe.score.passed}/{probe.score.total}
                        {probe.ok ? ' · required ok' : ' · gaps'}
                      </strong>
                      <span className="muted">{probe.summary}</span>
                    </div>
                    <ul className="repo-readiness-checks">
                      {probe.checks.map((c) => (
                        <li
                          key={c.id}
                          className={c.ok ? 'is-ok' : c.required ? 'is-fail' : 'is-optional-miss'}
                          data-evidence={`repo-check-${c.id}`}
                        >
                          <span className="repo-check-mark" aria-hidden>
                            {c.ok ? '✓' : c.required ? '✗' : '○'}
                          </span>
                          <span className="repo-check-label">
                            {c.label}
                            {!c.required ? ' (optional)' : ''}
                          </span>
                          <span className="repo-check-detail muted">{c.detail}</span>
                        </li>
                      ))}
                    </ul>
                    {probe.guardian && probe.guardian.applicable ? (
                      <div data-evidence="repo-guardian-readiness" className="repo-guardian-readiness">
                        <strong>Guardian B-022 {probe.guardian.ok ? 'green' : 'blocked'}</strong>
                        <span className="muted">{probe.guardian.summary}</span>
                        {!probe.guardian.ok ? (
                          <ul data-evidence="repo-guardian-remediation">
                            {probe.guardian.controls.filter((c) => !c.ok).map((c) => (
                              <li key={c.id}>
                                <strong>{c.label}</strong>: {c.remediation ?? c.detail}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                    <p className="muted repo-readiness-footnote">
                      Soft SPEC checklist is advisory; Guardian B-022 is a hard server gate.
                      Mark ready remains a human decision.
                    </p>
                  </div>
                ) : null}
                <div className="repo-actions">
                  <button
                    disabled={readinessBusy}
                    data-evidence="repo-check-readiness"
                    onClick={() => {
                      if (readinessBusy) return;
                      if (probe && probeOpenKey === r.key) {
                        setProbeOpenKey(null);
                        return;
                      }
                      if (probe) {
                        setProbeOpenKey(r.key);
                        return;
                      }
                      runReadinessProbe(r.key);
                    }}
                  >
                    {readinessBusy
                      ? 'Probing…'
                      : probe && probeOpenKey === r.key
                        ? 'Hide checklist'
                        : probe
                          ? 'Show checklist'
                          : 'Check readiness'}
                  </button>
                  {probe && !readinessBusy ? (
                    <button
                      disabled={readinessBusy}
                      data-evidence="repo-reprobe-readiness"
                      onClick={() => {
                        runReadinessProbe(r.key);
                      }}
                    >
                      Re-probe
                    </button>
                  ) : null}
                  {r.readiness === 'incomplete' && !onboard ? (
                    <button
                      className="primary"
                      disabled={busy}
                      data-evidence="repo-start-onboarding"
                      onClick={() => {
                        startOnboarding(r.key);
                      }}
                    >
                      {starting ? 'Creating…' : 'Start onboarding'}
                    </button>
                  ) : null}
                  {r.readiness === 'incomplete' && onboard ? (
                    <button
                      className="primary"
                      disabled={busy}
                      data-evidence="repo-open-onboarding"
                      onClick={() => {
                        setFlash(`Open ${onboard.id}`);
                        onOpenTask?.(onboard.id, onboard);
                      }}
                    >
                      Open {onboard.id}
                    </button>
                  ) : null}
                  {r.readiness === 'incomplete' ? (
                    <ConfirmButton
                      label="Mark ready"
                      confirmLabel="Check WORKFLOW/AGENTS?"
                      onConfirm={() => {
                        markRepoReady(r.key);
                      }}
                      disabled={markBusyByRepo[r.key] === true}
                      data-evidence="repo-mark-ready"
                    />
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => {
                        void run(`incomplete:${r.key}`, async () => {
                          await editRepo(r.key, { readiness: 'incomplete' });
                          setFlash(`${r.key} marked incomplete`);
                        });
                      }}
                    >
                      Mark incomplete
                    </button>
                  )}
                  {r.readiness === 'incomplete' && forceOffer ? (
                    <ConfirmButton
                      label="强制标记就绪（跳过检查）"
                      confirmLabel="Confirm force ready?"
                      onConfirm={() => {
                        forceMarkReady(r.key);
                      }}
                      disabled={busyKey === `ready-force:${r.key}`}
                      data-evidence="repo-mark-ready-force"
                    />
                  ) : null}
                  <button
                    disabled={busy}
                    data-evidence="repo-browse-docs"
                    onClick={() => {
                      openDocs(r.key);
                    }}
                  >
                    {docsOpen ? 'Hide docs' : 'Browse docs'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      openEdit(r);
                    }}
                  >
                    Edit
                  </button>
                  <ConfirmButton
                    label="Remove"
                    confirmLabel="Confirm remove?"
                    onConfirm={() => {
                      void run(`remove:${r.key}`, () => removeRepo(r.key));
                    }}
                    disabled={busy}
                  />
                </div>
                {docsOpen ? renderDocsPanel(r.key, r.defaultBranch, docsList) : null}
              </>
            )}
          </li>
          );
        })}
        {repos.length === 0 && (
          <li className="muted repo-empty" data-evidence="repos-empty">
            No repos configured.
          </li>
        )}
      </ul>

      <form
        className="repo-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim() || !url.trim() || !branch.trim()) {
            onError('key, url, and branch are required');
            return;
          }
          void run('add', async () => {
            await addRepo({
              key: key.trim(),
              url: url.trim(),
              defaultBranch: branch.trim(),
              ...(addAdapter
                ? { adapter: addAdapter as AdapterKind }
                : {}),
              executionPolicy: { profile: addPolicyProfile },
            });
            setKey('');
            setUrl('');
            setBranch('main');
            setAddAdapter('');
            setAddPolicyProfile('compatible');
            setFlash(`Added ${key.trim()} (incomplete — start onboarding)`);
          });
        }}
      >
        <h3 className="repo-add-heading">Add repo</h3>
        <label>
          Key
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="my-app" />
        </label>
        <label>
          URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@host:org/my-app.git" />
        </label>
        <label>
          Default branch
          <input value={branch} onChange={(e) => setBranch(e.target.value)} />
        </label>
        <label>
          Agent
          {adapterSelect(addAdapter, setAddAdapter, busy)}
        </label>
        <label>
          Execution policy
          <select
            value={addPolicyProfile}
            onChange={(e) => setAddPolicyProfile(
              e.target.value === 'guardian' ? 'guardian' : 'compatible',
            )}
            data-evidence="repo-add-execution-policy"
          >
            <option value="compatible">compatible</option>
            <option value="guardian">guardian (starts incomplete)</option>
          </select>
        </label>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            Add repo
          </button>
        </div>
      </form>
    </div>
  );
}
