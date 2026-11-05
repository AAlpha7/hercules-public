import { describe, expect, it, vi } from 'vitest';
import {
  Analyst,
  ANALYST_SESSION_RULES,
  analystPrompt,
  parseAnalystOutput,
} from '../../src/orchestrator/analyst.js';
import type { AnalystRepoContext } from '../../src/orchestrator/analystContext.js';
import type { AnalystActivity } from '../../src/domain/analystActivity.js';
import type { RepoConfig } from '../../src/domain/repos.js';
import type { ReviewRunner } from '../../src/verification/reviewer.js';

const repo: RepoConfig = {
  key: 'app',
  url: 'x',
  defaultBranch: 'main',
  workflow: 'WORKFLOW.md',
  maxConcurrent: 1,
  adapter: null,
  readiness: 'ready',
};

const context: AnalystRepoContext = {
  repoKey: 'app',
  archetype: 'code',
  agentsMd: '# Agents\nBe careful.\n',
  workflowGates: ['typecheck', 'lint', 'test'],
  protectedPaths: ['WORKFLOW.md', 'AGENTS.md'],
  evidenceAnchors: ['create-draft-source', 'task-card'],
  testFiles: ['test/domain/foo.test.ts', 'test/web/bar.spec.tsx'],
  intentHits: ['src/web/CreateForm.tsx:10:intent draft'],
};

function cleanJsonDraft(overrides?: {
  body?: string;
  notes?: string[];
  labels?: string[];
}): string {
  const body =
    overrides?.body ??
    [
      '## Intent',
      'Add bound draft from intent',
      '',
      '## Acceptance criteria',
      '- [ ] (mechanical) Draft binds a named test @test:test/orchestrator/analyst.test.ts#parses last json',
      '- [ ] (reviewer) Spirit matches intent',
      '- [ ] (human) Phone owner approves the plan on Approve plan',
    ].join('\n');
  return [
    'Here is the draft.',
    '```json',
    JSON.stringify({
      title: 'Bound draft from intent',
      body,
      labels: overrides?.labels ?? ['ui'],
      priority: 2,
      notes: overrides?.notes ?? ['Assumes existing create form'],
    }),
    '```',
  ].join('\n');
}

describe('analystPrompt', () => {
  it('contains the grammar cheat-sheet and context sections', () => {
    const p = analystPrompt({
      intent: 'Add analyst badge to create form',
      context,
    });
    expect(p).toContain('Criterion line: - [ ] (<kind>) <claim> @<binding>');
    expect(p).toContain('@test:<path>#<title>');
    expect(p).toContain('@evidence:<anchor>');
    expect(p).toContain('never use @gate: as the only proof');
    expect(p).toContain(
      'Never write `data-evidence=<anchor>` inside claim text — any anchor named in prose becomes a hard L2 assert',
    );
    expect(p).toContain('### Workflow gates');
    expect(p).toContain('- typecheck');
    expect(p).toContain('### Protected paths');
    expect(p).toContain('- WORKFLOW.md');
    expect(p).toContain('### Evidence anchors');
    expect(p).toContain('- create-draft-source');
    expect(p).toContain('### Test files');
    expect(p).toContain('- test/domain/foo.test.ts');
    expect(p).toContain('### Intent keyword hits');
    expect(p).toContain('src/web/CreateForm.tsx:10:intent draft');
    expect(p).toContain('### AGENTS.md');
    expect(p).toContain('Be careful.');
    expect(p).toContain('## Human intent');
    expect(p).toContain('Add analyst badge to create form');
  });

  it('includes lint feedback on repair round', () => {
    const p = analystPrompt({
      intent: 'x'.repeat(20),
      context,
      lintFeedback: {
        ok: false,
        findings: [
          {
            severity: 'error',
            code: 'unbound-mechanical',
            message: 'add a binding',
            line: 3,
          },
        ],
        counts: { error: 1, warn: 0, info: 0 },
      },
    });
    expect(p).toContain('Fix every error; keep the rest');
    expect(p).toContain('unbound-mechanical');
  });

  it('output contract asks for an English slug', () => {
    const p = analystPrompt({
      intent: '把任务按最后活跃时间排序',
      context,
    });
    expect(p).toContain('"slug"');
    expect(p).toContain('ALWAYS in English');
  });
});

describe('parseAnalystOutput', () => {
  it('picks the last fenced json block', () => {
    const text = [
      '```json',
      JSON.stringify({ title: 'First', body: '## Intent\na', labels: [], priority: 1, notes: [] }),
      '```',
      'commentary',
      '```json',
      JSON.stringify({
        title: 'Second title wins',
        body: '## Intent\nb\n## Acceptance criteria\n- [ ] (human) ok',
        labels: ['x'],
        priority: 4,
        notes: ['n1'],
      }),
      '```',
    ].join('\n');
    const parsed = parseAnalystOutput(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('Second title wins');
    expect(parsed!.priority).toBe(4);
    expect(parsed!.notes).toEqual(['n1']);
  });

  it('survives fences inside the body (## Evidence yaml block)', () => {
    const body = [
      '## Intent',
      'skeleton while loading',
      '## Acceptance criteria',
      '- [ ] (human) phone check',
      '## Evidence',
      '```yaml',
      '- action: click',
      '  selector: "[data-evidence=nav-releases]"',
      '```',
      '## Out of scope',
      '- `WORKFLOW.md`',
    ].join('\n');
    const text = [
      'I inspected the panel first.',
      '```json',
      JSON.stringify({ title: 'Releases skeleton', body, labels: ['ui'], priority: 2, notes: [] }),
      '```',
    ].join('\n');
    const parsed = parseAnalystOutput(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('Releases skeleton');
    expect(parsed!.body).toBe(body);
    expect(parsed!.labels).toEqual(['ui']);
  });

  it('returns null for invalid output', () => {
    expect(parseAnalystOutput('no fence')).toBeNull();
    expect(parseAnalystOutput('```json\n{not json}\n```')).toBeNull();
    expect(
      parseAnalystOutput('```json\n{"title":"","body":"x","labels":[],"priority":1,"notes":[]}\n```'),
    ).toBeNull();
  });

  it('keeps a valid slug from the model output', () => {
    const text = [
      '```json',
      JSON.stringify({
        title: 'Sort tasks by last active',
        slug: 'sort-tasks-by-last-active',
        body: '## Intent\nsort\n## Acceptance criteria\n- [ ] (human) ok',
        labels: [],
        priority: 2,
        notes: [],
      }),
      '```',
    ].join('\n');
    const parsed = parseAnalystOutput(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.slug).toBe('sort-tasks-by-last-active');
  });

  it('normalises a title-cased slug to lowercase hyphenated form', () => {
    const text = [
      '```json',
      JSON.stringify({
        title: '中文标题',
        slug: 'Sort Tasks By Active',
        body: '## Intent\nsort\n## Acceptance criteria\n- [ ] (human) ok',
        labels: [],
        priority: 2,
        notes: [],
      }),
      '```',
    ].join('\n');
    const parsed = parseAnalystOutput(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.slug).toBe('sort-tasks-by-active');
  });

  it('drops an unusable slug and falls back to shortSlug(title)', () => {
    const text = [
      '```json',
      JSON.stringify({
        title: 'Fix upload retry path',
        slug: '排序',
        body: '## Intent\nfix\n## Acceptance criteria\n- [ ] (human) ok',
        labels: [],
        priority: 2,
        notes: [],
      }),
      '```',
    ].join('\n');
    const parsed = parseAnalystOutput(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.slug).toBe('fix-upload-retry-path');
  });

  it('omits slug when both model slug and title yield nothing usable', () => {
    const text = [
      '```json',
      JSON.stringify({
        title: '排序任务列表',
        slug: '排序',
        body: '## Intent\nsort\n## Acceptance criteria\n- [ ] (human) ok',
        labels: [],
        priority: 2,
        notes: [],
      }),
      '```',
    ].join('\n');
    const parsed = parseAnalystOutput(text);
    expect(parsed).not.toBeNull();
    expect(parsed!).not.toHaveProperty('slug');
  });
});

describe('Analyst.draft', () => {
  it('falls back to heuristic on invalid output with analyst unavailable warning', async () => {
    const run: ReviewRunner = vi.fn(async () => 'I refuse to draft JSON');
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Fix flaky upload retry in the orchestrator drain path carefully',
      repo,
      context,
    });
    expect(draft.source).toBe('heuristic');
    expect(draft.repairRounds).toBe(0);
    expect(draft.notes).toEqual([]);
    expect(draft.labels).toContain('needs-plan');
    expect(draft.warnings.some((w) => w.startsWith('analyst unavailable:'))).toBe(true);
    expect(draft.warnings.join('\n')).not.toMatch(/I refuse/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes the snapshot cwd to the runner only when given', async () => {
    const run = vi.fn<ReviewRunner>(async () => cleanJsonDraft());
    const a = new Analyst(run, { timeoutMs: 5_000 });
    await a.draft({ intent: 'Add named analyst test coverage', repo, context, cwd: '/snap' });
    expect(run.mock.calls[0]![1]?.cwd).toBe('/snap');
    await a.draft({ intent: 'Add named analyst test coverage', repo, context });
    expect(run.mock.calls[1]![1]).not.toHaveProperty('cwd');
  });

  it('prompt states the read-only snapshot scope before the output contract', () => {
    const prompt = analystPrompt({ intent: 'x', context });
    const scope = prompt.indexOf('## Scope');
    expect(scope).toBeGreaterThan(0);
    expect(prompt.indexOf('## Output contract')).toBeGreaterThan(scope);
    expect(prompt).toContain('read-only snapshot');
  });

  it('session rules forbid continuity / host reads', () => {
    expect(ANALYST_SESSION_RULES.length).toBeGreaterThan(0);
    expect(ANALYST_SESSION_RULES).toContain('continuity');
  });

  it('skips repair when round-1 lint is clean', async () => {
    const run: ReviewRunner = vi.fn(async () => cleanJsonDraft());
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Add named analyst test coverage for the draft parser',
      repo,
      context,
    });
    expect(draft.source).toBe('analyst');
    expect(draft.repairRounds).toBe(0);
    expect(draft.lint.counts.error).toBe(0);
    expect(draft.labels).toContain('needs-plan');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('emits draft/tool/done when onActivity is set and lint is clean', async () => {
    const events: AnalystActivity[] = [];
    const run: ReviewRunner = vi.fn(async (_prompt, opts) => {
      opts?.onActivity?.({ kind: 'tool', tool: 'read_file', target: 'x' });
      return cleanJsonDraft();
    });
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Stream analyst phases for a clean draft',
      repo,
      context,
      onActivity: (e) => {
        events.push(e);
      },
    });
    expect(draft.source).toBe('analyst');
    expect(events).toEqual([
      { kind: 'phase', phase: 'draft' },
      { kind: 'tool', tool: 'read_file', target: 'x' },
      { kind: 'phase', phase: 'done' },
    ]);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ onActivity: expect.any(Function) }),
    );
  });

  it('emits draft, repair, done across a lint repair round', async () => {
    const unboundBody = [
      '## Intent',
      'bad',
      '',
      '## Acceptance criteria',
      '- [ ] (mechanical) unbound claim without binding',
      '- [ ] (human) look',
    ].join('\n');
    const cleanBody = [
      '## Intent',
      'good',
      '',
      '## Acceptance criteria',
      '- [ ] (mechanical) named test exists @test:test/orchestrator/analyst.test.ts#repair round',
      '- [ ] (human) Phone approve',
    ].join('\n');
    const phases: AnalystActivity[] = [];
    const run: ReviewRunner = vi
      .fn()
      .mockResolvedValueOnce(cleanJsonDraft({ body: unboundBody }))
      .mockResolvedValueOnce(cleanJsonDraft({ body: cleanBody }));
    const a = new Analyst(run, { timeoutMs: 5_000 });
    await a.draft({
      intent: 'Phase sequence must include repair',
      repo,
      context,
      onActivity: (e) => {
        if (e.kind === 'phase') phases.push(e);
      },
    });
    expect(phases).toEqual([
      { kind: 'phase', phase: 'draft' },
      { kind: 'phase', phase: 'repair' },
      { kind: 'phase', phase: 'done' },
    ]);
  });

  it('emits draft, done on invalid output fallback', async () => {
    const phases: AnalystActivity[] = [];
    const run: ReviewRunner = vi.fn(async () => 'not a draft');
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Invalid output still emits done before heuristic fallback',
      repo,
      context,
      onActivity: (e) => {
        if (e.kind === 'phase') phases.push(e);
      },
    });
    expect(draft.source).toBe('heuristic');
    expect(phases).toEqual([
      { kind: 'phase', phase: 'draft' },
      { kind: 'phase', phase: 'done' },
    ]);
  });

  it('throwing onActivity never changes the returned draft', async () => {
    const run: ReviewRunner = vi.fn(async () => cleanJsonDraft());
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Listener exceptions must not alter the draft result',
      repo,
      context,
      onActivity: () => {
        throw new Error('listener boom');
      },
    });
    expect(draft.source).toBe('analyst');
    expect(draft.title).toBe('Bound draft from intent');
    expect(draft.repairRounds).toBe(0);
  });

  it('runs exactly one repair round on lint errors and keeps better draft', async () => {
    const unboundBody = [
      '## Intent',
      'bad',
      '',
      '## Acceptance criteria',
      '- [ ] (mechanical) unbound claim without binding',
      '- [ ] (human) look',
    ].join('\n');
    const cleanBody = [
      '## Intent',
      'good',
      '',
      '## Acceptance criteria',
      '- [ ] (mechanical) named test exists @test:test/orchestrator/analyst.test.ts#repair round',
      '- [ ] (human) Phone approve',
    ].join('\n');
    const run: ReviewRunner = vi
      .fn()
      .mockResolvedValueOnce(cleanJsonDraft({ body: unboundBody }))
      .mockResolvedValueOnce(cleanJsonDraft({ body: cleanBody, notes: ['repaired'] }));
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Repair unbound mechanical criteria in analyst drafts',
      repo,
      context,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(draft.repairRounds).toBe(1);
    expect(draft.source).toBe('analyst');
    expect(draft.body).toContain('@test:test/orchestrator/analyst.test.ts#repair round');
    expect(draft.notes).toEqual(['repaired']);
    expect(draft.lint.counts.error).toBe(0);
  });

  it('keeps round-1 when repair does not reduce errors', async () => {
    const unbound = [
      '## Intent',
      'still bad',
      '',
      '## Acceptance criteria',
      '- [ ] (mechanical) still unbound',
      '- [ ] (human) look',
    ].join('\n');
    const run: ReviewRunner = vi
      .fn()
      .mockResolvedValueOnce(cleanJsonDraft({ body: unbound, notes: ['round1'] }))
      .mockResolvedValueOnce(cleanJsonDraft({ body: unbound, notes: ['round2'] }));
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Keep first draft when repair fails to improve lint',
      repo,
      context,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(draft.repairRounds).toBe(1);
    expect(draft.notes).toEqual(['round1']);
    expect(draft.lint.counts.error).toBeGreaterThan(0);
  });

  it('always includes needs-plan and maps question notes to slot questions (≤ 3)', async () => {
    const run: ReviewRunner = vi.fn(async () =>
      cleanJsonDraft({
        notes: [
          'question: which screen?',
          'question: what should the badge show?',
          'question: how do we know it is done — gates green?',
          'question: fourth should be dropped',
          'assumption: keep create form',
        ],
        labels: ['needs-plan', 'ui'],
      }),
    );
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Clarify settings sheet language before shipping',
      repo,
      context,
    });
    expect(draft.labels.filter((l) => l === 'needs-plan')).toHaveLength(1);
    expect(draft.vague).toBe(true);
    expect(draft.questions.length).toBeGreaterThan(0);
    expect(draft.questions.length).toBeLessThanOrEqual(3);
    expect(draft.questions.map((q) => q.slot)).toContain('where');
    expect(draft.questions.some((q) => q.slot === 'done_when')).toBe(true);
    expect(draft.warnings.join('\n')).not.toMatch(/Intent looks vague/);
    expect(draft.filled.some((f) => /已补验收标准/.test(f))).toBe(true);
  });

  it('infers what slot by default for ambiguous question notes', async () => {
    const run: ReviewRunner = vi.fn(async () =>
      cleanJsonDraft({ notes: ['question: confirm phone copy?'] }),
    );
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Show badge after draft on create form',
      repo,
      context,
    });
    expect(draft.questions).toHaveLength(1);
    expect(draft.questions[0]?.slot).toBe('what');
  });

  it('runner infra errors surface a redacted stderr detail (never raw secrets)', async () => {
    const run: ReviewRunner = vi.fn(async () => {
      throw new Error(
        'L3 reviewer infrastructure failed: sandbox reports bwrap but required read-deny mounts are not in effect; refusing to start\nXAI_API_KEY=sk-secret-should-not-leak',
      );
    });
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({
      intent: 'Runner failure must not leak stderr into the task body',
      repo,
      context,
    });
    expect(draft.source).toBe('heuristic');
    expect(draft.warnings.some((w) => /analyst unavailable:.*refusing to start/i.test(w))).toBe(
      true,
    );
    expect(draft.warnings.join('\n')).not.toContain('sk-secret');
  });

  it('falls back on timeout without raw model text', async () => {
    const run: ReviewRunner = vi.fn(async (_prompt, opts) => {
      return await new Promise<string>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const a = new Analyst(run, { timeoutMs: 30 });
    const phases: string[] = [];
    const draft = await a.draft({
      intent: 'Timeout should become heuristic fallback without secrets',
      repo,
      context,
      onActivity: (act: AnalystActivity) => {
        if (act.kind === 'phase') phases.push(act.phase);
      },
    });
    expect(draft.source).toBe('heuristic');
    expect(draft.warnings.some((w) => /analyst unavailable:.*timeout \(after retry\)/i.test(w))).toBe(
      true,
    );
    // One retry with a fresh budget, visible as a phase, then fallback.
    expect(run).toHaveBeenCalledTimes(2);
    expect(phases).toEqual(['draft', 'retry', 'done']);
  });

  it('retries once after a timeout and keeps the analyst draft when the retry succeeds', async () => {
    let calls = 0;
    const run: ReviewRunner = vi.fn(async (_prompt, opts) => {
      calls += 1;
      if (calls === 1) {
        return await new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return cleanJsonDraft();
    });
    const a = new Analyst(run, { timeoutMs: 30 });
    const phases: string[] = [];
    const draft = await a.draft({
      intent: 'First turn stalls, second turn drafts',
      repo,
      context,
      onActivity: (act: AnalystActivity) => {
        if (act.kind === 'phase') phases.push(act.phase);
      },
    });
    expect(draft.source).toBe('analyst');
    expect(draft.warnings.some((w) => /analyst unavailable/i.test(w))).toBe(false);
    expect(phases).toEqual(['draft', 'retry', 'done']);
  });

  it('does not retry runner errors (only timeouts)', async () => {
    const run: ReviewRunner = vi.fn(async () => {
      throw new Error('spawn ENOENT grok');
    });
    const a = new Analyst(run, { timeoutMs: 5_000 });
    const draft = await a.draft({ intent: 'Runner is dead', repo, context });
    expect(draft.source).toBe('heuristic');
    expect(run).toHaveBeenCalledTimes(1);
    expect(draft.warnings.some((w) => /analyst unavailable:.*ENOENT/i.test(w))).toBe(true);
  });

  it('repair round gets its own timeout budget', async () => {
    vi.useFakeTimers();
    try {
      const unboundBody = [
        '## Intent',
        'bad',
        '',
        '## Acceptance criteria',
        '- [ ] (mechanical) unbound claim without binding',
        '- [ ] (human) look',
      ].join('\n');
      const cleanBody = [
        '## Intent',
        'good',
        '',
        '## Acceptance criteria',
        '- [ ] (mechanical) named test exists @test:test/orchestrator/analyst.test.ts#repair round',
        '- [ ] (human) Phone approve',
      ].join('\n');

      type Deferred = {
        resolve: (v: string) => void;
        promise: Promise<string>;
      };
      const makeDeferred = (): Deferred => {
        let resolve!: (v: string) => void;
        const promise = new Promise<string>((r) => {
          resolve = r;
        });
        return { resolve, promise };
      };

      const signals: AbortSignal[] = [];
      const call1 = makeDeferred();
      const call2 = makeDeferred();
      let callCount = 0;
      const run: ReviewRunner = vi.fn(async (_prompt, opts) => {
        const signal = opts?.signal;
        if (signal) signals.push(signal);
        callCount += 1;
        if (callCount === 1) return call1.promise;
        return call2.promise;
      });

      const a = new Analyst(run, { timeoutMs: 1000 });
      const draftPromise = a.draft({
        intent: 'Repair unbound mechanical criteria with a fresh timeout budget',
        repo,
        context,
      });

      // Let the first attempt start and record its signal.
      await Promise.resolve();
      expect(signals).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(800);
      call1.resolve(cleanJsonDraft({ body: unboundBody }));

      // Flush until the repair attempt starts (fresh AbortController).
      for (let i = 0; i < 20 && signals.length < 2; i += 1) {
        await Promise.resolve();
      }
      expect(signals).toHaveLength(2);
      expect(signals[0]).not.toBe(signals[1]);

      // Shared outer timer would have fired at 1000ms total; per-attempt
      // budget still has 500ms left on call 2 after this advance.
      await vi.advanceTimersByTimeAsync(500);
      expect(signals[1]!.aborted).toBe(false);

      call2.resolve(cleanJsonDraft({ body: cleanBody, notes: ['repaired'] }));
      const draft = await draftPromise;

      expect(draft.source).toBe('analyst');
      expect(draft.repairRounds).toBe(1);
      expect(draft.body).toContain('@test:test/orchestrator/analyst.test.ts#repair round');
    } finally {
      vi.useRealTimers();
    }
  });
});
