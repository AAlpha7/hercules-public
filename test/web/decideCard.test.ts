/**
 * The Decide surface answered WHAT but not the CEO's four questions:
 * 任务是干嘛的?为什么没全过?出了什么问题?为什么还能放行?(2026-07-23)
 * Pure derivations from body text — no invention.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTaskPurpose, failingGatesZh } from '../../src/web/decideCard.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('extractTaskPurpose', () => {
  it('grabs the first paragraph under Goal (preferred) or Task', () => {
    const body = '## Pipeline\nstage stuff\n\n## Goal\nSolid WORKFLOW.md + isolated boot hook for Hercules.\nMore detail.\n\n## Task\n1. do x\n';
    expect(extractTaskPurpose(body)).toBe('Solid WORKFLOW.md + isolated boot hook for Hercules.');
  });

  it('falls back to Task section, else null', () => {
    expect(extractTaskPurpose('## Task\n1. Run gates via WORKFLOW.\n')).toBe('1. Run gates via WORKFLOW.');
    expect(extractTaskPurpose('no sections here')).toBeNull();
  });
});

describe('failingGatesZh', () => {
  it('lists ❌ gates from the latest packet with zh names + condensed reason', () => {
    const body = [
      '**Gates**',
      '- ✅ setup',
      '- ✅ test',
      '- ❌ behavioral',
      '  ```',
      '  L2 declared in WORKFLOW but produced no evidence — app was not machine-verified (no browser / boot failed / missing auth / empty plan). More text.',
      '  ```',
    ].join('\n');
    const fails = failingGatesZh(body);
    expect(fails).toHaveLength(1);
    expect(fails[0]!.nameZh).toBe('行为验证(启动应用拿证据)');
    expect(fails[0]!.reasonZh).toMatch(/未产出.*证据|声明了.*没有产出/);
  });

  it('empty when all gates green or no packet', () => {
    expect(failingGatesZh('**Gates**\n- ✅ test\n')).toEqual([]);
    expect(failingGatesZh('## Task\nx')).toEqual([]);
  });

  it('cargo test fenced tail → reason names the failing test, not progress', () => {
    const body = [
      '**Gates**',
      '- ❌ test',
      '  ```',
      '  running 5986 tests',
      '  test memory::tests::snapshot_roundtrip ... ok',
      '',
      '  failures:',
      '      memory::tests::circuit_breaker_event_emitted_on_trip',
      '',
      '  test result: FAILED. 5972 passed; 1 failed; 13 ignored; 0 measured; 0 filtered out; finished in 38.20s',
      '  ```',
    ].join('\n');
    const fails = failingGatesZh(body);
    expect(fails).toHaveLength(1);
    expect(fails[0]!.reasonZh).toContain('circuit_breaker_event_emitted_on_trip');
    expect(fails[0]!.reasonZh).not.toContain('running 5986 tests');
  });
});

describe('Decide card wiring', () => {
  it('TaskDetail renders purpose, failing reasons, options, and 批准≠部署', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/extractTaskPurpose\(/);
    expect(src).toMatch(/failingGatesZh\(/);
    expect(src).toMatch(/data-evidence="decide-why"/);
    expect(src).toMatch(/批准 ≠ 部署|批准不等于部署/);
  });
});
