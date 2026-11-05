/**
 * Deploy scripts + WORKFLOW deploy policy (release-7 / design §4, §7-ops).
 *
 * Mechanical gates: scripts exist, pass shellcheck when available, encode the
 * isolation / restart contracts, and WORKFLOW.md declares deploy + protects them.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseWorkflow } from '../../src/control/workflow.js';

const execFileAsync = promisify(execFile);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const STAGING = join(ROOT, 'scripts/deploy-staging.sh');
const PRODUCTION = join(ROOT, 'scripts/deploy-production.sh');
const WORKFLOW_PATH = join(ROOT, 'WORKFLOW.md');
const DEPLOY_DOC = join(ROOT, 'docs/deploy.md');

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function shellcheckAvailable(): Promise<boolean> {
  try {
    await execFileAsync('shellcheck', ['--version']);
    return true;
  } catch {
    return false;
  }
}

describe('deploy scripts (release-7)', () => {
  it('scripts/deploy-staging.sh and scripts/deploy-production.sh exist and are executable shebangs', async () => {
    expect(await fileExists(STAGING)).toBe(true);
    expect(await fileExists(PRODUCTION)).toBe(true);
    const staging = await readFile(STAGING, 'utf8');
    const production = await readFile(PRODUCTION, 'utf8');
    expect(staging.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(production.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(staging).toMatch(/\bset -euo pipefail\b/);
    expect(production).toMatch(/\bset -euo pipefail\b/);
  });

  it('staging script builds into staging tree, refreshes control copy, restarts hercules-staging', async () => {
    const text = await readFile(STAGING, 'utf8');
    // Isolation defaults (design §4) — paths or env knobs that do not use HERCULES_*
    // prefixes (deploy children get scrubHerculesEnv).
    expect(text).toMatch(/hercules-staging|STAGING_UNIT/);
    expect(text).toMatch(/STAGING_CODE|Hercules-staging/);
    expect(text).toMatch(/STAGING_CONTROL|hercules-live-staging/);
    expect(text).toMatch(/STAGING_CONTROL_SRC|hercules-live/);
    // Build path
    expect(text).toMatch(/pnpm install --frozen-lockfile/);
    expect(text).toMatch(/pnpm build/);
    // Control-repo copy refresh
    expect(text).toMatch(/rsync|cp -a/);
    // Refreshing the control copy replaces the git history the staging M4
    // shadow store binds to (cutover soak finding 4): the store must be reset
    // right after, from the staging env file (deploy env is scrubbed), and the
    // reset must refuse anything that is not a staging-scoped database.
    expect(text).toMatch(/reset_staging_shadow_store/);
    expect(text).toMatch(/HERCULES_V2_SHADOW_DATABASE=/);
    expect(text).toMatch(/\*staging\*/);
    // C3: the M5 archive metadata lives in that same store, so the staging
    // evidence root (artifacts / exports / staged bundles) is reset with it,
    // read from the same env file and refusing non-staging or symlinked roots.
    expect(text).toMatch(/reset_staging_evidence_root/);
    expect(text).toMatch(/HERCULES_V2_EVIDENCE_ROOT=/);
    expect(text).toMatch(/refusing to reset non-staging evidence root/);
    // Restart contract
    expect(text).toMatch(/systemctl/);
    expect(text).toMatch(/NEEDS-OPERATOR/);
  });

  it('production script takes <sha>, fetch+checkout, install, build, restart (self-update aligned)', async () => {
    const text = await readFile(PRODUCTION, 'utf8');
    expect(text).toMatch(/usage:|Usage:|<sha>/);
    expect(text).toMatch(/git fetch/);
    expect(text).toMatch(/checkout|reset --hard/);
    expect(text).toMatch(/pnpm install --frozen-lockfile/);
    expect(text).toMatch(/pnpm build/);
    expect(text).toMatch(/systemctl/);
    expect(text).toMatch(/NEEDS-OPERATOR/);
    // Reject garbage sha
    expect(text).toMatch(/invalid|sha/i);
  });

  it('shellcheck passes on both deploy scripts when shellcheck is installed', async () => {
    if (!(await shellcheckAvailable())) {
      // Host without shellcheck: structural tests above still guard contracts.
      expect(await fileExists(STAGING)).toBe(true);
      return;
    }
    for (const script of [STAGING, PRODUCTION]) {
      const { stdout, stderr } = await execFileAsync('shellcheck', ['-x', script], {
        encoding: 'utf8',
      });
      const out = `${stdout}${stderr}`.trim();
      expect(out, `shellcheck ${script}: ${out}`).toBe('');
    }
  });

  it('production script rejects missing/invalid sha without mutating the tree', async () => {
    if (!(await fileExists(PRODUCTION))) return;
    // Missing arg
    try {
      await execFileAsync('bash', [PRODUCTION], { encoding: 'utf8', timeout: 5_000 });
      expect.fail('expected non-zero exit for missing sha');
    } catch (err) {
      const e = err as { code?: number; stderr?: string; stdout?: string };
      expect(e.code).not.toBe(0);
      expect(`${e.stderr ?? ''}${e.stdout ?? ''}`).toMatch(/usage|sha/i);
    }
    // Invalid sha
    try {
      await execFileAsync('bash', [PRODUCTION, '../evil'], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect.fail('expected non-zero exit for invalid sha');
    } catch (err) {
      const e = err as { code?: number; stderr?: string; stdout?: string };
      expect(e.code).not.toBe(0);
      expect(`${e.stderr ?? ''}${e.stdout ?? ''}`).toMatch(/invalid|sha/i);
    }
  });
});

describe('WORKFLOW.md deploy policy (hercules first landing)', () => {
  it('declares deploy.staging + deploy.production and protects the scripts', async () => {
    const raw = await readFile(WORKFLOW_PATH, 'utf8');
    const wf = parseWorkflow(raw);

    expect(wf.deploy).toBeDefined();
    expect(wf.deploy?.staging?.command).toMatch(/deploy-staging\.sh/);
    expect(wf.deploy?.staging?.health).toMatch(/8788/);
    expect(wf.deploy?.staging?.url).toMatch(/8788/);
    expect(wf.deploy?.staging?.verify.length).toBeGreaterThan(0);
    expect(wf.deploy?.staging?.verify.some((s) => s.kind === 'unlock')).toBe(true);

    expect(wf.deploy?.production?.command).toMatch(/deploy-production\.sh/);
    expect(wf.deploy?.production?.command).toMatch(/<sha>|\{sha\}/);
    expect(wf.deploy?.production?.health).toMatch(/8787/);
    expect(wf.deploy?.production?.smoke).toBeTruthy();

    const protectedJoined = wf.protectedPaths.join('\n');
    expect(protectedJoined).toMatch(/scripts\/deploy-staging\.sh/);
    expect(protectedJoined).toMatch(/scripts\/deploy-production\.sh/);
  });
});

describe('docs/deploy.md hercules-staging runbook', () => {
  it('documents hercules-staging unit isolation knobs and install/rollback', async () => {
    const doc = await readFile(DEPLOY_DOC, 'utf8');
    expect(doc).toMatch(/hercules-staging/);
    expect(doc).toMatch(/8788/);
    expect(doc).toMatch(/HERCULES_ADAPTER=fake/);
    expect(doc).toMatch(/HERCULES_DISPATCH_ENABLED=0/);
    expect(doc).toMatch(/HERCULES_SELF_UPDATE=0/);
    expect(doc).toMatch(/HERCULES_PUSH=/);
    expect(doc).toMatch(/HERCULES_WORK_DIR/);
    expect(doc).toMatch(/HERCULES_TOKEN/);
    expect(doc).toMatch(/deploy-staging\.sh|deploy-production\.sh/);
    expect(doc).toMatch(/[Rr]ollback/);
    // Unit file content present
    expect(doc).toMatch(/\[Service\]/);
    expect(doc).toMatch(/WorkingDirectory/);
  });
});
