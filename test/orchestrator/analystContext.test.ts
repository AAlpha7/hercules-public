import { describe, expect, it, vi } from 'vitest';
import {
  compileAnalystContext,
  escapeEreLiteral,
  type AnalystContextDeps,
} from '../../src/orchestrator/analystContext.js';
import type { RepoConfig } from '../../src/domain/repos.js';

const repo: RepoConfig = {
  key: 'app',
  url: 'x',
  defaultBranch: 'main',
  workflow: 'WORKFLOW.md',
  maxConcurrent: 1,
  adapter: null,
  readiness: 'ready',
};

const WORKFLOW = `---
gates:
  typecheck: pnpm typecheck
  lint: pnpm lint
  test: pnpm test
protected_paths:
  - WORKFLOW.md
  - AGENTS.md
---
be careful
`;

function makeDeps(overrides?: Partial<AnalystContextDeps>): AnalystContextDeps {
  return {
    readTrustedFile: vi.fn(async (_r, path) => {
      if (path === 'AGENTS.md') return 'line1\nline2\nline3\n';
      return null;
    }),
    listTrustedFiles: vi.fn(async () => [
      'src/a.ts',
      'test/a.test.ts',
      'test/b.spec.tsx',
      'src/b.ts',
    ]),
    grepTrusted: vi.fn(async (_r, pattern) => {
      if (pattern.includes('data-evidence')) {
        return [
          'src/web/A.tsx:1:data-evidence="task-card"',
          'src/web/B.tsx:2:data-evidence="task-card"',
          "src/web/C.tsx:3:data-evidence='create-submit'",
        ];
      }
      return ['src/x.ts:1:hit'];
    }),
    readWorkflow: vi.fn(async () => WORKFLOW),
    ...overrides,
  };
}

describe('escapeEreLiteral', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeEreLiteral('a.b+(c)')).toBe('a\\.b\\+\\(c\\)');
  });
});

describe('compileAnalystContext', () => {
  it('extracts gates, unique anchors, test files, and intent hits', async () => {
    const deps = makeDeps();
    const ctx = await compileAnalystContext(
      deps,
      repo,
      'Add create-submit badge for task-card evidence',
    );
    expect(ctx.repoKey).toBe('app');
    expect(ctx.archetype).toBe('code');
    expect(ctx.workflowGates).toEqual(['typecheck', 'lint', 'test']);
    expect(ctx.protectedPaths).toEqual(['WORKFLOW.md', 'AGENTS.md']);
    expect(ctx.evidenceAnchors).toEqual(['task-card', 'create-submit']);
    expect(ctx.testFiles).toEqual(['test/a.test.ts', 'test/b.spec.tsx']);
    expect(ctx.agentsMd).toContain('line1');
    expect(deps.grepTrusted).toHaveBeenCalled();
    const intentCall = vi
      .mocked(deps.grepTrusted)
      .mock.calls.find((c) => !String(c[1]).includes('data-evidence'));
    expect(intentCall).toBeDefined();
    // Keywords escaped for -E (no raw metachar shell).
    expect(String(intentCall![1])).not.toMatch(/[^\\][()+?]/);
  });

  it('respects caps for anchors and test files', async () => {
    const manyAnchors = Array.from({ length: 500 }, (_, i) =>
      `src/x.tsx:${i}:data-evidence="anchor-${i}"`,
    );
    const manyFiles = [
      ...Array.from({ length: 500 }, (_, i) => `test/f${i}.test.ts`),
      ...Array.from({ length: 100 }, (_, i) => `src/s${i}.ts`),
    ];
    const deps = makeDeps({
      listTrustedFiles: vi.fn(async () => manyFiles),
      grepTrusted: vi.fn(async (_r, pattern) => {
        if (pattern.includes('data-evidence')) return manyAnchors;
        return [];
      }),
    });
    const ctx = await compileAnalystContext(deps, repo, 'cap stress test for anchors');
    expect(ctx.evidenceAnchors.length).toBeLessThanOrEqual(300);
    expect(ctx.testFiles.length).toBeLessThanOrEqual(400);
    expect(new Set(ctx.evidenceAnchors).size).toBe(ctx.evidenceAnchors.length);
  });

  it('truncates AGENTS.md at a line boundary', async () => {
    const longLine = 'A'.repeat(100);
    const agents = Array.from({ length: 80 }, () => longLine).join('\n');
    expect(agents.length).toBeGreaterThan(6_000);
    const deps = makeDeps({
      readTrustedFile: vi.fn(async () => agents),
    });
    const ctx = await compileAnalystContext(deps, repo, 'truncate agents markdown carefully');
    expect(ctx.agentsMd).not.toBeNull();
    expect(ctx.agentsMd!.length).toBeLessThanOrEqual(6_000);
    expect(ctx.agentsMd!.length).toBeLessThan(agents.length);
    // No mid-line cut: every non-empty line is a full original line.
    const lines = ctx.agentsMd!.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toBe(longLine);
    }
  });

  it('escapes intent keywords for -E and caps hits', async () => {
    const deps = makeDeps({
      grepTrusted: vi.fn(async (_r, pattern, opts) => {
        if (pattern.includes('data-evidence')) return [];
        expect(pattern.length).toBeLessThanOrEqual(200);
        // Parentheses / dots from keywords must be escaped.
        if (pattern.includes('upload')) {
          expect(pattern).toMatch(/upload/);
        }
        const max = opts?.maxLines ?? 500;
        return Array.from({ length: max + 20 }, (_, i) => `src/a.ts:${i}:hit`);
      }),
    });
    const ctx = await compileAnalystContext(
      deps,
      repo,
      'Fix upload retry drain path in orchestrator carefully now',
    );
    expect(ctx.intentHits.length).toBeLessThanOrEqual(60);
  });

  it('defaults archetype to code when RepoConfig has none', async () => {
    const ctx = await compileAnalystContext(makeDeps(), repo, 'plain code task intent here');
    expect(ctx.archetype).toBe('code');
  });
});
