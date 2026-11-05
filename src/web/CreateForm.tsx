/**
 * New task / pipeline create sheet.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import {
  draftFromIntent,
  lintAcceptance,
  type AcLintReport,
  type AdapterKind,
  type DraftJobDto,
  type DraftJobPhase,
  type ExecutionClass,
  type IntentDraftDto,
  type IntentQuestionDto,
  type RepoDto,
} from './api.js';
import { draftOnboardingPlan, draftReadinessPipeline } from '../domain/onboarding.js';
import { SegmentedControl } from './SegmentedControl.js';
import {
  clearTaskDraft,
  isEmptyTaskDraft,
  listTaskDrafts,
  loadTaskDraft,
  saveTaskDraft,
  taskDraftFieldsEqual,
  type TaskDraftFields,
} from './taskDraftStore.js';

/** Typed DoD skeleton — untyped criteria default to human (cannot self-green). */
const AC_TEMPLATE = `## Task

(what to do)

## Acceptance criteria
- [ ] (mechanical) …
- [ ] (reviewer) …
- [ ] (human) …
`;

const PHASE_LABEL: Record<DraftJobPhase, string> = {
  context: '读取仓库上下文',
  draft: '起草 DoD',
  retry: '分析超时 · 重试一次',
  repair: '修复 AC lint',
  done: '完成',
};

type PipelineStageDraft = { title: string; body: string; adapter: string };

const OLD_VAGUE_WARN_RE =
  /Intent looks vague|tighten acceptance criteria before dispatch|edit DoD/i;

function appendOpenQuestionsSection(
  body: string,
  questions: readonly IntentQuestionDto[],
): string {
  if (questions.length === 0) return body;
  const cleaned = body.replace(/\n*## Open questions\n[\s\S]*?(?=\n## |\s*$)/, '').trimEnd();
  const lines = questions.map((q) => `- (${q.slot}) ${q.text}`);
  return `${cleaned}\n\n## Open questions\n${lines.join('\n')}\n`;
}

function applyIntentDraft(
  d: IntentDraftDto,
  setters: {
    setTitle: (v: string) => void;
    setSlug: (v: string | undefined) => void;
    setBody: (v: string) => void;
    setAsPlan: (v: boolean) => void;
    setAcLint: (v: AcLintReport) => void;
    setDraftSource: (v: 'analyst' | 'heuristic') => void;
    setDraftNotes: (v: readonly string[]) => void;
    setIntentWarn: (v: string | null | ((w: string | null) => string | null)) => void;
    setClarifyQuestions: (v: readonly IntentQuestionDto[]) => void;
    setFilled: (v: readonly string[]) => void;
    setClarifyDismissed: (v: boolean) => void;
  },
  sourceOverride?: 'analyst' | 'heuristic',
): void {
  setters.setTitle(d.title);
  setters.setSlug(d.slug);
  setters.setBody(d.body);
  setters.setAsPlan(true);
  setters.setAcLint(d.lint);
  setters.setDraftSource(sourceOverride ?? d.source);
  setters.setDraftNotes(d.notes ?? []);
  setters.setClarifyQuestions(d.questions ?? []);
  setters.setFilled(d.filled ?? []);
  setters.setClarifyDismissed(false);
  // Keep non-vague warnings (analyst busy / failed); never re-append the old
  // vague dead-end label (even if an older server still emits it).
  const keep = d.warnings.filter((w) => !OLD_VAGUE_WARN_RE.test(w));
  setters.setIntentWarn(keep.length > 0 ? keep.join(' · ') : null);
}

export function CreateForm({
  repos,
  availableAgents,
  defaultAgent,
  preferredAgent,
  initial,
  drafts = new Map(),
  onAckDraft = () => {},
  onClose,
  onCreate,
  onCreatePipeline,
}: {
  repos: RepoDto[];
  availableAgents: readonly string[];
  defaultAgent: string;
  /** Settings preference — seeds agent when no clone/prefill adapter. */
  preferredAgent: string;
  initial?: {
    title: string;
    repo: string;
    body: string;
    adapter?: AdapterKind | null;
    executionClass?: ExecutionClass | null;
    draft?: IntentDraftDto;
  };
  drafts?: ReadonlyMap<string, DraftJobDto>;
  onAckDraft?: (id: string) => void;
  onClose: () => void;
  onCreate: (input: {
    title: string;
    repo: string;
    body?: string;
    slug?: string;
    priority?: number;
    adapter?: AdapterKind | null;
    executionClass?: ExecutionClass | null;
    planPending?: boolean;
    labels?: string[];
  }) => void | Promise<void>;
  onCreatePipeline: (input: {
    title: string;
    repo: string;
    stages: readonly {
      title: string;
      body?: string;
      adapter?: AdapterKind | null;
      labels?: readonly string[];
    }[];
    priority?: number;
    idPrefix?: string;
  }) => void | Promise<void>;
}): JSX.Element {
  const seedAdapter = (): string => {
    if (initial?.adapter !== undefined && initial.adapter !== null) return initial.adapter;
    if (initial?.adapter === null) return '';
    // No prefill: honor Settings → preferred agent when listed as available.
    if (preferredAgent && availableAgents.includes(preferredAgent)) return preferredAgent;
    return '';
  };
  const seedDraft = initial?.draft;
  const stageSeed =
    preferredAgent && availableAgents.includes(preferredAgent) ? preferredAgent : '';
  const seedStages: PipelineStageDraft[] = [
    { title: 'Implement', body: '', adapter: stageSeed },
    { title: 'Review / polish', body: '', adapter: stageSeed },
  ];
  const initialExecutionClass = initial?.executionClass ?? 'implement';
  const initialHostClass =
    initialExecutionClass === 'host_operation' || initialExecutionClass === 'deploy';
  const seededAdapter = initialHostClass ? 'grok' : seedAdapter();
  const seedFields: TaskDraftFields = {
    intent: '',
    title: seedDraft?.title ?? initial?.title ?? '',
    slug: seedDraft?.slug,
    body: seedDraft?.body ?? initial?.body ?? '',
    adapter: seededAdapter,
    executionClass: initialExecutionClass,
    asPlan: Boolean(seedDraft),
    createMode: 'task',
    stages: seedStages,
    draftNotes: seedDraft?.notes ?? [],
    draftSource: seedDraft?.source ?? null,
    jobId: null,
  };
  const hasPrefill = Boolean(
    seedDraft ||
      (initial?.title && initial.title.trim().length > 0) ||
      (initial?.body && initial.body.trim().length > 0),
  );

  const [title, setTitle] = useState(seedFields.title);
  const [slug, setSlug] = useState<string | undefined>(seedFields.slug);
  const [repo, setRepo] = useState(initial?.repo ?? '');
  const [body, setBody] = useState(seedFields.body);
  const [adapter, setAdapter] = useState(seedFields.adapter);
  const [executionClass, setExecutionClass] =
    useState<ExecutionClass>(seedFields.executionClass);
  const hostExecutionClass =
    executionClass === 'host_operation' || executionClass === 'deploy';
  const [intent, setIntent] = useState(seedFields.intent);
  const [intentBusy, setIntentBusy] = useState(false);
  const [intentWarn, setIntentWarn] = useState<string | null>(null);
  const [clarifyQuestions, setClarifyQuestions] = useState<readonly IntentQuestionDto[]>(
    seedDraft?.questions ?? [],
  );
  const [filled, setFilled] = useState<readonly string[]>(seedDraft?.filled ?? []);
  const [clarifyDismissed, setClarifyDismissed] = useState(false);
  const [clarifyInputs, setClarifyInputs] = useState<Record<string, string>>({});
  const [draftSource, setDraftSource] = useState<'analyst' | 'heuristic' | null>(
    seedFields.draftSource,
  );
  const [draftNotes, setDraftNotes] = useState<readonly string[]>(seedFields.draftNotes);
  const [asPlan, setAsPlan] = useState(seedFields.asPlan);
  /** Live analyst panel: collapsed = one/two-line tails; expanded = full wrapped text. */
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [createMode, setCreateMode] = useState<'task' | 'pipeline'>(seedFields.createMode);
  /** In-flight create — control git commit can take 1–3s; show spinner / block double-tap. */
  const [submitting, setSubmitting] = useState(false);
  const [acLint, setAcLint] = useState<AcLintReport | null>(seedDraft?.lint ?? null);
  const [jobId, setJobId] = useState<string | null>(seedFields.jobId);
  /** Visible restore chip after loading a local draft. */
  const [restoredChip, setRestoredChip] = useState<{
    repoKey: string;
    savedAt: string;
  } | null>(null);
  const dirtyRef = useRef(false);
  const readyHandledRef = useRef<string | null>(null);
  const skipAutosaveRef = useRef(false);
  const hydratedRef = useRef(false);
  const seedFieldsRef = useRef(seedFields);
  const pipelineMode = createMode === 'pipeline';
  const [stages, setStages] = useState<PipelineStageDraft[]>([...seedStages]);

  const job = jobId ? (drafts.get(jobId) ?? null) : null;

  const snapshotFields = (): TaskDraftFields => ({
    intent,
    title,
    slug,
    body,
    adapter,
    executionClass,
    asPlan,
    createMode,
    stages,
    draftNotes,
    draftSource,
    jobId,
  });

  const applyStoredDraft = (fields: TaskDraftFields): void => {
    skipAutosaveRef.current = true;
    setIntent(fields.intent);
    setTitle(fields.title);
    setSlug(fields.slug);
    setBody(fields.body);
    setAdapter(fields.adapter);
    setExecutionClass(fields.executionClass);
    setAsPlan(fields.asPlan);
    setCreateMode(fields.createMode);
    setStages(fields.stages.map((s) => ({ ...s })));
    setDraftNotes(fields.draftNotes);
    setDraftSource(fields.draftSource);
    // Never re-attach a stored analyst job: it may be acked/expired and would
    // only surface a spurious 「analyst job lost」 warning (Claude R18 N1).
    setJobId(null);
    setClarifyQuestions([]);
    setFilled([]);
    setClarifyDismissed(false);
    setClarifyInputs({});
    setAcLint(null);
    setIntentWarn(null);
    dirtyRef.current = false;
    window.setTimeout(() => {
      skipAutosaveRef.current = false;
    }, 0);
  };

  const resetToSeed = (nextRepo: string): void => {
    const seed = seedFieldsRef.current;
    applyStoredDraft({ ...seed, jobId: null });
    setRepo(nextRepo);
    setRestoredChip(null);
  };

  useEffect(() => {
    if (seedDraft) dirtyRef.current = false;
  }, [seedDraft]);

  // Restore local draft once on mount (skip when opening with a deliberate prefill).
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (hasPrefill) return;
    try {
      const selected = initial?.repo ?? '';
      const stored = selected
        ? (() => {
            const d = loadTaskDraft(selected);
            return d ? { repoKey: selected, draft: d } : null;
          })()
        : (listTaskDrafts()[0] ?? null);
      if (!stored) return;
      applyStoredDraft(stored.draft);
      setRepo(stored.repoKey);
      setRestoredChip({ repoKey: stored.repoKey, savedAt: stored.draft.savedAt });
    } catch {
      /* storage / parse — keep seed */
    }
  }, [hasPrefill, initial?.repo]);

  // Debounced autosave of persisted fields (500 ms).
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipAutosaveRef.current) return;
    if (!repo) return;
    const fields: TaskDraftFields = {
      intent,
      title,
      slug,
      body,
      adapter,
      executionClass,
      asPlan,
      createMode,
      stages,
      draftNotes,
      draftSource,
      jobId,
    };
    if (isEmptyTaskDraft(fields)) return;
    if (taskDraftFieldsEqual(fields, seedFieldsRef.current)) return;
    const handle = window.setTimeout(() => {
      if (skipAutosaveRef.current) return;
      saveTaskDraft(repo, fields, new Date());
    }, 500);
    return () => window.clearTimeout(handle);
  }, [
    repo,
    intent,
    title,
    slug,
    body,
    adapter,
    executionClass,
    asPlan,
    createMode,
    stages,
    draftNotes,
    draftSource,
    jobId,
  ]);

  const onRepoChange = (next: string): void => {
    const prev = repo;
    if (prev && prev !== next) {
      const fields = snapshotFields();
      if (!isEmptyTaskDraft(fields) && !taskDraftFieldsEqual(fields, seedFieldsRef.current)) {
        saveTaskDraft(prev, fields, new Date());
      }
    }
    if (next === prev) return;
    if (!next) {
      resetToSeed('');
      return;
    }
    const stored = loadTaskDraft(next);
    if (stored) {
      skipAutosaveRef.current = true;
      setRepo(next);
      applyStoredDraft(stored);
      setRestoredChip({ repoKey: next, savedAt: stored.savedAt });
      return;
    }
    if (prev) {
      resetToSeed(next);
      return;
    }
    setRepo(next);
    setRestoredChip(null);
  };

  const discardRestoredDraft = (): void => {
    const key = restoredChip?.repoKey || repo;
    if (key) clearTaskDraft(key);
    resetToSeed(initial?.repo ?? '');
  };

  const clearDraftAfterSuccess = (repoKey: string): void => {
    if (repoKey) clearTaskDraft(repoKey);
    setRestoredChip(null);
  };

  const restoredMinutesAgo = restoredChip
    ? Math.max(
        0,
        Math.round((Date.now() - Date.parse(restoredChip.savedAt)) / 60_000) || 0,
      )
    : 0;

  const repoDto = repos.find((r) => r.key === repo);
  const inheritLabel = repoDto?.effectiveAdapter ?? defaultAgent;
  const incompleteRepo = repoDto?.readiness === 'incomplete';

  const stagesValid =
    stages.length >= 2 && stages.every((s) => s.title.trim().length > 0);

  const canSubmit =
    Boolean(title.trim()) &&
    Boolean(repo) &&
    (pipelineMode ? stagesValid : true) &&
    !submitting;

  // Debounced AC lint while editing the task body (non-pipeline only).
  useEffect(() => {
    if (pipelineMode) return;
    if (body.trim().length === 0) {
      setAcLint(null);
      return;
    }
    const handle = window.setTimeout(() => {
      void lintAcceptance(body)
        .then((report) => setAcLint(report))
        .catch(() => {
          /* advisory only — ignore network/parse failures */
        });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [body, pipelineMode]);

  // Job vanished from the map (server restart / TTL) for >10s → warn + clear.
  useEffect(() => {
    if (!jobId || job) return;
    const handle = window.setTimeout(() => {
      setIntentWarn('analyst job lost — regenerate');
      setJobId(null);
    }, 10_000);
    return () => window.clearTimeout(handle);
  }, [jobId, job]);

  // Apply / prompt / fail when the background analyst job settles.
  useEffect(() => {
    if (!job || !jobId) return;
    if (job.status === 'ready') {
      if (readyHandledRef.current === job.id) return;
      readyHandledRef.current = job.id;
      if (!dirtyRef.current && job.draft) {
        applyIntentDraft(
          job.draft,
          {
            setTitle,
            setSlug,
            setBody,
            setAsPlan,
            setAcLint,
            setDraftSource,
            setDraftNotes,
            setIntentWarn,
            setClarifyQuestions,
            setFilled,
            setClarifyDismissed,
          },
          'analyst',
        );
        dirtyRef.current = false;
        onAckDraft(job.id);
        setJobId(null);
      }
      return;
    }
    if (job.status === 'failed') {
      if (readyHandledRef.current === job.id) return;
      readyHandledRef.current = job.id;
      setIntentWarn(`analyst failed: ${job.error ?? 'unknown'}`);
      onAckDraft(job.id);
      setJobId(null);
    }
  }, [job, jobId, onAckDraft]);

  const draftSetters = {
    setTitle,
    setSlug,
    setBody,
    setAsPlan,
    setAcLint,
    setDraftSource,
    setDraftNotes,
    setIntentWarn,
    setClarifyQuestions,
    setFilled,
    setClarifyDismissed,
  };

  const applyAnalystDraft = (j: DraftJobDto): void => {
    if (!j.draft) return;
    applyIntentDraft(j.draft, draftSetters, 'analyst');
    dirtyRef.current = false;
    onAckDraft(j.id);
    setJobId(null);
  };

  const runDraftFromIntent = (nextIntent: string): void => {
    setIntentBusy(true);
    setIntentWarn(null);
    setDraftSource(null);
    setDraftNotes([]);
    setJobId(null);
    readyHandledRef.current = null;
    dirtyRef.current = false;
    void draftFromIntent(nextIntent, repo)
      .then((res) => {
        applyIntentDraft(res.draft, draftSetters);
        dirtyRef.current = false;
        setJobId(res.jobId);
      })
      .catch((e: unknown) => {
        setIntentWarn(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setIntentBusy(false));
  };

  const answerClarify = (slot: string, answer: string): void => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    const appendix = `「${slot}: ${trimmed}」`;
    const nextIntent = `${intent.trim()}\n${appendix}`.trim();
    setIntent(nextIntent);
    setClarifyInputs((m) => {
      const next = { ...m };
      delete next[slot];
      return next;
    });
    runDraftFromIntent(nextIntent);
  };

  const skipClarify = (): void => {
    setBody((b) => appendOpenQuestionsSection(b, clarifyQuestions));
    setClarifyDismissed(true);
  };

  const openQuestions = clarifyDismissed ? [] : clarifyQuestions;
  const filledCount = filled.length;
  const openCount = openQuestions.length;
  const clarifyBadge =
    filledCount > 0 || openCount > 0
      ? openCount > 0
        ? `已补 ${filledCount} 条 · ${openCount} 个问题待答`
        : `已补 ${filledCount} 条`
      : null;

  const runSubmit = (work: () => void | Promise<void>): void => {
    if (submitting) return;
    setSubmitting(true);
    void Promise.resolve()
      .then(work)
      .catch(() => {
        /* parent surfaces errors; keep sheet open */
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div
      className="sheet-backdrop"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <h2>{pipelineMode ? 'New pipeline' : 'New task'}</h2>
        {restoredChip ? (
          <div className="create-draft-restored" data-evidence="task-draft-restored">
            <span className="create-draft-restored-text">
              已恢复未提交草稿 · {restoredMinutesAgo} 分钟前
            </span>
            <button
              type="button"
              className="link create-draft-discard"
              data-evidence="task-draft-discard"
              onClick={discardRestoredDraft}
            >
              丢弃
            </button>
          </div>
        ) : null}
        <div className="create-mode-field">
          <SegmentedControl
            ariaLabel="Create mode"
            value={createMode}
            onChange={setCreateMode}
            options={[
              { value: 'task', label: 'Task', hint: 'single agent' },
              { value: 'pipeline', label: 'Pipeline', hint: 'stages + adapters' },
            ]}
          />
        </div>
        <label>
          Repo
          <select
            value={repo}
            onChange={(e) => onRepoChange(e.target.value)}
            data-evidence="create-repo"
          >
            <option value="">Select repo…</option>
            {repos.map((r) => (
              <option key={r.key} value={r.key}>
                {r.key} ({r.effectiveAdapter}
                {r.readiness === 'incomplete' ? ', incomplete' : ''})
              </option>
            ))}
          </select>
        </label>
        {!pipelineMode && (
          <label>
            Intent (optional — generate plan)
            <textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              rows={3}
              placeholder="e.g. 把底栏 Logout 改成 Settings，语言+默认 agent…"
            />
          </label>
        )}
        {!pipelineMode && (
          <div className="create-intent-actions">
            <button
              type="button"
              className="link"
              disabled={intentBusy || intent.trim().length === 0 || !repo}
              onClick={() => runDraftFromIntent(intent)}
            >
              {intentBusy ? 'Generating…' : 'Generate DoD from intent'}
            </button>
            {draftSource || clarifyBadge ? (
              <span className="muted create-draft-source" data-evidence="create-draft-source">
                {[draftSource, clarifyBadge].filter(Boolean).join(' · ')}
              </span>
            ) : null}
            {draftNotes.length > 0 ? (
              <ul className="muted create-analyst-notes" data-evidence="create-analyst-notes">
                {draftNotes.map((n, i) => (
                  <li key={`${i}-${n.slice(0, 24)}`}>{n}</li>
                ))}
              </ul>
            ) : null}
            {jobId ? (
              <div
                className="create-analyst-activity"
                data-evidence="create-analyst-activity"
                data-status={job?.status ?? 'pending'}
                data-expanded={activityExpanded ? 'true' : 'false'}
              >
                <div className="create-analyst-phase">
                  analyst · {job ? PHASE_LABEL[job.phase] : '…'}
                  {job?.status === 'running' ? <span className="spinner" /> : null}
                  <button
                    type="button"
                    className="link create-analyst-expand"
                    data-evidence="create-analyst-expand"
                    aria-expanded={activityExpanded}
                    onClick={() => setActivityExpanded((v) => !v)}
                  >
                    {activityExpanded ? 'Collapse' : 'Expand'}
                  </button>
                </div>
                <ul className="create-analyst-tools">
                  {(job?.activity ?? [])
                    .slice(activityExpanded ? -12 : -4)
                    .map((row, i) => (
                      <li key={`${row.at}-${i}`}>
                        {row.kind === 'tool' ? `🔧 ${row.text}` : `▸ ${row.text}`}
                      </li>
                    ))}
                </ul>
                {job?.status === 'running' && job.thinking ? (
                  <div className="create-analyst-thinking muted">💭 {job.thinking}</div>
                ) : null}
                {job?.status === 'running' && job.narration ? (
                  <div className="create-analyst-narration muted">{job.narration}</div>
                ) : null}
                {job?.status === 'ready' && dirtyRef.current ? (
                  <div className="create-analyst-apply-row">
                    <button
                      type="button"
                      className="link"
                      data-evidence="create-draft-apply"
                      onClick={() => applyAnalystDraft(job)}
                    >
                      Apply analyst draft
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        onAckDraft(job.id);
                        setJobId(null);
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {filledCount > 0 ? (
              <div className="muted create-intent-filled" data-evidence="intent-filled">
                已补 {filledCount} 条验收标准
                {filled.length > 0 ? (
                  <ul className="create-intent-filled-list">
                    {filled.map((line, i) => (
                      <li key={`${i}-${line.slice(0, 24)}`}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {openQuestions.length > 0 ? (
              <div className="create-intent-clarify" data-evidence="intent-clarify">
                {openQuestions.map((q) => (
                  <div key={q.slot} className="create-intent-clarify-row">
                    <div className="create-intent-clarify-text">{q.text}</div>
                    {q.options && q.options.length > 0 ? (
                      <div className="create-intent-clarify-options">
                        {q.options.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            className="create-intent-clarify-option"
                            data-evidence="intent-clarify-option"
                            disabled={intentBusy}
                            onClick={() => answerClarify(q.slot, opt)}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="create-intent-clarify-input-row">
                        <input
                          type="text"
                          value={clarifyInputs[q.slot] ?? ''}
                          placeholder="一句话回答…"
                          disabled={intentBusy}
                          onChange={(e) =>
                            setClarifyInputs((m) => ({ ...m, [q.slot]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              answerClarify(q.slot, clarifyInputs[q.slot] ?? '');
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="link"
                          disabled={intentBusy || !(clarifyInputs[q.slot] ?? '').trim()}
                          onClick={() => answerClarify(q.slot, clarifyInputs[q.slot] ?? '')}
                        >
                          确认
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="link create-intent-clarify-skip"
                  data-evidence="intent-clarify-skip"
                  disabled={intentBusy}
                  onClick={skipClarify}
                >
                  就这样，直接派发
                </button>
              </div>
            ) : null}
            {intentWarn ? (
              <div className="muted create-intent-warn" data-evidence="create-intent-warn">
                {intentWarn}
              </div>
            ) : null}
          </div>
        )}
        <label>
          {pipelineMode ? 'Pipeline name' : 'Title'}
          <input
            value={title}
            onChange={(e) => {
              dirtyRef.current = true;
              const next = e.target.value;
              setTitle(next);
              if (next.trim().length === 0) setSlug(undefined);
            }}
            placeholder={pipelineMode ? 'act1-polish' : 'Fix the thing'}
          />
        </label>
        {!pipelineMode && slug ? (
          <div className="hint" data-evidence="create-slug-preview">
            {`id: <n>-${slug}`}
          </div>
        ) : null}
        {incompleteRepo ? (
          <div className="create-intent-warn create-onboard-banner" data-evidence="create-incomplete-repo">
            <p>
              Repo is <strong>incomplete</strong> — only tasks labeled{' '}
              <code>onboarding</code>/<code>readiness</code> will dispatch until you mark the
              repo ready (Repos). Prefer the <strong>4-stage readiness pipeline</strong> for
              heavy repos.
            </p>
            {!pipelineMode ? (
              <button
                type="button"
                className="primary"
                data-evidence="create-fill-onboarding"
                onClick={() => {
                  const d = draftOnboardingPlan(repo || 'repo');
                  setTitle(d.title);
                  setBody(d.body);
                  setAsPlan(true);
                  setIntentWarn('Filled single-task onboarding plan — edit then Create plan');
                }}
              >
                Fill onboarding checklist
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                data-evidence="create-fill-readiness-pipeline"
                onClick={() => {
                  const d = draftReadinessPipeline(repo || 'repo');
                  setTitle(d.title);
                  setStages(
                    d.stages.map((s) => ({
                      title: s.title,
                      body: s.body,
                      adapter: stageSeed,
                    })),
                  );
                  setIntentWarn(
                    `Filled R1–R4 readiness pipeline (${d.idPrefix}) — create to dispatch stage 1`,
                  );
                }}
              >
                Fill readiness pipeline
              </button>
            )}
          </div>
        ) : null}
        {!pipelineMode ? (
          <>
            <label>
              Agent
              <select
                value={hostExecutionClass ? 'grok' : (adapter ?? '')}
                onChange={(e) => setAdapter(e.target.value)}
                disabled={hostExecutionClass}
              >
                <option value="">Default → {inheritLabel}</option>
                {availableAgents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Execution
              <select
                value={executionClass}
                onChange={(event) => {
                  const next = event.target.value as ExecutionClass;
                  setExecutionClass(next);
                  if (next === 'host_operation' || next === 'deploy') setAdapter('grok');
                }}
              >
                <option value="implement">Implement</option>
                <option value="explore">Explore</option>
                <option value="verify">Verify</option>
                <option value="host_operation">Host operation</option>
                <option value="deploy">Deploy</option>
              </select>
            </label>
            <label className="human-ac-item">
              <input
                type="checkbox"
                checked={asPlan}
                onChange={(e) => setAsPlan(e.target.checked)}
              />
              <span>Save as plan (approve before agent runs)</span>
            </label>
            <label>
              Description
              <textarea
                value={body}
                onChange={(e) => {
                  dirtyRef.current = true;
                  setBody(e.target.value);
                }}
                rows={8}
                placeholder={AC_TEMPLATE}
              />
            </label>
            {acLint && acLint.findings.length > 0 ? (
              <ul className="ac-lint-list create-intent-warn" data-evidence="create-ac-lint">
                {acLint.findings.map((f, i) => (
                  <li
                    key={`${f.code}-${f.line ?? 'x'}-${i}`}
                    className={
                      f.severity === 'error'
                        ? 'ac-lint-error'
                        : f.severity === 'warn'
                          ? 'ac-lint-warn'
                          : 'ac-lint-info'
                    }
                  >
                    {f.severity === 'error' ? '✖' : f.severity === 'warn' ? '⚠' : 'ℹ'}{' '}
                    {f.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              className="link"
              disabled={body.trim().length > 0}
              onClick={() => setBody(AC_TEMPLATE)}
            >
              Insert typed DoD template
            </button>
            <span className="muted task-agent-hint">
              (mechanical)=L1 · (reviewer)=L3 · (human)=you · (human, after deploy)=after promote. Untyped → human.
            </span>
          </>
        ) : (
          <div className="pipeline-stages">
            <div className="body-label">Stages (linear · stage N waits on N−1)</div>
            {stages.map((stage, i) => (
              <div key={i} className="pipeline-stage-card">
                <div className="pipeline-stage-head">
                  <strong>
                    {i + 1}/{stages.length}
                  </strong>
                  {stages.length > 2 && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => setStages((s) => s.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <label>
                  Stage title
                  <input
                    value={stage.title}
                    onChange={(e) =>
                      setStages((s) =>
                        s.map((st, j) => (j === i ? { ...st, title: e.target.value } : st)),
                      )
                    }
                    placeholder={`Stage ${i + 1}`}
                  />
                </label>
                <label>
                  Agent
                  <select
                    value={stage.adapter}
                    onChange={(e) =>
                      setStages((s) =>
                        s.map((st, j) => (j === i ? { ...st, adapter: e.target.value } : st)),
                      )
                    }
                  >
                    <option value="">Default → {inheritLabel}</option>
                    {availableAgents.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Body
                  <textarea
                    value={stage.body}
                    onChange={(e) =>
                      setStages((s) =>
                        s.map((st, j) => (j === i ? { ...st, body: e.target.value } : st)),
                      )
                    }
                    rows={3}
                    placeholder="What this stage should do…"
                  />
                </label>
              </div>
            ))}
            {stages.length < 12 && (
              <button
                type="button"
                className="link"
                onClick={() =>
                  setStages((s) => [...s, { title: `Stage ${s.length + 1}`, body: '', adapter: '' }])
                }
              >
                + Add stage
              </button>
            )}
          </div>
        )}
        <div className="actions">
          <button
            type="button"
            className="primary"
            data-evidence="create-submit"
            disabled={!canSubmit}
            aria-busy={submitting}
            onClick={() => {
              const submitRepo = repo;
              runSubmit(() => {
                if (pipelineMode) {
                  // Incomplete repos: auto-tag every stage so G8 still admits the chain.
                  const stageLabels = incompleteRepo
                    ? (['onboarding', 'readiness'] as const)
                    : undefined;
                  const readinessDraft =
                    incompleteRepo && stages.length === 4
                      ? draftReadinessPipeline(repo)
                      : null;
                  return Promise.resolve(
                    onCreatePipeline({
                      title: title.trim(),
                      repo,
                      ...(readinessDraft && title.trim() === readinessDraft.title
                        ? { idPrefix: readinessDraft.idPrefix, priority: readinessDraft.priority }
                        : {}),
                      stages: stages.map((s) => ({
                        title: s.title.trim(),
                        body: s.body.trim() || undefined,
                        adapter: s.adapter === '' ? null : (s.adapter as AdapterKind),
                        ...(stageLabels ? { labels: [...stageLabels] } : {}),
                      })),
                    }),
                  ).then(() => {
                    clearDraftAfterSuccess(submitRepo);
                  });
                }
                const labels = new Set<string>();
                if (asPlan) labels.add('needs-plan');
                // Incomplete repos only dispatch onboarding/readiness — auto-tag so
                // create does not silently park the task forever.
                if (incompleteRepo) {
                  labels.add('onboarding');
                  labels.add('readiness');
                }
                return Promise.resolve(
                  onCreate({
                    title: title.trim(),
                    repo,
                    body: body.trim() || undefined,
                    ...(slug ? { slug } : {}),
                    adapter: adapter === '' ? null : (adapter as AdapterKind),
                    executionClass,
                    planPending: asPlan,
                    labels: labels.size > 0 ? [...labels] : undefined,
                  }),
                ).then(() => {
                  clearDraftAfterSuccess(submitRepo);
                });
              });
            }}
          >
            {submitting ? (
              <>
                <span className="spinner" data-evidence="create-submitting" /> Creating…
              </>
            ) : pipelineMode ? (
              `Create ${stages.length} tasks`
            ) : acLint && acLint.counts.error > 0 ? (
              `Create anyway (${acLint.counts.error} AC errors)`
            ) : asPlan ? (
              'Create plan'
            ) : (
              'Create'
            )}
          </button>
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
