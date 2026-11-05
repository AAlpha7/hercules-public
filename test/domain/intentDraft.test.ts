import { describe, it, expect } from 'vitest';
import { draftTaskFromIntent, uiEvidenceSection } from '../../src/domain/intentDraft.js';
import { resolveEvidencePlan } from '../../src/domain/evidence.js';
import { lintAcceptance } from '../../src/domain/acceptanceLint.js';

describe('draftTaskFromIntent', () => {
  it('builds UI DoD + required settings evidence for settings intent', () => {
    const d = draftTaskFromIntent(
      '把底栏 Logout 改成 Settings，语言和默认 agent',
      'hercules',
    );
    expect(d.title).toMatch(/Settings|Logout|底栏/i);
    expect(d.body).toMatch(/Definition of Done|Acceptance/i);
    expect(d.body).toMatch(/\(mechanical\)/);
    // No placeholder (human) AC — UI proved by @gate/@evidence.
    expect(d.body).not.toMatch(/\(human\)/);
    expect(d.body).toMatch(/## Evidence/);
    expect(d.body).toMatch(/data-evidence=nav-settings/);
    expect(d.body).toMatch(/data-evidence=settings-panel/);
    // Settings path is required — not optional filler.
    expect(d.body).not.toMatch(/nav-settings\]\s*\n\s+optional:\s*true/i);
    expect(d.labels).toContain('needs-plan');
    expect(d.labels).toContain('ui');
  });

  it('bug drafts omit placeholder (human) lines', () => {
    const d = draftTaskFromIntent('Fix crash when opening Settings panel', 'hercules');
    expect(d.body).toMatch(/\(mechanical\)/);
    expect(d.body).not.toMatch(/\(human\)/);
  });

  it('onboarding keeps exactly one (human) readiness line', () => {
    const d = draftTaskFromIntent(
      'Onboard this repo: write AGENTS.md map and WORKFLOW.md gates',
      'hercules',
    );
    const humanLines = d.body
      .split('\n')
      .filter((l) => /\(human\)/.test(l));
    expect(humanLines).toHaveLength(1);
    expect(humanLines[0]).toMatch(
      /Set repo readiness to \*\*ready\*\* in Repos when the map is trustworthy/,
    );
  });

  it('builds pull-to-refresh evidence for list refresh intent (not settings chrome)', () => {
    // Case study task-5: generic UI template greenwashed Settings shots.
    const d = draftTaskFromIntent(
      '任务页面：下拉刷新任务列表和相关任务状态',
      'hercules',
    );
    expect(d.body).toMatch(/pull-to-refresh|task-list/);
    expect(d.body).toMatch(/data-evidence=task-list/);
    expect(d.body).toMatch(/data-evidence=pull-to-refresh/);
    expect(d.body).not.toMatch(/nav-settings/);
    expect(d.body).toMatch(/list\/pull-to-refresh|pull-to-refresh UX/i);

    const plan = resolveEvidencePlan({ taskBody: d.body });
    const requiredAsserts = plan.steps.filter(
      (s) => s.kind === 'assert' && s.selector && !s.optional,
    );
    expect(
      requiredAsserts.some((s) => s.selector?.includes('pull-to-refresh')),
    ).toBe(true);
    expect(requiredAsserts.some((s) => s.selector?.includes('task-list'))).toBe(true);
  });

  it('flags vague intent via open clarification questions (no old warning text)', () => {
    const d = draftTaskFromIntent('做一下', 'hercules');
    expect(d.vague).toBe(true);
    expect(d.questions.length).toBeGreaterThan(0);
    expect(d.warnings.join('\n')).not.toMatch(/Intent looks vague/);
  });

  it('carries a shortSlug for an ASCII intent title', () => {
    const d = draftTaskFromIntent('Fix crash when opening Settings panel', 'hercules');
    expect(d.slug).toBe('fix-crash-when-opening-settings-panel');
  });

  it('omits slug for a pure-CJK intent title', () => {
    const d = draftTaskFromIntent('任务列表各分类按最后活跃时间降序排序', 'hercules');
    expect(d).not.toHaveProperty('slug');
  });

  it('does not add UI-evidence reminder when Evidence section is present', () => {
    // UI intents get an Evidence template — no extra gap warning.
    const d = draftTaskFromIntent(
      '把底栏 Logout 改成 Settings，语言和默认 agent',
      'hercules',
    );
    expect(d.body).toMatch(/## Evidence/);
    expect(d.warnings.join('\n')).not.toMatch(/UI 类人工验收项需要/);
  });
});

describe('needsUiEvidenceReminder path (draft body without Evidence)', () => {
  it('surfaces reminder when body has UI human AC and no Evidence section', async () => {
    const { needsUiEvidenceReminder, UI_AC_EVIDENCE_REMINDER } = await import(
      '../../src/domain/uiAcEvidence.js'
    );
    const body = [
      '## Task',
      'docs only',
      '',
      '## Definition of Done',
      '- [ ] (human) 手机上点徽章一眼看懂为什么黄',
    ].join('\n');
    expect(needsUiEvidenceReminder(body)).toBe(true);
    expect(UI_AC_EVIDENCE_REMINDER).toMatch(/Evidence/);
  });
});

describe('uiEvidenceSection', () => {
  it('defaults generic UI to shell only (no optional settings spam)', () => {
    const sec = uiEvidenceSection('Add a nicer card layout on the home screen');
    expect(sec).toMatch(/screenshot shell/);
    expect(sec).not.toMatch(/nav-settings/);
    expect(sec).toMatch(/data-evidence hooks/i);
  });
});

describe('intent draft templates lint clean', () => {
  const intents = [
    '把底栏 Logout 改成 Settings，语言和默认 agent',
    '任务页面：下拉刷新任务列表和相关任务状态',
    'Add a create-task form with field validation',
    'Fix flaky upload retry bug in the orchestrator drain path',
    'Update README documentation for operators',
    'Make repo ready: WORKFLOW.md and AGENTS.md readiness',
    'Add adapter failover when agent_exit streaks exceed the threshold',
    'Add a nicer card layout on the home screen',
  ] as const;

  it('emits zero error findings for representative intents (code/UI/中文)', () => {
    expect(intents.length).toBeGreaterThanOrEqual(6);
    for (const intent of intents) {
      const d = draftTaskFromIntent(intent, 'hercules');
      const report = lintAcceptance(d.body);
      expect(report.ok, `${intent}: ${report.findings.map((f) => f.message).join('; ')}`).toBe(
        true,
      );
      expect(
        report.findings.some((f) => f.code === 'unbound-mechanical'),
        `unbound mechanical in: ${intent}`,
      ).toBe(false);
    }
  });
});
