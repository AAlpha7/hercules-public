import { describe, expect, it } from 'vitest';

import {
  TASK_SLUG_MAX,
  isValidTaskSlug,
  nextTaskNumber,
  shortSlug,
  taskNumberOf,
} from '../../src/domain/taskSlug.js';

describe('shortSlug', () => {
  it('lowercases, hyphenates, and drops punctuation', () => {
    expect(shortSlug('Fix the Upload!')).toBe('fix-the-upload');
    expect(shortSlug('  Sort   tasks -- by  last_active ')).toBe('sort-tasks-by-last-active');
  });

  it('yields an empty slug for pure-CJK text', () => {
    expect(shortSlug('任务列表各分类按最后活跃时间降序排序')).toBe('');
  });

  it('cuts on a word boundary within TASK_SLUG_MAX', () => {
    const slug = shortSlug('make the release panel show the production sha next to staging');
    expect(slug.length).toBeLessThanOrEqual(TASK_SLUG_MAX);
    expect(slug).toBe('make-the-release-panel-show-the');
  });

  it('truncates a single over-long word instead of returning nothing', () => {
    expect(shortSlug('a'.repeat(60))).toBe('a'.repeat(TASK_SLUG_MAX));
  });
});

describe('isValidTaskSlug', () => {
  it('accepts hyphenated lowercase words up to TASK_SLUG_MAX', () => {
    expect(isValidTaskSlug('fix-login')).toBe(true);
    expect(isValidTaskSlug('a'.repeat(TASK_SLUG_MAX))).toBe(true);
  });

  it('rejects uppercase, edge hyphens, doubled hyphens, unicode, and over-long values', () => {
    for (const bad of ['Fix', '-fix', 'fix-', 'fix--login', '修复', 'a'.repeat(TASK_SLUG_MAX + 1), '', 7]) {
      expect(isValidTaskSlug(bad)).toBe(false);
    }
  });
});

describe('task numbering', () => {
  it('reads the numeric prefix of generated ids only', () => {
    expect(taskNumberOf('42-fix-login')).toBe(42);
    expect(taskNumberOf('42')).toBe(42);
    expect(taskNumberOf('fix-login')).toBeNull();
    expect(taskNumberOf('42fix')).toBeNull();
    expect(taskNumberOf('l2-fixture-00-resilience')).toBeNull();
  });

  it('next number is one past the highest prefix, starting at 1', () => {
    expect(nextTaskNumber([])).toBe(1);
    expect(nextTaskNumber(['fix-bug', 'AUTH-1'])).toBe(1);
    expect(nextTaskNumber(['3-a', '12-b', '7'])).toBe(13);
  });
});
