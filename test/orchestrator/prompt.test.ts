import { describe, it, expect } from 'vitest';
import { assemblePrompt, assembleSteerPrompt } from '../../src/orchestrator/prompt.js';
import type { Task } from '../../src/domain/task.js';
import { parseDefinitionOfDone } from '../../src/domain/acceptance.js';
import { VERIFICATION_DIGEST_HEADING } from '../../src/domain/implementerBrief.js';
import type { GateResult, ReviewerVerdict } from '../../src/domain/verification.js';
import { withReviewPacket } from '../../src/orchestrator/orchestrator.js';
import {
  assembleReviewPacket,
  renderPacketMarkdown,
} from '../../src/verification/packet.js';

const task: Task = {
  id: 'T-1',
  title: 'Fix the upload retry',
  repo: 'app',
  state: 'todo',
  priority: 1,
  blockedBy: [],
  labels: [],
  adapter: null,
  agentSession: null,
  pendingSteer: null,
  attempts: 0,
  lastEventAt: null,
  createdAt: null,
  startedAt: null,
  endedAt: null,
  prUrl: null,
  prStatus: null,
  planPending: false,
  body: '## Task\nFix it\n\n## Acceptance criteria\n- [ ] retried 3x',
};

const allocation = { slug: 'T-1', port: 4000, scratchDir: '/ws/app/T-1/.scratch' };

describe('assemblePrompt (SPEC §12)', () => {
  it('combines the WORKFLOW body, the task, and the allocation context', () => {
    const prompt = assemblePrompt({ workflowBody: 'REPO POLICY: be careful', task, allocation });
    expect(prompt).toContain('REPO POLICY: be careful');
    expect(prompt).toContain('Fix the upload retry');
    expect(prompt).toContain('Acceptance criteria');
    expect(prompt).toContain('4000');
    expect(prompt).toContain('/ws/app/T-1/.scratch');
    expect(prompt).toContain('T-1');
    // WORKFLOW policy comes first (it frames everything that follows).
    expect(prompt.indexOf('REPO POLICY')).toBeLessThan(prompt.indexOf('Fix the upload retry'));
  });

  it('omits the WORKFLOW section when there is none', () => {
    const prompt = assemblePrompt({ workflowBody: '', task, allocation });
    expect(prompt).toContain('Fix the upload retry');
    expect(prompt).not.toContain('---\n\n# Repo policy');
  });

  it('instructs evidence-only self-assessment, typed DoD, and final-message hygiene', () => {
    const prompt = assemblePrompt({ workflowBody: '', task, allocation });
    expect(prompt).toContain('## Self-assessment');
    expect(prompt).toMatch(/\(mechanical\)/);
    expect(prompt).toMatch(/\(reviewer\)/);
    expect(prompt).toMatch(/\(human\)/);
    expect(prompt.toLowerCase()).toMatch(/evidence/);
    expect(prompt).toMatch(/pending human/i);
    expect(prompt).toMatch(/Final message contract/i);
    expect(prompt).toMatch(/report-hygiene/);
    expect(prompt).toMatch(/test-integrity/);
    expect(prompt).toMatch(/Never delete or rename an existing `it`\/`test` title/);
    // @test:path#title binds the it() string alone — stated at prompt time (grammar §1).
    expect(prompt).toMatch(/`@test:<path>#<title>`.*\*\*exactly\*\* `<title>`/s);
    expect(prompt).toMatch(/`describe` names are not part of it/);
    // Stale feature map fails closed in test/scripts/featureMap.test.ts — say so up front.
    expect(prompt).toMatch(/`data-evidence` anchor under `src\/web`.*`pnpm feature-map`/s);
    expect(prompt).toMatch(/sub-agent|multi-reviewer/i);
    // The instruction frames the END, so it comes after the task body.
    expect(prompt.indexOf('## Self-assessment')).toBeGreaterThan(prompt.indexOf('Fix it'));
  });

  it('adds factory open-PR duties that name the Cloud Agent head', () => {
    const factoryTask: Task = {
      ...task,
      id: 'T-factory',
      adapter: 'cursor',
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prStatus: 'open',
      pendingSteer:
        'Work **only** on the existing Cloud Agent branch `cursor/cloud-T-factory-abc` (open PR tip).',
    };
    const prompt = assemblePrompt({ workflowBody: '', task: factoryTask, allocation });
    expect(prompt).toContain('## Open factory PR on this task');
    expect(prompt).toContain('cursor/cloud-T-factory-abc');
    expect(prompt).toMatch(/do not create `hercules\/<id>`/i);
    expect(prompt).toMatch(/ready for review/);
    expect(prompt).not.toContain('hercules/<taskId>');
  });

  it('adds first-launch factory duties to open a ready-for-review PR', () => {
    const factoryTask: Task = {
      ...task,
      id: 'T-factory',
      adapter: 'cursor',
    };
    const prompt = assemblePrompt({ workflowBody: '', task: factoryTask, allocation });
    expect(prompt).toContain('## Factory PR (done artifact)');
    expect(prompt).toMatch(/ready for review/);
    expect(prompt).toMatch(/do not leave it as a draft/i);
    expect(prompt).toMatch(/Do \*\*not\*\* create `hercules\/<id>`/);
    expect(prompt).not.toContain('## Open factory PR on this task');
  });

  it('requires a current-run receipt for host operations', () => {
    const hostTask: Task = {
      ...task,
      executionClass: 'host_operation',
      hostCommandScope: ['systemctl restart hercules', 'systemctl is-active hercules'],
      hostApprovedAt: '2026-07-31T12:00:00.000Z',
    };
    const prompt = assemblePrompt({ workflowBody: '', task: hostTask, allocation });
    expect(prompt).toContain('## Approved host operation');
    expect(prompt).toContain('systemctl restart hercules');
    expect(prompt).toMatch(/deterministically/i);
    expect(prompt).toMatch(/Automatic retry is forbidden/i);
    expect(prompt).toContain('## Host operation receipt');
    expect(prompt).toMatch(/missing, stale, mismatched, non-success/i);
    expect(prompt).toMatch(/mechanical/i);
  });

  it('feeds a rework re-dispatch the brief plus the verification digest, not the prior agent narrative', () => {
    const productBrief = `## Task\nFix the upload retry\n\n## Acceptance criteria\n- [ ] (mechanical) gates green @gate:all\n- [ ] (reviewer) spirit\n- [ ] (human) ship\n`;
    const dod = parseDefinitionOfDone(productBrief);
    const gates: GateResult[] = [
      { name: 'typecheck', command: 'pnpm typecheck', passed: true, output: '' },
      {
        name: 'test',
        command: 'pnpm test',
        passed: false,
        output: 'FAIL upload.retry\nprompt-failing-gate-line',
      },
    ];
    const reviewer: ReviewerVerdict = {
      approved: false,
      summary: 'retry still flaky',
      comments: ['prompt-L3-comment-fix-backoff'],
    };
    const packet = assembleReviewPacket({
      taskId: 'T-1',
      branch: 'hercules/T-1',
      filesTouched: ['src/upload.ts'],
      diffSummary: '1 file changed',
      diff: '+prompt-secret-hunk-marker\n',
      gates,
      cheatFindings: [],
      screenshots: [],
      reviewerVerdict: reviewer,
      reviewerRan: true,
      selfAssessment: '**Result:** PASS-ish\nprompt-self-assessment-leak',
      finalReport: 'prompt-final-report-leak sentence unique',
      dod,
    });
    let body = withReviewPacket(productBrief, renderPacketMarkdown(packet));
    body +=
      '\n\n## Human steer (2026-09-04T00:00:00Z)\n\nplease keep the zh copy';
    const reworkTask: Task = { ...task, body };
    const prompt = assemblePrompt({ workflowBody: '', task: reworkTask, allocation });

    expect(prompt).toContain(VERIFICATION_DIGEST_HEADING);
    expect(prompt).toContain('prompt-L3-comment-fix-backoff');
    expect(prompt).toContain('please keep the zh copy');
    expect(prompt).toContain('Fix the upload retry');
    expect(prompt).not.toContain('prompt-self-assessment-leak');
    expect(prompt).not.toContain('prompt-final-report-leak');
    expect(prompt).not.toContain('prompt-secret-hunk-marker');
  });
});

describe('assembleSteerPrompt (comment-to-steer)', () => {
  it('is short: only the follow-up, not the full task body or WORKFLOW', () => {
    const prompt = assembleSteerPrompt(task, 'What did loop 58 write?');
    expect(prompt).toContain('What did loop 58 write?');
    expect(prompt).toContain('T-1');
    expect(prompt).toContain('## Self-assessment');
    expect(prompt).not.toContain('Fix it'); // original body
    expect(prompt).not.toContain('retried 3x');
    expect(prompt.length).toBeLessThan(1200);
  });

  it('adds open-PR conflict duties when the task already has an open PR', () => {
    const withPr: Task = {
      ...task,
      prUrl: 'https://github.com/example-org/acme/pull/6',
      prStatus: 'open',
    };
    const prompt = assembleSteerPrompt(withPr, 'Please resolve conflicts on PR');
    expect(prompt).toContain('Please resolve conflicts on PR');
    expect(prompt).toContain('## Open PR on this task');
    expect(prompt).toContain('https://github.com/example-org/acme/pull/6');
    expect(prompt).toMatch(/pr-mergeable/i);
    expect(prompt).toMatch(/merge or rebase/i);
    expect(prompt).toMatch(/[Pp]ush/);
    // Still omits the full product body / WORKFLOW.
    expect(prompt).not.toContain('retried 3x');
  });

  it('factory open-PR steer names the Cloud Agent head, not hercules/<id>', () => {
    const withPr: Task = {
      ...task,
      id: 'T-factory',
      adapter: 'cursor',
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prStatus: 'open',
      pendingSteer:
        'Open PR is still CONFLICTING. Work **only** on the existing Cloud Agent branch `cursor/cloud-T-factory-abc` (open PR tip).',
    };
    const prompt = assembleSteerPrompt(withPr, 'Please resolve conflicts on PR');
    expect(prompt).toContain('https://github.com/example-org/acme/pull/41');
    expect(prompt).toContain('cursor/cloud-T-factory-abc');
    expect(prompt).toMatch(/do not create `hercules\/<id>`/i);
    expect(prompt).not.toContain('hercules/<taskId>');
    expect(prompt).not.toContain('retried 3x');
  });
});

describe('assemblePrompt standalone final message (P6)', () => {
  it('requires a standalone final message with goal, diff, proof, blocker, and no back-references', () => {
    const prompt = assemblePrompt({ workflowBody: '', task, allocation });
    expect(prompt).toMatch(/stand alone/i);
    expect(prompt).toMatch(/restating the goal/);
    expect(prompt).toMatch(/diff summary/);
    expect(prompt).toMatch(/commands run/);
    expect(prompt).toMatch(/Blocker or open question/);
    expect(prompt).toContain('as above');
    expect(prompt).toContain('see earlier');
    expect(prompt).toContain('as discussed');
    expect(prompt).toContain('如上');
    expect(prompt).toContain('见上');
    expect(prompt).toContain('上述');
  });
});
