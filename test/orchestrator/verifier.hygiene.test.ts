/**
 * Operator-first hygiene: dirty final messages must not burn rework attempts
 * when structure gates + L3 are fine.
 */
import { describe, it, expect } from 'vitest';
import { WorktreeVerifier } from '../../src/orchestrator/verifier.js';
import { Reviewer } from '../../src/verification/reviewer.js';
import type { CommandRunner } from '../../src/verification/gates.js';
import type { WorktreeDiff } from '../../src/isolation/diff.js';
import type { Task } from '../../src/domain/task.js';
import type { RepoConfig } from '../../src/domain/repos.js';
import type { Workspace } from '../../src/domain/allocation.js';

const task: Task = {
  id: 'T-hyg',
  title: 'Write loop',
  repo: 'bookshelf',
  state: 'in_progress',
  priority: 1,
  blockedBy: [],
  labels: [],
  adapter: null,
  agentSession: 's',
  pendingSteer: null,
  attempts: 0,
  lastEventAt: null,
  createdAt: null,
  startedAt: null,
  endedAt: null,
  prUrl: null,
  prStatus: null,
  planPending: false,
  body: `## Task\nFinish the loop\n\n## Acceptance criteria\n- [ ] (mechanical) gates green @gate:test\n- [ ] (reviewer) story complete\n- [ ] (human) ship when ready\n`,
};

const repo: RepoConfig = {
  key: 'bookshelf',
  url: 'x',
  defaultBranch: 'main',
  workflow: 'WORKFLOW.md',
  maxConcurrent: 1,
  adapter: null, readiness: 'ready',
};
const workspace: Workspace = {
  taskId: 'T-hyg',
  repo: 'bookshelf',
  dir: '/ws/bookshelf/T-hyg',
  branch: 'hercules/T-hyg',
  allocation: { slug: 'T-hyg', port: 4100, scratchDir: '/ws/bookshelf/T-hyg/.scratch' },
  branchLease: { expectedBaseRevision: '0'.repeat(40), expectedRemoteTip: null },
};

const WORKFLOW = `---
gates:
  test: "true"
---
be careful
`;

const diff: WorktreeDiff = {
  diff: 'diff --git a/x.md b/x.md\n+hello',
  filesTouched: ['x.md'],
  diffSummary: '1 file changed',
  compareBase: 'main',
};

const pass: CommandRunner = async () => ({ exitCode: 0, output: 'ok' });

const POLLUTED_FINAL = `# Result
I thickened chapters 10-12.

## Verdict
**WARN**
## Confidence
0.8
## Findings
- 严重程度：MAJOR
  bad

## Verdict
WARN
## Confidence
0.9
## Findings
- 严重程度：MINOR
  ok

## Self-assessment
| item | evidence |
|---|---|
| (mechanical) gates | GREEN |
| (reviewer) complete | see prose |
| (human) ship | pending human |
`;

describe('WorktreeVerifier report hygiene (operator-first)', () => {
  it('L3 approve + dirty final → reviewable green, no auto-rework', async () => {
    const reviewer = new Reviewer(async () => 'VERDICT: approved\nSUMMARY: loop closes');
    const v = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => diff,
      commandRunner: pass,
      reviewer,
    });
    const packet = await v.verify(task, repo, workspace, [], undefined, POLLUTED_FINAL);
    expect(packet.reportPolluted).toBe(true);
    expect(packet.autoRework).toBe(false);
    expect(packet.green).toBe(true);
    expect(packet.dod.mechanical).toBe('pass');
    expect(packet.dod.reviewer).toBe('pass');
    expect(packet.dod.human).toBe('pending');
    // Soft gate present and passed
    const hyg = packet.gates.find((g) => g.name === 'report-hygiene');
    expect(hyg?.passed).toBe(true);
    // Cleaned report should not keep multi-confidence dumps
    expect(packet.finalReport).not.toMatch(/## Confidence/);
    expect(packet.selfAssessment).toMatch(/pending human/i);
  });

  it('L3 reject + dirty final → still auto-rework (content issue wins)', async () => {
    const reviewer = new Reviewer(
      async () => 'VERDICT: changes_requested\nSUMMARY: climax thin\n- thicken ch12',
    );
    const v = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => diff,
      commandRunner: pass,
      reviewer,
    });
    const packet = await v.verify(task, repo, workspace, [], undefined, POLLUTED_FINAL);
    expect(packet.reportPolluted).toBe(true);
    expect(packet.autoRework).toBe(true);
    expect(packet.dod.reviewer).toBe('fail');
    expect(packet.green).toBe(false);
  });

  it('structure gate fail → auto-rework even if final is clean', async () => {
    const fail: CommandRunner = async () => ({ exitCode: 1, output: 'boom' });
    const v = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => diff,
      commandRunner: fail,
    });
    const packet = await v.verify(
      task,
      repo,
      workspace,
      [],
      undefined,
      'Clean report.\n\n## Self-assessment\nok',
    );
    expect(packet.reportPolluted).toBe(false);
    expect(packet.autoRework).toBe(true);
    expect(packet.dod.mechanical).toBe('fail');
  });
});
