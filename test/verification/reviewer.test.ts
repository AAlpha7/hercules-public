import { describe, it, expect } from 'vitest';
import {
  reviewerPrompt,
  parseVerdict,
  hasValidVerdictLine,
  Reviewer,
  ReviewerInfraError,
} from '../../src/verification/reviewer.js';
import { isVerificationAborted } from '../../src/domain/verificationRun.js';
import type { Task } from '../../src/domain/task.js';
import type { CheatFinding } from '../../src/domain/verification.js';

const task: Task = {
  id: 'T-1',
  title: 'Fix upload retry',
  repo: 'app',
  state: 'in_progress',
  priority: 1,
  blockedBy: [],
  labels: [],
  adapter: null,
  agentSession: null,
    pendingSteer: null,
  attempts: 0,
  lastEventAt: null, createdAt: null, startedAt: null, endedAt: null,
  prUrl: null,
  prStatus: null,
  planPending: false,
  body: '## Task\nfix it\n\n## Acceptance criteria\n- [ ] retried 3x',
};

const cheats: CheatFinding[] = [
  { kind: 'test-edit', file: 'src/foo.test.ts', detail: 'edits a test file' },
];

describe('reviewerPrompt (SPEC §9.3, §9.5)', () => {
  it('includes the diff, acceptance criteria, cheat findings, and the spirit check', () => {
    const prompt = reviewerPrompt({
      task,
      diff: 'diff --git a/x b/x\n+const a = 1;',
      cheatFindings: cheats,
      principles: 'domain must not import web',
    });
    expect(prompt).toContain('Acceptance criteria');
    expect(prompt).toContain('const a = 1;');
    expect(prompt).toContain('domain must not import web');
    expect(prompt).toContain('src/foo.test.ts');
    expect(prompt.toLowerCase()).toContain('spirit');
    expect(prompt).toContain('VERDICT:');
    // L5 is L3's job — human is not the anti-cheat queue
    expect(prompt).toMatch(/YOUR job/i);
    expect(prompt).toMatch(/test-edit/i);
    // Placeholder data-evidence chrome must be judged for real functionality
    expect(prompt).toMatch(/data-evidence/i);
    expect(prompt).toMatch(/real (function|functionality)|真实功能/i);
    // Test-integrity (removed/renamed cases) is separate from ordinary test-edit
    // and remains a mechanical critical gate the reviewer cannot override.
    expect(prompt).toMatch(/test-integrity/i);
    expect(prompt).toMatch(/cannot be overridden|mechanical|not override/i);
  });

  it('adds a Gate toolchain edits scrutinize section when findings are present', () => {
    const prompt = reviewerPrompt({
      task,
      diff: '+x',
      cheatFindings: [
        {
          kind: 'gate-toolchain-edit',
          file: 'package.json',
          detail: 'package.json script "typecheck" changed: "a" → "b"',
        },
      ],
      principles: '',
    });
    expect(prompt).toContain('## Gate toolchain edits (scrutinize)');
    expect(prompt).toContain('package.json: package.json script "typecheck" changed');
    expect(prompt).toMatch(/does not weaken, skip, or pre-empt any gate/i);
  });

  it('adds a Verifier source edits scrutinize section when findings are present', () => {
    const prompt = reviewerPrompt({
      task,
      diff: '+x',
      cheatFindings: [
        {
          kind: 'verifier-edit',
          file: 'src/domain/evidence.ts',
          detail: 'edits verifier/acceptance source',
        },
      ],
      principles: '',
    });
    expect(prompt).toContain('## Verifier source edits (scrutinize)');
    expect(prompt).toContain('- src/domain/evidence.ts');
    expect(prompt).toMatch(/special-cases a task id/i);
  });
});

describe('parseVerdict', () => {
  it('parses an approval', () => {
    const v = parseVerdict('Looks good.\n\nVERDICT: approved\nSUMMARY: meets all criteria');
    expect(v.approved).toBe(true);
    expect(v.summary).toContain('meets all criteria');
  });

  it('parses a changes-requested verdict with comments', () => {
    const text = `VERDICT: changes_requested
SUMMARY: missing a test
- add a regression test
- handle the null case`;
    const v = parseVerdict(text);
    expect(v.approved).toBe(false);
    expect(v.comments).toEqual(['add a regression test', 'handle the null case']);
  });

  it('defaults to not-approved when no verdict line is present', () => {
    const v = parseVerdict('I am unsure about this.');
    expect(v.approved).toBe(false);
  });
});

describe('Reviewer', () => {
  it('runs a fresh review and returns the parsed verdict', async () => {
    let gotPrompt = '';
    const reviewer = new Reviewer(async (prompt) => {
      gotPrompt = prompt;
      return 'VERDICT: approved\nSUMMARY: ok';
    });
    const verdict = await reviewer.review({
      task,
      diff: '+x',
      cheatFindings: [],
      principles: '',
    });
    expect(verdict.approved).toBe(true);
    expect(gotPrompt).toContain('Acceptance criteria');
    expect(verdict.inputTruncation).toBeUndefined();
  });

  it('attaches inputTruncation when the diff exceeds the L3 ARG_MAX cap', async () => {
    const reviewer = new Reviewer(async () => 'VERDICT: approved\nSUMMARY: ok');
    const big = 'x'.repeat(80_001);
    const verdict = await reviewer.review({
      task,
      diff: big,
      cheatFindings: [],
      principles: '',
    });
    expect(verdict.approved).toBe(true);
    expect(verdict.inputTruncation).toEqual({ diffChars: 80_001, maxChars: 80_000 });
  });
});

describe('SUMMARY_ZH (executive summary line)', () => {
  it('prompt requests it and parseVerdict extracts it', () => {
    const p = reviewerPrompt({
      task: { id: 'T', title: 't', body: '' } as never,
      diff: 'x',
      cheatFindings: [],
      principles: '',
      dod: { criteria: [], needsReviewer: false, needsHuman: false, hasMechanical: false, hasSection: false, warnings: [] },
    });
    expect(p).toMatch(/SUMMARY_ZH:/);
    const v = parseVerdict(
      'looks fine\nVERDICT: approved\nSUMMARY: solid retry fix\nSUMMARY_ZH: 修复了上传重试在弱网下的丢失问题\n',
    );
    expect(v.summaryZh).toBe('修复了上传重试在弱网下的丢失问题');
  });

  it('summaryZh is absent when the model omits it (older sessions)', () => {
    const v = parseVerdict('VERDICT: approved\nSUMMARY: ok\n');
    expect(v.summaryZh).toBeUndefined();
  });
});

describe('L3 must be told when the task edits WORKFLOW (impossible-standard guard)', () => {
  // l2-control-fixture burned 3 more attempts after L2 was already excused:
  // the reviewer requested changes because "L2 still ends on an empty plane"
  // — the exact thing the trusted-mirror rule makes impossible pre-merge
  // (2026-07-26). Tell L3, or it enforces a standard nothing can meet.
  const task = {
    id: 't', title: 'edit workflow', repo: 'app', state: 'in_progress',
    priority: 100, blockedBy: [], labels: [], adapter: null, agentSession: null,
    pendingSteer: null, attempts: 0, lastEventAt: null, createdAt: null,
    startedAt: null, endedAt: null, prUrl: null, prStatus: null,
    planPending: false, body: '## Task\nchange boot',
  } as unknown as Parameters<typeof reviewerPrompt>[0]['task'];

  it('warns the reviewer when WORKFLOW is in the diff', () => {
    const p = reviewerPrompt({
      task, diff: 'diff --git a/WORKFLOW.md b/WORKFLOW.md\n+boot: new',
      cheatFindings: [], principles: '', workflowSelfChanged: true,
    });
    expect(p).toMatch(/WORKFLOW/);
    expect(p).toMatch(/合并后|after merge|不可能|cannot/i);
  });

  it('says nothing extra for a normal task', () => {
    const p = reviewerPrompt({
      task, diff: 'diff --git a/src/x.ts b/src/x.ts\n+x',
      cheatFindings: [], principles: '', workflowSelfChanged: false,
    });
    expect(p).not.toMatch(/合并后才生效|cannot exercise its own/i);
  });
});

describe('reviewer infrastructure failure is typed — never parsed into a verdict', () => {
  it('propagates ReviewerInfraError from the runner instead of returning changes_requested', async () => {
    const reviewer = new Reviewer(async () => {
      throw new ReviewerInfraError('L3 reviewer infrastructure failed: Not signed in');
    });
    const pending = reviewer.review({ task, diff: '+x', cheatFindings: [], principles: '' });
    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
    await expect(pending).rejects.toThrow(/Not signed in/);
  });

  it('is not mistaken for a human cancel abort', () => {
    expect(isVerificationAborted(new ReviewerInfraError('boom'))).toBe(false);
  });
});

describe('Reviewer.review central verdict gate — exact line or infrastructure failure', () => {
  it.each([
    ['VERDICT: approved_but_unverified\nSUMMARY: hedge'],
    ['VERDICT: changes_requested_later\nSUMMARY: hedge'],
    ['VERDICT: approve\nSUMMARY: prefix only'],
    ['VERDICT: approved\nVERDICT: changes_requested\nSUMMARY: conflict'],
    ['VERDICT: approved\nVERDICT: approved\nSUMMARY: duplicate'],
    ['VERDICT: approved\nVERDICT: approved_but_unverified\nSUMMARY: valid+malformed'],
    ['VERDICT: changes_requested\nVERDICT: wat\nSUMMARY: valid+unknown'],
    ['error: Not signed in. Run grok login.'],
    [''],
  ])('rejects non-exact runner output %j without leaking it', async (text) => {
    const reviewer = new Reviewer(async () => text);
    const pending = reviewer.review({ task, diff: '+x', cheatFindings: [], principles: '' });
    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
    // The durable error must not carry raw runner output.
    await expect(pending).rejects.not.toThrow(/Not signed in|approved_but|hedge/);
  });

  it.each([
    ['critique\nVERDICT: approved\nSUMMARY: ok', true],
    ['critique\n  verdict: APPROVED  \nSUMMARY: ok', true],
    ['critique\nVERDICT: changes_requested\nSUMMARY: fix x\n- do x', false],
  ])('accepts exact verdict %j → approved=%s', async (text, approved) => {
    const reviewer = new Reviewer(async () => text);
    const v = await reviewer.review({ task, diff: '+x', cheatFindings: [], principles: '' });
    expect(v.approved).toBe(approved);
  });

  it('hasValidVerdictLine is exact-line only and rejects duplicate/conflicting verdicts', () => {
    expect(hasValidVerdictLine('VERDICT: approved')).toBe(true);
    expect(hasValidVerdictLine('  VERDICT: Changes_Requested  ')).toBe(true);
    expect(hasValidVerdictLine('VERDICT: approved_but_unverified')).toBe(false);
    expect(hasValidVerdictLine('VERDICT: changes_requested_later')).toBe(false);
    expect(hasValidVerdictLine('VERDICT: approv')).toBe(false);
    expect(hasValidVerdictLine('prefix VERDICT: approved')).toBe(false);
    expect(hasValidVerdictLine('')).toBe(false);
    expect(hasValidVerdictLine('VERDICT: approved\nVERDICT: changes_requested')).toBe(false);
    expect(hasValidVerdictLine('VERDICT: approved\nVERDICT: approved')).toBe(false);
    // Valid-plus-malformed: the malformed field line still counts as a field.
    expect(hasValidVerdictLine('VERDICT: approved\nVERDICT: approved_but_unverified')).toBe(
      false,
    );
    expect(hasValidVerdictLine('VERDICT: changes_requested\nVERDICT: wat')).toBe(false);
    // Prose mentioning VERDICT mid-line is not a field line.
    expect(hasValidVerdictLine('the VERDICT: rules matter\nVERDICT: approved')).toBe(true);
  });

  it('parseVerdict never approves on prefix, duplicate, or conflicting verdict text', () => {
    expect(parseVerdict('VERDICT: approval likely\nSUMMARY: x').approved).toBe(false);
    expect(parseVerdict('VERDICT: approved_but_unverified\nSUMMARY: x').approved).toBe(false);
    expect(
      parseVerdict('VERDICT: approved\nVERDICT: changes_requested\nSUMMARY: x').approved,
    ).toBe(false);
    expect(parseVerdict('VERDICT: approved\nVERDICT: approved\nSUMMARY: x').approved).toBe(
      false,
    );
    expect(
      parseVerdict('VERDICT: approved\nVERDICT: approved_but_unverified\nSUMMARY: x').approved,
    ).toBe(false);
  });
});
