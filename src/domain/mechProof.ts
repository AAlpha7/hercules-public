/**
 * Domain — mechanical criterion proof bindings (acceptance-binding grammar).
 *
 * A mechanical AC declares how it is proved via an explicit binding:
 *   @gate:test | @evidence:nav-settings | @test:path | @test:path#title | @probe:kind:ref
 *
 * Unbound criteria never pass — they stay pending with a suggested binding.
 */
import type { DimensionStatus } from './acceptance.js';

export type MechProofKind =
  | 'gate'
  | 'evidence'
  | 'test-path'
  | 'test-case'
  | 'probe'
  | 'unbound';

export interface MechProofBinding {
  readonly kind: MechProofKind;
  /** gate name | evidence anchor | test path | test path (for test-case) | probe ref */
  readonly ref: string;
  /** test-case only: the it()/test() title */
  readonly title?: string;
  /** probe only: the probe kind, e.g. 'http' | 'screenshot' | 'mail' */
  readonly probeKind?: string;
  readonly cleanText: string;
}

/** @gate: / @evidence: / @prove: — ref is a single token. */
const GATE_EVIDENCE_PROVE_RE = /\s+@(gate|evidence|prove)\s*:\s*([^\s@]+)\s*$/i;

/** @test:<path> or @test:<path>#<title> — title runs to end of line. */
const TEST_BINDING_RE = /\s+@test\s*:\s*([^\s@#]+)(?:#(.+))?\s*$/i;

/** @probe:<kind>:<ref> — ref is the rest of the line. */
const PROBE_BINDING_RE = /\s+@probe\s*:\s*([^\s:]+)\s*:\s*(.+?)\s*$/i;

/** @scenario:<id> — human AC ↔ CLI evidence step (id charset [A-Za-z0-9._-]+). */
const SCENARIO_BINDING_RE = /\s+@scenario\s*:\s*([A-Za-z0-9._-]+)\s*$/i;

/**
 * Operator-facing warning when a green test gate did not echo the bound path
 * (runners that omit file names). Status is `unverified`, not `pending`.
 */
export function unverifiedTestPathWarning(ref: string): string {
  return (
    `无法自动核验：测试门禁已通过，但其输出未包含 ${ref}` +
    `（运行器未回显文件名）。请人工确认该文件被运行器包含；` +
    `让运行器回显文件名/用例名即可自动核验。`
  );
}

export interface ScenarioBinding {
  /** null when the line has no @scenario: binding. */
  readonly id: string | null;
  readonly cleanText: string;
}

/** Parse trailing `@scenario:<id>`; strip it from displayed text. */
export function parseScenarioBinding(rawText: string): ScenarioBinding {
  const text = rawText.trim();
  const m = SCENARIO_BINDING_RE.exec(text);
  if (!m) return { id: null, cleanText: text };
  const id = m[1]!.trim();
  const cleanText = text.slice(0, m.index).trim() || text;
  return { id, cleanText };
}

const GATE_LIKE =
  /\b(pnpm\s+)?(check(:full)?|typecheck|lint|test|build|vitest|tsc)\b|门禁|机检通过/i;

const EVIDENCE_LIKE =
  /data-evidence|nav-[\w-]+|settings-[\w-]+|钩子|screenshot|截图|底栏|settings?\s*页|行为证据|证据步骤|behavioral\s+evidence/i;

/**
 * Generic tokens that never prove a *specific* evidence claim by themselves.
 * Used by {@link extractEvidenceMatchKeywords} for suggestion anchors.
 */
const EVIDENCE_KEYWORD_STOP = new Set([
  // EN step kinds / chrome / boilerplate
  'l2',
  'evidence',
  'step',
  'steps',
  'behavioral',
  'screenshot',
  'assert',
  'click',
  'unlock',
  'optional',
  'true',
  'false',
  'data',
  'sel',
  'selector',
  'text',
  'ok',
  'pass',
  'passed',
  'run',
  'ran',
  'plan',
  'workflow',
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'when',
  'are',
  'was',
  'see',
  'open',
  'show',
  'page',
  'panel',
  'button',
  'hook',
  'hooks',
  'required',
  'all',
  'full',
  'green',
  'check',
  'test',
  'like',
  'need',
  'needs',
  'must',
  'should',
  'have',
  'been',
  'also',
  'only',
  'via',
  'see',
  'definition',
  'done',
  'dod',
  // ZH step kinds / chrome / boilerplate
  '证据',
  '步骤',
  '截图',
  '命中',
  '行为',
  '验收',
  '说明',
  '文本',
  '被',
  '与',
  '的',
  '和',
  '见',
  '全过',
  '全绿',
  '钩子',
  '底栏',
  '页面',
  '面板',
  '按钮',
  '打开',
  '看到',
  '显示',
  '查看',
  '列表',
  '界面',
  '手机',
  '齐全',
  '通过',
  '完成',
  '定义',
]);

/** Operator-facing warning when unbound evidence AC does not match run steps. */
export const EVIDENCE_STEP_MISMATCH_WARNING =
  '证据类验收项与实际执行的步骤不匹配';

/** Warning when criterion is too generic to extract matchable keywords. */
export const EVIDENCE_KEYWORD_FALLBACK_WARNING =
  '证据类验收项过泛，无法从文本提取可匹配关键词——回退为 L2 全绿即通过';

export interface EvidenceMatchKeywords {
  readonly keywords: readonly string[];
  /**
   * false when text is too short/generic to match — callers should fall back
   * to the pre-precision behaviour (pass when evidenceOk) with a warning.
   */
  readonly usable: boolean;
}

/**
 * CJK runs that only recombine evidence-boilerplate (行为+证据+步骤+全过…)
 * are not matchable claims — stripping known glue leaves nothing domain-specific.
 */
function isEvidenceBoilerplateCjk(run: string): boolean {
  if (EVIDENCE_KEYWORD_STOP.has(run)) return true;
  const stripped = run.replace(
    /行为|证据|步骤|全过|截图|命中|钩子|底栏|验收|说明|文本|齐全|通过|完成|定义|页面|面板|界面|列表|显示|查看|打开|看到|按钮|手机|被|与|的|和|见/g,
    '',
  );
  return stripped.length === 0;
}

/**
 * Pure: extract matchable keywords from an evidence-like criterion text
 * (selector names, screenshot names, assert text fragments, CN domain words).
 */
export function extractEvidenceMatchKeywords(text: string): EvidenceMatchKeywords {
  const out = new Set<string>();
  const lower = text.toLowerCase();

  // Explicit data-evidence values: data-evidence=task-list
  for (const m of lower.matchAll(/data-evidence\s*=\s*["']?([\w-]+)/g)) {
    const v = m[1];
    if (v && !EVIDENCE_KEYWORD_STOP.has(v)) {
      out.add(v);
      for (const part of v.split(/[_-]+/)) {
        if (part.length >= 3 && !EVIDENCE_KEYWORD_STOP.has(part)) out.add(part);
      }
    }
  }

  // English / kebab identifiers (nav-settings, failover-death, settings-sheet)
  for (const w of lower.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    if (EVIDENCE_KEYWORD_STOP.has(w)) continue;
    // Compound "data-evidence" is chrome, not a claim.
    if (w === 'data-evidence') continue;
    out.add(w);
    for (const part of w.split(/[_-]+/)) {
      if (part.length >= 3 && !EVIDENCE_KEYWORD_STOP.has(part)) out.add(part);
    }
  }

  // CJK runs (2+) and their bigrams for partial match (降级说明 → 降级)
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (isEvidenceBoilerplateCjk(run)) continue;
    if (!EVIDENCE_KEYWORD_STOP.has(run)) out.add(run);
    if (run.length > 2) {
      for (let i = 0; i < run.length - 1; i += 1) {
        const bi = run.slice(i, i + 2);
        if (!EVIDENCE_KEYWORD_STOP.has(bi) && !isEvidenceBoilerplateCjk(bi)) out.add(bi);
      }
    }
  }

  const keywords = [...out].filter((k) => {
    if (/[\u4e00-\u9fff]/.test(k)) return k.length >= 2;
    return k.length >= 3;
  });

  return { keywords, usable: keywords.length > 0 };
}

/** True when any keyword appears in any L2 step detail string. */
export function evidenceKeywordsMatchSteps(
  keywords: readonly string[],
  stepDetails: readonly string[],
): boolean {
  if (keywords.length === 0 || stepDetails.length === 0) return false;
  const haystack = stepDetails.join('\n').toLowerCase();
  return keywords.some((k) => haystack.includes(k.toLowerCase()));
}

/** First data-evidence= value, else first kebab-like keyword, for unbound suggestions. */
function suggestEvidenceAnchor(text: string): string | null {
  const explicit = /data-evidence\s*=\s*["']?([\w-]+)/i.exec(text);
  if (explicit?.[1]) return explicit[1];
  const extracted = extractEvidenceMatchKeywords(text);
  const kebab = extracted.keywords.find((k) => /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/i.test(k));
  if (kebab) return kebab;
  return extracted.keywords[0] ?? null;
}

function unboundSuggestion(cleanText: string): string {
  if (GATE_LIKE.test(cleanText)) return 'suggest @gate:test';
  if (EVIDENCE_LIKE.test(cleanText)) {
    const anchor = suggestEvidenceAnchor(cleanText);
    return anchor
      ? `suggest @evidence:${anchor}`
      : 'suggest @evidence:<anchor>';
  }
  return 'add @test:path#title, @evidence:anchor or @gate:name';
}

export function parseMechProofBinding(rawText: string): MechProofBinding {
  const text = rawText.trim();

  const probe = PROBE_BINDING_RE.exec(text);
  if (probe) {
    const probeKind = probe[1]!.trim();
    const ref = probe[2]!.trim();
    const cleanText = text.slice(0, probe.index).trim() || text;
    return { kind: 'probe', ref, probeKind, cleanText };
  }

  const test = TEST_BINDING_RE.exec(text);
  if (test) {
    const ref = test[1]!.trim();
    const titleRaw = test[2];
    const cleanText = text.slice(0, test.index).trim() || text;
    if (titleRaw !== undefined) {
      return { kind: 'test-case', ref, title: titleRaw.trim(), cleanText };
    }
    return { kind: 'test-path', ref, cleanText };
  }

  const m = GATE_EVIDENCE_PROVE_RE.exec(text);
  if (!m) {
    return { kind: 'unbound', ref: '', cleanText: text };
  }
  const tag = m[1]!.toLowerCase();
  const ref = m[2]!.trim();
  const cleanText = text.slice(0, m.index).trim() || text;
  if (tag === 'gate' || (tag === 'prove' && !ref.includes('/'))) {
    return { kind: 'gate', ref, cleanText };
  }
  if (tag === 'evidence') {
    return { kind: 'evidence', ref, cleanText };
  }
  // @prove:test/foo
  return { kind: 'test-path', ref, cleanText };
}

export interface MechEvalInput {
  readonly criterionText: string;
  readonly gatesPassed: boolean;
  readonly gateNames: readonly string[];
  /** L2 evidence run: null/undefined = not configured / not run. */
  readonly evidenceOk: boolean | null;
  readonly evidenceStepDetails: readonly string[];
  readonly filesTouched: readonly string[];
  readonly selfAssessment: string;
  /** L2 declared + expected but never ran — self-assessment cannot substitute. */
  readonly behavioralMissing?: boolean;
  /** The gate named test* (first match) as it ran; null = no test gate in this run. */
  readonly testGate?: {
    readonly passed: boolean;
    readonly output: string;
    /** Gate command string (e.g. `pnpm test:x`) when known. */
    readonly command?: string;
  } | null;
  /** it()/test() / Rust #[test] titles present per test file at the verified sha. */
  readonly testCaseIndex?: ReadonlyMap<string, readonly string[]>;
  /** it()/test() titles on ADDED diff lines per test file (new in this diff). */
  readonly addedTestTitles?: ReadonlyMap<string, readonly string[]>;
  /**
   * package.json `scripts` map (trusted or candidate). A script whose body
   * names the bound test file counts as OBSERVED when the test gate ran that
   * script (command or output contains the script name).
   */
  readonly packageJsonScripts?: Readonly<Record<string, string>>;
}

export interface MechEvalResult {
  readonly status: DimensionStatus;
  readonly warning: string | null;
  /** Human-readable proof source shown in the packet. */
  readonly proof: string;
}

function normalizeTestPath(ref: string): string {
  return ref.replace(/^\.\//, '');
}

function pathInFilesTouched(ref: string, filesTouched: readonly string[]): boolean {
  return filesTouched.some((f) => f === ref || f.endsWith('/' + ref));
}

/**
 * True when a package.json script that names `ref` was observed as the test
 * gate (command is/contains `pnpm <script>` / `npm run <script>`, or gate
 * output echoes the script name). Script body must contain the file path.
 */
export function observedViaPackageJsonScript(input: {
  readonly ref: string;
  readonly testGate: { readonly output: string; readonly command?: string };
  readonly packageJsonScripts: Readonly<Record<string, string>>;
}): boolean {
  // Observation = the gate's COMMAND is exactly an invocation of a script
  // whose body names the bound file. Substring matches (`pnpm test` inside
  // `pnpm test:unit`) and script names merely echoed in the output are not
  // evidence that the file ran (Grok R19 B2).
  const cmd = (input.testGate.command ?? '').trim();
  if (cmd.length === 0) return false;
  const ref = input.ref;
  for (const [name, body] of Object.entries(input.packageJsonScripts)) {
    if (!body.includes(ref)) continue;
    const n = escapeRegExpLiteral(name);
    const invocation = new RegExp(
      '^(?:' +
        n +
        '|(?:pnpm|yarn|bun)(?:\\s+run)?\\s+' + n +
        '|npm\\s+run\\s+' + n +
        (name === 'test' ? '|npm\\s+test|yarn\\s+test|bun\\s+test' : '') +
        ')(?:\\s+--?[\\w-]+(?:=\\S+)?)*\\s*$',
    );
    if (invocation.test(cmd)) return true;
  }
  return false;
}

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shared test-gate observation checks for test-path / test-case.
 * - Missing gate → `pending`
 * - Red gate / unobserved while red → `pending` (unchanged)
 * - Green gate + path not echoed → `unverified` (human confirm; axis may still pass)
 * - Green gate + package.json script naming the file was run → observed (pass)
 */
function testGateObservationPending(
  testGate: MechEvalInput['testGate'],
  ref: string,
  proof: string,
  packageJsonScripts?: Readonly<Record<string, string>>,
): MechEvalResult | null {
  if (testGate == null) {
    return { status: 'pending', warning: 'no test gate ran', proof };
  }
  const observedDirect = testGate.output.includes(ref);
  const observedViaScript =
    !observedDirect &&
    packageJsonScripts !== undefined &&
    observedViaPackageJsonScript({
      ref,
      testGate: {
        output: testGate.output,
        ...(testGate.command !== undefined ? { command: testGate.command } : {}),
      },
      packageJsonScripts,
    });
  if (observedDirect || observedViaScript) {
    if (!testGate.passed) {
      return {
        status: 'pending',
        warning: `test file ${ref} not observed in test gate output`,
        proof,
      };
    }
    return null;
  }
  if (testGate.passed) {
    return {
      status: 'unverified',
      warning: unverifiedTestPathWarning(ref),
      proof,
    };
  }
  return {
    status: 'pending',
    warning: `test file ${ref} not observed in test gate output`,
    proof,
  };
}

/**
 * Evaluate one mechanical criterion. Does not override a global L1 fail —
 * callers should fail all mechanical when gatesPassed is false.
 */
export function evaluateMechanicalCriterion(input: MechEvalInput): MechEvalResult {
  if (!input.gatesPassed) {
    return { status: 'fail', warning: null, proof: 'gates red' };
  }

  const binding = parseMechProofBinding(input.criterionText);

  if (binding.kind === 'gate') {
    const want = binding.ref.toLowerCase();
    const hit =
      input.gateNames.some((n) => n.toLowerCase() === want || n.toLowerCase().includes(want)) ||
      want === 'all' ||
      want === '*';
    const proof = `regression: gate ${binding.ref} green`;
    if (!hit && input.gateNames.length > 0) {
      return {
        status: 'fail',
        warning: `mechanical @gate:${binding.ref} not found in gate results`,
        proof,
      };
    }
    return { status: 'pass', warning: null, proof };
  }

  if (binding.kind === 'evidence') {
    const proof = `L2 step matched data-evidence=${binding.ref}`;
    if (input.evidenceOk === null) {
      return {
        status: 'fail',
        warning: `mechanical @evidence:${binding.ref} but L2 did not run`,
        proof,
      };
    }
    if (input.evidenceOk === false) {
      return {
        status: 'fail',
        warning: `L2 evidence plan failed (need @evidence:${binding.ref})`,
        proof,
      };
    }
    const needle = binding.ref.toLowerCase();
    const matched = input.evidenceStepDetails.some((d) => d.toLowerCase().includes(needle));
    if (!matched) {
      return {
        status: 'fail',
        warning: `L2 ran but no step matched @evidence:${binding.ref}`,
        proof,
      };
    }
    return { status: 'pass', warning: null, proof };
  }

  if (binding.kind === 'test-path') {
    const ref = normalizeTestPath(binding.ref);
    const proof = `test gate green · ${ref} in diff`;
    if (!pathInFilesTouched(ref, input.filesTouched)) {
      return {
        status: 'pending',
        warning: `test path ${ref} not in diff — bind a title (@test:path#title) or use @gate:test for regression`,
        proof,
      };
    }
    const obs = testGateObservationPending(
      input.testGate,
      ref,
      proof,
      input.packageJsonScripts,
    );
    if (obs) return obs;
    return { status: 'pass', warning: null, proof };
  }

  if (binding.kind === 'test-case') {
    const ref = normalizeTestPath(binding.ref);
    const title = (binding.title ?? '').trim();
    const added = input.addedTestTitles?.get(ref);
    const novelty =
      added !== undefined && added.includes(title) ? 'new in diff' : 'pre-existing';
    const isRust = /\.rs$/i.test(ref);
    const proof = isRust
      ? `test gate green · #[test] fn ${title}() in ${ref} (${novelty})`
      : `test gate green · it("${title}") in ${ref} (${novelty})`;

    if (input.testCaseIndex === undefined) {
      return {
        status: 'pending',
        warning: 'test case index unavailable',
        proof,
      };
    }
    const titles = input.testCaseIndex.get(ref);
    if (titles === undefined) {
      // The verifier indexes every bound path; a missing entry means the file
      // could not be read at the verified revision — unknown, not absent.
      return {
        status: 'pending',
        warning: `test file ${ref} could not be read at the verified revision — bind an existing file or re-verify`,
        proof,
      };
    }
    if (!titles.includes(title)) {
      return {
        status: 'fail',
        warning: `contracted test "${title}" not found in ${ref}`,
        proof,
      };
    }
    const obs = testGateObservationPending(
      input.testGate,
      ref,
      proof,
      input.packageJsonScripts,
    );
    if (obs) return obs;
    return { status: 'pass', warning: null, proof };
  }

  if (binding.kind === 'probe') {
    const probeKind = binding.probeKind ?? 'unknown';
    return {
      status: 'pending',
      warning: `@probe:${probeKind} has no verifier for this archetype`,
      proof: `@probe:${probeKind}`,
    };
  }

  // Unbound: never pass.
  const suggestion = unboundSuggestion(binding.cleanText);
  return {
    status: 'pending',
    warning: `unbound mechanical criterion — ${suggestion}`,
    proof: 'unbound',
  };
}

/**
 * Aggregate mechanical axis from per-criterion evals + global L1/L2/delivery.
 * Precedence: fail > skipped > pending > n/a > pass.
 * `unverified` ranks with `pass` (gates are green; human-confirm items are
 * listed separately via `unverifiedCriteria`).
 */
export function aggregateMechanicalStatus(input: {
  readonly gatesPassed: boolean;
  readonly deliveryFailed: boolean;
  readonly noFileChanges: boolean;
  readonly hasMechanicalCriteria: boolean;
  /** When L2 was required (workflow/task evidence) and failed. */
  readonly behavioralFailed: boolean;
  /**
   * L2 was declared and expected but never produced evidence (boot/health
   * failed, no browser, empty plan). Not a failure of the change — the proof
   * is simply absent — so it must not read as `pass` and must not auto-rework
   * (burning attempts on an environmental gap).
   */
  readonly behavioralMissing?: boolean;
  /**
   * L1 test/held-out failure fully reproduces on merge-base (pure main) —
   * trunk debt, not this task. Mechanical axis skipped; no auto-rework.
   */
  readonly trunkInheritedGateFail?: boolean;
  readonly criterionStatuses: readonly DimensionStatus[];
}): DimensionStatus {
  if (input.deliveryFailed) return 'fail';
  if (input.behavioralFailed) return 'fail';
  if (input.criterionStatuses.some((s) => s === 'fail')) return 'fail';
  if (input.behavioralMissing === true) return 'skipped';
  if (input.trunkInheritedGateFail === true) return 'skipped';
  // L1 red (not trunk-attributed) outranks per-criterion skipped/pending.
  if (!input.gatesPassed) return 'fail';
  if (input.criterionStatuses.some((s) => s === 'skipped')) return 'skipped';
  if (input.criterionStatuses.some((s) => s === 'pending')) return 'pending';
  if (input.noFileChanges && !input.hasMechanicalCriteria) return 'n/a';
  // pass + unverified (or unverified alone) → pass
  return 'pass';
}
