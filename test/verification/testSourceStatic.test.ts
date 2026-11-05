/**
 * Structured test-source static gate: TypeScript + esbuild collectors.
 *
 * Mechanical AC: a fixture with a duplicate object key fails even when no
 * assertions fail; removing the duplicate turns the gate green.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import {
  collectEsbuildTransformDiagnostics,
  collectTypescriptDiagnostics,
  runTestSourceStaticGate,
} from '../../src/verification/testSourceStatic.js';
import { KNOWN_ACTIONABLE_STATIC_CODES } from '../../src/domain/staticDiagnostics.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function esbuildAvailable(): boolean {
  for (const host of ['vite', 'vitest', 'esbuild'] as const) {
    try {
      if (host === 'esbuild') {
        require('esbuild');
        return true;
      }
      const hostPkg = require.resolve(host + '/package.json');
      createRequire(hostPkg)('esbuild');
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

function typescriptAvailable(): boolean {
  try {
    require('typescript');
    return true;
  } catch {
    return false;
  }
}

describe('testSourceStatic collectors (structured evidence)', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'hercules-static-diag-'));
  });

  it('esbuild flags duplicate object keys with file/line', async () => {
    if (!esbuildAvailable()) {
      // L1 install always provides vite/esbuild; skip only in bare sandboxes.
      expect(esbuildAvailable()).toBe(true);
      return;
    }
    const dir = join(scratch, 'dup');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'dup-policy.ts');
    // Prior incident: duplicate policy key — assertions can still pass.
    await writeFile(
      file,
      [
        'export const fixture = {',
        "  policy: 'a',",
        "  policy: 'b',",
        '};',
        'export function ok() { return fixture.policy === "b"; }',
        '',
      ].join('\n'),
      'utf8',
    );

    const diags = await collectEsbuildTransformDiagnostics(scratch, [file]);
    const actionable = diags.filter(
      (d) => d.severity === 'error' || d.severity === 'warning',
    );
    expect(actionable.length).toBeGreaterThan(0);
    const hit = actionable.find(
      (d) =>
        /duplicate/i.test(d.message) ||
        (d.code != null && /duplicate/i.test(d.code)),
    );
    expect(hit).toBeTruthy();
    expect(hit!.file).toMatch(/dup-policy\.ts/);
    expect(hit!.line).toBeTypeOf('number');

    // Removing the duplicate turns the transform clean.
    await writeFile(
      file,
      [
        'export const fixture = {',
        "  policy: 'b',",
        '};',
        'export function ok() { return fixture.policy === "b"; }',
        '',
      ].join('\n'),
      'utf8',
    );
    const clean = await collectEsbuildTransformDiagnostics(scratch, [file]);
    const cleanActionable = clean.filter(
      (d) => d.severity === 'error' || d.severity === 'warning',
    );
    expect(cleanActionable).toEqual([]);
  });

  it('typescript flags unresolved imports with TS2307', async () => {
    if (!typescriptAvailable()) {
      expect(typescriptAvailable()).toBe(true);
      return;
    }
    const dir = join(scratch, 'unresolved');
    await mkdir(dir, { recursive: true });
    const tsconfig = join(dir, 'tsconfig.json');
    const src = join(dir, 'bad-import.ts');
    await writeFile(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['./**/*.ts'],
      }),
      'utf8',
    );
    await writeFile(
      src,
      "import { missing } from './definitely-not-there.js';\nexport const x = missing;\n",
      'utf8',
    );

    const diags = collectTypescriptDiagnostics(dir, ['tsconfig.json']);
    const unresolved = diags.filter(
      (d) => d.code === KNOWN_ACTIONABLE_STATIC_CODES.typescriptUnresolvedModule,
    );
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved[0]!.file).toMatch(/bad-import\.ts/);
    expect(unresolved[0]!.line).toBeTypeOf('number');
  });

  it('typescript flags duplicate object keys with TS1117', async () => {
    if (!typescriptAvailable()) {
      expect(typescriptAvailable()).toBe(true);
      return;
    }
    const dir = join(scratch, 'ts-dup');
    await mkdir(dir, { recursive: true });
    const tsconfig = join(dir, 'tsconfig.json');
    const src = join(dir, 'dup.ts');
    await writeFile(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['./**/*.ts'],
      }),
      'utf8',
    );
    await writeFile(
      src,
      "export const policy = { mode: 'a', mode: 'b' };\n",
      'utf8',
    );

    const bad = collectTypescriptDiagnostics(dir, ['tsconfig.json']);
    expect(
      bad.some((d) => d.code === KNOWN_ACTIONABLE_STATIC_CODES.typescriptDuplicateKey),
    ).toBe(true);

    await writeFile(src, "export const policy = { mode: 'b' };\n", 'utf8');
    const good = collectTypescriptDiagnostics(dir, ['tsconfig.json']);
    expect(
      good.some((d) => d.code === KNOWN_ACTIONABLE_STATIC_CODES.typescriptDuplicateKey),
    ).toBe(false);
  });

  it('runTestSourceStaticGate fails closed on duplicate-key fixture and passes when fixed', async () => {
    if (!esbuildAvailable()) {
      expect(esbuildAvailable()).toBe(true);
      return;
    }
    const dir = join(scratch, 'gate');
    await mkdir(join(dir, 'test'), { recursive: true });
    const file = join(dir, 'test', 'fixture-dup.ts');
    await writeFile(
      file,
      "export const o = { k: 1, k: 2 };\nexport const pass = () => true;\n",
      'utf8',
    );

    const failed = await runTestSourceStaticGate({
      rootDir: dir,
      includeTypescript: false,
      includeEsbuild: true,
      files: [file],
    });
    expect(failed.ok).toBe(false);
    expect(failed.report).toMatch(/actionable finding/);
    expect(failed.report).toMatch(/fixture-dup\.ts/);

    await writeFile(
      file,
      "export const o = { k: 2 };\nexport const pass = () => true;\n",
      'utf8',
    );
    const passed = await runTestSourceStaticGate({
      rootDir: dir,
      includeTypescript: false,
      includeEsbuild: true,
      files: [file],
    });
    expect(passed.ok).toBe(true);
  });

  it('gate script is wired into package.json typecheck (all L1 paths)', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['typecheck']).toContain('check-test-source-static.mjs');
    expect(pkg.scripts['typecheck']).toContain('tsconfig.test-web.json');
    expect(pkg.scripts['typecheck']).toMatch(/tsc -p src\/web\/tsconfig\.json/);
    // Script uses structured esbuild messages, not stderr greps for "warning".
    const script = await readFile(
      join(ROOT, 'scripts/check-test-source-static.mjs'),
      'utf8',
    );
    expect(script).toMatch(/transformSync/);
    expect(script).toMatch(/result\.warnings/);
    expect(script).not.toMatch(/stderr\.includes\(['"]warning/i);
  });
});
