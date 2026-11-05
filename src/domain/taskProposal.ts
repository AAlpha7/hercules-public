/**
 * Structured task proposals from Remote Control chat agents.
 *
 * Agent emits a fenced block; the daemon parses it into a pending proposal.
 * Only a human Approve creates the control-repo task (never auto-create).
 *
 * ```hercules-task-proposal
 * title: Fix silver light scene
 * repo: bookshelf
 * priority: 50
 * body: |
 *   Do the thing.
 *   - [ ] (human) …
 * ```
 */
import { isValidIdentifier } from './task.js';

export interface TaskProposal {
  readonly id: string;
  readonly title: string;
  readonly repo: string | null;
  readonly body: string;
  readonly priority: number | null;
  /** Raw fence text (for audit / edit). */
  readonly raw: string;
  readonly createdAt: string;
  /** Message id that contained this proposal, if known. */
  readonly sourceMessageId: string | null;
}

export interface ParsedProposalFields {
  readonly title: string;
  readonly repo: string | null;
  readonly body: string;
  readonly priority: number | null;
  readonly raw: string;
}

const FENCE_RE =
  /```hercules-task-proposal\s*\n([\s\S]*?)```/gi;

/**
 * Extract all hercules-task-proposal fences from assistant text.
 * Returns empty array when none / malformed.
 */
export function extractTaskProposals(text: string): ParsedProposalFields[] {
  const out: ParsedProposalFields[] = [];
  const re = new RegExp(FENCE_RE.source, FENCE_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    const parsed = parseProposalBody(raw);
    if (parsed) out.push({ ...parsed, raw });
  }
  return out;
}

/**
 * Parse key: value lines + optional body: | block.
 * Requires a non-empty title.
 */
export function parseProposalBody(raw: string): Omit<ParsedProposalFields, 'raw'> | null {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  let repo: string | null = null;
  let priority: number | null = null;
  let bodyLines: string[] = [];
  let inBody = false;
  let bodyIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (inBody) {
      if (bodyIndent > 0 && line.length > 0 && !line.startsWith(' '.repeat(bodyIndent)) && !line.startsWith('\t')) {
        // dedent ended — treat as next key if it looks like key:
        if (/^[a-zA-Z_][\w-]*\s*:/.test(line)) {
          inBody = false;
          // fall through to key parsing
        } else {
          bodyLines.push(line);
          continue;
        }
      } else {
        bodyLines.push(bodyIndent > 0 ? line.slice(bodyIndent) : line);
        continue;
      }
    }

    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = (kv[1] ?? '').toLowerCase();
    const val = (kv[2] ?? '').trim();

    if (key === 'title') {
      title = val;
    } else if (key === 'repo') {
      repo = val.length > 0 && isValidIdentifier(val) ? val : null;
    } else if (key === 'priority') {
      const n = Number(val);
      priority = Number.isFinite(n) ? Math.floor(n) : null;
    } else if (key === 'body') {
      if (val === '|' || val === '>') {
        inBody = true;
        bodyIndent = 2; // common YAML block indent
        bodyLines = [];
      } else if (val.length > 0) {
        bodyLines = [val];
      } else {
        inBody = true;
        bodyIndent = 0;
        bodyLines = [];
      }
    }
  }

  const body = bodyLines.join('\n').trim();
  if (title.trim().length === 0) return null;
  return {
    title: title.trim().slice(0, 200),
    repo,
    body: body.length > 0 ? body : `## Task\n\n${title.trim()}\n\n## Acceptance criteria\n- [ ] (human) Confirm scope\n`,
    priority,
  };
}

/** Stable-ish id for a proposal (content hash lite). */
export function proposalIdFrom(fields: ParsedProposalFields, salt = ''): string {
  const s = `${fields.title}|${fields.repo ?? ''}|${fields.body.slice(0, 80)}|${salt}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `tp-${(h >>> 0).toString(36)}`;
}
