import { describe, it, expect } from 'vitest';
import {
  AGENTS_MAX_LINES,
  agentsMapLooksSubstantial,
  countLines,
  evaluateReadinessAssist,
  workflowTextLooksGated,
} from '../../src/domain/readinessAssist.js';

const GOOD_WORKFLOW = `---
setup:
  install: [pnpm install]
  boot: [pnpm start]
  health_check: curl -sf http://127.0.0.1:{port}/health
gates:
  test: pnpm test
  typecheck: pnpm typecheck
---
# Policy
`;

const GOOD_AGENTS = `# Agent map

Read WORKFLOW.md. Layout under src/.
Domain is pure; control does I/O.
`;

const GOOD_FACTS = {
  gateNames: ['typecheck', 'test'],
  hasInstall: true,
  hasBoot: true,
  hasHealthCheck: true,
  hasBehavioral: true,
} as const;

describe('countLines', () => {
  it('matches wc -l trailing-newline semantics', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
  });
});

describe('workflowTextLooksGated', () => {
  it('accepts gates + setup', () => {
    expect(workflowTextLooksGated(GOOD_WORKFLOW)).toBe(true);
  });

  it('rejects empty gates map', () => {
    expect(workflowTextLooksGated('---\ngates: {}\n---\n')).toBe(false);
  });
});

describe('agentsMapLooksSubstantial', () => {
  it('rejects tiny stubs', () => {
    expect(agentsMapLooksSubstantial('see AGENTS')).toBe(false);
  });

  it('accepts a short map with heading', () => {
    expect(agentsMapLooksSubstantial(GOOD_AGENTS)).toBe(true);
  });
});

describe('evaluateReadinessAssist', () => {
  it('passes required checks and scores checklist when workflow + agents look ready', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: GOOD_WORKFLOW,
      agentsContent: GOOD_AGENTS,
      agentsPath: 'AGENTS.md',
      workflowFacts: GOOD_FACTS,
    });
    expect(r.ok).toBe(true);
    expect(r.score.total).toBe(7);
    expect(r.score.passed).toBe(7);
    expect(r.score.requiredPassed).toBe(r.score.requiredTotal);
    expect(r.summary).toMatch(/Checklist 7\/7/);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual([
      'workflow-present',
      'workflow-parse',
      'workflow-gates',
      'workflow-boot',
      'workflow-behavioral',
      'agents-map',
      'agents-budget',
    ]);
  });

  it('fails when workflow missing', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: null,
      agentsContent: GOOD_AGENTS,
      agentsPath: 'AGENTS.md',
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'workflow-present')?.ok).toBe(false);
    expect(r.score.passed).toBeLessThan(r.score.total);
  });

  it('fails on empty agents stub', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: GOOD_WORKFLOW,
      agentsContent: 'x',
      agentsPath: 'CLAUDE.md',
      workflowFacts: GOOD_FACTS,
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'agents-map')?.ok).toBe(false);
  });

  it('uses injected parse error (workflow-parse fails; gates skipped)', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: GOOD_WORKFLOW,
      agentsContent: GOOD_AGENTS,
      agentsPath: 'AGENTS.md',
      workflowParseError: 'invalid front matter',
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'workflow-parse')?.detail).toMatch(/invalid/);
    expect(r.checks.find((c) => c.id === 'workflow-gates')?.ok).toBe(false);
  });

  it('flags AGENTS.md over the line budget without auto-ready', () => {
    const fat = Array.from({ length: AGENTS_MAX_LINES + 5 }, (_, i) => `line ${i}`).join('\n') + '\n';
    // Make it look substantial via heading + bulk.
    const content = `# Agent map\n\n${fat}`;
    expect(countLines(content)).toBeGreaterThan(AGENTS_MAX_LINES);
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: GOOD_WORKFLOW,
      agentsContent: content,
      agentsPath: 'AGENTS.md',
      workflowFacts: GOOD_FACTS,
    });
    expect(r.ok).toBe(false);
    const budget = r.checks.find((c) => c.id === 'agents-budget');
    expect(budget?.ok).toBe(false);
    expect(budget?.detail).toMatch(/over budget/);
    expect(budget?.required).toBe(true);
  });

  it('optional boot may fail while overall ok when gates+map pass', () => {
    const wfNoBoot = `---
setup:
  install: [pnpm i]
gates:
  test: pnpm test
---
# policy
`;
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: wfNoBoot,
      agentsContent: GOOD_AGENTS,
      agentsPath: 'AGENTS.md',
      workflowFacts: {
        gateNames: ['test'],
        hasInstall: true,
        hasBoot: false,
        hasHealthCheck: false,
        hasBehavioral: true, // isolate the boot-optional rule, not L2 policy
      },
    });
    expect(r.ok).toBe(true);
    const boot = r.checks.find((c) => c.id === 'workflow-boot');
    expect(boot?.required).toBe(false);
    expect(boot?.ok).toBe(false);
    expect(r.score.passed).toBe(r.score.total - 1);
    expect(r.summary).toMatch(/optional missing: workflow-boot/);
  });

  it('requires at least one gate command when facts injected', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: GOOD_WORKFLOW,
      agentsContent: GOOD_AGENTS,
      agentsPath: 'AGENTS.md',
      workflowFacts: {
        gateNames: [],
        hasInstall: true,
        hasBoot: true,
        hasHealthCheck: false,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'workflow-gates')?.ok).toBe(false);
  });

  it('never implies readiness flip — result is advisory only', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: GOOD_WORKFLOW,
      agentsContent: GOOD_AGENTS,
      agentsPath: 'AGENTS.md',
      workflowFacts: GOOD_FACTS,
    });
    // Shape contract: score + checks, no readiness field.
    expect(r).toMatchObject({
      ok: true,
      score: expect.objectContaining({ passed: expect.any(Number), total: expect.any(Number) }),
    });
    expect(r).not.toHaveProperty('readiness');
  });
});

describe('workflow-behavioral check (SPEC §9.2 L2 is REQUIRED, §15 boots-in-isolation)', () => {
  it('flags a WORKFLOW with no behavioral block (bookshelf shipped review-green with zero L2)', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: '---\ngates:\n  test: pnpm test\n---\nx',
      agentsContent: '# map\n## Read order\nstuff here to be substantial enough',
      agentsPath: 'AGENTS.md',
      workflowFacts: {
        gateNames: ['test'], hasInstall: true, hasBoot: true, hasHealthCheck: true,
        hasBehavioral: false,
      },
      workflowParseError: null,
    });
    const check = r.checks.find((c) => c.id === 'workflow-behavioral');
    expect(check).toBeDefined();
    expect(check!.ok).toBe(false);
    expect(check!.required).toBe(true);
  });

  it('passes when behavioral is declared', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: '---\nbehavioral:\n  base_url: http://x\ngates:\n  test: t\n---\nx',
      agentsContent: '# map\n## Read order\nstuff here to be substantial enough',
      agentsPath: 'AGENTS.md',
      workflowFacts: {
        gateNames: ['test'], hasInstall: true, hasBoot: true, hasHealthCheck: true,
        hasBehavioral: true,
      },
      workflowParseError: null,
    });
    expect(r.checks.find((c) => c.id === 'workflow-behavioral')!.ok).toBe(true);
  });

  it('passes soft behavioral check with valid trusted cli_evidence and no browser block', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: GOOD_WORKFLOW,
      agentsContent: GOOD_AGENTS,
      agentsPath: 'AGENTS.md',
      workflowFacts: {
        gateNames: ['test'],
        hasInstall: false,
        hasBoot: false,
        hasHealthCheck: false,
        hasBehavioral: false,
        hasCliEvidence: true,
      },
      workflowParseError: null,
    });
    const check = r.checks.find((c) => c.id === 'workflow-behavioral');
    expect(check?.ok).toBe(true);
    expect(check?.required).toBe(true);
    expect(check?.label).toMatch(/browser|CLI/i);
    expect(check?.detail).toMatch(/cli_evidence/i);
    expect(check?.detail).not.toMatch(/Declare base_url/);
    expect(r.ok).toBe(true);
  });

  it('stays red when neither browser behavioral nor valid cli_evidence is declared', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: GOOD_WORKFLOW,
      agentsContent: GOOD_AGENTS,
      agentsPath: 'AGENTS.md',
      workflowFacts: {
        gateNames: ['test'],
        hasInstall: true,
        hasBoot: true,
        hasHealthCheck: true,
        hasBehavioral: false,
        hasCliEvidence: false,
      },
      workflowParseError: null,
    });
    const check = r.checks.find((c) => c.id === 'workflow-behavioral');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/browser|CLI|cli_evidence/i);
    expect(r.ok).toBe(false);
  });

  it('stays red for invalid cli_evidence (parse failed; prose alone does not count)', () => {
    const r = evaluateReadinessAssist({
      workflowPath: 'WORKFLOW.md',
      workflowContent: GOOD_WORKFLOW,
      agentsContent: GOOD_AGENTS,
      agentsPath: 'AGENTS.md',
      workflowFacts: null,
      workflowParseError: 'cli_evidence.version must be 1',
    });
    const check = r.checks.find((c) => c.id === 'workflow-behavioral');
    expect(check?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

});
