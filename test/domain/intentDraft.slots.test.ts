/**
 * C3.35 — intent slot detection + clarification questions (where / what / done_when).
 */
import { describe, expect, it } from 'vitest';
import {
  detectIntentSlots,
  draftTaskFromIntent,
  HERCULES_WHERE_OPTIONS,
  questionsForMissingSlots,
  questionTextForSlot,
} from '../../src/domain/intentDraft.js';

describe('detectIntentSlots table (zh + en)', () => {
  const cases: ReadonlyArray<{
    intent: string;
    missing: ReadonlyArray<'where' | 'what' | 'doneWhen'>;
  }> = [
    { intent: '做一下', missing: ['where', 'what', 'doneWhen'] },
    // "fix it" has a bare what verb+object but still lacks where / done-when.
    { intent: 'fix it', missing: ['where', 'doneWhen'] },
    { intent: 'improve', missing: ['where', 'what', 'doneWhen'] },
    { intent: '改 Settings', missing: ['what', 'doneWhen'] },
    { intent: '任务页显示徽章', missing: ['doneWhen'] },
    { intent: '把底栏 Logout 改成 Settings', missing: ['doneWhen'] },
    {
      intent: 'Settings 页把语言改成中文，测试通过',
      missing: [],
    },
    {
      intent: 'Add a create-task form on Tasks and assert the submit button',
      missing: [],
    },
    {
      intent: 'Fix crash when opening Settings panel — regression test must pass',
      missing: [],
    },
    {
      intent: '在 src/web/CreateForm.tsx 新增确认按钮，截图验收',
      missing: [],
    },
    {
      intent: 'Chat 隐藏未读角标 when list empty then badge gone',
      missing: [],
    },
    {
      intent: 'Repos 页不再显示 incomplete 横幅 @gate:test',
      missing: [],
    },
    {
      intent: 'https://hercules.example/settings 改成深色主题',
      missing: ['doneWhen'],
    },
    {
      intent: '「where: Tasks」「what: 按最后活跃排序」「done_when: 门禁绿」',
      missing: [],
    },
  ];

  it('covers ≥ 12 zh/en intents with expected missing slots', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    for (const c of cases) {
      const slots = detectIntentSlots(c.intent);
      const missing: Array<'where' | 'what' | 'doneWhen'> = [];
      if (slots.where === null) missing.push('where');
      if (slots.what === null) missing.push('what');
      if (slots.doneWhen === null) missing.push('doneWhen');
      expect(missing, c.intent).toEqual([...c.missing]);
    }
  });
});

describe('questionsForMissingSlots', () => {
  it('emits ONE question per missing slot with zh wording', () => {
    const slots = detectIntentSlots('做一下');
    const qs = questionsForMissingSlots(slots, 'hercules');
    expect(qs.map((q) => q.slot)).toEqual(['where', 'what', 'done_when']);
    expect(qs[0]?.text).toBe(questionTextForSlot('where'));
    expect(qs[1]?.text).toBe(questionTextForSlot('what'));
    expect(qs[2]?.text).toBe(questionTextForSlot('done_when'));
  });

  it('offers Hercules SPA surfaces as where options only for hercules', () => {
    const slots = { where: null, what: '改成徽章', doneWhen: '测试通过' };
    const hercules = questionsForMissingSlots(slots, 'hercules');
    expect(hercules).toHaveLength(1);
    expect(hercules[0]?.options).toEqual([...HERCULES_WHERE_OPTIONS]);

    const other = questionsForMissingSlots(slots, 'demostory');
    expect(other).toHaveLength(1);
    expect(other[0]?.options).toBeUndefined();
  });
});

describe('draftTaskFromIntent clarification contract', () => {
  it('sets vague from questions, fills summaries, and never emits the old warning', () => {
    const d = draftTaskFromIntent('做一下', 'hercules');
    expect(d.vague).toBe(true);
    expect(d.questions.length).toBeGreaterThan(0);
    expect(d.filled.some((f) => /已补验收标准/.test(f))).toBe(true);
    expect(d.warnings.join('\n')).not.toMatch(/Intent looks vague/);
    expect(d.warnings.join('\n')).not.toMatch(/tighten acceptance criteria/);
  });

  it('complete intent has no questions and still drafts bindable AC', () => {
    const d = draftTaskFromIntent(
      'Settings 页把语言改成中文，测试通过',
      'hercules',
    );
    expect(d.questions).toEqual([]);
    expect(d.vague).toBe(false);
    expect(d.body).toMatch(/@gate:test/);
    expect(d.filled.length).toBeGreaterThan(0);
  });

  it('empty intent stays vague with questions and Empty intent warning only', () => {
    const d = draftTaskFromIntent('', 'hercules');
    expect(d.vague).toBe(true);
    expect(d.questions).toHaveLength(3);
    expect(d.warnings).toEqual(['Empty intent']);
  });
});

describe('detectIntentSlots — Claude R18 note cases', () => {
  it('加一个 counts as a change verb; 登录页 is a place; 通过 alone is not a done-when', () => {
    const a = detectIntentSlots('设置页加一个深色模式开关，测试通过');
    expect(a.where).toBe('设置页');
    expect(a.what).toContain('加一个');
    expect(a.doneWhen).toContain('测试通过');
    const b = detectIntentSlots('登录页密码框显示明文');
    expect(b.where).toBe('登录页');
    const c = detectIntentSlots('通过设置页打开深色模式');
    expect(c.doneWhen).toBeNull();
    const d = detectIntentSlots('Figure out where: the crash happens');
    expect(d.where).toBeNull();
  });
});
