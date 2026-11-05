/**
 * The trust-chain statement is domain-generated English even in zh mode
 * (visual audit 2026-07-23). Client-side zh renderer from structured DTO
 * fields — same facts, CEO language.
 */
import { describe, it, expect } from 'vitest';
import { trustChainZh } from '../../src/web/releasesText.js';

describe('trustChainZh', () => {
  it('composes counts + unverified ids + operator merges + direct commits', () => {
    const zh = trustChainZh({
      aheadTasks: [
        { id: 'a', verified: true },
        { id: 'b', verified: false },
      ],
      operatorMergedCount: 1,
      directCommits: [{ sha: 'x', subject: 's' }],
    });
    expect(zh).toMatch(/2 项任务改动/);
    expect(zh).toMatch(/1 项通过全套机器验证/);
    expect(zh).toMatch(/无机器验证记录.*b/);
    expect(zh).toMatch(/1 项为操作员合并/);
    expect(zh).toMatch(/1 个直接提交.*发布前请过目/);
  });

  it('clean all-verified release reads reassuring and short', () => {
    const zh = trustChainZh({
      aheadTasks: [{ id: 'a', verified: true }],
      operatorMergedCount: 0,
      directCommits: [],
    });
    expect(zh).toMatch(/全部通过机器验证与人工批准/);
    expect(zh).not.toMatch(/直接提交/);
  });

  it('direct-commits-only release warns clearly', () => {
    const zh = trustChainZh({ aheadTasks: [], operatorMergedCount: 0, directCommits: [{}, {}] });
    expect(zh).toMatch(/没有任务管线改动/);
    expect(zh).toMatch(/2 个直接提交/);
  });

  it('ReleasesPanel uses it when lang is zh', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const src = await readFile(join(root, 'src/web/ReleasesPanel.tsx'), 'utf8');
    expect(src).toMatch(/trustChainZh\(/);
    expect(src).toMatch(/lang === 'zh'/);
  });
});
