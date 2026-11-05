import { describe, it, expect } from 'vitest';
import {
  splitTaskBody,
  packetStatusChip,
  packetCostChip,
  parseHumanCriteria,
  sectionDefaultOpen,
  antiCheatSectionTone,
  antiCheatBadge,
  thrashBrakeStillActive,
  partitionSectionsForDisplay,
  bodyHasSuccessfulPacket,
  latestReviewPacketSlice,
} from '../../src/web/taskBodySplit.js';

const SAMPLE = `## Task
Check the loop.

## Acceptance criteria
- [ ] (human) ready
- [ ] (mechanical) tests pass

## Review packet

### t-1 — \`hercules/t-1\`
**✅ automated proof complete** (human Approve still required if human ACs exist)

**Definition of Done**
| Axis | Status |
|---|---|
| mechanical (L1) | ✅ pass |

**Evidence matrix** *(agent citations — not a verdict)*
| Criterion | Kind | Status | Evidence |
|---|---|---|---|
| ready | \`human\` | ⏳ pending | pending human |

**Self-assessment** *(agent evidence only)*
pending human

**Agent's report** *(evidence, not a verdict)*
Long narrative about work.

**Files touched**
- \`src/a.ts\`
- \`src/b.ts\`

**Diff**
\`\`\`diff
+hello
\`\`\`

**Cost (steer resume)**
💵 **Steer turn** $0.02 · 0.8k in / 0.2k out · _session resume — not a full implementer run_
`;

describe('splitTaskBody', () => {
  it('keeps the brief separate from packet sections', () => {
    const { brief, sections } = splitTaskBody(SAMPLE);
    expect(brief).toContain('Check the loop');
    expect(brief).not.toContain('Definition of Done');
    const titles = sections.map((s) => s.title.toLowerCase());
    expect(titles.some((t) => t.includes('definition of done'))).toBe(true);
    expect(titles.some((t) => t.includes("agent's report") || t.includes('agent'))).toBe(true);
    expect(titles.some((t) => t.includes('diff'))).toBe(true);
  });

  it('marks evidence sections as evidence kind', () => {
    const { sections } = splitTaskBody(SAMPLE);
    const diff = sections.find((s) => /diff/i.test(s.title));
    expect(diff?.kind).toBe('evidence');
    const dod = sections.find((s) => /definition of done/i.test(s.title));
    expect(dod?.kind).toBe('brief');
  });

  it('default-opens matrix, short files, cost; keeps long report collapsed', () => {
    const { sections } = splitTaskBody(SAMPLE);
    const matrix = sections.find((s) => /evidence matrix/i.test(s.title));
    const files = sections.find((s) => /files touched/i.test(s.title));
    const report = sections.find((s) => /agent's report/i.test(s.title));
    const cost = sections.find((s) => /cost/i.test(s.title));
    expect(matrix && sectionDefaultOpen(matrix)).toBe(true);
    expect(files && sectionDefaultOpen(files)).toBe(true);
    expect(report && sectionDefaultOpen(report)).toBe(false);
    expect(cost && sectionDefaultOpen(cost)).toBe(true);
  });

  it('treats L3 report as collapsed evidence and keeps embedded ## inside the section', () => {
    const body = [
      '## Task',
      'Retain depth.',
      '',
      '## Review packet',
      '**Reviewer (L3):** approved',
      '',
      '**L3 report**',
      '',
      '> ## Per-flag adjudications',
      '> - test-edit in foo.test.ts - justified',
      '',
      '**Gates**',
      '- typecheck',
    ].join('\n');
    const { sections } = splitTaskBody(body);
    const l3 = sections.find((s) => s.title.toLowerCase() === 'l3 report');
    expect(l3).toBeDefined();
    expect(l3?.kind).toBe('evidence');
    expect(l3 && sectionDefaultOpen(l3)).toBe(false);
    expect(l3?.text).toContain('## Per-flag adjudications');
    expect(l3?.text).toContain('test-edit in foo.test.ts');
    expect(sections.some((s) => /per-flag adjudications/i.test(s.title))).toBe(false);
  });

  it('pulls Run failure out of the product brief into collapsible sections', () => {
    // Case study: orbit onboarding — historical crashes must not sit in Task brief.
    const body = `
## Task
Make orbit ready.

## Definition of Done
- [ ] (human) Mark ready

## Run failure (t1)
**Kind:** \`agent_exit\`

## Salvage brief
Reached max attempts.

## Review packet
**✅ automated proof complete**

**Definition of Done**
| Axis | Status |
|---|---|
| mechanical | ✅ pass |
`;
    const { brief, sections } = splitTaskBody(body);
    expect(brief).toMatch(/Make orbit ready/);
    expect(brief).not.toMatch(/agent_exit/);
    expect(brief).not.toMatch(/Run failure/);
    const titles = sections.map((s) => s.title.toLowerCase());
    expect(titles.some((t) => t.startsWith('run failure'))).toBe(true);
    expect(titles.some((t) => t.includes('definition of done'))).toBe(true);
  });

  it('collapses historical Run failure when a Review packet exists', () => {
    const fail = {
      key: 's0',
      title: 'Run failure (2026-07-15)',
      text: '**Kind:** `stall`',
      kind: 'harness' as const,
    };
    expect(sectionDefaultOpen(fail)).toBe(true);
    expect(sectionDefaultOpen(fail, { hasReviewPacket: true })).toBe(false);
    expect(sectionDefaultOpen(fail, { hasReviewPacket: false })).toBe(true);
  });

  it('partitions prior audit after a green packet; live DoD stays first', () => {
    const body = `
## Task
x

## Run failure (old)
**Kind:** \`agent_exit\`

## Auto-rework
old rework

## Review packet
**✅ automated proof complete**

**Definition of Done**
| Axis | Status |
| mechanical | ✅ |
`;
    const { sections } = splitTaskBody(body);
    const { live, prior } = partitionSectionsForDisplay(sections, {
      hasReviewPacket: true,
      hasSuccessfulPacket: true,
    });
    expect(prior.some((s) => /run failure/i.test(s.title))).toBe(true);
    expect(prior.some((s) => /auto-rework/i.test(s.title))).toBe(true);
    expect(live.some((s) => /definition of done/i.test(s.title))).toBe(true);
    expect(live.some((s) => /run failure/i.test(s.title))).toBe(false);
  });

  it('only opens the latest steer pair when many exist', () => {
    const s0 = {
      key: 'a',
      title: 'Human steer (t0)',
      text: 'q0',
      kind: 'meta' as const,
    };
    const s1 = {
      key: 'b',
      title: 'Steer result (t0)',
      text: 'a0',
      kind: 'meta' as const,
    };
    const s2 = {
      key: 'c',
      title: 'Human steer (t1)',
      text: 'q1',
      kind: 'meta' as const,
    };
    const s3 = {
      key: 'd',
      title: 'Steer result (t1)',
      text: 'a1',
      kind: 'meta' as const,
    };
    expect(sectionDefaultOpen(s0, { steerIndex: 0, steerCount: 4 })).toBe(false);
    expect(sectionDefaultOpen(s1, { steerIndex: 1, steerCount: 4 })).toBe(false);
    expect(sectionDefaultOpen(s2, { steerIndex: 2, steerCount: 4 })).toBe(true);
    expect(sectionDefaultOpen(s3, { steerIndex: 3, steerCount: 4 })).toBe(true);
  });
});

describe('packetStatusChip', () => {
  it('detects automated proof complete', () => {
    const chip = packetStatusChip(SAMPLE);
    expect(chip?.label).toMatch(/Auto OK/i);
  });

  it('ignores historical Auto-rework when latest packet is green', () => {
    // Case study: task body keeps old ## Auto-rework after a successful re-run.
    const body = `
## Auto-rework
Independent verification failed

## Review packet
**✅ automated proof complete** (human Approve still required)

**Definition of Done**
ok
`;
    expect(packetStatusChip(body)?.label).toMatch(/Auto OK/i);
    expect(packetStatusChip(body)?.tone).toBe('success');
    expect(bodyHasSuccessfulPacket(body)).toBe(true);
  });

  it('thrashBrakeStillActive clears after a later green proof in the trail', () => {
    const thrashOnly = `
## Review packet
**🔄 auto-rework**

## Thrash brake (pr-mergeable) (t1)
Stopped auto re-queue
`;
    expect(thrashBrakeStillActive(thrashOnly)).toBe(true);

    const thrashThenGreen = `
## Thrash brake (pr-mergeable) (t1)
Stopped

## Review packet
**✅ automated proof complete**
`;
    expect(thrashBrakeStillActive(thrashThenGreen)).toBe(false);
  });

  it('latestReviewPacketSlice is the last packet only', () => {
    const body = `
## Review packet
**🔄 auto-rework** old

## Review packet
**✅ automated proof complete** new
`;
    const slice = latestReviewPacketSlice(body);
    expect(slice).toMatch(/automated proof complete/);
    expect(slice).not.toMatch(/auto-rework/);
  });

  it('distinguishes auto-rework steer vs full in the status chip', () => {
    const steer = packetStatusChip(
      '## Review packet\n**🔄 auto-rework (steer)** — cheap session resume will be queued',
    );
    expect(steer?.label).toMatch(/steer/i);
    expect(steer?.tone).toBe('warn');

    const full = packetStatusChip(
      '## Review packet\n**🔄 auto-rework (full)** — full implementer re-dispatch will be queued',
    );
    expect(full?.label).toMatch(/full/i);
    expect(full?.tone).toBe('danger');
  });
});

describe('packetCostChip', () => {
  it('labels steer cost distinctly', () => {
    const chip = packetCostChip(SAMPLE);
    expect(chip?.kind).toBe('steer');
    expect(chip?.label).toMatch(/Steer/i);
    expect(chip?.amount).toBe('0.02');
    expect(chip?.tone).toBe('steer');
  });

  it('labels full implementer cost', () => {
    const body = `
## Review packet
**Cost (full implementer)**
💰 **Full run** $1.20 · 12.0k in / 3.4k out
`;
    const chip = packetCostChip(body);
    expect(chip?.kind).toBe('implementer');
    expect(chip?.label).toMatch(/Full run \$1\.20/);
    expect(chip?.tone).toBe('full');
  });

  it('reads Cost after ## 决策摘要 via the latest packet region', () => {
    const body = `
## Review packet
**✅ automated proof complete**

## 决策摘要
- **改动**:x

**Cost (full implementer)**
💰 **Full run** $0.42 · 1k in / 1k out
`;
    expect(packetCostChip(body)?.amount).toBe('0.42');
  });
});

describe('packetStatusChip No file changes (region)', () => {
  it('sees No file changes after ## 决策摘要 in the latest region', () => {
    const body = `
## Review packet
**✅ automated proof complete**

## 决策摘要
- **改动**:analysis

**ℹ️ No file changes.** Allowed for this run.
`;
    // Green status line wins over the soft no-diff banner when both present.
    expect(packetStatusChip(body)?.label).toMatch(/Auto OK/i);

    const noProof = `
## Review packet

## 决策摘要
- **改动**:analysis

**ℹ️ No file changes.** Allowed for this run.
`;
    expect(packetStatusChip(noProof)?.label).toMatch(/No file changes/i);
  });
});

describe('parseHumanCriteria', () => {
  it('extracts human (and untyped) ACs only', () => {
    const acs = parseHumanCriteria(SAMPLE);
    expect(acs.map((c) => c.text)).toEqual(['ready']);
  });

  it('parses ## Definition of Done (logout-style) before Review packet', () => {
    const body = `
## Task
Settings

## Definition of Done
- [ ] (mechanical) gates
- [ ] (human) 真机验收设置页体验

## Review packet
Verification failed: Cannot use simple-git on a directory that does not exist
`;
    const acs = parseHumanCriteria(body);
    expect(acs).toHaveLength(1);
    expect(acs[0]!.text).toMatch(/真机验收/);
  });
});

describe('areHumanCriteriaChecked (Approve UI gate)', () => {
  it('blocks Approve until every human AC checkbox is checked', async () => {
    const { areHumanCriteriaChecked, parseHumanCriteria: parse } = await import(
      '../../src/web/taskBodySplit.js'
    );
    const body = `
## Definition of Done
- [ ] (mechanical) gates
- [ ] (human) Device check
- [ ] (human) Ready in Repos
`;
    const acs = parse(body);
    expect(areHumanCriteriaChecked(body, {})).toBe(false);
    expect(areHumanCriteriaChecked(body, { [acs[0]!.id]: true })).toBe(false);
    expect(
      areHumanCriteriaChecked(body, { [acs[0]!.id]: true, [acs[1]!.id]: true }),
    ).toBe(true);
  });

  it('allows Approve when there are no human ACs', async () => {
    const { areHumanCriteriaChecked } = await import('../../src/web/taskBodySplit.js');
    const body = `
## Definition of Done
- [ ] (mechanical) gates only
`;
    expect(areHumanCriteriaChecked(body, {})).toBe(true);
  });
});

describe('packetStatusChip verify crash', () => {
  it('flags verification infrastructure failure', async () => {
    const { packetStatusChip: chip, isVerificationInfraFailure } = await import(
      '../../src/web/taskBodySplit.js'
    );
    const body =
      '## Review packet\n\nVerification failed: Cannot use simple-git on a directory that does not exist\n';
    expect(isVerificationInfraFailure(body)).toBe(true);
    expect(chip(body)?.label).toMatch(/Verify crashed|crash/i);
    expect(chip(body)?.tone).toBe('danger');
  });
});

describe('anti-cheat section (L3 owns L5 — human is not the queue)', () => {
  it('mutes L3-cleared summary', () => {
    const text =
      `- ✅ Independent L3 scrutinized 0 critical + 6 review-only flag(s) · **approved** — ` +
      `see L3 summary\n` +
      `- _test-edit ×6 (normal when shipping feature tests; L3 owns this)_`;
    expect(antiCheatSectionTone(text)).toBe('muted');
    expect(antiCheatBadge(text)).toMatch(/L3/i);
  });

  it('soft test-edit alone is muted (→ L3), not human-urgent', () => {
    const text =
      `- ℹ️ test-edit ×6 — L3 will scrutinize when review runs (usual with feature tests; **not** a human code-review queue)`;
    expect(antiCheatSectionTone(text)).toBe('muted');
    expect(antiCheatBadge(text)).toMatch(/L3/i);
  });

  it('unresolved critical stays danger for implementer/L3 path', () => {
    const text = `- 🚨 eslint-disable in \`src/x.ts:3\` — disables a lint rule`;
    expect(antiCheatSectionTone(text)).toBe('danger');
    expect(antiCheatBadge(text)).toMatch(/crit|L3/i);
  });

  it('never auto-opens anti-cheat (L3/rework queue, not human scan)', () => {
    const soft = {
      key: 's1',
      title: 'Anti-cheating (L5 → L3)',
      text: '- ✅ Independent L3 scrutinized 0 critical + 6 review-only flag(s) · **approved**',
      kind: 'evidence' as const,
    };
    const hard = {
      key: 's2',
      title: 'Anti-cheating flags',
      text: '- 🚨 as-any in `src/a.ts:1` — blanket `as any` cast',
      kind: 'evidence' as const,
    };
    expect(sectionDefaultOpen(soft)).toBe(false);
    expect(sectionDefaultOpen(hard)).toBe(false);
  });
});

describe('run brief markdown rendering', () => {
  it('TaskDetail renders the run-purpose summary as markdown, not raw text', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const src = await readFile(join(root, 'src/web/TaskDetail.tsx'), 'utf8');
    // Raw **bold** / `code` in "What this run is for" (2026-07-18 report).
    expect(src).not.toMatch(/<pre className="run-brief-text">/);
    expect(src).toMatch(/run-brief-text[\s\S]{0,120}<Markdown text=\{extractTaskSummary\(task\.body\)\}/);
  });
});
