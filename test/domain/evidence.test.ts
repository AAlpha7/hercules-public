import { describe, it, expect } from 'vitest';
import {
  parseEvidenceLine,
  parseEvidenceEntries,
  parseTaskEvidenceSection,
  resolveEvidencePlan,
  taskBodyWithoutEvidenceSection,
  taskBodyWithoutIncidentSections,
  extractDataEvidenceHooks,
} from '../../src/domain/evidence.js';
import { textMatches } from '../../src/verification/evidenceDrive.js';

describe('evidence DSL', () => {
  it('parses unlock / click / assert / screenshot lines', () => {
    expect(parseEvidenceLine('unlock')?.kind).toBe('unlock');
    expect(parseEvidenceLine('click [data-evidence=nav-settings]')).toEqual(
      expect.objectContaining({
        kind: 'click',
        selector: '[data-evidence=nav-settings]',
      }),
    );
    expect(parseEvidenceLine('screenshot settings-sheet')?.name).toBe('settings-sheet');
    expect(parseEvidenceLine('assert text=Language|语言')?.text).toBe('Language|语言');
    expect(parseEvidenceLine('assert sel=[data-evidence=settings-panel]')?.selector).toBe(
      '[data-evidence=settings-panel]',
    );
    expect(parseEvidenceLine('click [data-evidence=x] optional')?.optional).toBe(true);
  });

  it('parses WORKFLOW-style object entries', () => {
    const steps = parseEvidenceEntries([
      'unlock',
      { screenshot: 'shell' },
      { click: '[data-evidence=nav-settings]', optional: true },
      { assert: { text: 'Settings|设置' } },
      { screenshot: 'settings' },
    ]);
    expect(steps.map((s) => s.kind)).toEqual([
      'unlock',
      'screenshot',
      'click',
      'assert',
      'screenshot',
    ]);
    expect(steps[2]?.optional).toBe(true);
  });

  it('task ## Evidence overrides workflow', () => {
    const body = `
## Task
x

## Evidence
- unlock
- click [data-evidence=nav-settings]
- assert text=语言|Language
- screenshot settings-sheet

## Definition of Done
- [ ] (human) ok
`;
    const plan = resolveEvidencePlan({
      taskBody: body,
      workflowEvidence: parseEvidenceEntries(['unlock', { screenshot: 'shell' }]),
    });
    expect(plan.source).toBe('task');
    expect(plan.steps.some((s) => s.kind === 'click')).toBe(true);
    expect(plan.steps.filter((s) => s.kind === 'screenshot').length).toBeGreaterThanOrEqual(1);
  });

  it('defaults to unlock + shell when nothing declared', () => {
    const plan = resolveEvidencePlan({});
    expect(plan.source).toBe('default');
    expect(plan.steps.map((s) => s.kind)).toEqual(['unlock', 'screenshot']);
  });

  it('textMatches supports alternation and regex', () => {
    expect(textMatches('foo Language bar', 'Language|语言')).toBe(true);
    expect(textMatches('设置页', 'Language|语言|设置')).toBe(true);
    expect(textMatches('Hello Settings', '/set+ings/i')).toBe(true);
    expect(textMatches('nope', 'Language')).toBe(false);
  });

  it('parseTaskEvidenceSection ignores review packet tail', () => {
    const steps = parseTaskEvidenceSection(`
## Evidence
- unlock
- screenshot shell

## Review packet
- click should-not-parse
`);
    expect(steps).toHaveLength(2);
  });

  it('parseTaskEvidenceSection honors indented optional: true (settings-build L2 false fail)', () => {
    const steps = parseTaskEvidenceSection(`
## Evidence
- unlock
- screenshot shell
- click [data-evidence=nav-settings]
  optional: true
- screenshot settings
  optional: true
`);
    expect(steps).toHaveLength(4);
    const click = steps.find((s) => s.kind === 'click');
    expect(click?.optional).toBe(true);
    const shots = steps.filter((s) => s.kind === 'screenshot');
    expect(shots.some((s) => s.name === 'settings' && s.optional === true)).toBe(true);
  });

  it('hardens optional data-evidence asserts named in the task body (logout hooks)', () => {
    const body = `
## 功能
4. L2 证据钩子 — data-evidence（nav-settings / settings-panel / settings-language）

## Evidence
- unlock
- click [data-evidence=nav-settings]
- assert sel=[data-evidence=settings-panel] optional
- screenshot settings-sheet
`;
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.source).toBe('task');
    const panel = plan.steps.find(
      (s) => s.kind === 'assert' && s.selector?.includes('settings-panel'),
    );
    expect(panel?.optional).toBeFalsy();
    // Missing settings-language hook gets a required assert.
    expect(
      plan.steps.some(
        (s) => s.kind === 'assert' && s.selector?.includes('settings-language'),
      ),
    ).toBe(true);
  });

  it('hardens optional clicks when task claims the same data-evidence hooks', () => {
    const body = `
## Definition of Done
- [ ] (mechanical) Settings Deploy UI with data-evidence=nav-settings / settings-update / settings-update-btn

## Evidence
- unlock
- screenshot shell
- click [data-evidence=nav-settings]
  optional: true
- assert sel=[data-evidence=settings-update] optional
- screenshot settings
  optional: true
`;
    const plan = resolveEvidencePlan({ taskBody: body });
    const click = plan.steps.find((s) => s.kind === 'click');
    expect(click?.optional).toBeFalsy();
    const update = plan.steps.find(
      (s) => s.kind === 'assert' && s.selector?.includes('settings-update'),
    );
    expect(update?.optional).toBeFalsy();
    // Screenshot stays optional — not a data-evidence claim target.
    const settingsShot = plan.steps.find(
      (s) => s.kind === 'screenshot' && s.name === 'settings',
    );
    expect(settingsShot?.optional).toBe(true);
  });

  it('replaces off-topic Settings Evidence for pull-to-refresh tasks (task-5 greenwash)', () => {
    const body = `
## Task
任务页面：下拉刷新任务列表和相关任务状态

## Evidence
- unlock
- screenshot shell
- click [data-evidence=nav-settings]
  optional: true
- screenshot settings
  optional: true
`;
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.steps.some((s) => s.selector?.includes('pull-to-refresh'))).toBe(true);
    expect(plan.steps.some((s) => s.selector?.includes('task-list'))).toBe(true);
    // Settings clicks must not remain the only UI proof.
    const settingsOnly =
      plan.steps.some((s) => s.selector?.includes('nav-settings')) &&
      !plan.steps.some((s) => s.selector?.includes('pull-to-refresh'));
    expect(settingsOnly).toBe(false);
    const ptrAssert = plan.steps.find(
      (s) => s.kind === 'assert' && s.selector?.includes('pull-to-refresh'),
    );
    expect(ptrAssert?.optional).toBeFalsy();
  });

  it('keeps optional steps soft when hooks are only inside ## Evidence', () => {
    const body = `
## Task
Explore UI; no promised hooks.

## Evidence
- unlock
- click [data-evidence=nav-settings]
  optional: true
- screenshot settings
  optional: true
`;
    const plan = resolveEvidencePlan({ taskBody: body });
    const click = plan.steps.find((s) => s.kind === 'click');
    expect(click?.optional).toBe(true);
  });

  it('taskBodyWithoutEvidenceSection drops the Evidence block for claim scan', () => {
    const body = `
## DoD
data-evidence=settings-panel

## Evidence
- click [data-evidence=nav-settings]

## Notes
keep me
`;
    const stripped = taskBodyWithoutEvidenceSection(body);
    expect(stripped).toMatch(/settings-panel/);
    expect(stripped).not.toMatch(/nav-settings/);
    expect(stripped).toMatch(/keep me/);
    expect(extractDataEvidenceHooks(stripped)).toEqual(['settings-panel']);
  });

  it('does not claim data-evidence hooks cited only as anti-pattern / incident examples', () => {
    // Live rework (2026-07-25): l5-placeholder-evidence-hook describes twin
    // cheats by name; harden must NOT require those selectors on the SPA.
    // Header matches production task: `## 真实案例 (2026-07-25, …)` — CJK
    // section titles must drop without relying on ASCII `\b`.
    const body = `
## Goal
新增一类 L5 反作弊检测: 为通过 assert 而造的占位证据钩子.

## 真实案例 (2026-07-25, 两个独立任务同时中招)
- \`web-render-tests\`: \`ReposPanel.tsx\` 新增 \`shellMarkReadyChrome\` —— 一个 **disabled** 的假 Mark ready 按钮, onConfirm 是空注释, 仅为满足 \`assert sel=[data-evidence=repo-mark-ready]\`.
- \`human-ui-ac-needs-evidence\`: \`App.tsx\` 新增 \`<div data-evidence="human-ac-unproven">unproven-ui-ac-host</div>\`, 内容是占位字符串.
两者 L3 都放行了——人眼审 diff 才发现. 这类作弊必须机器识别.

## Requirements
1. 识别带 data-evidence 的占位元素 (disabled + 空处理 / 占位文本 / for L2 注释).

## Evidence
- unlock
- click [data-evidence=nav-tasks]
- assert sel=[data-evidence=task-list]
- screenshot tasks

## Definition of Done
- [ ] (mechanical) 单测覆盖真占位命中与正常控件不命中
`;
    // Section strip alone must remove both incident hooks (no line-filter needed).
    const withoutIncidents = taskBodyWithoutIncidentSections(body);
    expect(withoutIncidents).not.toMatch(/repo-mark-ready|human-ac-unproven/);
    expect(withoutIncidents).toMatch(/## Goal/);
    expect(withoutIncidents).toMatch(/## Requirements/);

    const plan = resolveEvidencePlan({ taskBody: body });
    expect(
      plan.steps.some(
        (s) => s.selector?.includes('repo-mark-ready') || s.selector?.includes('human-ac-unproven'),
      ),
    ).toBe(false);
    // Declared Evidence hooks still present.
    expect(plan.steps.some((s) => s.selector?.includes('nav-tasks'))).toBe(true);
    expect(plan.steps.some((s) => s.selector?.includes('task-list'))).toBe(true);
    expect(extractDataEvidenceHooks(taskBodyWithoutEvidenceSection(body))).toEqual([]);
  });

  it('still claims DoD product hooks outside incident sections', () => {
    const body = `
## Goal
Ship Settings chrome.

## 真实案例
- past cheat used data-evidence=repo-mark-ready as a fake host.

## Definition of Done
- [ ] (mechanical) L2 finds data-evidence=settings-panel
`;
    const hooks = extractDataEvidenceHooks(taskBodyWithoutEvidenceSection(body));
    expect(hooks).toContain('settings-panel');
    expect(hooks).not.toContain('repo-mark-ready');
  });

  it('hardens claimed nav-* hooks as click steps (release-6 panel path)', () => {
    const body = `
## Task
Releases panel with data-evidence=nav-releases, releases-panel, promote-btn

## Definition of Done
- [ ] (mechanical) L2 finds data-evidence=nav-releases / releases-panel / promote-btn
`;
    const plan = resolveEvidencePlan({
      taskBody: body,
      workflowEvidence: [
        { kind: 'unlock', raw: 'unlock' },
        { kind: 'screenshot', name: 'shell', raw: 'screenshot shell' },
        {
          kind: 'click',
          selector: '[data-evidence=nav-settings]',
          raw: 'click [data-evidence=nav-settings]',
        },
        {
          kind: 'assert',
          selector: '[data-evidence=settings-panel]',
          raw: 'assert sel=[data-evidence=settings-panel]',
        },
      ],
    });
    const navClick = plan.steps.find(
      (s) => s.kind === 'click' && s.selector?.includes('nav-releases'),
    );
    expect(navClick, 'claimed nav-releases must become a click, not assert-only').toBeTruthy();
    expect(
      plan.steps.some(
        (s) => s.kind === 'assert' && s.selector?.includes('releases-panel'),
      ),
    ).toBe(true);
    expect(
      plan.steps.some(
        (s) => s.kind === 'assert' && s.selector?.includes('promote-btn'),
      ),
    ).toBe(true);
  });
});
