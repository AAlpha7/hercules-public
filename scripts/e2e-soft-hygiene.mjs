/**
 * Live-path e2e (no real Grok $): Orchestrator + FakeAdapter + real WorktreeVerifier
 * with injected polluted finalMessage + mock L3.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { Orchestrator } from '../dist/src/orchestrator/orchestrator.js';
import { FakeAdapter } from '../dist/src/orchestrator/fakeAdapter.js';
import { WorktreeVerifier } from '../dist/src/orchestrator/verifier.js';
import { Reviewer } from '../dist/src/verification/reviewer.js';
import { makeConfig } from '../dist/src/config.js';
import { GitControlPort } from '../dist/src/orchestrator/gitControlPort.js';
import { GitWorkspaces } from '../dist/src/isolation/worktree.js';
import { PortAllocator } from '../dist/src/isolation/ports.js';

const POLLUTED = `# Result
I wrote chapters.

## Verdict
**WARN**
## Confidence
0.8
## Findings
- 严重程度：MAJOR
  x

## Verdict
WARN
## Confidence
0.9
## Findings
- 严重程度：MINOR
  y

## Self-assessment
| item | evidence |
|---|---|
| (mechanical) gates | green |
| (reviewer) complete | prose |
| (human) ship | pending human |
`;

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'hercules-e2e-'));
  const controlDir = join(tmp, 'control');
  const targetDir = join(tmp, 'target');
  const workRoot = join(tmp, 'work');

  await mkdir(controlDir, { recursive: true });
  const cg = simpleGit(controlDir);
  await cg.init(['-b', 'main']);
  await cg.addConfig('user.email', 'e2e@h.local');
  await cg.addConfig('user.name', 'e2e');
  await writeFile(
    join(controlDir, 'repos.yaml'),
    `repos:\n  app:\n    url: ${targetDir}\n    default_branch: main\n    workflow: WORKFLOW.md\n    max_concurrent: 1\n`,
  );
  await mkdir(join(controlDir, 'tasks'), { recursive: true });
  await writeFile(
    join(controlDir, 'tasks', 'E2E-1.md'),
    `---\nid: E2E-1\ntitle: Soft hygiene e2e\nrepo: app\nstate: todo\npriority: 1\n---\n\n## Task\nDo the thing\n\n## Acceptance criteria\n- [ ] (mechanical) gates\n- [ ] (reviewer) quality\n- [ ] (human) ship\n`,
  );
  await cg.add('.');
  await cg.commit('init control');

  await mkdir(targetDir, { recursive: true });
  const tg = simpleGit(targetDir);
  await tg.init(['-b', 'main']);
  await tg.addConfig('user.email', 'e2e@h.local');
  await tg.addConfig('user.name', 'e2e');
  await writeFile(join(targetDir, 'WORKFLOW.md'), `---\ngates:\n  test: "true"\n---\npolicy\n`);
  await writeFile(join(targetDir, 'README.md'), '# app\n');
  await tg.add('.');
  await tg.commit('init target');

  const ports = new PortAllocator(5200, 4);
  const workspaces = new GitWorkspaces({ root: workRoot, ports });
  const reviewer = new Reviewer(async () => 'VERDICT: approved\nSUMMARY: ok for ship as draft');
  const verifier = new WorktreeVerifier({
    workspaces,
    reviewer,
    commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
  });

  const adapter = new FakeAdapter({
    durationMs: 50,
    finalMessage: POLLUTED,
    activity: ['wrote src/x.ts'],
  });

  const origCreate = workspaces.create.bind(workspaces);
  workspaces.create = async (repo, taskId) => {
    const w = await origCreate(repo, taskId);
    await writeFile(join(w.dir, 'x.ts'), 'export const x = 1\n');
    return w;
  };

  const control = new GitControlPort(controlDir);
  let now = 0;
  const orch = new Orchestrator({
    config: makeConfig(controlDir, { tickIntervalMs: 999999, maxAttempts: 3 }),
    control,
    adapter,
    workspaces,
    verifier,
    clock: () => now,
  });

  let report = await orch.tick();
  console.log('tick1 dispatched', report.dispatched, 'running', orch.running);
  if (!report.dispatched.includes('E2E-1')) throw new Error('expected dispatch E2E-1');

  now = 100;
  report = await orch.tick();
  console.log('tick2 completed', report.completed, 'retried', report.retried, 'failed', report.failed);

  const snap = await control.read();
  const t = snap.tasks.find((x) => x.id === 'E2E-1');
  if (!t) throw new Error('task missing');
  console.log('state', t.state, 'attempts', t.attempts);
  console.log('auto-rework section', t.body.includes('## Auto-rework'));
  console.log('soft hygiene note', /soft hygiene|Report hygiene \(soft\)|cleaned/i.test(t.body));
  console.log('L3 approved', /Reviewer \(L3\):\s*\*\*✅ approved\*\*|Reviewer \(L3\):\s*✅ approved/i.test(t.body));

  const ok =
    t.state === 'review' &&
    t.attempts === 0 &&
    report.completed.includes('E2E-1') &&
    report.retried.length === 0 &&
    !t.body.includes('## Auto-rework') &&
    /Reviewer \(L3\).*approved/i.test(t.body);

  console.log('--- packet head ---\n', t.body.slice(0, 900));
  await rm(tmp, { recursive: true, force: true });
  if (!ok) {
    process.exit(1);
  }
  console.log('E2E PASS: dirty final + L3 approve → review (no attempt burn)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
