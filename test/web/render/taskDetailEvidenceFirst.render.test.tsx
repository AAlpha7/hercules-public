/**
 * C3.20 — evidence-first task sheet: gallery before decide, chips, lightbox,
 * habit-adaptive secondary sections.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  greenReviewBody,
  makeTask,
  taskDetailDefaults,
} from './fixtures.js';
import {
  renderDecisionCardBlock,
  type DecisionCard,
} from '../../../src/domain/decisionCard.js';
import {
  defaultOpen,
  loadSheetHabits,
  SHEET_HABITS_KEY,
} from '../../../src/web/sheetHabits.js';

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchPrSummary: vi.fn().mockRejectedValue(new Error('no pr')),
    fetchTaskFiles: vi.fn().mockResolvedValue({ files: [] }),
    fetchTaskFile: vi.fn().mockResolvedValue({ content: '', truncated: false }),
    fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock-evidence'),
    editRepo: vi.fn(),
  };
});

import { TaskDetail } from '../../../src/web/TaskDetail.js';

const TASK_ID = 'evidence-review-1';

function card(overrides: Partial<DecisionCard> = {}): DecisionCard {
  return {
    v: 1,
    purpose: 'Ship evidence-first sheet',
    areas: [{ area: 'src/web', count: 2 }],
    filesTouched: 3,
    reviewOnlyFlags: [],
    criteria: [
      {
        text: 'Spot-check screenshots',
        kind: 'human',
        status: 'pending',
        why: 'pending human',
      },
    ],
    gates: [
      { name: 'typecheck', passed: true },
      { name: 'test', passed: true },
      { name: 'lint', passed: true },
      { name: 'build', passed: true },
      { name: 'behavioral', passed: true },
      { name: 'delivery', passed: true },
    ],
    evidence: { ran: true, ok: true, steps: 3 },
    boundaries: {
      branch: `hercules/${TASK_ID}`,
      protectedPathsTouched: false,
      testsEdited: false,
      crossTaskIds: [],
      crossTaskCommits: [],
    },
    reviewer: { ran: true, approved: true, summaryZh: '截图齐全' },
    ...overrides,
  };
}

/** Review body with 3 step-labelled screenshots + 决策摘要 + decision card. */
function evidenceReviewBody(): string {
  return `## Goal
Evidence-first layout.

## Definition of Done
- [ ] (human) Spot-check screenshots
- [ ] (mechanical) tests pass

## Review packet

### ${TASK_ID} — \`hercules/${TASK_ID}\`
**✅ automated proof complete** (human Approve still required if human ACs exist)

## 决策摘要

- **改动**:${TASK_ID}(3 个文件改动)
- **可信度**:门禁 6/6 绿 · 独立审稿:通过 · 浏览器行为证据 3 步通过 · CLI行为证据 1 步通过
- **风险**:无标记风险

**Behavioral evidence** *(declarative plan — not label guessing)*

Plan source: \`workflow\` · ✅ all required steps ok

- ✅ \`unlock\` — opened sheet
- ✅ \`assert [data-evidence=review-decide]\` — visible
- ✅ \`screenshot scene-a\` — wrote
- ✅ \`screenshot scene-b\` — wrote
- ❌ \`screenshot scene-c\` — wrote

_Screenshot: scene-a.png_ (scene: unlock)
![evidence](/api/tasks/${TASK_ID}/screenshots/scene-a.png)
_Screenshot: scene-b.png_
![evidence](/api/tasks/${TASK_ID}/screenshots/scene-b.png)
_Screenshot: scene-c.png_
![evidence](/api/tasks/${TASK_ID}/screenshots/scene-c.png)

**Agent's report** *(evidence, not a verdict)*
Did the work.

${renderDecisionCardBlock(card())}
`;
}

function installMemoryStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return map.size;
      },
      clear() {
        map.clear();
      },
      getItem(key: string) {
        return map.has(key) ? map.get(key)! : null;
      },
      key(i: number) {
        return [...map.keys()][i] ?? null;
      },
      removeItem(key: string) {
        map.delete(key);
      },
      setItem(key: string, value: string) {
        map.set(key, String(value));
      },
    },
  });
}

describe('TaskDetail evidence-first sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMemoryStorage();
  });

  it('renders evidence-first before review-decide and packet-details', () => {
    const task = makeTask({ id: TASK_ID, body: evidenceReviewBody() });
    const { container } = render(<TaskDetail {...taskDetailDefaults(task)} />);

    const first = container.querySelector('[data-evidence="evidence-first"]');
    const decide = container.querySelector('[data-evidence="review-decide"]');
    const packet = container.querySelector('[data-evidence="packet-details"]');
    expect(first).toBeTruthy();
    expect(decide).toBeTruthy();
    expect(packet).toBeTruthy();

    const position = (el: Element) =>
      el.compareDocumentPosition(first!);
    // first precedes decide and packet
    expect(decide!.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(packet!.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(packet!.compareDocumentPosition(decide!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    void position;
  });

  it('shows 3 tiles with ✓/✗ badges; caption is title + lightbox only', async () => {
    const user = userEvent.setup();
    const task = makeTask({ id: TASK_ID, body: evidenceReviewBody() });
    render(<TaskDetail {...taskDetailDefaults(task)} />);

    const shots = document.querySelectorAll('[data-evidence="evidence-shot"]');
    expect(shots.length).toBe(3);
    expect(shots[0]).toHaveAttribute('data-ok', '1');
    expect(shots[1]).toHaveAttribute('data-ok', '1');
    expect(shots[2]).toHaveAttribute('data-ok', '0');
    // Compact strip: no under-tile caption node — label lives in title + lightbox.
    expect(document.querySelector('.evidence-shot-caption')).toBeNull();
    expect(shots[0]).toHaveAttribute('title', expect.stringMatching(/screenshot scene-a/i));
    expect(shots[2]).toHaveAttribute('title', expect.stringMatching(/screenshot scene-c/i));

    await user.click(shots[0] as HTMLElement);
    const lightbox = document.querySelector('[data-evidence="evidence-lightbox"]');
    expect(lightbox).toBeTruthy();
    expect(lightbox!.textContent).toMatch(/screenshot scene-a/i);

    await user.click(lightbox!);
    expect(document.querySelector('[data-evidence="evidence-lightbox"]')).toBeNull();
  });

  it('keeps evidence-first phone class/attribute contract (browser smoke owns height)', () => {
    const task = makeTask({ id: TASK_ID, body: evidenceReviewBody() });
    render(<TaskDetail {...taskDetailDefaults(task)} />);
    const first = document.querySelector(
      '[data-evidence="evidence-first"]',
    ) as HTMLElement | null;
    expect(first).toBeTruthy();
    expect(first!.classList.contains('evidence-first')).toBe(true);
    expect(first!.getAttribute('data-budget-max')).toBe('96');
    // Chips stay a single non-wrapping row (class contract for the strip).
    const chips = first!.querySelector('.evidence-chips');
    expect(chips).toBeTruthy();
    expect(chips!.classList.contains('evidence-chips')).toBe(true);
    expect(first!.querySelector('.evidence-shot-thumb')).toBeTruthy();
    // 3 tiles → stacked (not --inline); 3 shots exceed the inline threshold.
    expect(first!.classList.contains('evidence-first--inline')).toBe(false);
  });

  it('inlines chips beside the strip when there are ≤2 media items', () => {
    const body = evidenceReviewBody().replace(
      /_Screenshot: scene-c\.png_[\s\S]*?!\[evidence\]\(\/api\/tasks\/[^)]+scene-c\.png\)\n/,
      '',
    );
    const task = makeTask({ id: TASK_ID, body });
    render(<TaskDetail {...taskDetailDefaults(task)} />);
    const first = document.querySelector('[data-evidence="evidence-first"]');
    expect(first).toBeTruthy();
    expect(document.querySelectorAll('[data-evidence="evidence-shot"]').length).toBe(2);
    expect(first!.classList.contains('evidence-first--inline')).toBe(true);
  });

  it('renders credibility chips from the packet / card', () => {
    const task = makeTask({ id: TASK_ID, body: evidenceReviewBody() });
    render(<TaskDetail {...taskDetailDefaults(task)} />);

    const chips = document.querySelectorAll('[data-evidence="evidence-chip"]');
    const byKind = new Map(
      [...chips].map((el) => [el.getAttribute('data-kind'), el.textContent ?? '']),
    );
    expect(byKind.get('gates')).toMatch(/门禁\s*6\/6/);
    expect(byKind.get('reviewer')).toMatch(/审稿\s*通过/);
    expect(byKind.get('behavioral')).toMatch(/行为证据/);
    expect(byKind.get('cli')).toMatch(/CLI证据/);
    expect(byKind.get('files')).toMatch(/改动\s*3\s*文件/);
  });

  it('shows the strip on a failed task with screenshots', () => {
    const task = makeTask({
      id: TASK_ID,
      state: 'failed',
      body: evidenceReviewBody(),
    });
    render(<TaskDetail {...taskDetailDefaults(task)} />);
    expect(document.querySelector('[data-evidence="evidence-first"]')).toBeTruthy();
    expect(document.querySelectorAll('[data-evidence="evidence-shot"]').length).toBe(3);
  });

  it('does not render evidence-first for a running task', () => {
    const task = makeTask({
      id: TASK_ID,
      state: 'in_progress',
      body: evidenceReviewBody(),
    });
    render(<TaskDetail {...taskDetailDefaults(task)} />);
    expect(document.querySelector('[data-evidence="evidence-first"]')).toBeNull();
  });

  it('shows a muted empty note when review has no screenshots', () => {
    const task = makeTask({
      id: 'no-shots',
      body: `${greenReviewBody('Check UI')}\n\n## 决策摘要\n\n- **可信度**:门禁 6/6 绿 · 独立审稿:通过 · 行为证据未运行 · 浏览器证据不适用\n`,
    });
    render(<TaskDetail {...taskDetailDefaults(task)} />);
    const first = document.querySelector('[data-evidence="evidence-first"]');
    expect(first).toBeTruthy();
    expect(first!.textContent).toMatch(/无截图证据/);
    expect(document.querySelectorAll('[data-evidence="evidence-shot"]').length).toBe(0);
  });

  it('habit: opening task-body thrice moves it above files and defaults open; closing packet-details keeps it closed', async () => {
    const user = userEvent.setup();
    const task = makeTask({
      id: TASK_ID,
      body: evidenceReviewBody(),
      verifiedSha: 'abc1234567890',
    });
    const now = Date.now();

    // Seed: files was used a lot historically; task-body gets three fresh opens
    // so it outranks files. packet-details closed thrice → stays closed.
    localStorage.setItem(
      SHEET_HABITS_KEY,
      JSON.stringify({
        files: {
          events: [
            { kind: 'open', at: now - 60_000 },
            { kind: 'click', at: now - 60_000 },
          ],
        },
        'task-body': {
          events: [
            { kind: 'open', at: now },
            { kind: 'open', at: now },
            { kind: 'open', at: now },
          ],
        },
        'packet-details': {
          events: [
            { kind: 'close', at: now },
            { kind: 'close', at: now },
            { kind: 'close', at: now },
          ],
        },
      }),
    );

    const seeded = loadSheetHabits();
    expect(defaultOpen('task-body', seeded, false, now)).toBe(true);
    expect(defaultOpen('packet-details', seeded, false, now)).toBe(false);

    render(<TaskDetail {...taskDetailDefaults(task)} />);
    const body2 = document.querySelector(
      '[data-section="task-body"], [data-evidence="task-body"]',
    ) as HTMLDetailsElement;
    const files = document.querySelector(
      '[data-section="files"], [data-evidence="task-files"]',
    ) as HTMLElement;
    const packet = document.querySelector(
      '[data-evidence="packet-details"]',
    ) as HTMLDetailsElement;

    expect(body2).toBeTruthy();
    expect(files).toBeTruthy();
    expect(packet).toBeTruthy();
    expect(body2.getAttribute('data-habit-open')).toBe('1');
    expect(packet.getAttribute('data-habit-open')).toBe('0');

    // Habit ranking uses flex `order` (DOM source order stays static).
    const bodyOrder = Number((body2 as HTMLElement).style.order || 999);
    const filesOrder = Number(files.style.order || 999);
    expect(bodyOrder).toBeLessThan(filesOrder);

    // Also record a real open gesture so habits keep learning.
    if (!body2.open) {
      await user.click(body2.querySelector('summary')!);
    }
  });

  it('B1: programmatic habit defaultOpen does not record; summary click does', async () => {
    const user = userEvent.setup();
    const now = Date.now();
    localStorage.setItem(
      SHEET_HABITS_KEY,
      JSON.stringify({
        'task-body': {
          events: [
            { kind: 'open', at: now },
            { kind: 'open', at: now },
            { kind: 'open', at: now },
          ],
        },
      }),
    );
    const task = makeTask({
      id: TASK_ID,
      body: evidenceReviewBody(),
      verifiedSha: 'abc1234567890',
    });
    render(<TaskDetail {...taskDetailDefaults(task)} />);

    const body = document.querySelector(
      '[data-section="task-body"]',
    ) as HTMLDetailsElement;
    expect(body).toBeTruthy();
    expect(body.getAttribute('data-habit-open')).toBe('1');

    // Flush effects / any native toggle from controlled open=true.
    await Promise.resolve();
    await Promise.resolve();
    expect(loadSheetHabits()['task-body']?.events.length).toBe(3);

    await user.click(body.querySelector('summary')!);
    expect(loadSheetHabits()['task-body']?.events.length).toBe(4);
  });

  it('storage-throwing environment falls back to static sheet behaviour', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
        removeItem() {
          throw new Error('denied');
        },
        clear() {},
        key() {
          return null;
        },
        length: 0,
      },
    });
    const task = makeTask({ id: TASK_ID, body: evidenceReviewBody() });
    expect(() => render(<TaskDetail {...taskDetailDefaults(task)} />)).not.toThrow();
    expect(document.querySelector('[data-evidence="evidence-first"]')).toBeTruthy();
    expect(document.querySelector('[data-evidence="review-decide"]')).toBeTruthy();
  });

  it('N4: with setItem throwing, opening task-body three times leaves order unchanged', async () => {
    const user = userEvent.setup();
    const map = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        get length() {
          return map.size;
        },
        clear() {
          map.clear();
        },
        getItem(key: string) {
          return map.has(key) ? map.get(key)! : null;
        },
        key(i: number) {
          return [...map.keys()][i] ?? null;
        },
        removeItem(key: string) {
          map.delete(key);
        },
        setItem() {
          throw new Error('quota');
        },
      },
    });
    const task = makeTask({
      id: TASK_ID,
      body: evidenceReviewBody(),
      verifiedSha: 'abc1234567890',
    });
    render(<TaskDetail {...taskDetailDefaults(task)} />);
    const body = document.querySelector(
      '[data-section="task-body"]',
    ) as HTMLDetailsElement;
    const files = document.querySelector(
      '[data-section="files"], [data-evidence="task-files"]',
    ) as HTMLElement;
    expect(body).toBeTruthy();
    expect(files).toBeTruthy();
    const orderBefore = Number((body as HTMLElement).style.order || 999);
    const filesBefore = Number(files.style.order || 999);

    const summary = body.querySelector('summary');
    expect(summary).toBeTruthy();
    await user.click(summary!);
    await user.click(summary!);
    await user.click(summary!);

    expect(Number((body as HTMLElement).style.order || 999)).toBe(orderBefore);
    expect(Number(files.style.order || 999)).toBe(filesBefore);
  });

  it('N3: summary gesture is consumed once; programmatic content click does not record', async () => {
    const user = userEvent.setup();
    const task = makeTask({
      id: TASK_ID,
      body: evidenceReviewBody(),
      verifiedSha: 'abc1234567890',
    });
    render(<TaskDetail {...taskDetailDefaults(task)} />);
    const body = document.querySelector(
      '[data-section="task-body"]',
    ) as HTMLDetailsElement;
    expect(body).toBeTruthy();
    const before = loadSheetHabits()['task-body']?.events.length ?? 0;

    await user.click(body.querySelector('summary')!);
    const afterClick = loadSheetHabits()['task-body']?.events.length ?? 0;
    expect(afterClick).toBe(before + 1);

    // Programmatic open change inside the window must not record again.
    body.open = !body.open;
    body.dispatchEvent(new Event('toggle', { bubbles: true }));
    expect(loadSheetHabits()['task-body']?.events.length ?? 0).toBe(afterClick);

    // Programmatic content click (detail 0) must not record.
    const content = body.querySelector('.disclosure-body, .md, pre, p') ?? body;
    content.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(loadSheetHabits()['task-body']?.events.length ?? 0).toBe(afterClick);
  });
});
