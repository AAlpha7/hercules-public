import { describe, it, expect } from 'vitest';
import {
  findProtectedPathMentions,
  formatProtectedPathBlockMessage,
  globToRegExp,
  hasForceProtectedPath,
  matchesProtectedPath,
  stampForceProtectedPath,
  FORCE_PROTECTED_PATH_LABEL,
} from '../../src/domain/protectedPaths.js';
import { scanDiff } from '../../src/verification/antiCheat.js';

const PROTECTED = [
  'test/invariants/**',
  'scripts/deploy-staging.sh',
  'scripts/deploy-production.sh',
  'core/tests/structural_guards.rs',
] as const;

describe('matchesProtectedPath / globToRegExp — shared with L5', () => {
  it('matches ** globs the same way L5 scanDiff does', () => {
    expect(matchesProtectedPath('test/invariants/agent-map.test.ts', PROTECTED)).toBe(true);
    expect(matchesProtectedPath('test/smoke/core.test.ts', PROTECTED)).toBe(false);
    expect(matchesProtectedPath('scripts/deploy-staging.sh', PROTECTED)).toBe(true);
    expect(matchesProtectedPath('scripts/other.sh', PROTECTED)).toBe(false);
  });

  it('is consistent with scanDiff protected-path findings on the same paths', () => {
    const file = 'test/invariants/no-silencing.test.ts';
    const diff = `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1,1 +1,1 @@
-expect(x).toBe(1);
+expect(x).toBe(2);
`;
    const l5 = scanDiff(diff, { protectedPaths: [...PROTECTED] });
    expect(l5.some((f) => f.kind === 'protected-path' && f.file === file)).toBe(true);
    expect(matchesProtectedPath(file, PROTECTED)).toBe(true);

    const ordinary = 'src/domain/task.ts';
    const okDiff = `diff --git a/${ordinary} b/${ordinary}
--- a/${ordinary}
+++ b/${ordinary}
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;
    expect(scanDiff(okDiff, { protectedPaths: [...PROTECTED] })).toEqual([]);
    expect(matchesProtectedPath(ordinary, PROTECTED)).toBe(false);
  });

  it('anchors full path (no accidental substring hits)', () => {
    // `test/invariants/**` must not match a different tree that only shares a suffix.
    expect(globToRegExp('test/invariants/**').test('other/test/invariants/x.ts')).toBe(false);
    expect(matchesProtectedPath('other/test/invariants/x.ts', ['test/invariants/**'])).toBe(
      false,
    );
  });
});

describe('findProtectedPathMentions — hit / miss / explicit-only', () => {
  it('hits: backtick path under a protected glob (orbit structural_guards case)', () => {
    const body = `
## Task
Update the constant in \`core/tests/structural_guards.rs\` so the guard count matches.

## Acceptance criteria
- [ ] (mechanical) constant reconciled
`;
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([
      'core/tests/structural_guards.rs',
    ]);
  });

  it('hits: free path-like token with extension (no backticks)', () => {
    const body = 'Please edit scripts/deploy-staging.sh to add a health probe.';
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual(['scripts/deploy-staging.sh']);
  });

  it('hits: file under protected ** glob named in backticks (modification request)', () => {
    const body = 'Update the count in `test/invariants/agent-map.test.ts`.';
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([
      'test/invariants/agent-map.test.ts',
    ]);
  });

  it('miss: ordinary source path not protected', () => {
    const body = 'Fix retry logic in `src/orchestrator/actions.ts`.';
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([]);
  });

  it('miss: bare filename without directory (zero-FP bias)', () => {
    const body = 'Update `package.json` and `README.md`.';
    expect(findProtectedPathMentions(body, ['package.json', 'README.md'])).toEqual([]);
  });

  it('miss: URL or absolute path is not a repo-relative mention', () => {
    const body =
      'See https://example.com/test/invariants/foo and /abs/scripts/deploy-staging.sh';
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([]);
  });

  it('miss: prose about "protected paths" without naming a file', () => {
    const body = 'Respect protected_paths; do not edit held-out smoke.';
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([]);
  });

  it('miss: empty protected list or empty body', () => {
    expect(findProtectedPathMentions('`scripts/deploy-staging.sh`', [])).toEqual([]);
    expect(findProtectedPathMentions('', PROTECTED)).toEqual([]);
  });

  it('dedupes repeated mentions', () => {
    const body =
      'Edit `scripts/deploy-staging.sh` then re-check scripts/deploy-staging.sh again.';
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual(['scripts/deploy-staging.sh']);
  });
});

describe('findProtectedPathMentions — negation / prohibitive context', () => {
  it('blocks: modification request ("更新 X 的常数")', () => {
    const body = '更新 `core/tests/structural_guards.rs` 的常数，使守卫计数一致。';
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([
      'core/tests/structural_guards.rs',
    ]);
  });

  it('allows: prohibitive mention ("不得修改 X")', () => {
    const body = '不得修改 `core/tests/structural_guards.rs`，如实报告即可。';
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([]);
  });

  it('allows: English do-not / must-not / never / forbidden near path', () => {
    expect(
      findProtectedPathMentions(
        'Do not weaken `test/invariants/agent-map.test.ts`.',
        PROTECTED,
      ),
    ).toEqual([]);
    expect(
      findProtectedPathMentions(
        'You must not edit `scripts/deploy-staging.sh`.',
        PROTECTED,
      ),
    ).toEqual([]);
    expect(
      findProtectedPathMentions(
        'Never touch `scripts/deploy-production.sh` in this task.',
        PROTECTED,
      ),
    ).toEqual([]);
    expect(
      findProtectedPathMentions(
        'Edits to `scripts/deploy-staging.sh` are forbidden.',
        PROTECTED,
      ),
    ).toEqual([]);
  });

  it('allows: Chinese prohibit patterns (禁止 / 不许 / 不是改 / 不要动 / 勿 / 绝不 / 不动)', () => {
    expect(
      findProtectedPathMentions('禁止改动 `scripts/deploy-staging.sh`。', PROTECTED),
    ).toEqual([]);
    expect(
      findProtectedPathMentions('不许改 `scripts/deploy-staging.sh`。', PROTECTED),
    ).toEqual([]);
    expect(
      findProtectedPathMentions(
        '如实报告而不是改 `core/tests/structural_guards.rs` 守卫。',
        PROTECTED,
      ),
    ).toEqual([]);
    expect(
      findProtectedPathMentions('不要动 `scripts/deploy-production.sh`。', PROTECTED),
    ).toEqual([]);
    expect(
      findProtectedPathMentions('勿编辑 `test/invariants/agent-map.test.ts`。', PROTECTED),
    ).toEqual([]);
    expect(
      findProtectedPathMentions('绝不改写 `scripts/deploy-staging.sh`。', PROTECTED),
    ).toEqual([]);
    expect(
      findProtectedPathMentions('`scripts/deploy-staging.sh` 不动。', PROTECTED),
    ).toEqual([]);
  });

  it('blocks: same body forbids then requires same path (nearest context each)', () => {
    // First occurrence is prohibitive; second is a clear modification request.
    // Each mention is judged by its local window — the require wins → still block.
    const body = `
不得修改 \`scripts/deploy-staging.sh\`。
更新 \`scripts/deploy-staging.sh\` 的常数。
`;
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual(['scripts/deploy-staging.sh']);
  });

  it('allows: only prohibitive mentions of a path (no modification request)', () => {
    const body = `
## 红线
- 如实报告而不是改 \`core/tests/structural_guards.rs\`
- 不得修改 \`scripts/deploy-staging.sh\`
`;
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([]);
  });

  it('blocks: mixed paths — only non-prohibitive path is returned', () => {
    const body = `
不得修改 \`scripts/deploy-staging.sh\`。
请更新 \`core/tests/structural_guards.rs\` 的常数。
`;
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([
      'core/tests/structural_guards.rs',
    ]);
  });

  it('allows: multi-path forbid shares negation (filename dots are not sentence ends)', () => {
    // Production-shaped: one prohibit cue covers several backtick paths.
    // Regression: treating `.` in `…staging.sh` as a sentence boundary clipped
    // the window so the 2nd path lost 不得修改 and false-blocked.
    const body =
      '不得修改 `core/tests/structural_guards.rs` 与 `scripts/deploy-staging.sh`。';
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([]);
    const body2 =
      '不得修改 `scripts/deploy-staging.sh`、`scripts/deploy-production.sh` 与 `core/tests/structural_guards.rs`';
    expect(findProtectedPathMentions(body2, PROTECTED)).toEqual([]);
  });
});

describe('findProtectedPathMentions — product brief only (Req 0)', () => {
  it('miss: path literals only under ## Review packet / failure log', () => {
    // Second production false positive: old packet / park notes re-named paths
    // after a prior run and re-parked a task whose product brief never asked
    // to edit them.
    const body = `
## Goal
Wire L2 evidence hooks; do not touch deploy scripts.

## Definition of Done
- [ ] (mechanical) gates green

## Review packet

### some-task — branch
Diff mentioned \`test/invariants/agent-map.test.ts\` and scripts/deploy-staging.sh
in the failure log and agent report.

## Protected path (pre-dispatch)

该任务要求修改保护路径 \`test/invariants/agent-map.test.ts\`, \`scripts/deploy-staging.sh\` — 此类改动只能由人类完成
`;
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([]);
  });

  it('allows: prohibitive product brief + packet path noise still no hit', () => {
    // v2-shaped: red-line forbids the guard file; packet history re-lists it.
    const body = `
## Goal
L2 evidence wiring from current main.

## 红线
- 若结构守卫套件因 main 自身状态失败, 如实报告而不是改 \`core/tests/structural_guards.rs\` 守卫。
- 不得修改 \`scripts/deploy-staging.sh\`

## Definition of Done
- [ ] (mechanical) held-out green

## Review packet

**Anti-cheating (L5)**
- protected-path candidate: \`core/tests/structural_guards.rs\`
- also saw scripts/deploy-production.sh in a prior attempt log

## Protected path (pre-dispatch)

该任务要求修改保护路径 \`core/tests/structural_guards.rs\` — 此类改动只能由人类完成
`;
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([]);
  });

  it('blocks: product-brief edit request still hits even when packet also names it', () => {
    const body = `
## Task
Update the constant in \`core/tests/structural_guards.rs\`.

## Review packet
Also listed \`core/tests/structural_guards.rs\` in the diff summary.
`;
    expect(findProtectedPathMentions(body, PROTECTED)).toEqual([
      'core/tests/structural_guards.rs',
    ]);
  });
});

describe('format / force audit helpers', () => {
  it('formats a clear Chinese block message', () => {
    const msg = formatProtectedPathBlockMessage(['scripts/deploy-staging.sh']);
    expect(msg).toContain('`scripts/deploy-staging.sh`');
    expect(msg).toMatch(/保护路径/);
    expect(msg).toMatch(/只能由人类完成/);
  });

  it('force stamp + hasForceProtectedPath round-trip', () => {
    const stamped = stampForceProtectedPath(
      'body',
      ['scripts/deploy-staging.sh'],
      '2026-07-30T00:00:00.000Z',
    );
    expect(hasForceProtectedPath({ labels: [], body: stamped })).toBe(true);
    expect(
      hasForceProtectedPath({ labels: [FORCE_PROTECTED_PATH_LABEL], body: 'plain' }),
    ).toBe(true);
    expect(hasForceProtectedPath({ labels: [], body: 'plain' })).toBe(false);
  });
});
