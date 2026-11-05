/**
 * Gate script contract — structured collectors, allowlist discipline, L1 wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts/check-test-source-static.mjs');
const WORKFLOW = join(ROOT, 'WORKFLOW.md');
const PKG = join(ROOT, 'package.json');
const TEST_WEB_TSCONFIG = join(ROOT, 'tsconfig.test-web.json');

describe('scripts/check-test-source-static.mjs contract', () => {
  it('uses structured esbuild transform APIs (not stderr warning greps)', async () => {
    const src = await readFile(SCRIPT, 'utf8');
    expect(src).toMatch(/transformSync/);
    expect(src).toMatch(/result\.warnings/);
    // TypeScript project checks are real `tsc -p` in package.json typecheck.
    // Must not implement a global "any stderr warning fails" policy.
    expect(src).not.toMatch(/\/warning\/i/);
    expect(src).not.toMatch(/includes\(['`"]warning/i);
  });

  it('keeps default allowlist empty (no silent mask of new diagnostics)', async () => {
    const src = await readFile(SCRIPT, 'utf8');
    expect(src).toMatch(/ALLOWLIST\s*=\s*Object\.freeze\(\[\]\)/);
  });

  it('bounds and redacts gate evidence output', async () => {
    const src = await readFile(SCRIPT, 'utf8');
    expect(src).toMatch(/REPORT_MAX_CHARS\s*=\s*4000/);
    expect(src).toMatch(/REDACTED/);
  });

  it('is on the typecheck script used by WORKFLOW L1 (verify/reverify/merge)', async () => {
    const pkg = JSON.parse(await readFile(PKG, 'utf8')) as {
      scripts: Record<string, string>;
    };
    const wf = await readFile(WORKFLOW, 'utf8');
    expect(pkg.scripts['typecheck']).toContain('check-test-source-static.mjs');
    expect(pkg.scripts['typecheck']).toContain('tsconfig.test-web.json');
    // WORKFLOW typecheck gate runs pnpm typecheck — same command for all L1 paths.
    expect(wf).toMatch(/typecheck:\s*pnpm typecheck/);
  });

  it('typechecks every web test so unresolved imports cannot hide outside render tests', async () => {
    const config = JSON.parse(await readFile(TEST_WEB_TSCONFIG, 'utf8')) as {
      include?: string[];
    };
    expect(config.include).toContain('test/web/**/*.ts');
    expect(config.include).toContain('test/web/**/*.tsx');
    expect(config.include).not.toContain('test/web/render/**/*.ts');
  });
});
