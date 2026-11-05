/**
 * Domain — trusted CLI behavioral-evidence dialect (Guardian B-022).
 * Independent of browser CDP L2. Plans come only from trusted WORKFLOW
 * `cli_evidence:`. Task bodies never inject argv. Pure: no IO.
 */
import { isValidIdentifier } from './task.js';
import { redactHostOutput } from './hostExecutor.js';

export const CLI_EVIDENCE_VERSION = 1 as const;
export const DEFAULT_CLI_EVIDENCE_TIMEOUT_MS = 30_000;
export const MIN_CLI_EVIDENCE_TIMEOUT_MS = 100;
/**
 * Per-step ceiling. Raised 5 → 20 min on 2026-09-11: a recorded device
 * matrix (20 scenarios × 2 device passes + seed) legitimately runs ~6–10 min
 * in one `cli_evidence` step. The plan-wide budget below keeps a 32-step plan
 * from claiming hours.
 */
export const MAX_CLI_EVIDENCE_TIMEOUT_MS = 20 * 60_000;
/** Sum of every step's timeout_ms must stay within this (fail closed at parse). */
export const MAX_CLI_EVIDENCE_PLAN_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_CLI_EVIDENCE_MAX_OUTPUT_BYTES = 16 * 1024;
export const MIN_CLI_EVIDENCE_MAX_OUTPUT_BYTES = 256;
export const MAX_CLI_EVIDENCE_MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_CLI_EVIDENCE_TOTAL_OUTPUT_BYTES = 64 * 1024;
export const MAX_CLI_EVIDENCE_RECEIPT_BYTES = 512 * 1024;
export const MAX_CLI_EVIDENCE_STEPS = 32;
export const MAX_CLI_EVIDENCE_ARGV = 64;
export const MAX_CLI_EVIDENCE_ARGV_ELEMENT = 512;
/** Max media files collected from a step's artifacts_dir. */
export const MAX_CLI_EVIDENCE_ARTIFACTS_PER_STEP = 24;
/** Per-file size cap for collected CLI evidence media. */
export const MAX_CLI_EVIDENCE_ARTIFACT_BYTES = 10 * 1024 * 1024;
/** Aggregate size cap for collected CLI evidence media per step. */
export const MAX_CLI_EVIDENCE_ARTIFACTS_TOTAL_BYTES = 25 * 1024 * 1024;
export const CLI_EVIDENCE_ARTIFACT_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'webm', 'mp4',
] as const;
export const CLI_EVIDENCE_RECEIPT_HEADING = '## CLI behavioral evidence';
export const CLI_EVIDENCE_RECEIPT_BLOCK_START = '<!-- hercules-cli-evidence:v1';
export const CLI_EVIDENCE_RECEIPT_BLOCK_END = '-->';
export const CLI_EVIDENCE_PACKET_AUTHORITY = '<!-- hercules-cli-evidence-authority:v1 -->';
const MAX_CLI_EVIDENCE_REGEX_LENGTH = 256;
const MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES = 4 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const PLAN_KEYS = new Set(['version', 'steps']);
const STEP_KEYS = new Set([
  'id', 'argv', 'cwd', 'timeout_ms', 'max_output_bytes', 'expect', 'optional',
  'artifacts_dir',
]);
const EXPECT_KEYS = new Set([
  'exit_code', 'stdout_contains', 'stdout_matches',
  'stderr_contains', 'stderr_matches', 'stderr_empty',
]);
const SHELL_WRAPPERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish',
  'env', 'command', 'xargs', 'sudo', 'doas',
]);
const INLINE_INTERPRETER_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  node: new Set([
    '-e', '--eval', '-p', '--print', '-r', '--require', '--import',
    '--loader', '--experimental-loader', '--input-type',
  ]),
  python: new Set(['-c', '-m']),
  python3: new Set(['-c', '-m']),
  perl: new Set(['-e', '-E', '-M', '-m']),
  ruby: new Set(['-e', '-r']),
};

export class CliEvidenceParseError extends Error {
  override readonly name = 'CliEvidenceParseError';
  constructor(message: string) {
    super(message);
  }
}

export interface CliEvidenceExpect {
  readonly exitCode: number;
  readonly stdoutContains?: string;
  readonly stdoutMatches?: string;
  readonly stderrContains?: string;
  readonly stderrMatches?: string;
  readonly stderrEmpty?: boolean;
}

export interface CliEvidenceStep {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly expect: CliEvidenceExpect;
  readonly optional: boolean;
  /** Workspace-relative dir of media to collect after the step (optional). */
  readonly artifactsDir?: string;
}

export type CliEvidenceArtifactKind = 'image' | 'video';

export interface CliEvidenceArtifact {
  /** Served basename under /api/tasks/<id>/screenshots/<name>. */
  readonly name: string;
  readonly kind: CliEvidenceArtifactKind;
  readonly bytes: number;
  /** Lowercase hex sha256 of the collected file bytes. */
  readonly sha256: string;
}

export interface CliEvidencePlan {
  readonly version: typeof CLI_EVIDENCE_VERSION;
  readonly steps: readonly CliEvidenceStep[];
  readonly source: 'workflow';
}

export type CliEvidenceStepStatus =
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'spawn_error'
  | 'oversized_output'
  | 'workspace_escape'
  | 'workspace_mutation'
  | 'sandbox_error'
  | 'not_run'
  | 'omitted';

export type CliEvidenceVerdict = 'passed' | 'failed' | 'not_run';

export interface CliEvidenceAssertionResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CliEvidenceStepReceipt {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly status: CliEvidenceStepStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly assertions: readonly CliEvidenceAssertionResult[];
  readonly ok: boolean;
  readonly optional: boolean;
  readonly omissionReason?: string;
  readonly artifacts?: readonly CliEvidenceArtifact[];
  /** Why some candidates under artifacts_dir were not collected. */
  readonly artifactsSkipped?: string;
}

export interface CliEvidenceReceipt {
  readonly version: typeof CLI_EVIDENCE_VERSION;
  readonly source: 'workflow';
  readonly status: CliEvidenceVerdict;
  readonly ok: boolean;
  readonly steps: readonly CliEvidenceStepReceipt[];
  readonly omissionReason?: string;
  readonly durationMs: number;
}

function hasControlCharacter(el: string): boolean {
  for (let i = 0; i < el.length; i += 1) {
    const code = el.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function parseCwd(raw: unknown, loc: string): string {
  if (raw === undefined || raw === null || raw === '' || raw === '.') return '.';
  if (typeof raw !== 'string') throw new CliEvidenceParseError(loc + '.cwd must be a string');
  if (raw.includes('\0')) throw new CliEvidenceParseError(loc + '.cwd null byte');
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new CliEvidenceParseError(loc + '.cwd must be workspace-relative');
  }
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new CliEvidenceParseError(loc + '.cwd must not contain ..');
  }
  if (parts.length === 0) return '.';
  if (!parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p))) {
    throw new CliEvidenceParseError(loc + '.cwd has unsafe path segments');
  }
  return parts.join('/');
}

/**
 * Workspace-relative media directory. Unlike cwd, `.` / empty (workspace root)
 * is rejected — collection must target an explicit subdirectory.
 */
function parseArtifactsDir(raw: unknown, loc: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new CliEvidenceParseError(loc + '.artifacts_dir must be a string');
  }
  if (raw.includes('\0')) throw new CliEvidenceParseError(loc + '.artifacts_dir null byte');
  if (raw === '' || raw === '.') {
    throw new CliEvidenceParseError(loc + '.artifacts_dir must not be the workspace root');
  }
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new CliEvidenceParseError(loc + '.artifacts_dir must be workspace-relative');
  }
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new CliEvidenceParseError(loc + '.artifacts_dir must not contain ..');
  }
  if (parts.length === 0) {
    throw new CliEvidenceParseError(loc + '.artifacts_dir must not be the workspace root');
  }
  if (!parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p))) {
    throw new CliEvidenceParseError(loc + '.artifacts_dir has unsafe path segments');
  }
  return parts.join('/');
}

export function cliEvidenceArtifactKindForName(name: string): CliEvidenceArtifactKind | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 'image';
  if (ext === 'webm' || ext === 'mp4') return 'video';
  return null;
}

export function isCliEvidenceArtifactExtension(ext: string): boolean {
  const lower = ext.toLowerCase();
  return (CLI_EVIDENCE_ARTIFACT_EXTENSIONS as readonly string[]).includes(lower);
}

function parseTimeout(raw: unknown, loc: string): number {
  if (raw === undefined || raw === null) return DEFAULT_CLI_EVIDENCE_TIMEOUT_MS;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new CliEvidenceParseError(loc + '.timeout_ms must be an integer');
  }
  if (raw < MIN_CLI_EVIDENCE_TIMEOUT_MS || raw > MAX_CLI_EVIDENCE_TIMEOUT_MS) {
    throw new CliEvidenceParseError(loc + '.timeout_ms out of range');
  }
  return raw;
}

function parseMaxOutput(raw: unknown, loc: string): number {
  if (raw === undefined || raw === null) return DEFAULT_CLI_EVIDENCE_MAX_OUTPUT_BYTES;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new CliEvidenceParseError(loc + '.max_output_bytes must be an integer');
  }
  if (raw < MIN_CLI_EVIDENCE_MAX_OUTPUT_BYTES || raw > MAX_CLI_EVIDENCE_MAX_OUTPUT_BYTES) {
    throw new CliEvidenceParseError(loc + '.max_output_bytes out of range');
  }
  return raw;
}

function parseArgv(raw: unknown, loc: string): readonly string[] {
  if (typeof raw === 'string') {
    throw new CliEvidenceParseError(loc + '.argv must be an array (shell strings rejected)');
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CliEvidenceParseError(loc + '.argv must be a non-empty array');
  }
  if (raw.length > MAX_CLI_EVIDENCE_ARGV) {
    throw new CliEvidenceParseError(loc + '.argv exceeds max elements');
  }
  const argv: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const el = raw[i];
    if (typeof el !== 'string' || el.length === 0) {
      throw new CliEvidenceParseError(loc + '.argv[' + i + '] must be a non-empty string');
    }
    if (el.length > MAX_CLI_EVIDENCE_ARGV_ELEMENT) {
      throw new CliEvidenceParseError(loc + '.argv[' + i + '] exceeds max length');
    }
    if (el.includes('\0') || hasControlCharacter(el)) {
      throw new CliEvidenceParseError(loc + '.argv[' + i + '] contains a control character');
    }
    if (
      /^--?(?:token|password|secret|api[_-]?key|credential)(?:=|$)/i.test(el) ||
      /^(?:[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL))=/i.test(el) ||
      /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i.test(el)
    ) {
      throw new CliEvidenceParseError(loc + '.argv must not carry secret values');
    }
    argv.push(el);
  }
  const exe0 = argv[0]!;
  if (exe0.startsWith('/') || /^[A-Za-z]:[\\/]/.test(exe0) || exe0.split('/').includes('..')) {
    throw new CliEvidenceParseError(loc + '.argv[0] must not be absolute or traverse paths');
  }
  const slash = exe0.lastIndexOf('/');
  const base = slash >= 0 ? exe0.slice(slash + 1) : exe0;
  if (SHELL_WRAPPERS.has(base.toLowerCase())) {
    throw new CliEvidenceParseError(loc + '.argv[0] must not be a shell wrapper');
  }
  const inlineFlags = INLINE_INTERPRETER_FLAGS[base.toLowerCase()];
  if (inlineFlags && argv.slice(1).some((arg) => inlineFlags.has(arg))) {
    throw new CliEvidenceParseError(loc + '.argv uses an inline interpreter escape');
  }
  if (inlineFlags) {
    const script = argv.slice(1).find((arg) => !arg.startsWith('-'));
    if (
      script !== undefined &&
      (script.startsWith('/') || /^[A-Za-z]:[\\/]/.test(script) || script.split('/').includes('..'))
    ) {
      throw new CliEvidenceParseError(loc + '.argv interpreter script must be workspace-relative');
    }
  }
  return argv;
}

function parseExpect(raw: unknown, loc: string): CliEvidenceExpect {
  if (raw === undefined || raw === null) return { exitCode: 0 };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliEvidenceParseError(loc + '.expect must be a mapping');
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!EXPECT_KEYS.has(k)) {
      throw new CliEvidenceParseError(loc + '.expect: unknown field ' + k);
    }
  }
  let exitCode = 0;
  if (o['exit_code'] !== undefined) {
    if (typeof o['exit_code'] !== 'number' || !Number.isInteger(o['exit_code'])) {
      throw new CliEvidenceParseError(loc + '.expect.exit_code must be 0..255');
    }
    if (o['exit_code'] < 0 || o['exit_code'] > 255) {
      throw new CliEvidenceParseError(loc + '.expect.exit_code must be 0..255');
    }
    exitCode = o['exit_code'];
  }
  const out: {
    exitCode: number;
    stdoutContains?: string;
    stdoutMatches?: string;
    stderrContains?: string;
    stderrMatches?: string;
    stderrEmpty?: boolean;
  } = { exitCode };
  if (typeof o['stdout_contains'] === 'string' && o['stdout_contains'].length > 0) {
    out.stdoutContains = o['stdout_contains'];
  } else if (o['stdout_contains'] !== undefined) {
    throw new CliEvidenceParseError(loc + '.expect.stdout_contains invalid');
  }
  if (typeof o['stdout_matches'] === 'string' && o['stdout_matches'].length > 0) {
    validateEvidenceRegex(o['stdout_matches'], loc + '.expect.stdout_matches');
    out.stdoutMatches = o['stdout_matches'];
  } else if (o['stdout_matches'] !== undefined) {
    throw new CliEvidenceParseError(loc + '.expect.stdout_matches invalid');
  }
  if (typeof o['stderr_contains'] === 'string' && o['stderr_contains'].length > 0) {
    out.stderrContains = o['stderr_contains'];
  } else if (o['stderr_contains'] !== undefined) {
    throw new CliEvidenceParseError(loc + '.expect.stderr_contains invalid');
  }
  if (typeof o['stderr_matches'] === 'string' && o['stderr_matches'].length > 0) {
    validateEvidenceRegex(o['stderr_matches'], loc + '.expect.stderr_matches');
    out.stderrMatches = o['stderr_matches'];
  } else if (o['stderr_matches'] !== undefined) {
    throw new CliEvidenceParseError(loc + '.expect.stderr_matches invalid');
  }
  if (o['stderr_empty'] === true || o['stderr_empty'] === false) {
    out.stderrEmpty = o['stderr_empty'];
  } else if (o['stderr_empty'] !== undefined) {
    throw new CliEvidenceParseError(loc + '.expect.stderr_empty must be boolean');
  }
  return out;
}

function validateEvidenceRegex(pattern: string, loc: string): void {
  if (pattern.length > MAX_CLI_EVIDENCE_REGEX_LENGTH) {
    throw new CliEvidenceParseError(loc + ' exceeds max regex length');
  }
  // A small linear-time dialect is enough for CLI contracts. Contains covers
  // free-form matching; quantifiers, backrefs and lookarounds are excluded so
  // persisted trusted config cannot create a verifier ReDoS lane.
  if (/[+*?{]/.test(pattern) || /\\[1-9]/.test(pattern) || /\(\?/.test(pattern)) {
    throw new CliEvidenceParseError(loc + ' uses unsupported unsafe regex syntax');
  }
  try { new RegExp(pattern); } catch {
    throw new CliEvidenceParseError(loc + ' invalid regex');
  }
}

function parseStep(raw: unknown, index: number): CliEvidenceStep {
  const loc = 'cli_evidence.steps[' + index + ']';
  if (typeof raw === 'string') {
    throw new CliEvidenceParseError(loc + ': shell/command strings rejected — use argv');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliEvidenceParseError(loc + ': must be a mapping');
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!STEP_KEYS.has(k)) throw new CliEvidenceParseError(loc + ': unknown field ' + k);
  }
  if ('command' in o || 'shell' in o || 'cmd' in o || 'script' in o) {
    throw new CliEvidenceParseError(loc + ': shell/command strings rejected — use argv only');
  }
  if (typeof o['id'] !== 'string' || !isValidIdentifier(o['id'])) {
    throw new CliEvidenceParseError(loc + '.id must be a safe identifier');
  }
  if (o['optional'] !== undefined && o['optional'] !== true && o['optional'] !== false) {
    throw new CliEvidenceParseError(loc + '.optional must be a boolean');
  }
  const artifactsDir = parseArtifactsDir(o['artifacts_dir'], loc);
  return {
    id: o['id'],
    argv: parseArgv(o['argv'], loc),
    cwd: parseCwd(o['cwd'], loc),
    timeoutMs: parseTimeout(o['timeout_ms'], loc),
    maxOutputBytes: parseMaxOutput(o['max_output_bytes'], loc),
    expect: parseExpect(o['expect'], loc),
    optional: o['optional'] === true,
    ...(artifactsDir !== undefined ? { artifactsDir } : {}),
  };
}

export function parseCliEvidenceConfig(raw: unknown): CliEvidencePlan | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliEvidenceParseError('cli_evidence must be a mapping');
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!PLAN_KEYS.has(k)) {
      throw new CliEvidenceParseError('cli_evidence: unknown field ' + k);
    }
  }
  if (o['version'] !== CLI_EVIDENCE_VERSION) {
    throw new CliEvidenceParseError('cli_evidence.version must be 1');
  }
  if (!Array.isArray(o['steps']) || o['steps'].length === 0) {
    throw new CliEvidenceParseError('cli_evidence.steps must be a non-empty array');
  }
  if (o['steps'].length > MAX_CLI_EVIDENCE_STEPS) {
    throw new CliEvidenceParseError('cli_evidence.steps exceeds max');
  }
  const steps: CliEvidenceStep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < o['steps'].length; i += 1) {
    const step = parseStep(o['steps'][i], i);
    if (seen.has(step.id)) {
      throw new CliEvidenceParseError('duplicate step id ' + step.id);
    }
    seen.add(step.id);
    steps.push(step);
  }
  const planTimeoutMs = steps.reduce((sum, step) => sum + step.timeoutMs, 0);
  if (planTimeoutMs > MAX_CLI_EVIDENCE_PLAN_TIMEOUT_MS) {
    throw new CliEvidenceParseError(
      'cli_evidence plan timeouts sum to ' + String(planTimeoutMs) + 'ms, above the ' +
        String(MAX_CLI_EVIDENCE_PLAN_TIMEOUT_MS) + 'ms plan budget',
    );
  }
  // Capture budgets (max_output_bytes) may exceed the receipt total — receipts
  // truncate per step (head+tail marker) so verbose gates never burn the attempt.
  const persistentMetadata = JSON.stringify(steps.map((step) => ({
    id: step.id, argv: step.argv, cwd: step.cwd, optional: step.optional,
  }))).replace(/[<>&]/g, (char) =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  // Worst-case persisted output is the receipt total budget (not sum of capture caps).
  const worstCaseReceiptBytes = utf8ByteLength(persistentMetadata) +
    MAX_CLI_EVIDENCE_TOTAL_OUTPUT_BYTES * 6 + steps.length * 2_048;
  if (worstCaseReceiptBytes > MAX_CLI_EVIDENCE_RECEIPT_BYTES) {
    throw new CliEvidenceParseError('cli_evidence plan exceeds receipt persistence budget');
  }
  return { version: CLI_EVIDENCE_VERSION, steps, source: 'workflow' };
}

export function isPathInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const root = workspaceRoot.endsWith('/') ? workspaceRoot.slice(0, -1) : workspaceRoot;
  const cand =
    candidate.endsWith('/') && candidate.length > 1 ? candidate.slice(0, -1) : candidate;
  if (cand === root) return true;
  return cand.startsWith(root + '/');
}

export function redactCliEvidenceOutput(raw: string, maxBytes: number): string {
  return redactHostOutput(raw, maxBytes);
}

/** Marker inserted between head and tail when truncating CLI evidence output. */
export const CLI_EVIDENCE_TRUNCATION_MARKER_RE =
  /\u2026\s+\d+\s+bytes truncated\s+\u2026/;

/**
 * Truncate UTF-8 text to at most `maxBytes`, keeping a head and a tail with an
 * explicit `… N bytes truncated …` marker. Never hides exit status — callers
 * keep assertion/exit evaluation on the untruncated capture.
 */
export function truncateCliEvidenceOutput(raw: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = enc.encode(raw);
  if (bytes.byteLength <= maxBytes) return raw;
  const omitted = bytes.byteLength - maxBytes;
  // Leave room for the marker inside maxBytes.
  const marker = `\u2026 ${String(omitted)} bytes truncated \u2026`;
  const markerBytes = enc.encode(marker);
  if (markerBytes.byteLength >= maxBytes) {
    return decodeUtf8PrefixLocal(bytes.subarray(0, maxBytes));
  }
  const keep = maxBytes - markerBytes.byteLength;
  const headLen = Math.floor(keep / 2);
  const tailLen = keep - headLen;
  const head = decodeUtf8PrefixLocal(bytes.subarray(0, headLen));
  // Tail: walk forward past any continuation bytes at the cut.
  let tailStart = bytes.byteLength - tailLen;
  while (tailStart < bytes.byteLength && (bytes[tailStart]! & 0xc0) === 0x80) {
    tailStart += 1;
  }
  const tail = dec.decode(bytes.subarray(tailStart));
  return head + marker + tail;
}

function decodeUtf8PrefixLocal(buf: Uint8Array): string {
  let end = buf.byteLength;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (buf[end - 1]! & 0x80) !== 0) {
    const b = buf[end - 1]!;
    if ((b & 0xe0) === 0xc0 || (b & 0xf0) === 0xe0 || (b & 0xf8) === 0xf0) {
      end -= 1;
    }
  }
  return new TextDecoder().decode(buf.subarray(0, end));
}

/**
 * Fit every step's stdout/stderr into the receipt total budget by truncating
 * per step (fair share of remaining bytes). Exit codes / assertion results on
 * the receipt are left untouched.
 */
export function truncateCliEvidenceReceiptSteps(
  steps: readonly CliEvidenceStepReceipt[],
  totalBudget: number = MAX_CLI_EVIDENCE_TOTAL_OUTPUT_BYTES,
): readonly CliEvidenceStepReceipt[] {
  if (steps.length === 0) return steps;
  const sizes = steps.map(
    (s) => utf8ByteLength(s.stdoutTail) + utf8ByteLength(s.stderrTail),
  );
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= totalBudget) return steps;

  // Fair share per step; unused budget cascades to later steps.
  let remainingBudget = totalBudget;
  let remainingSteps = steps.length;
  return steps.map((step) => {
    const fair = Math.max(0, Math.floor(remainingBudget / remainingSteps));
    remainingSteps -= 1;
    const outBytes = utf8ByteLength(step.stdoutTail);
    const errBytes = utf8ByteLength(step.stderrTail);
    const stepTotal = outBytes + errBytes;
    if (stepTotal <= fair) {
      remainingBudget -= stepTotal;
      return step;
    }
    // Prefer keeping some of each stream when both are present.
    let outCap: number;
    let errCap: number;
    if (outBytes === 0) {
      outCap = 0;
      errCap = fair;
    } else if (errBytes === 0) {
      outCap = fair;
      errCap = 0;
    } else {
      outCap = Math.floor(fair / 2);
      errCap = fair - outCap;
    }
    const stdoutTail = truncateCliEvidenceOutput(step.stdoutTail, outCap);
    const stderrTail = truncateCliEvidenceOutput(step.stderrTail, errCap);
    const used = utf8ByteLength(stdoutTail) + utf8ByteLength(stderrTail);
    remainingBudget = Math.max(0, remainingBudget - used);
    return { ...step, stdoutTail, stderrTail };
  });
}

export function isCliEvidenceFailed(receipt: CliEvidenceReceipt | undefined): boolean {
  return receipt !== undefined && receipt.status === 'failed';
}

export function isCliEvidenceNotRun(receipt: CliEvidenceReceipt | undefined): boolean {
  return receipt !== undefined && receipt.status === 'not_run';
}

/** Which captured streams lost bytes to the capture budget (truncate overflow mode). */
export interface CliEvidenceCaptureTruncation {
  readonly stdout: boolean;
  readonly stderr: boolean;
}

/**
 * Content assertions are evaluated on the captured bytes only. A stream that
 * lost bytes to the capture budget can prove a positive match (the bytes are
 * real) but never a negative one: `stdout_contains` that was not seen and
 * `stderr_empty` fail closed with a truncation detail instead of passing on
 * output the runner never saw (Claude round 19 B2 — a step could flood
 * stdout to hide its stderr from `stderr_empty`).
 */
export function evaluateCliEvidenceAssertions(input: {
  readonly expect: CliEvidenceExpect;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated?: CliEvidenceCaptureTruncation;
}): readonly CliEvidenceAssertionResult[] {
  const results: CliEvidenceAssertionResult[] = [];
  const exp = input.expect;
  const truncated = input.truncated ?? { stdout: false, stderr: false };
  const cut = (stream: 'stdout' | 'stderr'): string =>
    stream + ' was truncated at the capture budget before this could be proven';
  const codeOk = input.exitCode === exp.exitCode;
  results.push({
    name: 'exit_code',
    ok: codeOk,
    detail: codeOk
      ? 'exit matches expected'
      : 'exit ' + String(input.exitCode) + ' !== ' + String(exp.exitCode),
  });
  if (exp.stdoutContains !== undefined) {
    const ok = input.stdout.includes(exp.stdoutContains);
    results.push({
      name: 'stdout_contains', ok,
      detail: ok ? 'ok' : truncated.stdout ? cut('stdout') : 'missing',
    });
  }
  if (exp.stdoutMatches !== undefined) {
    let ok = false;
    try { ok = new RegExp(exp.stdoutMatches).test(input.stdout); } catch { ok = false; }
    results.push({
      name: 'stdout_matches', ok,
      detail: ok ? 'ok' : truncated.stdout ? cut('stdout') : 'no match',
    });
  }
  if (exp.stderrContains !== undefined) {
    const ok = input.stderr.includes(exp.stderrContains);
    results.push({
      name: 'stderr_contains', ok,
      detail: ok ? 'ok' : truncated.stderr ? cut('stderr') : 'missing',
    });
  }
  if (exp.stderrMatches !== undefined) {
    const ok = new RegExp(exp.stderrMatches).test(input.stderr);
    results.push({
      name: 'stderr_matches', ok,
      detail: ok ? 'ok' : truncated.stderr ? cut('stderr') : 'no match',
    });
  }
  if (exp.stderrEmpty === true) {
    const empty = input.stderr.trim().length === 0;
    const ok = empty && !truncated.stderr;
    results.push({
      name: 'stderr_empty', ok,
      detail: ok ? 'empty' : truncated.stderr ? cut('stderr') : 'not empty',
    });
  }
  return results;
}

export function omittedCliEvidenceReceipt(
  plan: CliEvidencePlan | null,
  reason: string,
): CliEvidenceReceipt {
  if (!plan) {
    return {
      version: CLI_EVIDENCE_VERSION,
      source: 'workflow',
      status: 'not_run',
      ok: false,
      steps: [],
      omissionReason: reason,
      durationMs: 0,
    };
  }
  return {
    version: plan.version,
    source: 'workflow',
    status: 'not_run',
    ok: false,
    steps: plan.steps.map((s) => ({
      id: s.id,
      argv: s.argv,
      cwd: s.cwd,
      status: 'not_run' as const,
      exitCode: null,
      durationMs: 0,
      stdoutTail: '',
      stderrTail: '',
      assertions: [],
      ok: false,
      optional: s.optional,
      omissionReason: reason,
    })),
    omissionReason: reason,
    durationMs: 0,
  };
}

export function assembleCliEvidenceReceipt(input: {
  readonly plan: CliEvidencePlan;
  readonly steps: readonly CliEvidenceStepReceipt[];
  readonly durationMs: number;
  readonly omissionReason?: string;
}): CliEvidenceReceipt {
  // Always fit tails into the receipt budget (never fail an attempt on volume).
  const fittedSteps = truncateCliEvidenceReceiptSteps(input.steps);
  if (input.omissionReason) {
    return {
      version: input.plan.version,
      source: 'workflow',
      status: 'not_run',
      ok: false,
      steps: fittedSteps,
      omissionReason: input.omissionReason,
      durationMs: input.durationMs,
    };
  }
  const requiredFailed = fittedSteps.some((s) => !s.ok && !s.optional);
  const anyRun = fittedSteps.some(
    (s) => s.status !== 'not_run' && s.status !== 'omitted',
  );
  if (!anyRun) {
    return {
      version: input.plan.version,
      source: 'workflow',
      status: 'not_run',
      ok: false,
      steps: fittedSteps,
      omissionReason: 'no steps executed',
      durationMs: input.durationMs,
    };
  }
  return {
    version: input.plan.version,
    source: 'workflow',
    status: requiredFailed ? 'failed' : 'passed',
    ok: !requiredFailed,
    steps: fittedSteps,
    durationMs: input.durationMs,
  };
}

export function cliEvidenceWorkspaceMutationReceipt(
  receipt: CliEvidenceReceipt,
): CliEvidenceReceipt {
  const integrityStep: CliEvidenceStepReceipt = {
    id: 'workspace-integrity',
    argv: ['git', 'status'],
    cwd: '.',
    status: 'workspace_mutation',
    exitCode: null,
    durationMs: 0,
    stdoutTail: '',
    stderrTail: 'CLI evidence modified the verified worktree; exact baseline restored',
    assertions: [],
    ok: false,
    optional: false,
  };
  return {
    ...receipt,
    status: 'failed',
    ok: false,
    steps: [...receipt.steps, integrityStep],
  };
}

export function formatCliEvidenceReceipt(
  receipt: CliEvidenceReceipt,
  opts?: { readonly taskId?: string },
): string {
  const lines: string[] = [CLI_EVIDENCE_RECEIPT_HEADING, ''];
  const verdict =
    receipt.status === 'passed'
      ? 'passed'
      : receipt.status === 'failed'
        ? 'failed'
        : 'not-run';
  const mark =
    receipt.status === 'passed' ? 'OK' : receipt.status === 'failed' ? 'FAIL' : 'SKIP';
  lines.push(
    '**Verdict:** ' + mark + ' ' + verdict +
      ' source=' + receipt.source +
      ' v' + String(receipt.version) +
      ' ' + String(receipt.durationMs) + 'ms',
  );
  if (receipt.omissionReason) {
    lines.push('**Omission:** ' + formatReceiptText(redactCliEvidenceOutput(
      receipt.omissionReason,
      MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES,
    )));
  }
  lines.push('');
  const taskId = opts?.taskId;
  for (const st of receipt.steps) {
    const sm = st.optional && st.status !== 'passed'
      ? 'OPTIONAL'
      : st.ok
        ? 'OK'
        : st.status === 'not_run'
          ? 'SKIP'
          : 'FAIL';
    lines.push(
      '- ' + sm + ' `' + st.id + '` status=`' + st.status +
        '` exit=' + String(st.exitCode) + ' ' + String(st.durationMs) + 'ms',
    );
    lines.push('  - argv: `' + formatReceiptCode(redactCliEvidenceOutput(
      st.argv.join(' '),
      MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES,
    )) + '` cwd=`' + formatReceiptCode(redactCliEvidenceOutput(st.cwd, 512)) + '`');
    if (st.omissionReason) lines.push('  - omission: ' + formatReceiptText(redactCliEvidenceOutput(
      st.omissionReason,
      MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES,
    )));
    for (const a of st.assertions) {
      lines.push('  - assert ' + (a.ok ? 'OK' : 'FAIL') + ' `' + a.name + '`: ' + a.detail);
    }
    if (st.stdoutTail.length > 0) {
      lines.push('  - stdout: ' + formatReceiptText(st.stdoutTail));
    }
    if (st.stderrTail.length > 0) {
      lines.push('  - stderr: ' + formatReceiptText(st.stderrTail));
    }
    if (st.artifactsSkipped) {
      lines.push('  - artifacts skipped: ' + formatReceiptText(redactCliEvidenceOutput(
        st.artifactsSkipped,
        MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES,
      )));
    }
    // Sheet-pairing lines: one ✅/❌ step marker per artifact so extractEvidenceMedia
    // can label each media tile by step id without guessing.
    if (taskId && st.artifacts && st.artifacts.length > 0) {
      const stepMark = st.ok ? '✅' : '❌';
      for (const art of st.artifacts) {
        lines.push('- ' + stepMark + ' cli ' + st.id);
        const url = '/api/tasks/' + taskId + '/screenshots/' + art.name;
        if (art.kind === 'video') {
          lines.push('[video: ' + art.name + '](' + url + ')');
        } else {
          lines.push('![evidence](' + url + ')');
        }
      }
    }
  }
  return lines.join('\n');
}

function formatReceiptText(text: string): string {
  return text
    .split('\n')
    .slice(-5)
    .join(' | ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', "'");
}

function formatReceiptCode(text: string): string {
  return text.replace(/[\r\n`]/g, ' ');
}

export function serializeCliEvidenceReceipt(receipt: CliEvidenceReceipt): string {
  const encoded = JSON.stringify(receipt).replace(/[<>&]/g, (char) =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  if (utf8ByteLength(encoded) > MAX_CLI_EVIDENCE_RECEIPT_BYTES) {
    throw new CliEvidenceParseError('CLI evidence receipt exceeds persistence budget');
  }
  return CLI_EVIDENCE_RECEIPT_BLOCK_START + '\n' + encoded + '\n' +
    CLI_EVIDENCE_RECEIPT_BLOCK_END;
}

export function neutralizeCliEvidenceStructure(text: string): string {
  return text
    .replaceAll(CLI_EVIDENCE_RECEIPT_BLOCK_START, '<!-- cli-evidence-user-text:v1')
    .replaceAll(CLI_EVIDENCE_PACKET_AUTHORITY, '<!-- cli-evidence-authority-user-text:v1 -->');
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validReceiptString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && utf8ByteLength(value) <= maxBytes;
}

function isStrictCliEvidenceReceipt(value: unknown): value is CliEvidenceReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (!exactKeys(receipt, new Set([
    'version', 'source', 'status', 'ok', 'steps', 'omissionReason', 'durationMs',
  ]))) return false;
  if (
    receipt['version'] !== CLI_EVIDENCE_VERSION || receipt['source'] !== 'workflow' ||
    !['passed', 'failed', 'not_run'].includes(String(receipt['status'])) ||
    typeof receipt['ok'] !== 'boolean' ||
    typeof receipt['durationMs'] !== 'number' || !Number.isFinite(receipt['durationMs']) ||
    receipt['durationMs'] < 0 || !Array.isArray(receipt['steps']) ||
    receipt['steps'].length > MAX_CLI_EVIDENCE_STEPS + 1 ||
    (receipt['omissionReason'] !== undefined &&
      !validReceiptString(receipt['omissionReason'], MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES))
  ) return false;
  if (receipt['ok'] !== (receipt['status'] === 'passed')) return false;
  let outputBytes = 0;
  let anyRun = false;
  let requiredFailed = false;
  for (const rawStep of receipt['steps']) {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) return false;
    const step = rawStep as Record<string, unknown>;
    if (!exactKeys(step, new Set([
      'id', 'argv', 'cwd', 'status', 'exitCode', 'durationMs', 'stdoutTail', 'stderrTail',
      'assertions', 'ok', 'optional', 'omissionReason', 'artifacts', 'artifactsSkipped',
    ]))) return false;
    if (
      !validReceiptString(step['id'], 128) || !isValidIdentifier(step['id']) ||
      !Array.isArray(step['argv']) || step['argv'].length > MAX_CLI_EVIDENCE_ARGV ||
      !step['argv'].every((arg) => validReceiptString(arg, MAX_CLI_EVIDENCE_ARGV_ELEMENT)) ||
      !validReceiptString(step['cwd'], 1024) ||
      !['passed', 'failed', 'timeout', 'spawn_error', 'oversized_output', 'workspace_escape',
        'workspace_mutation', 'sandbox_error', 'not_run', 'omitted'].includes(String(step['status'])) ||
      !(step['exitCode'] === null || (typeof step['exitCode'] === 'number' &&
        Number.isInteger(step['exitCode']))) ||
      typeof step['durationMs'] !== 'number' || !Number.isFinite(step['durationMs']) ||
      step['durationMs'] < 0 || typeof step['ok'] !== 'boolean' ||
      typeof step['optional'] !== 'boolean' || !Array.isArray(step['assertions']) ||
      step['assertions'].length > 8 ||
      (step['omissionReason'] !== undefined &&
        !validReceiptString(step['omissionReason'], MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES)) ||
      (step['artifactsSkipped'] !== undefined &&
        !validReceiptString(step['artifactsSkipped'], MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES)) ||
      !validReceiptString(step['stdoutTail'], MAX_CLI_EVIDENCE_TOTAL_OUTPUT_BYTES) ||
      !validReceiptString(step['stderrTail'], MAX_CLI_EVIDENCE_TOTAL_OUTPUT_BYTES)
    ) return false;
    if (step['artifacts'] !== undefined) {
      if (!Array.isArray(step['artifacts']) ||
        step['artifacts'].length > MAX_CLI_EVIDENCE_ARTIFACTS_PER_STEP) return false;
      for (const rawArt of step['artifacts']) {
        if (!rawArt || typeof rawArt !== 'object' || Array.isArray(rawArt)) return false;
        const art = rawArt as Record<string, unknown>;
        if (!exactKeys(art, new Set(['name', 'kind', 'bytes', 'sha256']))) return false;
        if (
          !validReceiptString(art['name'], 256) ||
          !/^[A-Za-z0-9._-]+$/.test(String(art['name'])) ||
          cliEvidenceArtifactKindForName(String(art['name'])) !== art['kind'] ||
          (art['kind'] !== 'image' && art['kind'] !== 'video') ||
          typeof art['bytes'] !== 'number' || !Number.isInteger(art['bytes']) ||
          art['bytes'] < 0 || art['bytes'] > MAX_CLI_EVIDENCE_ARTIFACT_BYTES ||
          typeof art['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(art['sha256'])
        ) return false;
      }
    }
    const ran = step['status'] !== 'not_run' && step['status'] !== 'omitted';
    anyRun ||= ran;
    requiredFailed ||= ran && step['ok'] === false && step['optional'] === false;
    if (step['status'] === 'passed' && step['ok'] !== true) return false;
    if (!ran && step['ok'] !== false) return false;
    if (ran && step['status'] !== 'passed' && step['ok'] !== step['optional']) return false;
    // Truncated receipts may still carry large per-step capture tails that were
    // fitted at assemble time; reject only when the persisted sum exceeds the
    // budget (and the text is not a recognized truncated form that somehow
    // overflowed — that is a writer bug).
    outputBytes += utf8ByteLength(step['stdoutTail']) + utf8ByteLength(step['stderrTail']);
    if (outputBytes > MAX_CLI_EVIDENCE_TOTAL_OUTPUT_BYTES) return false;
    for (const rawAssertion of step['assertions']) {
      if (!rawAssertion || typeof rawAssertion !== 'object' || Array.isArray(rawAssertion)) return false;
      const assertion = rawAssertion as Record<string, unknown>;
      if (!exactKeys(assertion, new Set(['name', 'ok', 'detail'])) ||
        !validReceiptString(assertion['name'], 128) || typeof assertion['ok'] !== 'boolean' ||
        !validReceiptString(assertion['detail'], MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES)) return false;
    }
  }
  if (receipt['status'] === 'passed' && (!anyRun || requiredFailed)) return false;
  if (receipt['status'] === 'failed' && (!anyRun || !requiredFailed)) return false;
  if (receipt['status'] === 'not_run' &&
    (anyRun || requiredFailed || !validReceiptString(receipt['omissionReason'],
      MAX_CLI_EVIDENCE_DIAGNOSTIC_BYTES) || receipt['omissionReason'].length === 0)) return false;
  return true;
}

export function extractCliEvidenceReceipt(text: string): CliEvidenceReceipt | null {
  const start = text.lastIndexOf(CLI_EVIDENCE_RECEIPT_BLOCK_START);
  if (start < 0) return null;
  const jsonStart = start + CLI_EVIDENCE_RECEIPT_BLOCK_START.length;
  const end = text.indexOf(CLI_EVIDENCE_RECEIPT_BLOCK_END, jsonStart);
  if (end < 0 || utf8ByteLength(text.slice(jsonStart, end)) >
    MAX_CLI_EVIDENCE_RECEIPT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(jsonStart, end).trim());
    return isStrictCliEvidenceReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
