/**
 * L2 deploy.staging fixture seed (scripts/l2-seed-deploy-staging-fixture.mjs).
 *
 * Proves the hermetic seed lands a deploy.staging repo + release record +
 * ahead task so Releases digest chrome is non-empty, and that re-runs are
 * byte-identical (the v2 wipe bug regresses here).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseTaskFile } from '../../src/control/taskFile.js';
import { parseReposConfig } from '../../src/control/reposConfig.js';
import { parseReleaseFile } from '../../src/control/releaseFile.js';
import { parseWorkflow } from '../../src/control/workflow.js';
import { buildSnapshot } from '../../src/control/snapshot.js';
import { buildReleasePanelEntry } from '../../src/domain/release.js';

const execFileAsync = promisify(execFile);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts/l2-seed-deploy-staging-fixture.mjs');
const CONTROL_SCRIPT = join(ROOT, 'scripts/l2-seed-control-fixture.mjs');
const REPO_KEY = 'fixture-deploy-staging';
const AHEAD_TASK_ID = 'l2-fixture-deploy-staging-ahead';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('scripts/l2-seed-deploy-staging-fixture.mjs', { timeout: 60_000 }, () => {
  let scratchDir: string;
  let ctrlDir: string;

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'hercules-l2-deploy-staging-'));
    ctrlDir = join(scratchDir, 'ctrl');
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  it('script exists', async () => {
    expect(await fileExists(SCRIPT)).toBe(true);
  });

  it(
    'seeds a deploy.staging repo + release record + ahead task for digest',
    async () => {
      await execFileAsync(process.execPath, [CONTROL_SCRIPT, ctrlDir], { cwd: ROOT });

      const snap = await buildSnapshot(ctrlDir);
      expect(snap.problems).toEqual([]);
      expect(snap.repos.repos[REPO_KEY]).toBeDefined();

      const workflowPath = join(scratchDir, 'work', '.l2-demo-src', REPO_KEY, 'WORKFLOW.md');
      const wf = parseWorkflow(await readFile(workflowPath, 'utf8'));
      expect(wf.deploy?.staging?.command).toMatch(/printf l2-fixture-no-staging-deploy/);
      expect(wf.deploy?.staging?.health).toBeTruthy();
      expect(wf.deploy?.production?.command).toBeTruthy();

      const release = parseReleaseFile(
        await readFile(join(ctrlDir, 'releases', `${REPO_KEY}.md`), 'utf8'),
        REPO_KEY,
      );
      expect(release.productionSha).toBeTruthy();
      expect(release.stagingSha).toBeTruthy();
      expect(release.productionSha).not.toBe(release.stagingSha);
      expect(release.stagingStatus).toBe('ready');

      const ahead = parseTaskFile(
        await readFile(join(ctrlDir, 'tasks', `${AHEAD_TASK_ID}.md`), 'utf8'),
        AHEAD_TASK_ID,
      );
      expect(ahead.repo).toBe(REPO_KEY);
      expect(ahead.state).toBe('done');
      expect(ahead.mergedSha).toBe(release.stagingSha);
      expect(ahead.title).toMatch(/\[L2 fixture\]/);

      const entry = buildReleasePanelEntry({
        release,
        mainSha: release.stagingSha,
        stagingUrl: wf.deploy?.staging?.url ?? null,
        hasProductionDeploy: true,
        tasks: snap.tasks,
      });
      expect(entry.aheadCount).toBeGreaterThan(0);
      expect(entry.digest.headlines.length).toBeGreaterThan(0);
      expect(entry.stagingDrift).toBe(false);
    },
    60_000,
  );

  it(
    'is idempotent: re-run produces identical seeded bytes',
    async () => {
      await execFileAsync(process.execPath, [CONTROL_SCRIPT, ctrlDir], { cwd: ROOT });
      await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });

      const reposPath = join(ctrlDir, 'repos.yaml');
      const releasePath = join(ctrlDir, 'releases', `${REPO_KEY}.md`);
      const aheadPath = join(ctrlDir, 'tasks', `${AHEAD_TASK_ID}.md`);

      const before = {
        repos: await readFile(reposPath, 'utf8'),
        release: await readFile(releasePath, 'utf8'),
        ahead: await readFile(aheadPath, 'utf8'),
      };

      await execFileAsync(process.execPath, [SCRIPT, ctrlDir], { cwd: ROOT });

      expect(await readFile(reposPath, 'utf8')).toBe(before.repos);
      expect(await readFile(releasePath, 'utf8')).toBe(before.release);
      expect(await readFile(aheadPath, 'utf8')).toBe(before.ahead);

      // Still a valid registry after re-run.
      const cfg = parseReposConfig(before.repos);
      expect(cfg.repos[REPO_KEY]).toBeDefined();
    },
    60_000,
  );
});
