/**
 * Repos panel docs browser: open README / docs/*.md from the trusted mirror
 * without leaving the phone Repos sheet.
 *
 * Reader-first layout + entry pins + search (repo-docs-reader-ux).
 * Registry keys always use fetchRepoDocs/fetchRepoDoc — no client short-circuit.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('repo docs browser wiring', () => {
  it('client api exposes fetchRepoDocs/fetchRepoDoc', async () => {
    const api = await readFile(join(ROOT, 'src/web/api.ts'), 'utf8');
    expect(api).toMatch(/export const fetchRepoDocs/);
    expect(api).toMatch(/export const fetchRepoDoc /);
    expect(api).toMatch(/\/docs/);
    expect(api).toMatch(/encodeURIComponent\(path\)/);
  });

  it('ReposPanel renders a browse-docs disclosure with markdown view', async () => {
    const src = await readFile(join(ROOT, 'src/web/ReposPanel.tsx'), 'utf8');
    expect(src).toMatch(/data-evidence="repo-docs"/);
    expect(src).toMatch(/data-evidence="repo-doc-view"/);
    expect(src).toMatch(/data-evidence="repo-doc-row"/);
    expect(src).toMatch(/data-evidence="repo-browse-docs"/);
    expect(src).toMatch(/fetchRepoDocs\(/);
    expect(src).toMatch(/fetchRepoDoc\(/);
    expect(src).toMatch(/\.md['"`]?\)?\s*\?|endsWith\(['"`]\.md/);
  });

  it('wires entry pins, search, all-toggle, and reader-above-list', async () => {
    const src = await readFile(join(ROOT, 'src/web/ReposPanel.tsx'), 'utf8');
    expect(src).toMatch(/data-evidence="repo-docs-entrypoints"/);
    expect(src).toMatch(/data-evidence="repo-docs-search"/);
    expect(src).toMatch(/data-evidence="repo-docs-all-toggle"/);
    expect(src).toMatch(/splitRepoDocEntrypoints/);
    expect(src).toMatch(/filterDocsByQuery/);
    expect(src).toMatch(/scrollIntoView/);
    // Reader block appears before entrypoints/list in the JSX tree.
    const viewIdx = src.indexOf('data-evidence="repo-doc-view"');
    const entryIdx = src.indexOf('data-evidence="repo-docs-entrypoints"');
    expect(viewIdx).toBeGreaterThan(-1);
    expect(entryIdx).toBeGreaterThan(-1);
    expect(viewIdx).toBeLessThan(entryIdx);
    expect(src).toMatch(/Back to list/);
  });

  it('never short-circuits a registry key to client fixture content', async () => {
    const src = await readFile(join(ROOT, 'src/web/ReposPanel.tsx'), 'utf8');
    // No empty-registry fake row hijacking key `demo` (collides with real L2 mirror).
    expect(src).not.toMatch(/emptyReposDocsDemo|emptyReposDocsContent|EMPTY_REPOS_DOCS/);
    expect(src).not.toMatch(/repo-empty-demo/);
    // openDocs / openDocFile always call the API helpers.
    expect(src).toMatch(/fetchRepoDocs\(/);
    expect(src).toMatch(/fetchRepoDoc\(/);
    // Empty registry is plain copy, not a demo browse host.
    expect(src).toMatch(/No repos configured/);
    expect(src).not.toMatch(/no registry — docs demo/);
  });
});
