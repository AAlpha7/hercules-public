#!/usr/bin/env node
/**
 * L2 isolation control-plane fixture.
 *
 * Seeds a realistic control repo into a scratch directory so L2 browser
 * evidence can exercise real decision / repos chrome (Mark ready, DecisionCard,
 * task list groups) without an empty plane forcing agents to invent
 * placeholder data-evidence hooks in production code.
 *
 * Also seeds a docs-capable `demo` repo + bare mirror under the sibling
 * `{scratch}/work/.mirrors/demo.git` so Repos → Browse docs L2 evidence
 * (entry pins, search, reader) can run offline. WORKFLOW setup.boot points
 * HERCULES_WORK_DIR at that work root.
 *
 * Usage (from repo root, WORKFLOW setup.boot):
 *   node scripts/l2-seed-control-fixture.mjs {scratch_dir}/ctrl
 *
 * Safe by design:
 *   - Writes only under the scratch layout (ctrl + sibling work/).
 *   - Never touches production work roots or live control repos.
 *   - Task titles carry "[L2 fixture]" so humans never confuse them with real work.
 *
 * Extending: add tasks/*.md bodies or repos.yaml entries below; keep titles
 * tagged [L2 fixture]; re-run is idempotent (wipes tasks/ then rewrites).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildM7ReviewFixtureEnvelope } from './l2-review-fixture-data.mjs';

const DEPLOY_STAGING_SEED = join(
  dirname(fileURLToPath(import.meta.url)),
  'l2-seed-deploy-staging-fixture.mjs',
);

const ctrlArg = process.argv[2];
if (!ctrlArg || ctrlArg.trim() === '') {
  console.error('usage: node scripts/l2-seed-control-fixture.mjs <control-dir>');
  process.exit(2);
}

const ctrlDir = resolve(ctrlArg);
const tasksDir = join(ctrlDir, 'tasks');
/** Sibling of ctrl — matches WORKFLOW `HERCULES_WORK_DIR={scratch_dir}/work`. */
const workRoot = resolve(join(ctrlDir, '..', 'work'));
const DOCS_DEMO_KEY = 'demo';
const M7_REVIEW_FIXTURE_FILE = 'm7-review-fixture.json';

/** DecisionCard machine block — full CEO surface for the review task. */
function decisionCardBlock() {
  const card = {
    v: 1,
    purpose: 'Prove L2 isolation boots against a realistic control plane fixture.',
    areas: [
      { area: 'src/web', count: 3 },
      { area: 'scripts', count: 1 },
      { area: 'test', count: 2 },
    ],
    filesTouched: 6,
    boundaries: {
      branch: 'hercules/l2-fixture-review',
      protectedPathsTouched: false,
      testsEdited: true,
      // Non-empty → yellow cross-task badge on DecisionCard.
      crossTaskIds: ['l2-fixture-todo', 'other-task'],
      // Embedded foreign commits so badge expand lists sha + subject + taskId
      // (boundary-badge-why L2 evidence: badge-expanded must show commit lines).
      crossTaskCommits: [
        {
          sha: 'eb2182c0abcdef0123456789abcdef0123456789',
          subject: 'hercules: l2-fixture-todo — verified state',
          taskId: 'l2-fixture-todo',
        },
        {
          sha: 'a33ce578abcdef0123456789abcdef0123456789',
          subject: 'hercules: other-task — verified state',
          taskId: 'other-task',
        },
      ],
    },
    // Named review-only flags (not bare counts) for anti-cheat row on card.
    reviewOnlyFlags: [
      {
        kind: 'test-edit',
        meaningZh: '改动了测试文件，需确认测试仍在真正约束行为',
      },
      {
        kind: 'cross-task-commits',
        meaningZh: '分支夹带其他任务的提交，审计血缘交叉',
      },
    ],
    criteria: [
      {
        text: 'L1 gates green on the fixture branch',
        kind: 'mechanical',
        status: 'pass',
        why: 'typecheck + lint + unit tests green in packet',
      },
      {
        // Human UI AC with no related L2 click/assert/screenshot — soft warn
        // (unprovenUiWarning) so TaskDetail renders data-evidence=human-ac-unproven
        // next to the checkbox. Fixture data only; not a production placeholder.
        text: '手机上点黄色跨任务徽章, 一眼看懂为什么黄、涉及哪些提交',
        kind: 'human',
        status: 'pending',
        why: '(human判断)',
        how: 'Open the review task; confirm the yellow cross-task badge explains commits',
        unprovenUiWarning: '⚠ 该人工项无对应证据步骤——你无法在部署前核验',
        unprovenUiReason:
          '现有证据步骤与「手机上点黄色跨任务徽章…」无关（例如只截了任务列表）——请补 click/assert/screenshot 指向该 UI 断言',
      },
      {
        text: 'Reviewer finds no critical issues',
        kind: 'reviewer',
        status: 'pass',
        why: 'L3 summary: fixture-only changes, no production pollution',
      },
    ],
    gates: [
      { name: 'typecheck', passed: true },
      { name: 'lint', passed: true },
      { name: 'test', passed: true },
      { name: 'build', passed: true },
      // Failed gate row → decide-why / gate chips show partial.
      {
        name: 'behavioral',
        passed: false,
        reason: 'L2 declared… 具体原因: fixture intentionally leaves one gate red for UI coverage。',
      },
    ],
    evidence: { ran: true, ok: false, steps: 4 },
    reviewer: {
      ran: true,
      approved: true,
      summaryZh: '夹具只写控制面数据, 未污染生产代码',
    },
  };
  return `\n<!-- hercules:decision-card\n${JSON.stringify(card)}\n-->\n`;
}

function reviewTaskBody() {
  return `## Goal

Prove L2 isolation boots against a realistic control plane fixture.

## Task

[L2 fixture] Review-state task with a full DecisionCard packet so L2 can open
Decide chrome without inventing placeholder hooks in \`src/\`.

## Definition of Done

- [x] (mechanical) L1 gates green on the fixture branch
- [ ] (human) 手机上点黄色跨任务徽章, 一眼看懂为什么黄、涉及哪些提交
- [x] (reviewer) Reviewer finds no critical issues

## Review packet

**Branch** \`hercules/l2-fixture-review\`

**Gates**
- ✅ typecheck
- ✅ lint
- ✅ test
- ✅ build
- ❌ behavioral
\`\`\`
L2 declared… 具体原因: fixture intentionally leaves one gate red for UI coverage。
\`\`\`

**Self-assessment** *(agent evidence only — not authoritative)*
| item | evidence |
|---|---|
| (mechanical) L1 | green |
| (reviewer) no critical | L3 ok |
| (human) DecisionCard content | pending human |

${decisionCardBlock()}`;
}

/**
 * Build repos.yaml. `demo` sorts first alphabetically so L2's first
 * [data-evidence=repo-browse-docs] click hits a docs-capable mirror.
 * @param {string} demoSourceUrl absolute path to the demo source git tree
 */
function buildReposYaml(demoSourceUrl) {
  return `# L2 isolation fixture — not a production control plane.
# Written only into {scratch_dir}/ctrl by scripts/l2-seed-control-fixture.mjs.
repos:
  ${DOCS_DEMO_KEY}:
    url: ${demoSourceUrl}
    default_branch: main
    workflow: WORKFLOW.md
    max_concurrent: 1
    readiness: ready
    adapter: fake
  fixture-ready-app:
    url: file:///tmp/hercules-l2-fixture-ready-app.git
    default_branch: main
    workflow: WORKFLOW.md
    max_concurrent: 1
    readiness: ready
  fixture-incomplete-app:
    url: file:///tmp/hercules-l2-fixture-incomplete-app.git
    default_branch: main
    workflow: WORKFLOW.md
    max_concurrent: 1
    readiness: incomplete
`;
}

/**
 * Create a small git tree + bare mirror with entry docs + rest docs so the
 * Repos panel docs browser (pins / search / reader) has offline content.
 * @returns {string} absolute path to the demo source tree (repos.yaml url)
 */
function seedDocsDemoMirror() {
  const sourceDir = join(workRoot, '.l2-demo-src', DOCS_DEMO_KEY);
  const docsDir = join(sourceDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(sourceDir, 'README.md'), '# Demo\n\nL2 fixture README.\n', 'utf8');
  writeFileSync(join(sourceDir, 'AGENTS.md'), '# Agents\n\nMap for demo.\n', 'utf8');
  writeFileSync(join(sourceDir, 'WORKFLOW.md'), '---\ngates: {}\n---\n', 'utf8');
  writeFileSync(join(docsDir, 'guide.md'), '# Guide\n\nBody for search filter.\n', 'utf8');
  writeFileSync(
    join(docsDir, '2026-04-21-notes.md'),
    '# Notes\n\nRest-list filler for collapse UX.\n',
    'utf8',
  );

  // Fresh source tree each seed (idempotent re-run).
  const sourceGit = join(sourceDir, '.git');
  if (existsSync(sourceGit)) {
    rmSync(sourceGit, { recursive: true, force: true });
  }
  try {
    git(['init', '-q', '-b', 'main'], sourceDir);
  } catch (err) {
    const text = gitErrText(err);
    if (!/unknown option|invalid option|-b/i.test(text)) throw err;
    git(['init', '-q'], sourceDir);
  }
  git(['add', '.'], sourceDir);
  git(['commit', '-qm', 'l2: seed docs demo source'], sourceDir);

  const mirrorsDir = join(workRoot, '.mirrors');
  mkdirSync(mirrorsDir, { recursive: true });
  const mirrorPath = join(mirrorsDir, `${DOCS_DEMO_KEY}.git`);
  if (existsSync(mirrorPath)) {
    rmSync(mirrorPath, { recursive: true, force: true });
  }
  git(['clone', '--bare', '--quiet', sourceDir, mirrorPath], workRoot);
  return sourceDir;
}

/** @type {ReadonlyArray<{ id: string; content: string }>} */
const TASKS = [
  {
    id: 'l2-fixture-review',
    content: `---
id: l2-fixture-review
title: "[L2 fixture] Review decide card with cross-task badge"
repo: fixture-ready-app
state: review
priority: 10
blocked_by: []
labels: [l2-fixture]
agent_session: null
attempts: 1
last_event_at: "2026-07-25T00:00:00.000Z"
verified_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
---

${reviewTaskBody()}
`,
  },
  {
    id: 'l2-fixture-done',
    content: `---
id: l2-fixture-done
title: "[L2 fixture] Completed sample for done group"
repo: fixture-ready-app
state: done
priority: 50
blocked_by: []
labels: [l2-fixture]
agent_session: null
attempts: 1
last_event_at: "2026-07-24T12:00:00.000Z"
ended_at: "2026-07-24T12:00:00.000Z"
---

## Goal

Fill the done section of the task list during L2 isolation.

## Task

[L2 fixture] Already-merged sample — no action required.
`,
  },
  {
    id: 'l2-fixture-failed',
    content: `---
id: l2-fixture-failed
title: "[L2 fixture] Failed sample for failed group"
repo: fixture-ready-app
state: failed
priority: 40
blocked_by: []
labels: [l2-fixture]
agent_session: null
attempts: 3
last_event_at: "2026-07-24T18:00:00.000Z"
ended_at: "2026-07-24T18:00:00.000Z"
---

## Goal

Fill the failed section of the task list during L2 isolation.

## Task

[L2 fixture] Exhausted-attempts sample so failed chrome has content.
`,
  },
  {
    id: 'l2-fixture-todo',
    content: `---
id: l2-fixture-todo
title: "[L2 fixture] Todo sample for open queue"
repo: fixture-incomplete-app
state: todo
priority: 20
blocked_by: []
labels: [l2-fixture]
agent_session: null
attempts: 0
last_event_at: null
---

## Goal

Fill the todo section of the task list during L2 isolation.

## Task

[L2 fixture] Open queue sample — fake adapter never dispatches real work.
`,
  },
  ...m7OutcomeReviewTasks(),
  // --- Resilience / fault-injection scene (adapter-failover + agent-death) ---
  // Three provider deaths mark primary unhealthy; the 4th task carries the
  // post-failover timeline (降级) + precise death cause for L2 assert/screenshot.
  // Bodies are pre-seeded post-scenario state so L2 does not need a live multi-
  // tick death chain (and never routes isolation dispatch to a real provider).
  ...resilienceScenarioTasks(),
];

function m7OutcomeReviewTasks() {
  return [
    ['l2-m7-fail', '[L2 fixture] Verified failure review'],
    ['l2-m7-human', '[L2 fixture] Human outcome confirmation'],
    ['l2-m7-missing', '[L2 fixture] Missing evaluation evidence'],
    ['l2-m7-pass', '[L2 fixture] Verified pass with evidence'],
  ].map(([id, title], index) => ({
    id,
    content: `---
id: ${id}
title: "${title}"
repo: fixture-ready-app
state: review
priority: ${60 + index}
blocked_by: []
labels: [l2-fixture, m7-outcome-review]
adapter: fake
agent_session: null
attempts: 1
last_event_at: "2026-08-29T00:00:00.000Z"
verified_sha: "0123456789abcdef0123456789abcdef01234567"
---

## Goal

Exercise the real M7 outcome review surface against a scratch-only, evidence-bound fixture.

## Safety

This record is isolated test data. It cannot merge, deploy, send externally, or mutate a live control repo.
`,
  }));
}

/**
 * Provider-death streak + failover task for L2 phone evidence.
 * @returns {ReadonlyArray<{ id: string; content: string }>}
 */
function resilienceScenarioTasks() {
  const deathBody = (n, stamp) => `## Goal

[L2 fixture] Controlled fake_behavior=die-immediately death #${n} so provider health reaches the unhealthy threshold.

## Task

Fault-injection sample — not real product work. When isolation re-dispatches
this task with \`HERCULES_FAKE_FAULT_INJECTION=1\`, the fake adapter dies per
script and produces a real agent_exit event stream.

## Run failure (${stamp})

**Kind:** \`agent_exit\`
**Attempt:** 1 / 3
**Attempt accounting:** burn
**Death cause:** xAI 502 mid-stream
**Exit code:** 1
**Adapter:** \`fake\`
**Detail:** Agent process exited without a successful **done** event (non-zero exit, stream error, or crash). **No verification packet** was produced — this is not an L1/L2/L3 fail.

### Last agent activity
\`\`\`
fake: die-immediately script
error: status 502 Bad Gateway mid-stream while streaming response
\`\`\`

### Next actions
1. **Retry** — after fixing env / API / quota / WORKFLOW issues
2. **Steer** — narrower instruction if partial branch work exists
3. **Switch agent** — different adapter on the preserved branch

## Run timeline

- \`${stamp}\` **dispatch** — dispatched adapter \`fake\`
- \`${stamp}\` **agent_activity** — fake: die-immediately script
- \`${stamp}\` **agent_exit** ❌ — xAI 502 mid-stream | exit 1
`;

  const dieTasks = [1, 2, 3].map((n) => {
    const stamp = `2026-07-30T0${n}:00:00.000Z`;
    const id = `l2-fixture-resilience-die-${n}`;
    return {
      id,
      content: `---
id: ${id}
title: "[L2 fixture] Resilience die #${n} (fake_behavior=die-immediately)"
repo: fixture-ready-app
state: failed
priority: 30
blocked_by: []
labels: [l2-fixture, resilience, fault-injection]
adapter: fake
fake_behavior: die-immediately
agent_session: null
attempts: 1
last_event_at: "${stamp}"
ended_at: "${stamp}"
---

${deathBody(n, stamp)}
`,
    };
  });

  const failoverStamp = '2026-07-30T04:00:00.000Z';
  const failoverNote =
    'adapter 降级: fake 不健康(3 次异常退出), 本轮使用 claude';
  // Task-body Evidence does `click [data-evidence=task-card]` (first card in
  // DOM). STATE_ORDER puts `review` first — keep this scene in review with an
  // id that localeCompare-sorts before l2-fixture-review so the generic click
  // opens Resilience (not the decide-card greenwash).
  const failoverId = 'l2-fixture-00-resilience-failover';
  const failoverTask = {
    id: failoverId,
    content: `---
id: ${failoverId}
title: "[L2 fixture] Resilience failover — adapter 降级 after 3× die-immediately"
repo: fixture-ready-app
state: review
priority: 5
blocked_by: []
labels: [l2-fixture, resilience, fault-injection, adapter-failover]
adapter: fake
fake_behavior: die-mid-turn
agent_session: null
attempts: 1
last_event_at: "${failoverStamp}"
started_at: "${failoverStamp}"
ended_at: "${failoverStamp}"
---

## Goal

[L2 fixture] Fourth dispatch after three \`fake_behavior=die-immediately\` deaths —
timeline must show adapter 降级 and the mini-packet must show an exact death cause
(retroactive L2 proof for adapter-failover + agent-death-resilience).

## Adapter failover

${failoverNote}

Prior streak: die-immediately ×3 on fake primary → unhealthy → this dispatch used claude.

## Run failure (${failoverStamp})

**Kind:** \`agent_exit\`
**Attempt:** 1 / 3
**Attempt accounting:** burn
**Death cause:** xAI 502 mid-stream
**Exit code:** 1
**Adapter:** \`claude\`
**Detail:** Agent process exited without a successful **done** event (non-zero exit, stream error, or crash). **No verification packet** was produced — this is not an L1/L2/L3 fail.

### Last agent activity
\`\`\`
fake: mid-turn tool call (after die-immediately streak)
error: stream interrupted status 502 Bad Gateway mid-stream
\`\`\`

### Stderr tail
\`\`\`
status 502 Bad Gateway mid-stream (provider disconnect)
\`\`\`

### Next actions
1. **Retry** — after fixing env / API / quota / WORKFLOW issues
2. **Steer** — narrower instruction if partial branch work exists
3. **Switch agent** — different adapter on the preserved branch

## Run timeline

- \`${failoverStamp}\` **dispatch** — dispatched adapter \`claude\` | ${failoverNote}
- \`${failoverStamp}\` **agent_activity** — fake: mid-turn tool call (after die-immediately streak)
- \`${failoverStamp}\` **agent_exit** ❌ — xAI 502 mid-stream | exit 1
`,
  };

  return [...dieTasks, failoverTask];
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'hercules-l2-fixture',
      GIT_AUTHOR_EMAIL: 'l2-fixture@hercules.local',
      GIT_COMMITTER_NAME: 'hercules-l2-fixture',
      GIT_COMMITTER_EMAIL: 'l2-fixture@hercules.local',
    },
  });
}

function gitErrText(err) {
  if (!err || typeof err !== 'object') return String(err);
  const parts = [];
  if ('stderr' in err && err.stderr) parts.push(String(err.stderr));
  if ('stdout' in err && err.stdout) parts.push(String(err.stdout));
  if (err instanceof Error && err.message) parts.push(err.message);
  return parts.join('\n');
}

function seed() {
  mkdirSync(ctrlDir, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  // Idempotent: drop prior fixture tasks, rewrite registry.
  if (existsSync(tasksDir)) {
    rmSync(tasksDir, { recursive: true, force: true });
  }
  mkdirSync(tasksDir, { recursive: true });

  const demoSource = seedDocsDemoMirror();
  writeFileSync(
    join(workRoot, M7_REVIEW_FIXTURE_FILE),
    `${JSON.stringify(buildM7ReviewFixtureEnvelope(), null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  writeFileSync(join(ctrlDir, 'repos.yaml'), buildReposYaml(demoSource), 'utf8');
  for (const t of TASKS) {
    writeFileSync(join(tasksDir, `${t.id}.md`), t.content, 'utf8');
  }

  const gitDir = join(ctrlDir, '.git');
  if (!existsSync(gitDir)) {
    // Prefer `init -b main` (git ≥2.28); fall back to plain init.
    try {
      git(['init', '-q', '-b', 'main'], ctrlDir);
    } catch (err) {
      const text = gitErrText(err);
      if (!/unknown option|invalid option|-b/i.test(text)) throw err;
      git(['init', '-q'], ctrlDir);
    }
  }

  git(['add', '-A'], ctrlDir);
  // Allow empty when re-run produces identical tree.
  try {
    git(['commit', '-qm', 'l2-control-fixture seed'], ctrlDir);
  } catch (err) {
    const text = gitErrText(err);
    if (!/nothing to commit/i.test(text)) {
      throw err;
    }
  }

  // Deploy.staging synthetic repo + release record for Releases digest evidence.
  // Separate script keeps this file's core seed stable; WORKFLOW.md stays untouched.
  if (existsSync(DEPLOY_STAGING_SEED)) {
    execFileSync(process.execPath, [DEPLOY_STAGING_SEED, ctrlDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}

seed();
console.error(
  `[l2-seed-control-fixture] seeded ${ctrlDir} (${TASKS.length} tasks) + docs demo mirror under ${workRoot}`,
);
