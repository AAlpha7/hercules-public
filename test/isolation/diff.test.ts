import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { captureWorktreeDiff } from '../../src/isolation/diff.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hercules-diff-'));
  const g = simpleGit(dir);
  await g.init(['-b', 'main']);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  await writeFile(join(dir, 'a.ts'), 'const a = 1;\n');
  await g.add('.');
  await g.commit('base');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('captureWorktreeDiff', () => {
  it('captures the working-tree change vs the base ref', async () => {
    await writeFile(join(dir, 'a.ts'), 'const a = 2;\n');
    await writeFile(join(dir, 'b.ts'), 'export const b = 3;\n');

    const result = await captureWorktreeDiff(dir, 'HEAD');
    expect(result.diff).toContain('const a = 2;');
    expect(result.filesTouched.sort()).toEqual(['a.ts', 'b.ts']);
    expect(result.diffSummary).toMatch(/file/);
  });

  it('reports an empty change cleanly', async () => {
    const result = await captureWorktreeDiff(dir, 'HEAD');
    expect(result.filesTouched).toEqual([]);
    expect(result.diff).toBe('');
  });

  it('keeps non-ASCII path names unquoted (readable on phone)', async () => {
    const rel = '奇点/正文/第01章.md';
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, '奇点', '正文'), { recursive: true });
    await writeFile(join(dir, rel), '# 雨还在\n');
    const result = await captureWorktreeDiff(dir, 'HEAD');
    expect(result.filesTouched).toContain(rel);
    // Must not be C-style quoted octal escapes.
    expect(result.filesTouched.join('\n')).not.toMatch(/\\[0-9]{3}/);
    expect(result.diff).toContain('雨还在');
  });

  it('diffs against merge-base so lagging behind main is not a false "delete"', async () => {
    // main advances with a protected-looking path; branch only has feature work.
    const { mkdir } = await import('node:fs/promises');
    const g = simpleGit(dir);
    await g.checkoutLocalBranch('feature');
    await writeFile(join(dir, 'feat.ts'), 'export const f = 1;\n');
    await g.add('.');
    await g.commit('feat: agent work');
    await g.checkout('main');
    await mkdir(join(dir, 'test', 'invariants'), { recursive: true });
    await writeFile(join(dir, 'test/invariants/held.ts'), 'export {};\n');
    await g.add('.');
    await g.commit('main: protected suite');
    await g.checkout('feature');

    const result = await captureWorktreeDiff(dir, 'main');
    // Feature branch should report only its own files — not reverse-deletes of main.
    expect(result.filesTouched).toContain('feat.ts');
    expect(result.filesTouched).not.toContain('test/invariants/held.ts');
    expect(result.diff).not.toMatch(/^-export \{\}/m);
  });

  it('throws a clear error when the worktree dir is missing', async () => {
    await expect(captureWorktreeDiff(join(dir, 'nope'), 'HEAD')).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe('foreign task lineage (cross-task cherry-pick detection)', () => {
  it('surfaces commit subjects attributed to OTHER task ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hercules-xtask-'));
    const g = simpleGit(dir);
    await g.init(['-b', 'main']);
    await g.addConfig('user.email', 't@h.local');
    await g.addConfig('user.name', 'T');
    await writeFile(join(dir, 'a.txt'), 'base\n');
    await g.add('.');
    await g.commit('base');
    await g.checkoutLocalBranch('hercules/R3');
    await writeFile(join(dir, 'b.txt'), 'from r2\n');
    await g.add('.');
    // The R3 incident: R2's commits cherry-picked into R3's branch.
    await g.commit('hercules: R2 — verified state (auto-commit at L1)');
    await writeFile(join(dir, 'c.txt'), 'own work\n');
    await g.add('.');
    await g.commit('hercules: R3 — verified state (auto-commit at L1)');

    const d = await captureWorktreeDiff(dir, 'main');
    expect(d.foreignTaskIds).toEqual(['R2']); // own id (from branch) excluded
    // Same loop surfaces sha + subject for DecisionCard (no extra git call).
    expect(d.foreignCommits).toBeDefined();
    expect(d.foreignCommits).toHaveLength(1);
    expect(d.foreignCommits![0]!.taskId).toBe('R2');
    expect(d.foreignCommits![0]!.subject).toMatch(/^hercules: R2/);
    expect(d.foreignCommits![0]!.sha).toMatch(/^[0-9a-f]{40}$/i);
    await rm(dir, { recursive: true, force: true });
  });
});
