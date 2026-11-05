/**
 * Lane 3 — control panel is read-only over coordinator state.
 *
 * One contract, three lanes. Panel is the operator's phone (`src/web` SPA + `/ceo/`).
 * It may call `/api` as a client. It must not write the coordinator state
 * store (control-repo tasks/repos.yaml, work-root path/branch/daemon leases,
 * cost ledger). Desk (#19) stays parked; this test does not touch it.
 *
 * Read files, assert strings. No mocks, no network, no /api / desk / deploy
 * change. Same style as
 * `l2-boot-work-dir.test.ts` (A4).
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Phone SPA, CEO static mount, and CEO HTML — not `src/server/api.ts`. */
const PANEL_ROOTS = ['src/web', 'src/server/ceoPanel.ts', 'static/ceo'] as const;

const PANEL_FILE_RE = /\.(ts|tsx|js|mjs|cjs|html)$/;

/**
 * Direct state-store writers. UI labels such as `settings-cost-ledger` and
 * `/api` client helpers are not on this list.
 */
const FORBIDDEN_WRITER_IDS = [
  'writeTaskFile',
  'writeReposFile',
  'writeReleaseFile',
  'writeSuccessionFile',
  'GitControlPort',
  'CostLedgerStore',
  'TaskPathLeaseStore',
  'writeOwnerFile',
  'acquireDaemonLease',
  'acquireMainDaemonLease',
  'acquireLeaseForDaemonStartup',
] as const;

/** Filenames / lease dirs the panel must not write (or even name as paths). */
const FORBIDDEN_STATE_FILES = [
  'cost-ledger.json',
  '.hercules-path-leases',
  '.hercules-merge-ops',
] as const;

const FORBIDDEN_WRITER_IMPORT = /(?:from\s+|import\s*\(\s*)['"][^'"]*\/(?:control\/store|control\/costLedgerStore|orchestrator\/gitControlPort|isolation\/taskPathLeaseStore|isolation\/daemonLease(?:Paths|Lifecycle|Flock)?|isolation\/exactLeasePush)(?:\.js)?['"]/;

const FORBIDDEN_FS_WRITE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/;

function writerHit(src: string): string | undefined {
  for (const id of FORBIDDEN_WRITER_IDS) {
    if (src.includes(id)) return id;
  }
  for (const file of FORBIDDEN_STATE_FILES) {
    if (src.includes(file)) return file;
  }
  const importHit = FORBIDDEN_WRITER_IMPORT.exec(src);
  if (importHit) return importHit[0];
  const fsHit = FORBIDDEN_FS_WRITE.exec(src);
  if (fsHit) return fsHit[0];
  return undefined;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      yield* walk(full);
    } else if (ent.isFile() && PANEL_FILE_RE.test(ent.name)) {
      yield full;
    }
  }
}

async function listPanelFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const rel of PANEL_ROOTS) {
    const abs = join(ROOT, rel);
    const st = await stat(abs);
    if (st.isFile()) {
      files.push(abs);
      continue;
    }
    for await (const file of walk(abs)) {
      files.push(file);
    }
  }
  return files;
}

describe('Control panel is read-only over coordinator state', () => {
  it('detector flags a direct state-store writer snippet', () => {
    expect(writerHit("import { writeTaskFile } from '../control/store.js';")).toBe(
      'writeTaskFile',
    );
    expect(writerHit('await new CostLedgerStore({ rootDir }).append(receipt);')).toBe(
      'CostLedgerStore',
    );
    expect(writerHit("await writeFile('cost-ledger.json', body);")).toBe('cost-ledger.json');
    expect(
      writerHit("import { TaskPathLeaseStore } from '../isolation/taskPathLeaseStore.js';"),
    ).toBe('TaskPathLeaseStore');
  });

  it('allows /api client usage and cost-ledger display hooks', () => {
    expect(writerHit("request<StateDto>('/api/state');")).toBeUndefined();
    expect(writerHit('data-evidence="settings-cost-ledger"')).toBeUndefined();
    expect(writerHit("import { readFile } from 'node:fs/promises';")).toBeUndefined();
    expect(writerHit('/** control git commit can take 1–3s */')).toBeUndefined();
  });

  it('panel surfaces exist and do not import or call state-store writers', async () => {
    const files = await listPanelFiles();
    expect(files.length, 'panel surfaces must contain files to scan').toBeGreaterThan(0);

    const rels = files.map((f) => relative(ROOT, f).replaceAll('\\', '/'));
    expect(rels.some((r) => r.startsWith('src/web/'))).toBe(true);
    expect(rels).toContain('src/server/ceoPanel.ts');
    expect(rels).toContain('static/ceo/index.html');

    for (const file of files) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      const src = await readFile(file, 'utf8');
      const hit = writerHit(src);
      expect(hit, `${rel} must not write coordinator state (${hit ?? ''})`).toBeUndefined();
    }
  });

  it('SPA still talks to /api as a client (handlers stay in src/server/api.ts)', async () => {
    const apiClient = await readFile(join(ROOT, 'src/web/api.ts'), 'utf8');
    expect(apiClient, 'src/web/api.ts must remain an /api client').toMatch(/['"`]\/api\//);
    expect(apiClient, 'panel client must not embed GitControlPort').not.toContain('GitControlPort');
    expect(apiClient, 'panel client must not embed writeTaskFile').not.toContain('writeTaskFile');

    const ceo = await readFile(join(ROOT, 'src/server/ceoPanel.ts'), 'utf8');
    expect(ceo, 'ceoPanel may read static HTML').toContain('readFile');
    expect(ceo, 'ceoPanel must serve static/ceo/index.html').toContain('static/ceo/index.html');
    expect(ceo, 'ceoPanel must not write files').not.toMatch(FORBIDDEN_FS_WRITE);
  });
});
