/**
 * Domain layer — gate-fail attribution (pure).
 *
 * When an L1 `test` / `held-out-smoke` gate fails, Hercules can re-run the same
 * failed item on a clean merge-base checkout (no branch delta). If the failure
 * reproduces on pure main, it is a **trunk-inherited** problem — not the task's
 * fault: packet explains, DoD mechanical axis is skipped, no auto-rework, no
 * attempt burn. If it does not reproduce, existing rework behavior is unchanged.
 *
 * Case study (2026-07-30): orbit main broke a structural guard; a task that
 * never touched tool code inherited the red held-out suite and burned 3 attempts.
 *
 * Pure: no IO / git / fs. Checkout + re-run live in verification/isolation.
 */

/** Only these gate names may be attributed (setup/build/typecheck/lint excluded). */
export const ATTRIBUTABLE_GATE_NAMES: ReadonlySet<string> = new Set([
  'test',
  'held-out-smoke',
]);

export function isAttributableGate(name: string): boolean {
  return ATTRIBUTABLE_GATE_NAMES.has(name);
}

/** Max failed tests to re-run on merge-base (cost cap). */
export const MAX_ATTRIBUTION_TESTS = 5;

/**
 * Stable cache key for (repo, merge-base, test) — avoids re-paying for the same
 * merge-base reproduction probe.
 */
export function attributionCacheKey(
  repoKey: string,
  mergeBase: string,
  testId: string,
): string {
  const repo = repoKey.trim().toLowerCase();
  const mb = mergeBase.trim().toLowerCase();
  const test = testId.trim();
  return `${repo}|${mb}|${test}`;
}

/**
 * Extract failed test identifiers from gate output.
 * Supports cargo (`failures:` blocks), vitest FAIL lines, and jest ● lines.
 * Order preserved; deduped; capped at {@link MAX_ATTRIBUTION_TESTS}.
 */
export function extractFailedTestIds(output: string): string[] {
  const lines = output.split('\n').map((l) => l.trimEnd());
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string): void => {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) return;
    // Reject obvious noise / progress.
    if (/^running \d+ tests?$/i.test(id)) return;
    if (/^test result:/i.test(id)) return;
    seen.add(id);
    found.push(id);
  };

  // 1. Cargo: last `failures:` block with bare test paths (most reliable).
  let cargoNames: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() !== 'failures:') continue;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trim();
      if (t.length === 0) break;
      if (!/^[A-Za-z0-9_:][A-Za-z0-9_:]*$/.test(t)) break;
      block.push(t);
    }
    if (block.length > 0) cargoNames = block;
  }
  for (const n of cargoNames) push(n);

  // 2. Vitest / Playwright-style: "FAIL  path > suite > name" or "× suite > name"
  for (const line of lines) {
    const fail = /^\s*(?:FAIL|×|x)\s+(.+?)\s*$/i.exec(line);
    if (fail?.[1]) {
      // Drop duration suffixes like " 12ms"
      const body = fail[1].replace(/\s+\d+(?:\.\d+)?m?s\s*$/i, '').trim();
      // Prefer the leaf test name after the last " > " when a file path is present.
      push(body);
    }
  }

  // 3. Jest: "● suite › name" / "● name"
  for (const line of lines) {
    const m = /^\s*●\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) push(m[1].replace(/\s+\d+(?:\.\d+)?m?s\s*$/i, '').trim());
  }

  // 4. Generic "test path::name ... FAILED" (cargo verbose)
  for (const line of lines) {
    const m = /^test\s+(\S+)\s+\.\.\.\s+FAILED\b/i.exec(line.trim());
    if (m?.[1]) push(m[1]);
  }

  return found.slice(0, MAX_ATTRIBUTION_TESTS);
}

/**
 * Build a minimal re-run command that targets only the failed tests.
 * Returns null when the runner is unknown and we refuse a full-suite re-run
 * (cost control — attribution must not become a second full L1).
 */
export function buildMinimalRerunCommand(
  originalCommand: string,
  failedTests: readonly string[],
): string | null {
  const tests = failedTests.map((t) => t.trim()).filter((t) => t.length > 0);
  if (tests.length === 0) return null;
  const cmd = originalCommand.trim();
  if (cmd.length === 0) return null;

  // Vitest (incl. held_out_smoke: `pnpm exec vitest run …`)
  if (/\bvitest\b/.test(cmd)) {
    const pattern = tests.map(escapeVitestFilter).join('|');
    // Avoid double -t.
    const stripped = cmd.replace(/\s+-t(?:estNamePattern)?(?:=|\s+)\S+/g, '').trim();
    return `${stripped} -t ${shellSingleQuote(pattern)}`;
  }

  // Cargo test
  if (/\bcargo\s+test\b/.test(cmd) || /^cargo\s+test\b/.test(cmd)) {
    if (tests.length === 1) {
      // Exact name when possible — cheapest single binary filter.
      const name = tests[0]!;
      // Insert filter after `cargo test` and before existing args when simple.
      return appendCargoFilter(cmd, name, /* exact */ true);
    }
    // Multiple: OR regex filter (cargo treats filter as substring / regex).
    const pattern = tests.map(escapeCargoFilter).join('|');
    return appendCargoFilter(cmd, pattern, /* exact */ false);
  }

  // pnpm/npm/yarn test without explicit vitest — try vitest name filter.
  // Hercules and many TS repos map `pnpm test` → vitest; full suite re-run is
  // forbidden here so we only emit a targeted vitest invocation.
  if (/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?test\b/.test(cmd) || /\bpnpm\s+test\b/.test(cmd)) {
    const pattern = tests.map(escapeVitestFilter).join('|');
    return `pnpm exec vitest run -t ${shellSingleQuote(pattern)}`;
  }

  return null;
}

function escapeVitestFilter(name: string): string {
  // vitest -t is a regex; escape meta chars so leaf names match literally.
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeCargoFilter(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellSingleQuote(s: string): string {
  // Safe single-quoted shell string.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appendCargoFilter(cmd: string, filter: string, exact: boolean): string {
  // If command already has `--`, append filter flags after it carefully.
  const exactBit = exact ? ' -- --exact' : '';
  // Prefer: `cargo test [opts] FILTER [-- --exact]`
  // Strip a trailing bare `--` then re-add with exact if needed.
  const base = cmd.replace(/\s+--\s*$/, '').trim();
  // Avoid injecting into an already-filtered command with a second filter
  // that cargo would treat as a binary name — replace is hard; append is fine
  // when the original is typically `cargo test --workspace` etc.
  if (exact) {
    // `cargo test FILTER -- --exact` — put filter before any existing `--`.
    if (/\s--\s/.test(base)) {
      // cargo test --workspace -- --test-threads=1  → insert filter before --
      return base.replace(/\s--\s/, ` ${filter} -- `) + (exact ? ' --exact' : '');
    }
    return `${base} ${filter}${exactBit}`;
  }
  if (/\s--\s/.test(base)) {
    return base.replace(/\s--\s/, ` ${filter} -- `);
  }
  return `${base} ${filter}`;
}

/**
 * Heuristic path fragments implied by a test id (for "branch did not touch
 * related files" evidence). Pure — never claims ownership, only hints.
 */
export function relatedPathHints(testIds: readonly string[]): string[] {
  const hints = new Set<string>();
  for (const id of testIds) {
    // Cargo: module::tests::name → module path segments
    if (id.includes('::')) {
      const parts = id.split('::').filter((p) => p.length > 0 && p !== 'tests' && p !== 'test');
      // Drop the leaf test function name (last segment).
      const mods = parts.slice(0, -1);
      for (const m of mods) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(m)) hints.add(m);
      }
      if (mods.length > 0) {
        hints.add(mods.join('/'));
      }
      continue;
    }
    // Vitest FAIL "test/foo.test.ts > suite > name"
    const filePart = id.split(/\s*>\s*/)[0]?.trim() ?? '';
    if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePart) || filePart.includes('/')) {
      hints.add(filePart.replace(/\\/g, '/'));
      // Parent dirs / basenames without extension.
      const segs = filePart.replace(/\\/g, '/').split('/');
      for (const s of segs) {
        if (s.length > 0 && s !== '.' && !/\.(?:ts|tsx|js|jsx)$/.test(s)) hints.add(s);
      }
      const base = segs[segs.length - 1]?.replace(/\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/i, '');
      if (base) hints.add(base);
    }
  }
  return [...hints];
}

/**
 * Which of `filesTouched` match any related path hint (substring, case-sensitive
 * path segment). Empty → branch did not touch related paths (stronger trunk claim).
 */
export function filesTouchingRelated(
  filesTouched: readonly string[],
  relatedHints: readonly string[],
): string[] {
  if (relatedHints.length === 0) return [];
  const out: string[] = [];
  for (const f of filesTouched) {
    const norm = f.replace(/\\/g, '/');
    for (const h of relatedHints) {
      if (h.length === 0) continue;
      if (norm === h || norm.includes(h) || h.includes(norm)) {
        out.push(f);
        break;
      }
    }
  }
  return out;
}

/** Per-test reproduction result on merge-base. */
export type BaseTestResult = {
  readonly testId: string;
  /** true = still failed on merge-base (reproduced). */
  readonly failedOnBase: boolean;
  /** true when answer came from cache (no re-run). */
  readonly fromCache: boolean;
};

export type GateFailAttributionOutcome =
  | 'trunk_inherited'
  | 'branch_introduced'
  | 'inconclusive';

/**
 * Structured attribution report attached to the review packet.
 */
export interface GateFailAttributionReport {
  readonly gateName: string;
  readonly originalCommand: string;
  readonly mergeBase: string;
  readonly failedTests: readonly string[];
  readonly baseResults: readonly BaseTestResult[];
  readonly outcome: GateFailAttributionOutcome;
  /** Tests that also fail on merge-base. */
  readonly reproducedTests: readonly string[];
  /** Tests that pass on merge-base (branch introduced / env fluke). */
  readonly novelTests: readonly string[];
  readonly cacheHits: readonly string[];
  /** Path hints derived from test ids. */
  readonly relatedHints: readonly string[];
  /** filesTouched that match relatedHints (anti-gaming evidence). */
  readonly relatedTouched: readonly string[];
  /** filesTouched that do NOT match (shown as "branch did not touch …"). */
  readonly relatedUntouchedEvidence: readonly string[];
  readonly rerunCommand: string | null;
  readonly note: string;
}

export interface ClassifyGateFailAttributionInput {
  readonly gateName: string;
  readonly originalCommand: string;
  readonly mergeBase: string;
  readonly failedTests: readonly string[];
  readonly baseResults: readonly BaseTestResult[];
  readonly filesTouched: readonly string[];
  readonly rerunCommand: string | null;
  /**
   * When true, the probe could not run (no merge-base, checkout failed, etc.).
   * Forces inconclusive — never pretend trunk inheritance.
   */
  readonly probeFailed?: boolean;
  readonly probeError?: string;
}

/**
 * Pure classifier: all failed tests reproduced on merge-base → trunk_inherited;
 * any novel failure → branch_introduced; no tests / probe fail → inconclusive.
 */
export function classifyGateFailAttribution(
  input: ClassifyGateFailAttributionInput,
): GateFailAttributionReport {
  const failedTests = [...input.failedTests];
  const hints = relatedPathHints(failedTests);
  const relatedTouched = filesTouchingRelated(input.filesTouched, hints);
  const cacheHits = input.baseResults.filter((r) => r.fromCache).map((r) => r.testId);
  const reproducedTests = input.baseResults
    .filter((r) => r.failedOnBase)
    .map((r) => r.testId);
  const novelTests = input.baseResults
    .filter((r) => !r.failedOnBase)
    .map((r) => r.testId);

  let outcome: GateFailAttributionOutcome = 'inconclusive';
  let note: string;

  if (input.probeFailed === true) {
    outcome = 'inconclusive';
    note = input.probeError?.trim() || 'merge-base probe failed';
  } else if (failedTests.length === 0 || input.baseResults.length === 0) {
    outcome = 'inconclusive';
    note = 'could not extract failed test names for minimal re-run';
  } else if (novelTests.length === 0 && reproducedTests.length > 0) {
    outcome = 'trunk_inherited';
    note = formatTrunkNote(input.mergeBase, reproducedTests, relatedTouched, input.filesTouched);
  } else if (novelTests.length > 0) {
    outcome = 'branch_introduced';
    note =
      `failure does not fully reproduce on merge-base ` +
      `\`${shortSha(input.mergeBase)}\` — novel: ${novelTests.join(', ')}` +
      (reproducedTests.length > 0
        ? ` (also on main: ${reproducedTests.join(', ')})`
        : '');
  } else {
    outcome = 'inconclusive';
    note = 'no base results';
  }

  // Untouched evidence: list path hints not matched by any filesTouched.
  const relatedUntouchedEvidence = hints.filter(
    (h) => !relatedTouched.some((f) => f.includes(h) || h.includes(f.replace(/\\/g, '/'))),
  );

  return {
    gateName: input.gateName,
    originalCommand: input.originalCommand,
    mergeBase: input.mergeBase,
    failedTests,
    baseResults: input.baseResults,
    outcome,
    reproducedTests,
    novelTests,
    cacheHits,
    relatedHints: hints,
    relatedTouched,
    relatedUntouchedEvidence,
    rerunCommand: input.rerunCommand,
    note,
  };
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function formatTrunkNote(
  mergeBase: string,
  reproduced: readonly string[],
  relatedTouched: readonly string[],
  filesTouched: readonly string[],
): string {
  const mb = shortSha(mergeBase);
  const tests = reproduced.slice(0, 3).join(', ');
  const more = reproduced.length > 3 ? ` +${reproduced.length - 3} more` : '';
  const touchBit =
    relatedTouched.length === 0
      ? `分支未触碰相关路径 (filesTouched=${filesTouched.length})`
      : `分支也改了相关文件: ${relatedTouched.slice(0, 5).join(', ')}` +
        (relatedTouched.length > 5 ? '…' : '') +
        ' — 但失败在纯 main 上同样复现, 非本任务单独引入';
  return (
    `该失败在 main (merge-base ${mb}) 上同样存在 — 属主干既有问题, 非本任务引入` +
    ` [${tests}${more}]; ${touchBit}`
  );
}

/** True when packet policy should skip auto-rework for this gate failure. */
export function isTrunkInherited(report: GateFailAttributionReport | null | undefined): boolean {
  return report?.outcome === 'trunk_inherited';
}

/**
 * Named probes the next L1 auto-rework / full re-dispatch MUST close first.
 * Empty for trunk-inherited (no auto-rework) or when attribution has no test
 * identity — avoids bloating unrelated fails.
 *
 * Dogfood (task-7): agents chased older syntax narratives while the final fail
 * stayed on a named novel probe (e.g. appSplit line budget).
 */
export function attributedReworkProbes(
  report: GateFailAttributionReport | null | undefined,
): readonly string[] {
  if (!report || report.outcome === 'trunk_inherited') return [];
  if (report.outcome === 'branch_introduced' && report.novelTests.length > 0) {
    return report.novelTests;
  }
  // branch_introduced without novel (defensive) or inconclusive with names
  if (report.failedTests.length > 0) return report.failedTests;
  return [];
}

/**
 * Hard rework requirement lines for review packet / auto-rework body.
 * Pure — callers join with newlines. Empty when no named probe to force.
 */
export function formatAttributedGateReworkRequirement(
  report: GateFailAttributionReport | null | undefined,
): string[] {
  if (!report) return [];
  const probes = attributedReworkProbes(report);
  if (probes.length === 0) return [];

  const lines: string[] = [
    '**MUST fix attributed L1 probe first** (close this before older narrative / syntax rabbit-holes):',
  ];
  for (const p of probes) {
    lines.push('- `' + p + '`');
  }
  if (report.rerunCommand) {
    lines.push('- Exact command: `' + report.rerunCommand + '`');
  } else {
    lines.push('- Re-run the failing L1 test gate until this probe is green.');
  }
  lines.push(
    '_Full re-dispatch is fail-closed on this probe: do not declare done while it still fails._',
  );
  return lines;
}

/**
 * Packet markdown lines (Chinese primary, matches other CEO surfaces).
 * Pure — callers join with newlines.
 */
export function formatGateFailAttributionMarkdown(
  report: GateFailAttributionReport,
): string[] {
  const body = formatGateFailAttributionMarkdownBody(report);
  const hard = formatAttributedGateReworkRequirement(report);
  if (hard.length === 0) return body;
  return [...body, ...hard];
}

function formatGateFailAttributionMarkdownBody(
  report: GateFailAttributionReport,
): string[] {
  const lines: string[] = [];
  lines.push('**Gate-fail attribution**');
  const mb = shortSha(report.mergeBase);
  if (report.outcome === 'trunk_inherited') {
    lines.push(
      `⚠ 该失败在 main (merge-base \`${mb}\`) 上同样存在 — 属主干既有问题, 非本任务引入`,
    );
    lines.push(
      `_Gate \`${report.gateName}\` · tests: ${report.reproducedTests.join(', ') || '(all)'}_`,
    );
    if (report.relatedUntouchedEvidence.length > 0) {
      lines.push(
        `_分支未触碰相关路径线索: ${report.relatedUntouchedEvidence.slice(0, 8).join(', ')}` +
          (report.relatedUntouchedEvidence.length > 8 ? '…' : '') +
          `_`,
      );
    }
    if (report.relatedTouched.length > 0) {
      lines.push(
        `_相关路径有改动但仍在 main 复现: ${report.relatedTouched.slice(0, 8).join(', ')}_`,
      );
    }
    if (report.cacheHits.length > 0) {
      lines.push(`_cache hit: ${report.cacheHits.length} test(s)_`);
    }
    lines.push('_DoD 机械轴该项记 skipped · 不 auto-rework · 请先修主干_');
  } else if (report.outcome === 'branch_introduced') {
    lines.push(
      `ℹ️ merge-base \`${mb}\` 上**未**完整复现 — 按任务引入失败处理 (现有返工逻辑)`,
    );
    if (report.novelTests.length > 0) {
      lines.push(`_Novel on branch: ${report.novelTests.join(', ')}_`);
    }
  } else {
    lines.push(`ℹ️ 无法归因 (merge-base \`${mb || '?'}\`): ${report.note}`);
  }
  if (report.rerunCommand) {
    lines.push(`_probe: \`${report.rerunCommand}\`_`);
  }
  return lines;
}

/**
 * Marker string used by decision-inbox / body scan to flag trunk debt.
 * Keep stable — inbox matches this substring.
 */
export const TRUNK_INHERITED_MARKER =
  '属主干既有问题, 非本任务引入';

export function bodyHasTrunkInheritedGateFail(body: string): boolean {
  return body.includes(TRUNK_INHERITED_MARKER) || body.includes('trunk_inherited');
}
