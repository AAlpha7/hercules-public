/**
 * Domain — repository-authoritative project-state closure (opt-in).
 *
 * Before Merge Selected pushes, an opted-in repository may require declared
 * Status / Backlog / ExecPlan / Changelog surfaces on the merged tree to no
 * longer assert a superseded project state. Contract paths come only from the
 * trusted default-branch WORKFLOW (or an explicitly referenced policy file on
 * that tip) — never from task-body prose. Pure: no IO / git / fs / network.
 */

/** Receipt / contract schema version (bounded, stable). */
export const PROJECT_STATE_CLOSURE_VERSION = 1 as const;

/** Fixed surface kinds — filenames are never inferred from prose. */
export const PROJECT_STATE_SURFACE_KINDS = [
  'status',
  'backlog',
  'exec_plan',
  'changelog',
] as const;

export type ProjectStateSurfaceKind = (typeof PROJECT_STATE_SURFACE_KINDS)[number];

export function isProjectStateSurfaceKind(v: unknown): v is ProjectStateSurfaceKind {
  return (
    typeof v === 'string' &&
    (PROJECT_STATE_SURFACE_KINDS as readonly string[]).includes(v)
  );
}

/** Durable task / API status for the closure lane. */
export const PROJECT_STATE_CLOSURE_STATUSES = [
  'not_applicable',
  'pending',
  'passed',
  'failed',
] as const;

export type ProjectStateClosureStatus =
  (typeof PROJECT_STATE_CLOSURE_STATUSES)[number];

export function isProjectStateClosureStatus(
  v: unknown,
): v is ProjectStateClosureStatus {
  return (
    typeof v === 'string' &&
    (PROJECT_STATE_CLOSURE_STATUSES as readonly string[]).includes(v)
  );
}

/** Stable machine-readable reason codes (no free prose keys). */
export const PROJECT_STATE_CLOSURE_CODES = [
  'ok',
  'not_applicable',
  'surface_missing',
  'stale_assertion',
  'required_assertion_missing',
  'invalid_contract',
  'policy_unreadable',
] as const;

export type ProjectStateClosureCode =
  (typeof PROJECT_STATE_CLOSURE_CODES)[number];

export const PROJECT_STATE_CLOSURE_RECEIPT_HEADING = '## Project-state closure';
export const PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_START =
  '<!-- hercules-project-state-closure:v1';
export const PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_END = '-->';
export const PROJECT_STATE_CLOSURE_RECEIPT_SECTION_BEGIN =
  '<!-- hercules-project-state-closure-begin:v1 -->';
export const PROJECT_STATE_CLOSURE_RECEIPT_SECTION_END =
  '<!-- hercules-project-state-closure-end:v1 -->';

/** Hard bounds so receipts stay phone-safe (no raw logs / host paths). */
export const MAX_PROJECT_STATE_CLOSURE_RULES = 32;
export const MAX_PROJECT_STATE_CLOSURE_PATTERNS = 16;
export const MAX_PROJECT_STATE_CLOSURE_PATTERN_LEN = 256;
export const MAX_PROJECT_STATE_CLOSURE_REQUIRED_UPDATE_LEN = 400;
export const MAX_PROJECT_STATE_CLOSURE_SNIPPET_LEN = 120;
export const MAX_PROJECT_STATE_CLOSURE_FINDINGS = 24;
export const MAX_PROJECT_STATE_CLOSURE_PATH_LEN = 240;
export const MAX_PROJECT_STATE_CLOSURE_RECEIPT_BYTES = 32 * 1024;

export class ProjectStateClosureParseError extends Error {
  override readonly name = 'ProjectStateClosureParseError';
  constructor(message: string) {
    super(message);
  }
}

/** One declared surface: kind + trusted relative path (never task-injected). */
export interface ProjectStateSurfaceDecl {
  readonly kind: ProjectStateSurfaceKind;
  /** Repo-relative path declared in trusted policy. */
  readonly path: string;
}

/** When a rule applies to a task (labels / milestone tokens). */
export interface ProjectStateClosureWhen {
  /** Apply when the task has any of these labels. Empty = ignore labels. */
  readonly labelsAny: readonly string[];
  /**
   * Milestone tokens matched against task labels (exact, case-sensitive).
   * Empty = ignore milestones. Both empty means the rule always applies when
   * the contract is present (repository-wide opt-in for every mergeable task).
   */
  readonly milestonesAny: readonly string[];
}

/** One applicability + content rule against declared surfaces. */
export interface ProjectStateClosureRule {
  readonly id: string;
  readonly when: ProjectStateClosureWhen;
  /** Declared surface kinds this rule inspects (must exist on the contract). */
  readonly surfaces: readonly ProjectStateSurfaceKind[];
  /** Fail when surface content still contains any of these substrings. */
  readonly forbidPatterns: readonly string[];
  /** Fail when surface content lacks any of these substrings. */
  readonly requirePatterns: readonly string[];
  /** Bounded human remediation naming the surface + required update. */
  readonly requiredUpdate: string;
}

/** Opt-in contract after trusted parse (WORKFLOW or referenced policy). */
export interface ProjectStateClosureContract {
  readonly version: typeof PROJECT_STATE_CLOSURE_VERSION;
  /**
   * Optional path to a trusted default-branch policy file (repo-relative).
   * Present only when the WORKFLOW references an external policy; the file
   * content is loaded by the control/merge layers from the trusted tip.
   */
  readonly policyPath: string | null;
  readonly surfaces: readonly ProjectStateSurfaceDecl[];
  readonly rules: readonly ProjectStateClosureRule[];
}

/** Exact SHAs + policy digest binding a closure evaluation. */
export interface ProjectStateClosureProvenance {
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly mergeTreeSha: string;
  readonly policyDigest: string;
}

export interface ProjectStateClosureFinding {
  readonly ruleId: string;
  readonly surface: ProjectStateSurfaceKind;
  readonly path: string;
  readonly code: ProjectStateClosureCode;
  /** Bounded actionable detail (no host paths, no raw logs). */
  readonly detail: string;
  readonly requiredUpdate: string;
}

export interface ProjectStateClosureReceipt {
  readonly version: typeof PROJECT_STATE_CLOSURE_VERSION;
  readonly status: ProjectStateClosureStatus;
  readonly ok: boolean;
  readonly applicable: boolean;
  readonly findings: readonly ProjectStateClosureFinding[];
  readonly provenance: ProjectStateClosureProvenance;
  /** One-line operator summary (bounded). */
  readonly summary: string;
}

/** Delivery pipeline lanes kept distinct from each other. */
export const DELIVERY_PIPELINE_LANES = [
  'verification',
  'merge_eligibility',
  'project_state_closure',
  'deployment',
] as const;

export type DeliveryPipelineLane = (typeof DELIVERY_PIPELINE_LANES)[number];

export type DeliveryLaneState =
  | 'not_applicable'
  | 'missing'
  | 'pending'
  | 'eligible'
  | 'blocked'
  | 'passed'
  | 'failed'
  | 'merged'
  | 'deploying'
  | 'ready'
  | 'production';

export interface DeliveryPipelineStages {
  readonly verification: DeliveryLaneState;
  readonly mergeEligibility: DeliveryLaneState;
  readonly projectStateClosure: DeliveryLaneState;
  readonly deployment: DeliveryLaneState;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacter(el: string): boolean {
  for (let i = 0; i < el.length; i += 1) {
    const code = el.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Normalize a trusted policy path for a closure surface or policy file.
 * Rejects absolute / traversal / null-byte / host-like paths. Never accepts
 * task-body injection — callers must only pass trusted WORKFLOW/policy values.
 */
export function normalizeProjectStatePath(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ProjectStateClosureParseError('path must be a string');
  }
  let t = raw.trim();
  if (t.length === 0) {
    throw new ProjectStateClosureParseError('path must be non-empty');
  }
  if (t.length > MAX_PROJECT_STATE_CLOSURE_PATH_LEN) {
    throw new ProjectStateClosureParseError('path exceeds max length');
  }
  if (t.includes('\0') || hasControlCharacter(t)) {
    throw new ProjectStateClosureParseError('path contains a control character');
  }
  if (t.indexOf(String.fromCharCode(92)) >= 0) {
    throw new ProjectStateClosureParseError('path must use forward slashes');
  }
  if (t.startsWith('/') || t.startsWith('~') || t.includes('://')) {
    throw new ProjectStateClosureParseError('absolute or URL path rejected');
  }
  if (/^[A-Za-z]:[\\/]/.test(t)) {
    throw new ProjectStateClosureParseError('absolute or URL path rejected');
  }
  while (t.startsWith('./')) t = t.slice(2);
  const parts = t.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.length === 0) {
    throw new ProjectStateClosureParseError('path must be non-empty');
  }
  if (parts.some((p) => p === '..')) {
    throw new ProjectStateClosureParseError('path must not contain ..');
  }
  for (const p of parts) {
    if (!/^[A-Za-z0-9._@+-]+$/.test(p)) {
      throw new ProjectStateClosureParseError(
        'path has unsafe path segments: ' + JSON.stringify(raw),
      );
    }
  }
  return parts.join('/');
}

function parseLabelList(raw: unknown, loc: string): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ProjectStateClosureParseError(loc + ' must be an array of strings');
  }
  if (raw.length > 64) {
    throw new ProjectStateClosureParseError(loc + ' exceeds max entries');
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const el = raw[i];
    if (typeof el !== 'string' || el.trim().length === 0) {
      throw new ProjectStateClosureParseError(loc + '[' + i + '] must be a non-empty string');
    }
    const t = el.trim();
    if (t.length > 64 || hasControlCharacter(t)) {
      throw new ProjectStateClosureParseError(loc + '[' + i + '] is invalid');
    }
    out.push(t);
  }
  return out;
}

function parsePatternList(raw: unknown, loc: string): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ProjectStateClosureParseError(loc + ' must be an array of strings');
  }
  if (raw.length > MAX_PROJECT_STATE_CLOSURE_PATTERNS) {
    throw new ProjectStateClosureParseError(loc + ' exceeds max patterns');
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const el = raw[i];
    if (typeof el !== 'string' || el.length === 0) {
      throw new ProjectStateClosureParseError(loc + '[' + i + '] must be a non-empty string');
    }
    if (el.length > MAX_PROJECT_STATE_CLOSURE_PATTERN_LEN) {
      throw new ProjectStateClosureParseError(loc + '[' + i + '] exceeds max length');
    }
    if (el.includes('\0') || hasControlCharacter(el)) {
      throw new ProjectStateClosureParseError(loc + '[' + i + '] contains a control character');
    }
    out.push(el);
  }
  return out;
}

function parseSurfaceMap(raw: unknown): readonly ProjectStateSurfaceDecl[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProjectStateClosureParseError('surfaces must be a mapping of kind → path');
  }
  const obj = raw as Record<string, unknown>;
  const decls: ProjectStateSurfaceDecl[] = [];
  for (const kind of PROJECT_STATE_SURFACE_KINDS) {
    if (!(kind in obj)) continue;
    const path = normalizeProjectStatePath(obj[kind]);
    decls.push({ kind, path });
  }
  for (const key of Object.keys(obj)) {
    if (!isProjectStateSurfaceKind(key)) {
      throw new ProjectStateClosureParseError(
        'unknown surface kind ' +
          JSON.stringify(key) +
          ' (want status|backlog|exec_plan|changelog)',
      );
    }
  }
  return decls;
}

function parseRule(raw: unknown, index: number): ProjectStateClosureRule {
  const loc = 'rules[' + String(index) + ']';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectStateClosureParseError(loc + ' must be a mapping');
  }
  const obj = raw as Record<string, unknown>;
  const idRaw = obj['id'];
  if (typeof idRaw !== 'string' || idRaw.trim().length === 0) {
    throw new ProjectStateClosureParseError(loc + '.id must be a non-empty string');
  }
  const id = idRaw.trim();
  if (id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new ProjectStateClosureParseError(loc + '.id is not a safe identifier');
  }

  const whenRaw = obj['when'];
  let labelsAny: readonly string[] = [];
  let milestonesAny: readonly string[] = [];
  if (whenRaw !== undefined && whenRaw !== null) {
    if (typeof whenRaw !== 'object' || Array.isArray(whenRaw)) {
      throw new ProjectStateClosureParseError(loc + '.when must be a mapping');
    }
    const w = whenRaw as Record<string, unknown>;
    labelsAny = parseLabelList(w['labels_any'], loc + '.when.labels_any');
    milestonesAny = parseLabelList(w['milestones_any'], loc + '.when.milestones_any');
  }

  const surfacesRaw = obj['surfaces'];
  if (!Array.isArray(surfacesRaw) || surfacesRaw.length === 0) {
    throw new ProjectStateClosureParseError(loc + '.surfaces must be a non-empty array');
  }
  if (surfacesRaw.length > PROJECT_STATE_SURFACE_KINDS.length) {
    throw new ProjectStateClosureParseError(loc + '.surfaces exceeds max entries');
  }
  const surfaces: ProjectStateSurfaceKind[] = [];
  const seenSurf = new Set<string>();
  for (let i = 0; i < surfacesRaw.length; i += 1) {
    const s = surfacesRaw[i];
    if (!isProjectStateSurfaceKind(s)) {
      throw new ProjectStateClosureParseError(
        loc + '.surfaces[' + i + '] must be status|backlog|exec_plan|changelog',
      );
    }
    if (seenSurf.has(s)) {
      throw new ProjectStateClosureParseError(loc + '.surfaces duplicates ' + s);
    }
    seenSurf.add(s);
    surfaces.push(s);
  }

  const forbidPatterns = parsePatternList(
    obj['forbid_patterns'] ?? obj['forbid'],
    loc + '.forbid_patterns',
  );
  const requirePatterns = parsePatternList(
    obj['require_patterns'] ?? obj['require'],
    loc + '.require_patterns',
  );
  if (forbidPatterns.length === 0 && requirePatterns.length === 0) {
    throw new ProjectStateClosureParseError(
      loc + ' needs at least one forbid_patterns or require_patterns entry',
    );
  }

  const reqRaw = obj['required_update'];
  if (typeof reqRaw !== 'string' || reqRaw.trim().length === 0) {
    throw new ProjectStateClosureParseError(loc + '.required_update must be a non-empty string');
  }
  const requiredUpdate = reqRaw.trim();
  if (requiredUpdate.length > MAX_PROJECT_STATE_CLOSURE_REQUIRED_UPDATE_LEN) {
    throw new ProjectStateClosureParseError(loc + '.required_update exceeds max length');
  }
  if (requiredUpdate.includes('\0') || hasControlCharacter(requiredUpdate)) {
    throw new ProjectStateClosureParseError(loc + '.required_update contains a control character');
  }

  return {
    id,
    when: { labelsAny, milestonesAny },
    surfaces,
    forbidPatterns,
    requirePatterns,
    requiredUpdate,
  };
}

function parseRules(raw: unknown): readonly ProjectStateClosureRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ProjectStateClosureParseError('rules must be an array');
  }
  if (raw.length > MAX_PROJECT_STATE_CLOSURE_RULES) {
    throw new ProjectStateClosureParseError('rules exceeds max entries');
  }
  const rules: ProjectStateClosureRule[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const rule = parseRule(raw[i], i);
    if (seenIds.has(rule.id)) {
      throw new ProjectStateClosureParseError('duplicate rule id ' + rule.id);
    }
    seenIds.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

/**
 * Parse a project_state_closure mapping (WORKFLOW front matter or policy file).
 * Returns null when the block is absent/empty (opt-out). Throws on invalid shape.
 */
export function parseProjectStateClosureConfig(
  raw: unknown,
): ProjectStateClosureContract | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProjectStateClosureParseError('project_state_closure must be a mapping');
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;

  let policyPath: string | null = null;
  if (obj['policy'] !== undefined && obj['policy'] !== null && obj['policy'] !== '') {
    policyPath = normalizeProjectStatePath(obj['policy']);
  }

  const surfaces = parseSurfaceMap(obj['surfaces']);
  const rules = parseRules(obj['rules']);

  // Policy-only stub is valid (loader fills surfaces/rules from the file).
  if (policyPath !== null && surfaces.length === 0 && rules.length === 0) {
    return {
      version: PROJECT_STATE_CLOSURE_VERSION,
      policyPath,
      surfaces: [],
      rules: [],
    };
  }

  if (surfaces.length === 0) {
    throw new ProjectStateClosureParseError(
      'project_state_closure.surfaces must declare at least one of status|backlog|exec_plan|changelog',
    );
  }
  if (rules.length === 0) {
    throw new ProjectStateClosureParseError(
      'project_state_closure.rules must declare at least one rule',
    );
  }

  const declared = new Set(surfaces.map((s) => s.kind));
  for (const rule of rules) {
    for (const kind of rule.surfaces) {
      if (!declared.has(kind)) {
        throw new ProjectStateClosureParseError(
          'rule ' + rule.id + ' references undeclared surface ' + kind,
        );
      }
    }
  }

  return {
    version: PROJECT_STATE_CLOSURE_VERSION,
    policyPath,
    surfaces,
    rules,
  };
}

/**
 * Merge a loaded external policy file into a WORKFLOW stub that only named
 * `policy:`. WORKFLOW-inline surfaces/rules win when both are present.
 */
export function resolveProjectStateClosureContract(input: {
  readonly workflowContract: ProjectStateClosureContract | null;
  readonly policyFileContract: ProjectStateClosureContract | null;
}): ProjectStateClosureContract | null {
  const wf = input.workflowContract;
  if (!wf) return null;
  const file = input.policyFileContract;
  if (wf.surfaces.length > 0 && wf.rules.length > 0) {
    return wf;
  }
  if (!file) {
    throw new ProjectStateClosureParseError(
      'project_state_closure.policy is set but the trusted policy file is missing or empty',
    );
  }
  if (file.surfaces.length === 0 || file.rules.length === 0) {
    throw new ProjectStateClosureParseError(
      'trusted policy file must declare surfaces and rules',
    );
  }
  return {
    version: PROJECT_STATE_CLOSURE_VERSION,
    policyPath: wf.policyPath,
    surfaces: file.surfaces,
    rules: file.rules,
  };
}

/** Canonical object for policy digest (stable key order). */
export function projectStateClosureCanonical(contract: ProjectStateClosureContract): unknown {
  return {
    version: contract.version,
    policyPath: contract.policyPath,
    surfaces: contract.surfaces.map((s) => ({ kind: s.kind, path: s.path })),
    rules: contract.rules.map((r) => ({
      id: r.id,
      when: {
        labels_any: [...r.when.labelsAny],
        milestones_any: [...r.when.milestonesAny],
      },
      surfaces: [...r.surfaces],
      forbid_patterns: [...r.forbidPatterns],
      require_patterns: [...r.requirePatterns],
      required_update: r.requiredUpdate,
    })),
  };
}

/** Whether a rule applies to this task (labels / milestone tokens). */
export function ruleAppliesToTask(
  rule: ProjectStateClosureRule,
  task: { readonly labels: readonly string[] },
): boolean {
  const labels = new Set(task.labels);
  const { labelsAny, milestonesAny } = rule.when;
  if (labelsAny.length === 0 && milestonesAny.length === 0) return true;
  if (labelsAny.some((l) => labels.has(l))) return true;
  if (milestonesAny.some((m) => labels.has(m))) return true;
  return false;
}

function boundSnippet(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_PROJECT_STATE_CLOSURE_SNIPPET_LEN) return oneLine;
  return oneLine.slice(0, MAX_PROJECT_STATE_CLOSURE_SNIPPET_LEN - 1) + '…';
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/**
 * Evaluate declared surfaces on the merged tree. Does not edit any files.
 * Callers inject surface contents (null = missing). Task body never supplies paths.
 */
export function evaluateProjectStateClosure(input: {
  readonly contract: ProjectStateClosureContract;
  readonly task: { readonly id: string; readonly labels: readonly string[] };
  /** Map surface kind → file content (null when the declared path is absent). */
  readonly surfaceContents: ReadonlyMap<ProjectStateSurfaceKind, string | null>;
  readonly provenance: ProjectStateClosureProvenance;
}): ProjectStateClosureReceipt {
  const applicableRules = input.contract.rules.filter((r) =>
    ruleAppliesToTask(r, input.task),
  );
  if (applicableRules.length === 0) {
    return {
      version: PROJECT_STATE_CLOSURE_VERSION,
      status: 'not_applicable',
      ok: true,
      applicable: false,
      findings: [],
      provenance: input.provenance,
      summary:
        'Project-state closure not applicable for this task (no matching rule)',
    };
  }

  const surfaceByKind = new Map(
    input.contract.surfaces.map((s) => [s.kind, s] as const),
  );
  const findings: ProjectStateClosureFinding[] = [];

  for (const rule of applicableRules) {
    for (const kind of rule.surfaces) {
      if (findings.length >= MAX_PROJECT_STATE_CLOSURE_FINDINGS) break;
      const decl = surfaceByKind.get(kind);
      if (!decl) {
        findings.push({
          ruleId: rule.id,
          surface: kind,
          path: '(undeclared)',
          code: 'invalid_contract',
          detail: 'rule references undeclared surface',
          requiredUpdate: rule.requiredUpdate,
        });
        continue;
      }
      const content = input.surfaceContents.get(kind);
      if (content === undefined || content === null) {
        findings.push({
          ruleId: rule.id,
          surface: kind,
          path: decl.path,
          code: 'surface_missing',
          detail: 'declared surface missing on merge tree',
          requiredUpdate: rule.requiredUpdate,
        });
        continue;
      }
      for (const pat of rule.forbidPatterns) {
        if (findings.length >= MAX_PROJECT_STATE_CLOSURE_FINDINGS) break;
        if (content.includes(pat)) {
          findings.push({
            ruleId: rule.id,
            surface: kind,
            path: decl.path,
            code: 'stale_assertion',
            detail:
              'still asserts superseded state matching ' +
              JSON.stringify(boundSnippet(pat)),
            requiredUpdate: rule.requiredUpdate,
          });
        }
      }
      for (const pat of rule.requirePatterns) {
        if (findings.length >= MAX_PROJECT_STATE_CLOSURE_FINDINGS) break;
        if (!content.includes(pat)) {
          findings.push({
            ruleId: rule.id,
            surface: kind,
            path: decl.path,
            code: 'required_assertion_missing',
            detail:
              'missing required update marker ' + JSON.stringify(boundSnippet(pat)),
            requiredUpdate: rule.requiredUpdate,
          });
        }
      }
    }
  }

  if (findings.length > 0) {
    const first = findings[0]!;
    return {
      version: PROJECT_STATE_CLOSURE_VERSION,
      status: 'failed',
      ok: false,
      applicable: true,
      findings,
      provenance: input.provenance,
      summary:
        'Project-state closure blocked: ' +
        first.surface +
        ' (' +
        first.path +
        ') — ' +
        first.requiredUpdate,
    };
  }

  return {
    version: PROJECT_STATE_CLOSURE_VERSION,
    status: 'passed',
    ok: true,
    applicable: true,
    findings: [],
    provenance: input.provenance,
    summary:
      'Project-state closure passed on merge tree ' +
      shortSha(input.provenance.mergeTreeSha) +
      ' (policy ' +
      shortSha(input.provenance.policyDigest) +
      ')',
  };
}

/** Bounded markdown receipt for task body / merge failure (no host paths). */
export function formatProjectStateClosureReceipt(
  receipt: ProjectStateClosureReceipt,
): string {
  const lines: string[] = [PROJECT_STATE_CLOSURE_RECEIPT_HEADING, ''];
  const mark =
    receipt.status === 'passed'
      ? 'OK'
      : receipt.status === 'failed'
        ? 'FAIL'
        : receipt.status === 'not_applicable'
          ? 'N/A'
          : 'PENDING';
  lines.push(
    '**Verdict:** ' +
      mark +
      ' `' +
      receipt.status +
      '` — distinct from code verification, gate-merge eligibility, and deployment.',
  );
  lines.push(
    '- **Base:** `' +
      shortSha(receipt.provenance.baseSha) +
      '` · **Candidate:** `' +
      shortSha(receipt.provenance.candidateSha) +
      '` · **Merge tree:** `' +
      shortSha(receipt.provenance.mergeTreeSha) +
      '`',
  );
  lines.push('- **Policy digest:** `' + receipt.provenance.policyDigest + '`');
  lines.push('- **Summary:** ' + receipt.summary);
  lines.push(
    '- **Note:** A green or failed closure receipt never claims a target milestone is complete merely because a candidate SHA merged.',
  );
  if (receipt.findings.length > 0) {
    lines.push('');
    lines.push('### Findings');
    for (const f of receipt.findings) {
      lines.push(
        '- `' +
          f.code +
          '` surface=`' +
          f.surface +
          '` path=`' +
          f.path +
          '` rule=`' +
          f.ruleId +
          '`: ' +
          f.detail,
      );
      lines.push('  - **Required update:** ' + f.requiredUpdate);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Embed a structured receipt for restart/reconnect survival. */
export function encodeProjectStateClosureReceiptBlock(
  receipt: ProjectStateClosureReceipt,
): string {
  const payload = {
    version: receipt.version,
    status: receipt.status,
    ok: receipt.ok,
    applicable: receipt.applicable,
    findings: receipt.findings,
    provenance: receipt.provenance,
    summary: receipt.summary,
  };
  const encoded = JSON.stringify(payload);
  if (utf8ByteLength(encoded) > MAX_PROJECT_STATE_CLOSURE_RECEIPT_BYTES) {
    const slim = JSON.stringify({
      version: receipt.version,
      status: receipt.status,
      ok: receipt.ok,
      applicable: receipt.applicable,
      findings: receipt.findings.slice(0, 4),
      provenance: receipt.provenance,
      summary: boundSnippet(receipt.summary),
    });
    return (
      PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_START +
      '\n' +
      slim +
      '\n' +
      PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_END
    );
  }
  return (
    PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_START +
    '\n' +
    encoded +
    '\n' +
    PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_END
  );
}

/** Parse the last embedded receipt block from task body (restart-safe). */
export function parseProjectStateClosureReceiptFromBody(
  text: string,
): ProjectStateClosureReceipt | null {
  const start = text.lastIndexOf(PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_START);
  if (start < 0) return null;
  const jsonStart = start + PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_START.length;
  const end = text.indexOf(PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_END, jsonStart);
  if (end < 0) return null;
  const raw = text.slice(jsonStart, end).trim();
  if (raw.length === 0 || utf8ByteLength(raw) > MAX_PROJECT_STATE_CLOSURE_RECEIPT_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o['version'] !== PROJECT_STATE_CLOSURE_VERSION) return null;
  if (!isProjectStateClosureStatus(o['status'])) return null;
  if (typeof o['ok'] !== 'boolean' || typeof o['applicable'] !== 'boolean') return null;
  if (typeof o['summary'] !== 'string') return null;
  const prov = o['provenance'];
  if (typeof prov !== 'object' || prov === null || Array.isArray(prov)) return null;
  const p = prov as Record<string, unknown>;
  if (
    typeof p['baseSha'] !== 'string' ||
    typeof p['candidateSha'] !== 'string' ||
    typeof p['mergeTreeSha'] !== 'string' ||
    typeof p['policyDigest'] !== 'string'
  ) {
    return null;
  }
  const findingsRaw = o['findings'];
  if (!Array.isArray(findingsRaw)) return null;
  const findings: ProjectStateClosureFinding[] = [];
  for (const f of findingsRaw) {
    if (typeof f !== 'object' || f === null || Array.isArray(f)) continue;
    const fr = f as Record<string, unknown>;
    if (
      typeof fr['ruleId'] !== 'string' ||
      !isProjectStateSurfaceKind(fr['surface']) ||
      typeof fr['path'] !== 'string' ||
      typeof fr['code'] !== 'string' ||
      typeof fr['detail'] !== 'string' ||
      typeof fr['requiredUpdate'] !== 'string'
    ) {
      continue;
    }
    if (!(PROJECT_STATE_CLOSURE_CODES as readonly string[]).includes(fr['code'])) {
      continue;
    }
    findings.push({
      ruleId: fr['ruleId'],
      surface: fr['surface'],
      path: fr['path'],
      code: fr['code'] as ProjectStateClosureCode,
      detail: fr['detail'],
      requiredUpdate: fr['requiredUpdate'],
    });
  }
  return {
    version: PROJECT_STATE_CLOSURE_VERSION,
    status: o['status'],
    ok: o['ok'],
    applicable: o['applicable'],
    findings,
    provenance: {
      baseSha: p['baseSha'],
      candidateSha: p['candidateSha'],
      mergeTreeSha: p['mergeTreeSha'],
      policyDigest: p['policyDigest'],
    },
    summary: o['summary'],
  };
}

/**
 * Append or replace the durable closure receipt section on a task body.
 * Ownership is the begin/end marker pair (or legacy JSON block). Never
 * replaces a generic user-authored `## Project-state closure` heading.
 */
export function upsertProjectStateClosureReceiptBody(
  body: string,
  receipt: ProjectStateClosureReceipt,
): string {
  return upsertProjectStateClosureReceiptBodyImpl(body, receipt);
}

const PROJECT_STATE_CLOSURE_NL = String.fromCharCode(10);

function projectStateClosureOwnedSection(receipt: ProjectStateClosureReceipt): string {
  const nl = PROJECT_STATE_CLOSURE_NL;
  return PROJECT_STATE_CLOSURE_RECEIPT_SECTION_BEGIN + nl +
    formatProjectStateClosureReceipt(receipt).trimEnd() + nl + nl +
    encodeProjectStateClosureReceiptBlock(receipt) + nl +
    PROJECT_STATE_CLOSURE_RECEIPT_SECTION_END + nl;
}

function hasOtherH2Between(between: string): boolean {
  const nl = PROJECT_STATE_CLOSURE_NL;
  return between.startsWith('## ') || between.includes(nl + '## ');
}

function findOwnedProjectStateClosureRange(
  text: string,
): { readonly start: number; readonly end: number } | null {
  const beginIdx = text.lastIndexOf(PROJECT_STATE_CLOSURE_RECEIPT_SECTION_BEGIN);
  if (beginIdx >= 0) {
    const byMarkers = findOwnedBySectionMarkers(text, beginIdx);
    if (byMarkers) return byMarkers;
  }
  return findOwnedByLegacyBlock(text);
}

function findOwnedBySectionMarkers(
  text: string,
  beginIdx: number,
): { readonly start: number; readonly end: number } | null {
  const endIdx = text.indexOf(
    PROJECT_STATE_CLOSURE_RECEIPT_SECTION_END,
    beginIdx + PROJECT_STATE_CLOSURE_RECEIPT_SECTION_BEGIN.length,
  );
  if (endIdx < 0) return null;
  let end = endIdx + PROJECT_STATE_CLOSURE_RECEIPT_SECTION_END.length;
  if (text[end] === PROJECT_STATE_CLOSURE_NL) end += 1;
  return { start: beginIdx, end };
}

function findOwnedByLegacyBlock(
  text: string,
): { readonly start: number; readonly end: number } | null {
  const blockStart = text.lastIndexOf(PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_START);
  if (blockStart < 0) return null;
  const jsonStart = blockStart + PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_START.length;
  const blockEndMark = text.indexOf(PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_END, jsonStart);
  if (blockEndMark < 0) return null;
  let end = blockEndMark + PROJECT_STATE_CLOSURE_RECEIPT_BLOCK_END.length;
  if (text[end] === PROJECT_STATE_CLOSURE_NL) end += 1;
  let start = blockStart;
  const before = text.slice(0, blockStart);
  const headingIdx = before.lastIndexOf(PROJECT_STATE_CLOSURE_RECEIPT_HEADING);
  if (headingIdx >= 0) {
    const between = before.slice(headingIdx + PROJECT_STATE_CLOSURE_RECEIPT_HEADING.length);
    if (!hasOtherH2Between(between) && between.includes('**Verdict:**')) {
      start = headingIdx;
    }
  }
  return { start, end };
}

function spliceOwnedProjectStateClosureSection(
  body: string,
  owned: { readonly start: number; readonly end: number },
  section: string,
): string {
  const nl = PROJECT_STATE_CLOSURE_NL;
  const before = body.slice(0, owned.start).trimEnd();
  let after = body.slice(owned.end);
  while (after.startsWith(nl)) after = after.slice(1);
  const parts: string[] = [];
  if (before.length > 0) parts.push(before);
  parts.push(section.trimEnd());
  if (after.length > 0) parts.push(after);
  return parts.join(nl + nl) + nl;
}

function upsertProjectStateClosureReceiptBodyImpl(
  body: string,
  receipt: ProjectStateClosureReceipt,
): string {
  const section = projectStateClosureOwnedSection(receipt);
  const trimmed = body.trimEnd();
  const owned = findOwnedProjectStateClosureRange(trimmed);
  if (owned) {
    return spliceOwnedProjectStateClosureSection(trimmed, owned, section);
  }
  if (trimmed.length === 0) return section;
  return trimmed + PROJECT_STATE_CLOSURE_NL + PROJECT_STATE_CLOSURE_NL + section;
}

/**
 * Derive the four delivery lanes as separate states.
 * Never equates merge success with project-state closure or deployment.
 */
export function deriveDeliveryPipelineStages(input: {
  readonly verifiedSha?: string | null;
  readonly state: string;
  readonly mergedSha?: string | null;
  readonly prStatus?: string | null;
  readonly projectStateClosureStatus?: ProjectStateClosureStatus | null;
  /** Repo has an opt-in contract (from trusted WORKFLOW). */
  readonly hasClosureContract: boolean;
  readonly stagingStatus?: string | null;
  readonly productionSha?: string | null;
  readonly hasDeployPolicy?: boolean;
}): DeliveryPipelineStages {
  const verified =
    input.verifiedSha !== undefined &&
    input.verifiedSha !== null &&
    input.verifiedSha !== '';
  const merged =
    input.mergedSha !== undefined &&
    input.mergedSha !== null &&
    input.mergedSha !== '';

  let verification: DeliveryLaneState = verified ? 'passed' : 'missing';
  if (input.state === 'failed' && !verified) verification = 'failed';

  let mergeEligibility: DeliveryLaneState;
  if (merged || input.prStatus === 'merged') {
    mergeEligibility = 'merged';
  } else if (input.state === 'done' && verified) {
    mergeEligibility = 'eligible';
  } else if (input.state === 'done' && !verified) {
    mergeEligibility = 'blocked';
  } else if (input.state === 'review') {
    mergeEligibility = 'pending';
  } else {
    mergeEligibility = 'not_applicable';
  }

  let projectStateClosure: DeliveryLaneState;
  if (!input.hasClosureContract) {
    projectStateClosure = 'not_applicable';
  } else if (input.projectStateClosureStatus === 'passed') {
    projectStateClosure = 'passed';
  } else if (input.projectStateClosureStatus === 'failed') {
    projectStateClosure = 'failed';
  } else if (input.projectStateClosureStatus === 'not_applicable') {
    projectStateClosure = 'not_applicable';
  } else if (merged) {
    // Merged without a closure stamp while contract exists — do not claim closed.
    projectStateClosure = 'pending';
  } else if (input.state === 'done' && verified) {
    projectStateClosure = 'pending';
  } else {
    projectStateClosure = 'pending';
  }

  let deployment: DeliveryLaneState = 'not_applicable';
  if (input.hasDeployPolicy) {
    if (input.productionSha) {
      deployment = 'production';
    } else if (input.stagingStatus === 'ready') {
      deployment = 'ready';
    } else if (
      input.stagingStatus === 'deploying' ||
      input.stagingStatus === 'verifying'
    ) {
      deployment = 'deploying';
    } else if (input.stagingStatus === 'failed') {
      deployment = 'failed';
    } else {
      deployment = 'pending';
    }
  }

  return {
    verification,
    mergeEligibility,
    projectStateClosure,
    deployment,
  };
}

/** Bounded merge-failure reason naming surface + required update. */
export function formatProjectStateClosureBlockReason(
  receipt: ProjectStateClosureReceipt,
): string {
  if (receipt.ok) {
    return 'project-state closure passed';
  }
  const first = receipt.findings[0];
  if (!first) {
    return (
      'project-state closure blocked before push (policy ' +
      shortSha(receipt.provenance.policyDigest) +
      ')'
    );
  }
  return (
    'project-state closure blocked before push: surface `' +
    first.surface +
    '` path=`' +
    first.path +
    '` (' +
    first.code +
    ') — ' +
    first.requiredUpdate +
    ' [base=' +
    shortSha(receipt.provenance.baseSha) +
    ' candidate=' +
    shortSha(receipt.provenance.candidateSha) +
    ' merge=' +
    shortSha(receipt.provenance.mergeTreeSha) +
    ' policy=' +
    shortSha(receipt.provenance.policyDigest) +
    ']'
  );
}
