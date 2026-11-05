/**
 * L2 control-plane fixture seed (scripts/l2-seed-control-fixture.mjs).
 *
 * Isolation boot used to empty-seed ctrl/ — agents then faked UI hooks so
 * assert sel= could pass. The seed must land a realistic control plane in the
 * scratch dir only; production src/ must not grow placeholder chrome for L2.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { parseTaskFile } from '../../src/control/taskFile.js';
import { parseReposConfig } from '../../src/control/reposConfig.js';
import { parseDecisionCard } from '../../src/domain/decisionCard.js';
import { buildSnapshot } from '../../src/control/snapshot.js';

const execFileAsync = promisify(execFile);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts/l2-seed-control-fixture.mjs');
const WORKFLOW_PATH = join(ROOT, 'WORKFLOW.md');
const AGENTS_PATH = join(ROOT, 'AGENTS.md');

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('scripts/l2-seed-control-fixture.mjs', { timeout: 60_000 }, () => {
  let scratchDir: string;
  let ctrlDir: string;
  let workDir: string;

  beforeEach(async () => {
    // Mirror WORKFLOW layout: {scratch}/ctrl + {scratch}/work
    scratchDir = await mkdtemp(join(tmpdir(), 'hercules-l2-fixture-'));
    ctrlDir = join(scratchDir, 'ctrl');
    workDir = join(scratchDir, 'work');
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  it('script exists', async () => {
    expect(await fileExists(SCRIPT)).toBe(true);
  });

  it('seeds repos.yaml with demo docs repo + ready + incomplete', async () => {
    await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });
    const yaml = await readFile(join(ctrlDir, 'repos.yaml'), 'utf8');
    const cfg = parseReposConfig(yaml);
    const entries = Object.values(cfg.repos);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(cfg.repos['demo']).toBeDefined();
    expect(entries.some((r) => r.readiness === 'ready')).toBe(true);
    expect(entries.some((r) => r.readiness === 'incomplete')).toBe(true);
  });

  it('seeds review/done/failed/todo tasks labeled [L2 fixture]', async () => {
    await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });
    const taskNames = await readdir(join(ctrlDir, 'tasks'));
    const md = taskNames.filter((n) => n.endsWith('.md'));
    expect(md.length).toBeGreaterThanOrEqual(4);

    const tasks = await Promise.all(
      md.map(async (name) => {
        const text = await readFile(join(ctrlDir, 'tasks', name), 'utf8');
        return parseTaskFile(text, name.replace(/\.md$/, ''));
      }),
    );

    const byState = new Map(tasks.map((t) => [t.state, t]));
    expect(byState.has('review')).toBe(true);
    expect(byState.has('done')).toBe(true);
    expect(byState.has('failed')).toBe(true);
    expect(byState.has('todo')).toBe(true);

    for (const t of tasks) {
      expect(t.title).toMatch(/\[L2 fixture\]/);
    }
  });

  it('review task embeds a real DecisionCard with cross-task badge, human AC, failed gate', async () => {
    await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });
    const taskNames = await readdir(join(ctrlDir, 'tasks'));
    const reviewFiles = await Promise.all(
      taskNames
        .filter((n) => n.endsWith('.md'))
        .map(async (name) => {
          const text = await readFile(join(ctrlDir, 'tasks', name), 'utf8');
          return parseTaskFile(text, name.replace(/\.md$/, ''));
        }),
    );
    // Resilience failover is also `review` (first task-card for L2); decide-card
    // fixture is the one with an embedded DecisionCard.
    const review = reviewFiles.find(
      (t) => t.state === 'review' && t.id === 'l2-fixture-review',
    );
    expect(review).toBeDefined();
    const card = parseDecisionCard(review!.body);
    expect(card).not.toBeNull();
    expect(card!.v).toBe(1);
    expect(card!.boundaries.crossTaskIds.length).toBeGreaterThan(0);
    // Yellow cross-task path needs embedded commits for L2 badge-expanded
    // (sha + subject + taskId on the expand panel).
    expect(card!.boundaries.crossTaskCommits?.length).toBeGreaterThan(0);
    for (const c of card!.boundaries.crossTaskCommits ?? []) {
      expect(c.sha.length).toBeGreaterThanOrEqual(7);
      expect(c.subject.length).toBeGreaterThan(0);
      expect(c.taskId.length).toBeGreaterThan(0);
    }
    expect(card!.reviewOnlyFlags?.length).toBeGreaterThan(0);
    const humanPending = card!.criteria.some(
      (c) => c.kind === 'human' && c.status !== 'pass',
    );
    expect(humanPending).toBe(true);
    // Soft UI-AC gap fields so TaskDetail can render data-evidence=human-ac-unproven
    // on a real review task (not an App.tsx placeholder host).
    const unproven = card!.criteria.find(
      (c) => c.kind === 'human' && typeof c.unprovenUiWarning === 'string',
    );
    expect(unproven).toBeDefined();
    expect(unproven!.unprovenUiWarning).toMatch(/无对应证据|无法在部署前核验/);
    expect(unproven!.text).toMatch(/徽章|badge|一眼|手机/i);
    expect(card!.gates.some((g) => g.passed === false)).toBe(true);
    expect(card!.purpose).toBeTruthy();
  });

  it('initializes a git repo and commits the seed (control plane mutation unit)', async () => {
    await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });
    const { stdout } = await execFileAsync('git', ['-C', ctrlDir, 'log', '--oneline'], {
      encoding: 'utf8',
    });
    expect(stdout.trim().length).toBeGreaterThan(0);
    // repos.yaml is valid YAML object shape
    const raw = parseYaml(await readFile(join(ctrlDir, 'repos.yaml'), 'utf8')) as {
      repos?: Record<string, unknown>;
    };
    expect(raw.repos).toBeTypeOf('object');
  });

  it(
    'is idempotent: re-run overwrites with the same fixture shape',
    async () => {
      await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });
      await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });
      const tasks = await readdir(join(ctrlDir, 'tasks'));
      expect(tasks.filter((n) => n.endsWith('.md')).length).toBeGreaterThanOrEqual(4);
    },
    60_000,
  );

  it(
    'buildSnapshot after seed has 0 problems, 3 repos, and every L2 task scene',
    async () => {
      await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });
      const snap = await buildSnapshot(ctrlDir);
      expect(snap.problems).toEqual([]);
      expect(Object.keys(snap.repos.repos).length).toBe(4);
      expect(snap.repos.repos['fixture-deploy-staging']).toBeDefined();
      // 4 classic states + 4 resilience scenes + 4 M7 review scenes + deploy ahead.
      expect(snap.tasks).toHaveLength(13);
      expect(snap.tasks.map((task) => task.id)).toEqual(
        expect.arrayContaining(['l2-m7-fail', 'l2-m7-human', 'l2-m7-missing', 'l2-m7-pass']),
      );
      const readiness = Object.values(snap.repos.repos).map((r) => r.readiness);
      expect(readiness).toContain('ready');
      expect(readiness).toContain('incomplete');
      // No "references unknown repo" orphans (empty repos.yaml wipe regression)
      expect(snap.problems.some((p) => /unknown repo/i.test(p.error))).toBe(false);
    },
    60_000,
  );

  it('seeds resilience fault-injection scene (3 die + failover with 降级 + death cause)', async () => {
    await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });
    const tasksDir = join(ctrlDir, 'tasks');
    const dieIds = [
      'l2-fixture-resilience-die-1',
      'l2-fixture-resilience-die-2',
      'l2-fixture-resilience-die-3',
    ];
    for (const id of dieIds) {
      const text = await readFile(join(tasksDir, `${id}.md`), 'utf8');
      const t = parseTaskFile(text, id);
      expect(t.state).toBe('failed');
      expect(t.fakeBehavior).toBe('die-immediately');
      expect(t.title).toMatch(/\[L2 fixture\]/);
      expect(t.body).toMatch(/Death cause:\*\* xAI 502 mid-stream/);
      expect(t.body).toMatch(/## Run timeline/);
    }
    const failover = parseTaskFile(
      await readFile(join(tasksDir, 'l2-fixture-00-resilience-failover.md'), 'utf8'),
      'l2-fixture-00-resilience-failover',
    );
    // review (not failed): STATE_ORDER surfaces Needs review first, and this
    // id sorts before l2-fixture-review so generic task-card click opens it.
    expect(failover.state).toBe('review');
    expect(failover.fakeBehavior).toBe('die-mid-turn');
    expect(failover.body).toMatch(/adapter 降级/);
    expect(failover.body).toMatch(/die-immediately/);
    expect(failover.body).toMatch(/Death cause:\*\* xAI 502 mid-stream/);
    expect(failover.body).toMatch(/## Run timeline/);
    // Timeline dispatch detail must carry 降级 for adapter-failover-timeline hook.
    expect(failover.body).toMatch(/dispatch[\s\S]*降级/);
    // First among review cards for task ## Evidence `click [data-evidence=task-card]`.
    expect(failover.id < 'l2-fixture-review').toBe(true);
    const snap = await buildSnapshot(ctrlDir);
    const reviewIds = snap.tasks.filter((t) => t.state === 'review').map((t) => t.id);
    expect(reviewIds[0]).toBe('l2-fixture-00-resilience-failover');
  });

  it('seeds demo bare mirror under sibling work/.mirrors with entry + rest docs', async () => {
    await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });
    const mirror = join(workDir, '.mirrors', 'demo.git');
    expect(await fileExists(mirror)).toBe(true);
    const { stdout } = await execFileAsync(
      'git',
      ['-C', mirror, 'ls-tree', '-r', '--name-only', 'main'],
      { encoding: 'utf8' },
    );
    const files = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(files).toContain('README.md');
    expect(files).toContain('AGENTS.md');
    expect(files).toContain('WORKFLOW.md');
    expect(files).toContain('docs/guide.md');
    expect(files).toContain('docs/2026-04-21-notes.md');
    // Body must match mirror seed (not client-side emptyReposDocsDemo text).
    const { stdout: readme } = await execFileAsync(
      'git',
      ['-C', mirror, 'show', 'main:README.md'],
      { encoding: 'utf8' },
    );
    expect(readme).toMatch(/L2 fixture README/);
    expect(readme).not.toMatch(/Empty-control docs browser fixture/);
  });
});

describe('WORKFLOW boot + AGENTS L2 fixture policy', () => {
  it('setup.boot calls the seed script before starting the isolated instance', async () => {
    const text = await readFile(WORKFLOW_PATH, 'utf8');
    expect(text).toMatch(/l2-seed-control-fixture\.mjs/);
    expect(text).toMatch(/\{scratch_dir\}\/ctrl/);
    // Seed runs before the isolated server starts (same boot chain)
    expect(text).toMatch(
      /l2-seed-control-fixture\.mjs\s+\{scratch_dir\}\/ctrl[\s\S]*?node dist\/src\/main\.js/,
    );
    // Isolation invariants preserved
    expect(text).toMatch(/HERCULES_ADAPTER=fake/);
    expect(text).toMatch(/HERCULES_FAKE_FAULT_INJECTION=1/);
    expect(text).toMatch(/HERCULES_WORK_DIR=\{scratch_dir\}\/work/);
    expect(text).toMatch(/HERCULES_SELF_UPDATE=0/);
    // Resilience L2 evidence targets fixture failover + death cause
    expect(text).toMatch(/l2-fixture-00-resilience-failover|l2-fixture-resilience-failover/);
    expect(text).toMatch(/adapter-failover-timeline|降级/);
    expect(text).toMatch(/agent-death-cause|die-immediately|Death cause|xAI 502|mid-stream/);
    // Empty repos: {} seed is gone — fixture script owns ctrl content
    expect(text).not.toMatch(/printf 'repos: \{\}\\n'/);
  });

  it('AGENTS.md documents fixture use and bans production placeholder chrome for asserts', async () => {
    const text = await readFile(AGENTS_PATH, 'utf8');
    expect(text).toMatch(/l2-seed-control-fixture|L2 fixture|control.?fixture/i);
    expect(text).toMatch(/占位|placeholder|disabled.*button|造假|assert/i);
    // Fixture bootstrap stays out of production boot paths (L3 hard rule)
    expect(text).not.toMatch(/maybeSeedL2Fixture/);
  });

  it('production src/ has no L2 fixture seed bridge', async () => {
    expect(await fileExists(join(ROOT, 'src/control/maybeSeedL2Fixture.ts'))).toBe(false);
    expect(await fileExists(join(ROOT, 'src/isolation/l2ScratchFixture.ts'))).toBe(false);
    const main = await readFile(join(ROOT, 'src/main.ts'), 'utf8');
    expect(main).not.toMatch(/maybeSeedL2Fixture|l2-seed-control-fixture|applyL2ScratchFixture/);
  });
});
