/**
 * Domain — SPEC §15 readiness checklist probe (soft assist).
 *
 * Vision: humans/agents see what is missing on the trusted default branch
 * before/during onboard. This never flips `readiness: ready` — Mark ready
 * (or forceReady) remains a human decision. Pure: no IO / git / fs.
 *
 * Checks (required unless noted):
 * - AGENTS.md / CLAUDE.md present + substantial map
 * - AGENTS.md size budget hint (≤~120 lines; CLAUDE-only uses thin-pointer budget)
 * - WORKFLOW present + parseable front matter
 * - Gate commands defined
 * - Optional: boot and/or health_check declared
 */

/** Soft encyclopedia ceiling — map, not SPEC (matches agent-map invariant). */
export const AGENTS_MAX_LINES = 120;
/** Thin CLAUDE.md pointer budget when AGENTS.md is absent. */
export const CLAUDE_MAX_LINES = 20;

export interface ReadinessCheckItem {
  readonly id: string;
  readonly ok: boolean;
  readonly label: string;
  readonly detail: string;
  /**
   * When false, a failed item still appears in the score total but does not
   * flip overall `ok` (e.g. optional boot/health). Default true.
   */
  readonly required: boolean;
}

export interface ReadinessScore {
  /** Checks that passed (required + optional). */
  readonly passed: number;
  /** All checks in the checklist. */
  readonly total: number;
  readonly requiredPassed: number;
  readonly requiredTotal: number;
}

export interface ReadinessAssistResult {
  /** True when every *required* check passes. */
  readonly ok: boolean;
  readonly checks: readonly ReadinessCheckItem[];
  readonly score: ReadinessScore;
  /** One-line summary for ActionError / flash / pill. */
  readonly summary: string;
}

/** Structured WORKFLOW facts from a trusted parse (injected by outer layers). */
export interface WorkflowProbeFacts {
  /** Gate names with non-empty commands (e.g. typecheck, test). */
  readonly gateNames: readonly string[];
  readonly hasInstall: boolean;
  readonly hasBoot: boolean;
  readonly hasHealthCheck: boolean;
  /** WORKFLOW declares a behavioral: block (L2, SPEC §9.2). */
  readonly hasBehavioral?: boolean;
  /** WORKFLOW declares a valid trusted cli_evidence plan (CLI-only behavioral proof). */
  readonly hasCliEvidence?: boolean;
}

export interface ReadinessAssistInput {
  /** Path configured on the repo (usually WORKFLOW.md). */
  readonly workflowPath: string;
  /** Content on default branch, or null if missing. */
  readonly workflowContent: string | null;
  /** AGENTS.md or CLAUDE.md content on default branch. */
  readonly agentsContent: string | null;
  /** Which map file was found. */
  readonly agentsPath: string | null;
  /**
   * When the outer layer successfully parsed WORKFLOW, pass structured facts.
   * Prefer this over text heuristics.
   */
  readonly workflowFacts?: WorkflowProbeFacts | null;
  /**
   * Optional pre-parse: when provided without workflowFacts, use this for the
   * gates check (legacy tests). Prefer workflowFacts.
   */
  readonly workflowHasGates?: boolean;
  readonly workflowParseError?: string | null;
}

/** Count lines the way `wc -l` does (trailing newline does not add a blank). */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith('\n')
    ? content.split('\n').length - 1
    : content.split('\n').length;
}

/** Heuristic: front matter mentions a known gate or non-empty gates: map. */
export function workflowTextLooksGated(content: string): boolean {
  const head = content.slice(0, 4000);
  // YAML gates block or install/boot under setup.
  if (/^gates\s*:/m.test(head) || /\ngates\s*:/m.test(head)) {
    // gates: {} empty is not enough
    if (/gates\s*:\s*\{\s*\}/.test(head)) return false;
    if (/gates\s*:\s*$/m.test(head) && !/^\s{2,}\w+\s*:/m.test(head.split(/gates\s*:/)[1] ?? '')) {
      return false;
    }
    // Any gate name under gates:
    if (
      /gates\s*:[\s\S]{0,800}?(typecheck|lint|test|build)\s*:/m.test(head) ||
      /gates\s*:[\s\S]{0,400}?\n\s+\w[\w-]*\s*:/m.test(head)
    ) {
      return true;
    }
  }
  if (/setup\s*:[\s\S]{0,400}?(install|boot)\s*:/m.test(head)) return true;
  return false;
}

/** Map file should be more than a one-line stub. */
export function agentsMapLooksSubstantial(content: string): boolean {
  const t = content.trim();
  if (t.length < 40) return false;
  // Prefer something that looks like a map (headers or layout).
  if (/^#\s+/m.test(t) || /AGENTS|WORKFLOW|layout|Read order/i.test(t)) return true;
  return t.length >= 120;
}

function scoreOf(checks: readonly ReadinessCheckItem[]): ReadinessScore {
  const total = checks.length;
  const passed = checks.filter((c) => c.ok).length;
  const required = checks.filter((c) => c.required);
  const requiredTotal = required.length;
  const requiredPassed = required.filter((c) => c.ok).length;
  return { passed, total, requiredPassed, requiredTotal };
}

/**
 * Evaluate SPEC §15 soft readiness from trusted-branch file contents (no I/O).
 * Does not mutate readiness — human still decides.
 */
export function evaluateReadinessAssist(input: ReadinessAssistInput): ReadinessAssistResult {
  const wfPath = input.workflowPath.trim() || 'WORKFLOW.md';
  const checks: ReadinessCheckItem[] = [];

  const hasWorkflow = input.workflowContent !== null && input.workflowContent.trim().length > 0;
  checks.push({
    id: 'workflow-present',
    ok: hasWorkflow,
    required: true,
    label: `${wfPath} on default branch`,
    detail: hasWorkflow
      ? `Found ${input.workflowContent!.length} bytes`
      : `Missing or empty \`${wfPath}\` on the default branch`,
  });

  // WORKFLOW parse (required when present; fails when missing too).
  let parseOk = false;
  let parseDetail = 'Skipped — workflow missing';
  if (hasWorkflow) {
    if (input.workflowParseError) {
      parseOk = false;
      parseDetail = input.workflowParseError;
    } else if (input.workflowFacts !== undefined && input.workflowFacts !== null) {
      parseOk = true;
      parseDetail = 'Front matter parsed';
    } else if (input.workflowHasGates !== undefined || input.workflowParseError === null) {
      // Outer layer attempted parse without error, or heuristic path.
      parseOk = input.workflowParseError == null || input.workflowParseError === '';
      parseDetail = parseOk
        ? input.workflowFacts === null
          ? 'No structured parse (heuristic path)'
          : 'No parse error reported'
        : String(input.workflowParseError);
    } else {
      // Pure text path: if content looks like YAML front matter, treat as parseable enough.
      parseOk = /^---\s*\n[\s\S]*?\n---/.test(input.workflowContent!);
      parseDetail = parseOk
        ? 'Looks like YAML front matter (heuristic)'
        : 'No YAML front matter detected';
    }
  }
  checks.push({
    id: 'workflow-parse',
    ok: hasWorkflow && parseOk,
    required: true,
    label: 'WORKFLOW.md parses',
    detail: parseDetail,
  });

  // Gate commands defined (required).
  let gatesOk = false;
  let gatesDetail = 'Skipped — workflow missing';
  if (hasWorkflow && parseOk) {
    if (input.workflowFacts) {
      const names = input.workflowFacts.gateNames.filter((n) => n.trim().length > 0);
      gatesOk = names.length > 0;
      gatesDetail = gatesOk
        ? `Gates: ${names.join(', ')}`
        : 'No gate commands in front matter (typecheck/lint/test/build)';
    } else if (input.workflowHasGates !== undefined) {
      gatesOk = input.workflowHasGates;
      gatesDetail = gatesOk ? 'Parsed gates present' : 'No executable gates in front matter';
    } else {
      gatesOk = workflowTextLooksGated(input.workflowContent!);
      gatesDetail = gatesOk
        ? 'Looks like setup/gates are declared'
        : 'No gates/setup install/boot detected in front matter';
    }
  } else if (hasWorkflow && !parseOk) {
    gatesDetail = 'Skipped — workflow parse failed';
  }
  checks.push({
    id: 'workflow-gates',
    ok: hasWorkflow && parseOk && gatesOk,
    required: true,
    label: 'Gate commands defined',
    detail: gatesDetail,
  });

  // Optional boot / health_check.
  let bootOk = false;
  let bootDetail = 'Skipped — workflow missing';
  if (hasWorkflow && parseOk) {
    if (input.workflowFacts) {
      const parts: string[] = [];
      if (input.workflowFacts.hasBoot) parts.push('boot');
      if (input.workflowFacts.hasHealthCheck) parts.push('health_check');
      if (input.workflowFacts.hasInstall) parts.push('install');
      bootOk = input.workflowFacts.hasBoot || input.workflowFacts.hasHealthCheck;
      bootDetail = bootOk
        ? `Declared: ${parts.join(', ')}`
        : 'No setup.boot or setup.health_check (optional for non-app repos)';
    } else {
      const head = input.workflowContent!.slice(0, 4000);
      const hasBoot = /setup\s*:[\s\S]{0,600}?boot\s*:/m.test(head);
      const hasHealth = /health_check\s*:/m.test(head);
      bootOk = hasBoot || hasHealth;
      bootDetail = bootOk
        ? `Heuristic: ${[hasBoot ? 'boot' : null, hasHealth ? 'health_check' : null].filter(Boolean).join(', ')}`
        : 'No boot/health_check detected (optional)';
    }
  } else if (hasWorkflow && !parseOk) {
    bootDetail = 'Skipped — workflow parse failed';
  }
  checks.push({
    id: 'workflow-boot',
    ok: bootOk,
    required: false,
    label: 'Boot / health_check (optional)',
    detail: bootDetail,
  });

  // L2 behavioral declaration (SPEC §9.2 REQUIRED v1 / §15 boots-in-isolation).
  // A ready repo without a behavioral: block ships review-green tasks with
  // ZERO behavioral proof and no guard ever fires (bookshelf, 2026-07-23).
  // CLI-only repos may supply a valid trusted cli_evidence plan instead of a
  // browser behavioral block. Soft assist accepts declaration only; Guardian
  // B-022 still requires a verified isolated CLI run for hard readiness.
  let behavioralOk = false;
  let behavioralDetail = 'Skipped — workflow missing';
  if (hasWorkflow) {
    let hasBrowser = false;
    let hasCli = false;
    if (input.workflowFacts) {
      hasBrowser = input.workflowFacts.hasBehavioral === true;
      hasCli = input.workflowFacts.hasCliEvidence === true;
    } else if (input.workflowFacts === null) {
      hasBrowser = /^behavioral\s*:/m.test(input.workflowContent!);
      hasCli = false;
    } else {
      hasBrowser = /^behavioral\s*:/m.test(input.workflowContent!);
      hasCli = false;
    }
    behavioralOk = hasBrowser || hasCli;
    if (behavioralOk) {
      if (hasBrowser && hasCli) {
        behavioralDetail = 'Browser `behavioral:` and trusted `cli_evidence` declared';
      } else if (hasBrowser) {
        behavioralDetail = 'Browser `behavioral:` block declared — L2 evidence will run';
      } else {
        behavioralDetail =
          'Trusted `cli_evidence` plan declared — CLI behavioral proof for CLI-only repos';
      }
    } else {
      behavioralDetail =
        'No browser `behavioral:` block and no valid trusted `cli_evidence` plan — ' +
        'tasks would reach review with no behavioral proof. ' +
        'Declare browser base_url + evidence (SPEC §9.2) or cli_evidence steps before marking ready.';
    }
  }
  checks.push({
    id: 'workflow-behavioral',
    ok: behavioralOk,
    required: true,
    label: 'Behavioral verification declared (browser or CLI)',
    detail: behavioralDetail,
  });

  // Agent map present + substantial.
  const hasAgents =
    input.agentsContent !== null &&
    input.agentsContent.trim().length > 0 &&
    input.agentsPath !== null;
  const agentsSubstantial =
    hasAgents && agentsMapLooksSubstantial(input.agentsContent!);
  checks.push({
    id: 'agents-map',
    ok: agentsSubstantial,
    required: true,
    label: 'Agent map (AGENTS.md or CLAUDE.md)',
    detail: !hasAgents
      ? 'Neither AGENTS.md nor CLAUDE.md found on default branch'
      : agentsSubstantial
        ? `Found \`${input.agentsPath}\` (${input.agentsContent!.length} bytes)`
        : `\`${input.agentsPath}\` looks like an empty stub`,
  });

  // Size budget hint (SPEC §15 ≤~120 lines for AGENTS.md).
  let budgetOk = false;
  let budgetDetail = 'Skipped — no agent map';
  if (hasAgents) {
    const lines = countLines(input.agentsContent!);
    const path = input.agentsPath!;
    if (path === 'AGENTS.md' || path.endsWith('/AGENTS.md')) {
      budgetOk = lines <= AGENTS_MAX_LINES;
      budgetDetail = budgetOk
        ? `\`${path}\` is ${lines} lines (budget ≤${AGENTS_MAX_LINES})`
        : `\`${path}\` is ${lines} lines — over budget (≤${AGENTS_MAX_LINES}); map not encyclopedia`;
    } else {
      // CLAUDE.md alone: thin pointer budget; prefer AGENTS.md.
      budgetOk = lines <= CLAUDE_MAX_LINES;
      budgetDetail = budgetOk
        ? `\`${path}\` is ${lines} lines (thin pointer ≤${CLAUDE_MAX_LINES}); prefer AGENTS.md as the map`
        : `\`${path}\` is ${lines} lines — should be a thin pointer to AGENTS.md (≤${CLAUDE_MAX_LINES})`;
    }
  }
  checks.push({
    id: 'agents-budget',
    ok: hasAgents && budgetOk,
    required: true,
    label: 'Agent map size budget',
    detail: budgetDetail,
  });

  const score = scoreOf(checks);
  const ok = checks.filter((c) => c.required).every((c) => c.ok);

  const failedRequired = checks.filter((c) => c.required && !c.ok).map((c) => c.id);
  const failedOptional = checks.filter((c) => !c.required && !c.ok).map((c) => c.id);
  let summary: string;
  if (ok) {
    summary =
      failedOptional.length === 0
        ? `Checklist ${score.passed}/${score.total} — all soft checks passed`
        : `Checklist ${score.passed}/${score.total} — required ok; optional missing: ${failedOptional.join(', ')}`;
  } else {
    summary = `Checklist ${score.passed}/${score.total} — failed: ${failedRequired.join(', ')}`;
  }

  return { ok, checks, score, summary };
}
