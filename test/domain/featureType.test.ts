import { describe, it, expect } from 'vitest';
import {
  classifyFeature,
  evidenceStepsForFeature,
  isEvidenceOffTopicForKind,
  evidenceMarkdownForFeature,
} from '../../src/domain/featureType.js';
import { resolveEvidencePlan } from '../../src/domain/evidence.js';
import { draftTaskFromIntent } from '../../src/domain/intentDraft.js';

describe('classifyFeature', () => {
  it('classifies pull-to-refresh before generic UI', () => {
    expect(classifyFeature('任务页面：下拉刷新任务列表')).toBe('pull_to_refresh');
  });

  it('classifies settings, form, auth, list, docs, bug', () => {
    expect(classifyFeature('Settings: language and default agent')).toBe('settings');
    expect(classifyFeature('Add a submit form for task title validation')).toBe('form');
    expect(classifyFeature('Login page auth token session')).toBe('auth');
    expect(classifyFeature('Improve the task list feed')).toBe('list');
    expect(classifyFeature('Update README documentation')).toBe('docs');
    expect(classifyFeature('Fix flaky upload retry bug')).toBe('bug');
  });

  it('classifies English fix lexically without fixture hits', () => {
    expect(classifyFeature('Fix flaky upload retry bug')).toBe('bug');
    expect(classifyFeature('Fixed race in queue drain')).toBe('bug');
    expect(classifyFeature('Fixing null deref on empty snapshot')).toBe('bug');
    expect(classifyFeature('Add fixture helpers for the adapter contract')).not.toBe('bug');
    expect(classifyFeature('Document the path prefix and suffix rules')).not.toBe('bug');
  });

  it('classifies onboarding/readiness', () => {
    expect(classifyFeature('Make orbit ready: WORKFLOW.md and AGENTS.md readiness')).toBe(
      'onboarding',
    );
  });

  it('does not treat 自然语言 / git 提交 as settings or form', () => {
    // 自然语言 must not trip SETTINGS_RE's 语言 token.
    expect(classifyFeature('从自然语言 intent 生成 DoD 与 Evidence 提醒')).not.toBe('settings');
    // 涉及哪些提交 = git commits, not form submit.
    expect(
      classifyFeature('手机上点黄色跨任务徽章, 一眼看懂为什么黄、涉及哪些提交'),
    ).not.toBe('form');
  });

  it('does not treat 备选列表 / adapter failover prose as a UI list feature', () => {
    // adapter-failover case study (2026-07-29): bare 列表 in 备选列表 forced
    // evidenceStepsForFeature('list') and L2 required a list hook. Classifier
    // must not treat fallback-chain prose as a UI list feature.
    const body = `
## Goal
当某个 adapter 在短窗口内连续 agent_exit, 后续派发自动降级到备选 adapter,
并在任务 timeline 与决策收件箱注明。

## Requirements
降级顺序取 repo/daemon 配置的备选列表 (默认 grok→claude→codex)。

## Definition of Done
- [ ] (mechanical) 单测覆盖阈值/窗口/降级顺序/全不健康
- [ ] (human) timeline 里能看到降级说明
`;
    expect(classifyFeature(body)).not.toBe('list');
    const plan = resolveEvidencePlan({ taskBody: body });
    // Post-fix plan should not force a list-only template (unlock+shell or WF).
    expect(plan.steps.some((s) => s.selector === '[data-evidence=list]')).toBe(false);
    expect(plan.steps.some((s) => s.selector === '[data-evidence=task-list]')).toBe(false);
  });

  it('does not treat 存在性校验 / 扫描目录列表 as a UI form feature', () => {
    // browser-resolve-at-use case study (2026-07-30): bare 校验 in 存在性校验
    // plus 列表 in 扫描目录列表 forced form evidence → L2 assert data-evidence=form.
    // Backend path-resolve tasks are not SPA form chrome.
    const body = `
## Goal
findChromium 目前在 daemon 启动时解析一次并缓存 (src/main.ts)。playwright 缓存轮换后,
老路径失效, daemon 报「Chromium 未安装」直到人工重启。浏览器路径应在每次使用时解析。

## Requirements
1. 调用点每次 findChromium() (或带 mtime/存在性校验的短 TTL 缓存 ≤60s); 移除 boot 时的一次性绑定。
2. 解析失败时错误信息包含实际扫描过的目录与候选 (exact-reason), 不再是笼统的「未安装」。
3. 单测: 路径消失→重新扫描找到新版本; 全部缺失→报错含扫描详情。

## Definition of Done
- [ ] (mechanical) 单测覆盖上述两态
- [ ] (mechanical) pnpm check:full green
- [ ] (reviewer) 无 boot 期缓存残留; 高频调用无性能回归 (解析是 readdir 级, 或有短 TTL)
- [ ] (human) 看 packet: 失败错误样例含扫描目录列表
`;
    expect(classifyFeature(body)).not.toBe('form');
    const workflowEvidence = [
      {
        kind: 'click' as const,
        selector: '[data-evidence=nav-settings]',
        raw: 'click [data-evidence=nav-settings]',
      },
      {
        kind: 'assert' as const,
        selector: '[data-evidence=settings-panel]',
        raw: 'assert sel=[data-evidence=settings-panel]',
      },
    ];
    const plan = resolveEvidencePlan({ taskBody: body, workflowEvidence });
    expect(plan.steps.some((s) => s.selector === '[data-evidence=form]')).toBe(false);
    // WORKFLOW Settings chrome must not be "repaired" away for this backend task.
    expect(plan.steps.some((s) => s.selector?.includes('settings-panel'))).toBe(true);
  });

  it('does not treat perform/platform suffix prose as a UI form feature', () => {
    // Suffix form tokens in perform/platform must not force form evidence.
    const body =
      'Request the required identity fields from gh; do not infer them. ' +
      'Perform a read-only identity preflight before comments or close/delete. ' +
      'Resolve the actor identity via the platform API only. Do not invent fields.';
    expect(classifyFeature(body)).not.toBe('form');
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.steps.some((s) => s.selector === '[data-evidence=form]')).toBe(false);
    // Genuine standalone form intent still maps to the form template.
    expect(classifyFeature('Add a submit form for task title validation')).toBe('form');
  });

  it('does not treat the nav suffix in unavailable as generic UI intent', () => {
    expect(classifyFeature('Define the backend retry policy when a provider is unavailable.')).toBe(
      'general',
    );
  });

  it('does not treat the card suffix in discard as generic UI intent', () => {
    expect(classifyFeature('Define the backend policy to discard stale receipts.')).toBe('general');
  });

  it('recognizes standalone nav/card and full navigation UI intent', () => {
    expect(classifyFeature('Add nav controls')).toBe('ui_generic');
    expect(classifyFeature('Add navigation controls')).toBe('ui_generic');
    expect(classifyFeature('Add a task card')).toBe('ui_generic');
  });

  it('list feature template uses real task-list chrome', () => {
    const steps = evidenceStepsForFeature('list');
    expect(steps?.some((s) => s.selector?.includes('task-list'))).toBe(true);
  });

  it('keeps decide-card Evidence for UI-AC gap tasks (no settings greenwash)', () => {
    const body = `
## Goal
人工验收项若描述界面行为而 evidence 无 click/assert, 操作员无法在部署前核验。

## 真实案例
人工项: 「手机上点黄色跨任务徽章, 一眼看懂为什么黄、涉及哪些提交」.
从自然语言 intent 生成 DoD 时若无 ## Evidence 应提醒.

## Requirements
同时在 UI 的人工项勾选框旁标注 (\`data-evidence=human-ac-unproven\`).

## Evidence
- unlock
- click [data-evidence=nav-tasks]
- assert sel=[data-evidence=task-list]
- click [data-evidence=task-card]
- assert sel=[data-evidence=decision-card]
- screenshot decide-card

## Definition of Done
- [ ] (mechanical) 中英文用语均覆盖
- [ ] (human) 看 packet 里的 decide-card 截图: 无证据支撑的人工项旁有显眼告警
`;
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.steps.some((s) => s.selector?.includes('decision-card'))).toBe(true);
    expect(plan.steps.some((s) => s.selector?.includes('task-card'))).toBe(true);
    // Claimed hook is required (not replaced by Settings template).
    expect(plan.steps.some((s) => s.selector?.includes('human-ac-unproven'))).toBe(true);
    expect(plan.steps.some((s) => s.selector?.includes('nav-settings'))).toBe(false);
  });
});

describe('evidence anti-greenwash via feature types', () => {
  it('flags settings chrome as off-topic for form tasks', () => {
    const steps = [
      { kind: 'click' as const, selector: '[data-evidence=nav-settings]', raw: 'click' },
      { kind: 'screenshot' as const, name: 'settings', raw: 'screenshot settings' },
    ];
    expect(isEvidenceOffTopicForKind('form', steps)).toBe(true);
    expect(isEvidenceOffTopicForKind('settings', steps)).toBe(false);
  });

  it('resolveEvidencePlan repairs form task with settings evidence', () => {
    const body = `
## Task
Add a create-task form with validation

## Evidence
- unlock
- click [data-evidence=nav-settings]
- screenshot settings
`;
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.steps.some((s) => s.selector?.includes('form'))).toBe(true);
    expect(
      plan.steps.some((s) => s.selector?.includes('nav-settings')) &&
        !plan.steps.some((s) => s.selector?.includes('form')),
    ).toBe(false);
  });

  it('intent draft form uses form evidence hooks', () => {
    const d = draftTaskFromIntent('Add a create-task form with field validation', 'hercules');
    expect(d.body).toMatch(/data-evidence=form/);
    expect(d.body).not.toMatch(/nav-settings/);
    expect(d.body).toMatch(/Feature kind: `form`/);
  });

  it('canonical templates cover major UI kinds', () => {
    for (const k of ['settings', 'pull_to_refresh', 'form', 'auth', 'list'] as const) {
      const steps = evidenceStepsForFeature(k);
      expect(steps?.length).toBeGreaterThan(0);
      expect(evidenceMarkdownForFeature(k)).toMatch(/## Evidence/);
    }
  });
});
