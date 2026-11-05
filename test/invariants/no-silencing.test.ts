/**
 * Structural quality gate — "no silencing to make green" (WORKFLOW.md / SPEC §9.5).
 *
 * Scans the repo for patterns that hide failures. Runs in the *unit* suite so a
 * drive-by `it.skip` or `as any` fails the fast local check, not only CI.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Directories we own and must keep clean. */
const SCAN_DIRS = ['src', 'test'] as const;

/**
 * Files that must mention the banned strings as *subject matter* (the
 * anti-cheat detector, its fixtures, this scanner) rather than as silencers.
 */
const ALLOWLIST = new Set([
  'test/invariants/no-silencing.test.ts',
  'src/verification/antiCheat.ts',
  'test/verification/antiCheat.test.ts',
  'src/domain/verification.ts', // AntiCheatKind union includes 'eslint-disable'
  // Subject-matter mentions (L3 prompt, packet fixtures, UI L5 parsing) — not silencers.
  'src/verification/reviewer.ts',
  'src/web/taskBodySplit.ts',
  'test/verification/packet.test.ts',
  'test/web/taskBody.test.ts',
  'src/verification/packet.ts',
]);

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

const RULES: readonly { name: string; re: RegExp }[] = [
  // Vitest / Jest skip patterns — hide failing cases.
  { name: 'it.skip / test.skip', re: /\b(?:it|test|describe)\.skip\s*\(/ },
  { name: 'xit / xdescribe', re: /\bx(?:it|describe)\s*\(/ },
  // TypeScript escape hatches.
  { name: '@ts-ignore / @ts-nocheck / @ts-expect-error', re: /@ts-(?:ignore|nocheck|expect-error)\b/ },
  { name: 'as any', re: /\bas\s+any\b/ },
  // Lint suppressions that paper over architecture rules.
  { name: 'eslint-disable', re: /eslint-disable(?:-next-line|-line)?\b/ },
];

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      yield* walk(full);
    } else if (ent.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(ent.name)) {
      yield full;
    }
  }
}

async function scan(): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const d of SCAN_DIRS) {
    const base = join(ROOT, d);
    try {
      await stat(base);
    } catch {
      continue;
    }
    for await (const file of walk(base)) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (ALLOWLIST.has(rel)) continue;
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Allow a single-line exception marker for rare, reviewed cases.
        if (line.includes('hercules-allow-silencing')) continue;
        for (const rule of RULES) {
          if (rule.re.test(line)) {
            hits.push({ file: rel, line: i + 1, rule: rule.name, text: line.trim() });
          }
        }
      }
    }
  }
  return hits;
}

describe('no-silencing invariant', () => {
  it('src/ and test/ contain no skip / any / ts-ignore / eslint-disable', async () => {
    const hits = await scan();
    const report = hits
      .map((h) => `  ${h.file}:${h.line}  [${h.rule}]  ${h.text}`)
      .join('\n');
    expect(
      hits,
      hits.length === 0
        ? undefined
        : `found ${hits.length} silencing pattern(s) — fix the root cause, do not hide it:\n${report}\n` +
            `(add trailing comment "hercules-allow-silencing" only for a reviewed, permanent exception)`,
    ).toEqual([]);
  });
});
