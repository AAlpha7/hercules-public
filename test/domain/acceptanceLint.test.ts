import { describe, it, expect } from 'vitest';
import {
  formatAcLint,
  lintAcceptance,
  type AcLintCode,
} from '../../src/domain/acceptanceLint.js';

function bodyWith(...items: string[]): string {
  return ['## Acceptance criteria', ...items].join('\n');
}

function codes(body: string): AcLintCode[] {
  return lintAcceptance(body).findings.map((f) => f.code);
}

describe('lintAcceptance', () => {
  describe('no-criteria', () => {
    it('errors when section is missing', () => {
      const r = lintAcceptance('## Task\nDo a thing\n');
      expect(r.ok).toBe(false);
      expect(codes('## Task\nDo a thing\n')).toContain('no-criteria');
      expect(r.findings[0]?.message).toMatch(/no ## Acceptance criteria/i);
    });

    it('errors when section has zero items', () => {
      const r = lintAcceptance('## Acceptance criteria\n\n## Notes\nx\n');
      expect(r.ok).toBe(false);
      expect(r.findings.some((f) => f.code === 'no-criteria')).toBe(true);
    });

    it('negative: section with items is not no-criteria', () => {
      const r = lintAcceptance(
        bodyWith('- [ ] (human) Ship when ready'),
      );
      expect(r.findings.some((f) => f.code === 'no-criteria')).toBe(false);
      expect(r.ok).toBe(true);
    });

    it('body over 200_000 chars → no-criteria with body too large', () => {
      const huge = 'x'.repeat(200_001);
      const r = lintAcceptance(huge);
      expect(r.ok).toBe(false);
      expect(r.findings).toEqual([
        {
          severity: 'error',
          code: 'no-criteria',
          message: 'body too large to lint',
        },
      ]);
    });
  });

  describe('unbound-mechanical', () => {
    it('errors on mechanical without @binding', () => {
      const body = bodyWith(
        '- [ ] (mechanical) typecheck and test pass',
        '- [ ] (human) look',
      );
      const r = lintAcceptance(body);
      expect(r.ok).toBe(false);
      const f = r.findings.find((x) => x.code === 'unbound-mechanical');
      expect(f).toBeDefined();
      expect(f?.message).toMatch(
        /^mechanical criterion never passes without a binding — /,
      );
      expect(f?.message).toMatch(/suggest @gate:test/);
      expect(f?.line).toBe(2);
      expect(f?.criterion).toBe('typecheck and test pass');
    });

    it('negative: bound mechanical is not unbound-mechanical', () => {
      const body = bodyWith(
        '- [ ] (mechanical) gates green @gate:test',
        '- [ ] (human) look',
      );
      expect(codes(body)).not.toContain('unbound-mechanical');
    });

    it('Chinese 机检 unbound + evidence-like suggestion', () => {
      const body = [
        '## 验收标准',
        '- [ ] （机检）底栏 Settings 钩子 data-evidence=nav-settings',
        '- [ ] （人工）手机确认',
      ].join('\n');
      const r = lintAcceptance(body);
      const f = r.findings.find((x) => x.code === 'unbound-mechanical');
      expect(f).toBeDefined();
      expect(f?.message).toMatch(/@evidence:nav-settings/);
    });
  });

  describe('stacked-bindings', () => {
    it('errors when two @bindings on one line', () => {
      const body = bodyWith(
        '- [ ] (mechanical) both @gate:test @evidence:nav-settings',
        '- [ ] (human) ok',
      );
      const r = lintAcceptance(body);
      expect(r.ok).toBe(false);
      expect(r.findings.some((f) => f.code === 'stacked-bindings')).toBe(true);
      expect(r.findings.find((f) => f.code === 'stacked-bindings')?.line).toBe(2);
    });

    it('negative: single binding is fine', () => {
      const body = bodyWith(
        '- [ ] (mechanical) one @gate:test',
        '- [ ] (human) ok',
      );
      expect(codes(body)).not.toContain('stacked-bindings');
    });
  });

  describe('all-gate-bound', () => {
    it('warns when every mechanical item is @gate:', () => {
      const body = bodyWith(
        '- [ ] (mechanical) a @gate:test',
        '- [ ] (mechanical) b @gate:lint',
        '- [ ] (human) ok',
      );
      expect(codes(body)).toContain('all-gate-bound');
      expect(lintAcceptance(body).ok).toBe(true);
    });

    it('negative: mixed evidence + gate is not all-gate-bound', () => {
      const body = bodyWith(
        '- [ ] (mechanical) a @gate:test',
        '- [ ] (mechanical) b @evidence:nav-settings',
        '- [ ] (human) ok',
      );
      expect(codes(body)).not.toContain('all-gate-bound');
    });

    it('negative: no mechanical → no all-gate-bound', () => {
      const body = bodyWith('- [ ] (human) only human');
      expect(codes(body)).not.toContain('all-gate-bound');
    });
  });

  describe('test-path-no-title', () => {
    it('warns on @test:path without #title', () => {
      const body = bodyWith(
        '- [ ] (mechanical) case @test:test/domain/x.test.ts',
        '- [ ] (human) ok',
      );
      const f = lintAcceptance(body).findings.find(
        (x) => x.code === 'test-path-no-title',
      );
      expect(f).toBeDefined();
      expect(f?.message).toMatch(/#<title>/);
    });

    it('negative: @test:path#title is clean', () => {
      const body = bodyWith(
        '- [ ] (mechanical) case @test:test/domain/x.test.ts#rejects forged pin',
        '- [ ] (human) ok',
      );
      expect(codes(body)).not.toContain('test-path-no-title');
    });
  });

  describe('probe-no-verifier', () => {
    it('warns on @probe:', () => {
      const body = bodyWith(
        '- [ ] (mechanical) http up @probe:http:https://example.com/health',
        '- [ ] (human) ok',
      );
      expect(codes(body)).toContain('probe-no-verifier');
    });

    it('negative: non-probe binding skips probe-no-verifier', () => {
      const body = bodyWith(
        '- [ ] (mechanical) gates @gate:test',
        '- [ ] (human) ok',
      );
      expect(codes(body)).not.toContain('probe-no-verifier');
    });
  });

  describe('checkpoint-missing-step', () => {
    it('warns when checkpoint text is not before <step>: <what>', () => {
      const body = bodyWith(
        '- [ ] (checkpoint) confirm staging',
        '- [ ] (mechanical) gates @gate:test',
      );
      expect(codes(body)).toContain('checkpoint-missing-step');
    });

    it('negative: English before form is ok', () => {
      const body = bodyWith(
        '- [ ] (checkpoint) before deploy: confirm staging URL',
        '- [ ] (mechanical) gates @gate:test',
      );
      expect(codes(body)).not.toContain('checkpoint-missing-step');
    });

    it('negative: Chinese 在…之前 form is ok', () => {
      const body = bodyWith(
        '- [ ] （检查点）在合并之前：确认截图',
        '- [ ] (mechanical) gates @gate:test',
      );
      expect(codes(body)).not.toContain('checkpoint-missing-step');
    });
  });

  describe('untyped-criterion', () => {
    it('info when no (kind) prefix', () => {
      const body = bodyWith(
        '- [ ] bare line without kind',
        '- [ ] (mechanical) gates @gate:test',
      );
      expect(codes(body)).toContain('untyped-criterion');
      expect(lintAcceptance(body).ok).toBe(true);
    });

    it('negative: typed criteria skip untyped-criterion', () => {
      const body = bodyWith(
        '- [ ] (human) typed',
        '- [ ] (mechanical) gates @gate:test',
      );
      expect(codes(body)).not.toContain('untyped-criterion');
    });

    it('negative: (human, after deploy) modifier counts as typed', () => {
      const body = bodyWith(
        '- [ ] (human, after deploy) confirm live badge',
        '- [ ] (人工, 上线后) 线上确认入口',
        '- [ ] (mechanical) gates @gate:test',
      );
      expect(codes(body)).not.toContain('untyped-criterion');
    });
  });

  describe('duplicate-criterion', () => {
    it('warns on same clean text twice', () => {
      const body = bodyWith(
        '- [ ] (mechanical) same claim @gate:test',
        '- [ ] (mechanical) same claim @gate:lint',
        '- [ ] (human) ok',
      );
      const r = lintAcceptance(body);
      expect(r.findings.some((f) => f.code === 'duplicate-criterion')).toBe(true);
      const dup = r.findings.find((f) => f.code === 'duplicate-criterion');
      expect(dup?.line).toBe(3);
    });

    it('identical raw lines get their own line numbers', () => {
      const body = bodyWith(
        '- [ ] (human) same',
        '- [ ] (mechanical) gates @gate:test',
        '- [ ] (human) same',
      );
      const dup = lintAcceptance(body).findings.find((f) => f.code === 'duplicate-criterion');
      expect(dup?.line).toBe(4);
    });

    it('negative: distinct texts are fine', () => {
      const body = bodyWith(
        '- [ ] (mechanical) a @gate:test',
        '- [ ] (mechanical) b @evidence:x',
        '- [ ] (human) ok',
      );
      expect(codes(body)).not.toContain('duplicate-criterion');
    });
  });

  describe('evidence-hook-in-prose', () => {
    it('errors when data-evidence= is named in mechanical prose without a reachable scene', () => {
      const body = bodyWith(
        '- [ ] (mechanical) TaskDetail shows Clean salvage (`data-evidence=salvage-fork`) for cancelled tasks @test:test/web/render/x.test.tsx#shows it',
      );
      const r = lintAcceptance(body);
      expect(r.ok).toBe(false);
      expect(codes(body)).toContain('evidence-hook-in-prose');
      const f = r.findings.find((x) => x.code === 'evidence-hook-in-prose');
      expect(f?.message).toMatch(/@evidence:salvage-fork/);
      expect(f?.line).toBeDefined();
    });

    it('errors for reviewer/human lines too', () => {
      const body = bodyWith(
        '- [ ] (reviewer) Check data-evidence=promote-btn is disabled',
      );
      expect(codes(body)).toContain('evidence-hook-in-prose');
      expect(lintAcceptance(body).ok).toBe(false);
    });

    it('negative: same hook as the line\'s own @evidence: binding is fine', () => {
      const body = bodyWith(
        '- [ ] (mechanical) Releases panel (data-evidence=releases-panel) renders @evidence:releases-panel',
      );
      expect(codes(body)).not.toContain('evidence-hook-in-prose');
    });

    it('negative: ## Evidence step that reaches the hook is fine', () => {
      const body = [
        '## Acceptance criteria',
        '- [ ] (mechanical) Clean salvage (data-evidence=salvage-fork) shows @test:test/a.test.ts#t',
        '',
        '## Evidence',
        '- unlock',
        '- click [data-task-id=l2-fixture-failed]',
        '- assert sel=[data-evidence=salvage-fork]',
      ].join('\n');
      expect(codes(body)).not.toContain('evidence-hook-in-prose');
    });

    it('negative: anchor only in @evidence: binding text (no prose mention) is fine', () => {
      const body = bodyWith(
        '- [ ] (mechanical) Releases panel renders @evidence:releases-panel',
      );
      expect(codes(body)).not.toContain('evidence-hook-in-prose');
    });

    it('two hooks in one line → two findings', () => {
      const body = bodyWith(
        '- [ ] (mechanical) shows data-evidence=foo and data-evidence=bar @gate:test',
      );
      const hooks = lintAcceptance(body).findings.filter(
        (f) => f.code === 'evidence-hook-in-prose',
      );
      expect(hooks).toHaveLength(2);
      expect(hooks.map((f) => f.message).join('\n')).toMatch(/data-evidence=foo/);
      expect(hooks.map((f) => f.message).join('\n')).toMatch(/data-evidence=bar/);
    });
  });

  describe('no-human-criterion (removed 2026-09-03: zero human lines is the normal case)', () => {
    it('emits nothing when there is no human/checkpoint item', () => {
      const body = bodyWith(
        '- [ ] (mechanical) gates @gate:test',
        '- [ ] (reviewer) spirit',
      );
      expect(codes(body)).not.toContain('no-human-criterion');
      expect(lintAcceptance(body).counts.info).toBe(0);
    });
  });

  describe('line numbers + Definition of Done', () => {
    it('reports 1-based line under ## Definition of Done', () => {
      const body = [
        '## Task',
        'Do it',
        '',
        '## Definition of Done',
        '- [ ] (mechanical) unbound claim',
        '- [ ] (human) ok',
      ].join('\n');
      const f = lintAcceptance(body).findings.find(
        (x) => x.code === 'unbound-mechanical',
      );
      expect(f?.line).toBe(5);
    });
  });

  describe('stable order + formatAcLint', () => {
    it('orders findings by line then code', () => {
      const body = bodyWith(
        '- [ ] (mechanical) first unbound',
        '- [ ] (mechanical) second unbound',
        '- [ ] bare',
      );
      const lines = lintAcceptance(body)
        .findings.filter((f) => f.line !== undefined)
        .map((f) => f.line!);
      const sorted = [...lines].sort((a, b) => a - b);
      expect(lines).toEqual(sorted);
    });

    it('formatAcLint summarizes counts', () => {
      const r = lintAcceptance(
        bodyWith('- [ ] (mechanical) unbound', '- [ ] bare'),
      );
      const s = formatAcLint(r);
      expect(s).toMatch(/\d+ errors?/);
      expect(s).toMatch(/:/);
    });

    it('formatAcLint returns ok when clean', () => {
      const r = lintAcceptance(
        bodyWith(
          '- [ ] (mechanical) a @gate:test',
          '- [ ] (mechanical) b @evidence:nav-settings',
          '- [ ] (human) ok',
        ),
      );
      expect(r.ok).toBe(true);
      expect(formatAcLint(r)).toMatch(/ok|warn|info/);
    });
  });

  describe('bounded criteria cap', () => {
    it('caps at 200 criteria without throwing', () => {
      const items = Array.from({ length: 250 }, (_, i) =>
        `- [ ] (human) item ${i}`,
      );
      const r = lintAcceptance(['## Acceptance criteria', ...items].join('\n'));
      expect(r.ok).toBe(true);
      // Cap means we do not emit 250 duplicate/info floods from the tail.
      expect(r.findings.length).toBeLessThan(250);
    });
  });
});
