import { describe, it, expect } from 'vitest';
import {
  buildTaskParts,
  formatTaskIndex,
  formatTaskMeta,
  readTaskPart,
  filterPartIds,
  formatReadPlan,
} from '../../src/web/taskInspect.js';
import { FRAGMENT_BANNER } from '../../src/web/voiceFragments.js';

const sampleBody = `
# Do the work

User wants a solid fix.

## Review packet

**Evidence matrix**
| criterion | status | evidence |
| c1 | pass | tests |

**Gates**
All gates green.

**Agent's report**
${'x'.repeat(5000)}

**Cost**
$0.12
`.trim();

const task = {
  id: 'task-9',
  title: 'Do the work',
  state: 'review' as const,
  repo: 'app',
  attempts: 1,
  adapter: null,
  prUrl: null,
  prStatus: null,
  planPending: false,
  body: sampleBody,
};

describe('taskInspect (structural document access)', () => {
  it('indexes brief + packet parts with sizes', () => {
    const { parts } = buildTaskParts(sampleBody);
    expect(parts.some((p) => p.ref.id === 'brief')).toBe(true);
    expect(parts.length).toBeGreaterThan(2);
    const idx = formatTaskIndex(task);
    expect(idx).toMatch(/TASK INDEX \(complete catalog/);
    expect(idx).toMatch(/brief/);
    expect(idx).toMatch(/chars/);
    expect(formatTaskMeta(task)).toMatch(/no body text/i);
  });

  it('reads a full short part as COMPLETE', () => {
    const r = readTaskPart(task, 'Gates', { maxChars: 5000 });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.complete).toBe(true);
    expect(r.nextOffset).toBeNull();
    expect(r.text).toMatch(/\[COMPLETE\]/);
    expect(r.text).toMatch(/All gates green/);
  });

  it('paginates long parts with FRAGMENT + nextOffset until complete', () => {
    const first = readTaskPart(task, "Agent's report", { offset: 0, maxChars: 800 });
    expect('error' in first).toBe(false);
    if ('error' in first) return;
    expect(first.complete).toBe(false);
    expect(first.nextOffset).toBe(800);
    expect(first.text).toContain(FRAGMENT_BANNER);
    expect(first.text).toMatch(/offset=800/);

    const second = readTaskPart(task, first.partId, {
      offset: first.nextOffset!,
      maxChars: 8000,
    });
    expect('error' in second).toBe(false);
    if ('error' in second) return;
    expect(second.complete).toBe(true);
    expect(second.text).toMatch(/\[COMPLETE\]/);
  });

  it('plans evidence-related parts without dumping content', () => {
    const plan = formatReadPlan(task, 'evidence');
    expect(plan).toMatch(/READ PLAN/);
    expect(plan).toMatch(/matrix|Evidence|report|Cost/i);
    expect(plan).not.toMatch(/All gates green/); // content not in plan
    const ids = filterPartIds(task, 'gates');
    expect(ids.some((p) => /gates/i.test(p.title))).toBe(true);
  });

  it('rejects unknown part with available catalog', () => {
    const r = readTaskPart(task, 'does-not-exist-xyz');
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toMatch(/Unknown part|Available/i);
  });
});
