#!/usr/bin/env node
/**
 * L2 deploy.staging fixture seed.
 *
 * Adds one hermetic synthetic repo whose trusted WORKFLOW declares
 * deploy.staging (+ production) with fake no-op commands, a seeded
 * releases/<repo>.md record, and an ahead task so the existing WORKFLOW
 * releases scene can screenshot a non-empty digest — without editing
 * WORKFLOW.md.
 *
 * Usage (from repo root; also invoked by l2-seed-control-fixture.mjs):
 *   node scripts/l2-seed-deploy-staging-fixture.mjs {scratch_dir}/ctrl
 *
 * Safe by design:
 *   - Writes only under the scratch layout (ctrl + sibling work/).
 *   - Fake deploy commands never reference scripts/deploy-*.sh.
 *   - Idempotent: fixed GIT_* dates → stable SHAs; re-run = identical bytes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const REPO_KEY = 'fixture-deploy-staging';
const AHEAD_TASK_ID = 'l2-fixture-deploy-staging-ahead';
const PROD_DATE = '2026-08-01T00:00:00 +0000';
const STAGING_DATE = '2026-08-02T00:00:00 +0000';

const ctrlArg = process.argv[2];
if (!ctrlArg || ctrlArg.trim() === '') {
  console.error('usage: node scripts/l2-seed-deploy-staging-fixture.mjs <control-dir>');
  process.exit(2);
}

const ctrlDir = resolve(ctrlArg);
const workRoot = resolve(join(ctrlDir, '..', 'work'));
const tasksDir = join(ctrlDir, 'tasks');
const releasesDir = join(ctrlDir, 'releases');

const FIXTURE_WORKFLOW = [
  '---',
  'gates:',
  '  typecheck: "true"',
  '  lint: "true"',
  '  test: "true"',
  '  build: "true"',
  'deploy:',
  '  staging:',
  '    command: "printf l2-fixture-no-staging-deploy"',
  '    health: "printf l2-fixture-healthy"',
  '    url: "http://127.0.0.1:9/"',
  '  production:',
  '    command: "printf l2-fixture-no-production-deploy <sha>"',
  '    health: "printf l2-fixture-healthy"',
  '    smoke: "printf l2-fixture-smoke-ok"',
  '---',
  '',
  '# L2 fixture deploy.staging repo',
  '',
  'Hermetic synthetic repo for Releases panel evidence. Commands are printf',
  'no-ops; fixture-mode guards also block any spawn.',
  '',
].join('\n');

function git(args, cwd, extraEnv = {}) {
  return execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'hercules-l2-fixture',
        GIT_AUTHOR_EMAIL: 'l2-fixture@hercules.local',
        GIT_COMMITTER_NAME: 'hercules-l2-fixture',
        GIT_COMMITTER_EMAIL: 'l2-fixture@hercules.local',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        ...extraEnv,
      },
    },
  );
}

function gitErrText(err) {
  if (!err || typeof err !== 'object') return String(err);
  const parts = [];
  if ('stderr' in err && err.stderr) parts.push(String(err.stderr));
  if ('stdout' in err && err.stdout) parts.push(String(err.stdout));
  if (err instanceof Error && err.message) parts.push(err.message);
  return parts.join('\n');
}

function initGitRepo(dir) {
  try {
    git(['init', '-q', '-b', 'main'], dir);
  } catch (err) {
    const text = gitErrText(err);
    if (!/unknown option|invalid option|-b/i.test(text)) throw err;
    git(['init', '-q'], dir);
  }
}

/**
 * Two deterministic commits → production tip + staging/main tip.
 * @returns {{ productionSha: string; stagingSha: string; sourceDir: string }}
 */
function seedDeployStagingMirror() {
  const sourceDir = join(workRoot, '.l2-demo-src', REPO_KEY);
  // Wipe prior tree so re-runs do not fold CHANGELOG into the baseline commit
  // (that made the ahead commit empty → git commit failed on idempotent re-seed).
  if (existsSync(sourceDir)) {
    rmSync(sourceDir, { recursive: true, force: true });
  }
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'README.md'), '# Fixture deploy staging\n\nL2 only.\n', 'utf8');
  writeFileSync(join(sourceDir, 'WORKFLOW.md'), FIXTURE_WORKFLOW, 'utf8');

  initGitRepo(sourceDir);
  git(['add', '.'], sourceDir);
  git(['commit', '-qm', 'l2: fixture deploy staging base'], sourceDir, {
    GIT_AUTHOR_DATE: PROD_DATE,
    GIT_COMMITTER_DATE: PROD_DATE,
  });
  git(['branch', '-M', 'main'], sourceDir);
  const productionSha = git(['rev-parse', 'HEAD'], sourceDir).trim();

  writeFileSync(
    join(sourceDir, 'CHANGELOG.md'),
    '# Changelog\n\n- [L2 fixture] Seeded ahead change for releases digest\n',
    'utf8',
  );
  git(['add', '.'], sourceDir);
  git(['commit', '-qm', 'l2: fixture deploy staging ahead'], sourceDir, {
    GIT_AUTHOR_DATE: STAGING_DATE,
    GIT_COMMITTER_DATE: STAGING_DATE,
  });
  const stagingSha = git(['rev-parse', 'HEAD'], sourceDir).trim();

  const mirrorsDir = join(workRoot, '.mirrors');
  mkdirSync(mirrorsDir, { recursive: true });
  const mirrorPath = join(mirrorsDir, REPO_KEY + '.git');
  if (existsSync(mirrorPath)) {
    rmSync(mirrorPath, { recursive: true, force: true });
  }
  git(['clone', '--bare', '--quiet', sourceDir, mirrorPath], workRoot);
  return { productionSha, stagingSha, sourceDir };
}

function plainRepoEntry(entry) {
  const out = {
    url: String(entry.url ?? ''),
    default_branch: String(entry.default_branch ?? 'main'),
    workflow: String(entry.workflow ?? 'WORKFLOW.md'),
    max_concurrent: Number(entry.max_concurrent ?? 1),
    readiness: String(entry.readiness ?? 'ready'),
  };
  if (entry.adapter != null && String(entry.adapter).trim() !== '') {
    out.adapter = String(entry.adapter);
  }
  return out;
}

function mergeReposYaml(sourceDir) {
  const reposPath = join(ctrlDir, 'repos.yaml');
  let repos = {};
  if (existsSync(reposPath)) {
    const raw = parseYaml(readFileSync(reposPath, 'utf8'));
    if (raw && typeof raw === 'object' && raw.repos && typeof raw.repos === 'object') {
      // New object copy; REPO_KEY overwrite + sorted stringify keep re-runs stable.
      repos = Object.assign({}, raw.repos);
    }
  }
  // Rebuild plain field objects so re-stringify is byte-stable across YAML parses.
  const plain = {};
  for (const [key, value] of Object.entries(repos)) {
    if (!value || typeof value !== 'object') continue;
    plain[key] = plainRepoEntry(value);
  }
  plain[REPO_KEY] = {
    url: sourceDir,
    default_branch: 'main',
    workflow: 'WORKFLOW.md',
    max_concurrent: 1,
    readiness: 'ready',
    adapter: 'fake',
  };
  writeFileSync(
    reposPath,
    stringifyYaml(
      { repos: plain },
      { sortMapEntries: true, defaultStringType: 'QUOTE_DOUBLE' },
    ),
    'utf8',
  );
}

function writeReleaseRecord(productionSha, stagingSha) {
  mkdirSync(releasesDir, { recursive: true });
  const lines = [
    '---',
    'production_sha: ' + productionSha,
    'staging_sha: ' + stagingSha,
    'staging_status: ready',
    'production_deployed_at: "2026-08-01T00:00:00.000Z"',
    'staging_verified_at: "2026-08-02T00:00:00.000Z"',
    'history:',
    '  - sha: ' + productionSha,
    '    at: "2026-08-01T00:00:00.000Z"',
    '    outcome: ok',
    '---',
    '',
    '## Release packet',
    '',
    '[L2 fixture] Seeded staging-ready release for visual evidence.',
    '',
  ];
  writeFileSync(join(releasesDir, REPO_KEY + '.md'), lines.join('\n') + '\n', 'utf8');
}

function writeAheadTask(stagingSha) {
  mkdirSync(tasksDir, { recursive: true });
  const lines = [
    '---',
    'id: ' + AHEAD_TASK_ID,
    'title: "[L2 fixture] Staging ahead change for Releases digest"',
    'repo: ' + REPO_KEY,
    'state: done',
    'priority: 55',
    'blocked_by: []',
    'merged_sha: "' + stagingSha + '"',
    'merged_via: gate',
    'labels: [l2-fixture, releases]',
    'agent_session: null',
    'attempts: 1',
    'last_event_at: "2026-08-02T00:00:00.000Z"',
    '---',
    '',
    '## Goal',
    '',
    'Seed ahead task so Releases digest is non-empty for L2 evidence.',
    '',
    '## Task',
    '',
    '[L2 fixture] Merged onto staging tip for digest chrome.',
    '',
  ];
  writeFileSync(join(tasksDir, AHEAD_TASK_ID + '.md'), lines.join('\n') + '\n', 'utf8');
}

function seed() {
  mkdirSync(ctrlDir, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(releasesDir, { recursive: true });

  const staged = seedDeployStagingMirror();
  mergeReposYaml(staged.sourceDir);
  // staging_sha == main tip (no drift); production != staging so digest has range.
  writeReleaseRecord(staged.productionSha, staged.stagingSha);
  writeAheadTask(staged.stagingSha);
}

seed();
console.error(
  '[l2-seed-deploy-staging-fixture] seeded ' + REPO_KEY + ' under ' + ctrlDir + ' (work=' + workRoot + ')',
);
