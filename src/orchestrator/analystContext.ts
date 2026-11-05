/**
 * Analyst stage — compile a bounded, trusted-mirror repo context for the
 * intent→draft LLM. Pure orchestration over injected read helpers; no spawn.
 */
import { parseWorkflow } from '../control/workflow.js';
import { extractEvidenceMatchKeywords } from '../domain/mechProof.js';
import type { RepoConfig } from '../domain/repos.js';

export interface AnalystRepoContext {
  readonly repoKey: string;
  readonly archetype: 'code' | 'browser' | 'bounded_non_code';
  readonly agentsMd: string | null;
  readonly workflowGates: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly evidenceAnchors: readonly string[];
  readonly testFiles: readonly string[];
  readonly intentHits: readonly string[];
}

export interface AnalystContextDeps {
  readTrustedFile(repo: RepoConfig, path: string): Promise<string | null>;
  listTrustedFiles(
    repo: RepoConfig,
    opts?: { readonly maxEntries?: number },
  ): Promise<readonly string[]>;
  grepTrusted(
    repo: RepoConfig,
    pattern: string,
    opts?: { readonly pathspec?: readonly string[]; readonly maxLines?: number },
  ): Promise<readonly string[]>;
  readWorkflow(repo: RepoConfig): Promise<string | null>;
}

const AGENTS_MD_MAX = 6_000;
const EVIDENCE_ANCHOR_CAP = 300;
const TEST_FILE_CAP = 400;
const INTENT_HIT_CAP = 60;
const INTENT_KEYWORD_CAP = 6;
const CONTEXT_TEXT_BUDGET = 40_000;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const EVIDENCE_GREP = String.raw`data-evidence\s*=\s*["']?([\w-]+)`;
const EVIDENCE_VALUE_RE = /data-evidence\s*=\s*["']?([\w-]+)/gi;

/** Escape a literal for POSIX ERE (`git grep -E`). */
export function escapeEreLiteral(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

function truncateAtLineBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastNl = slice.lastIndexOf('\n');
  if (lastNl <= 0) return slice;
  return slice.slice(0, lastNl);
}

function repoArchetype(repo: RepoConfig): 'code' | 'browser' | 'bounded_non_code' {
  if (!('archetype' in repo)) return 'code';
  const a = (repo as { readonly archetype?: unknown }).archetype;
  if (a === 'browser' || a === 'bounded_non_code' || a === 'code') return a;
  return 'code';
}

function intentKeywords(intent: string): readonly string[] {
  const { keywords } = extractEvidenceMatchKeywords(intent);
  const usable: string[] = [];
  const seen = new Set<string>();
  for (const k of keywords) {
    if (k.length < 3) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push(k);
    if (usable.length >= INTENT_KEYWORD_CAP) break;
  }
  return usable;
}

function estimateContextChars(ctx: AnalystRepoContext): number {
  return (
    (ctx.agentsMd?.length ?? 0) +
    ctx.workflowGates.join('\n').length +
    ctx.protectedPaths.join('\n').length +
    ctx.evidenceAnchors.join('\n').length +
    ctx.testFiles.join('\n').length +
    ctx.intentHits.join('\n').length +
    ctx.repoKey.length +
    ctx.archetype.length +
    64
  );
}

function trimListsToBudget(ctx: AnalystRepoContext): AnalystRepoContext {
  if (estimateContextChars(ctx) <= CONTEXT_TEXT_BUDGET) return ctx;
  let evidenceAnchors = [...ctx.evidenceAnchors];
  let testFiles = [...ctx.testFiles];
  let intentHits = [...ctx.intentHits];
  let protectedPaths = [...ctx.protectedPaths];
  let workflowGates = [...ctx.workflowGates];
  const shrink = (): AnalystRepoContext => ({
    ...ctx,
    workflowGates,
    protectedPaths,
    evidenceAnchors,
    testFiles,
    intentHits,
  });
  // Prefer trimming the large lists; never mid-line AGENTS.md (already line-bounded).
  while (estimateContextChars(shrink()) > CONTEXT_TEXT_BUDGET) {
    if (intentHits.length > 0) {
      intentHits = intentHits.slice(0, Math.max(0, intentHits.length - 10));
      continue;
    }
    if (testFiles.length > 40) {
      testFiles = testFiles.slice(0, Math.max(40, Math.floor(testFiles.length * 0.75)));
      continue;
    }
    if (evidenceAnchors.length > 20) {
      evidenceAnchors = evidenceAnchors.slice(
        0,
        Math.max(20, Math.floor(evidenceAnchors.length * 0.75)),
      );
      continue;
    }
    if (protectedPaths.length > 0) {
      protectedPaths = protectedPaths.slice(0, Math.max(0, protectedPaths.length - 5));
      continue;
    }
    if (workflowGates.length > 0) {
      workflowGates = workflowGates.slice(0, Math.max(0, workflowGates.length - 1));
      continue;
    }
    break;
  }
  return shrink();
}

export async function compileAnalystContext(
  deps: AnalystContextDeps,
  repo: RepoConfig,
  intent: string,
): Promise<AnalystRepoContext> {
  const agentsRaw = await deps.readTrustedFile(repo, 'AGENTS.md');
  const agentsMd =
    agentsRaw === null ? null : truncateAtLineBoundary(agentsRaw, AGENTS_MD_MAX);

  let workflowGates: string[] = [];
  let protectedPaths: string[] = [];
  const workflowContent = await deps.readWorkflow(repo);
  if (workflowContent) {
    try {
      const wf = parseWorkflow(workflowContent);
      workflowGates = wf.gates.map((g) => g.name);
      protectedPaths = [...wf.protectedPaths];
    } catch {
      // Unparseable WORKFLOW → empty gates/paths; draft still proceeds.
    }
  }

  const evidenceLines = await deps.grepTrusted(repo, EVIDENCE_GREP, {
    pathspec: ['src'],
    maxLines: EVIDENCE_ANCHOR_CAP * 2,
  });
  const anchorSet = new Set<string>();
  for (const line of evidenceLines) {
    EVIDENCE_VALUE_RE.lastIndex = 0;
    for (const m of line.matchAll(EVIDENCE_VALUE_RE)) {
      const v = m[1];
      if (v) anchorSet.add(v);
      if (anchorSet.size >= EVIDENCE_ANCHOR_CAP) break;
    }
    if (anchorSet.size >= EVIDENCE_ANCHOR_CAP) break;
  }
  const evidenceAnchors = [...anchorSet].slice(0, EVIDENCE_ANCHOR_CAP);

  const allFiles = await deps.listTrustedFiles(repo, { maxEntries: 5000 });
  const testFiles = allFiles.filter((p) => TEST_FILE_RE.test(p)).slice(0, TEST_FILE_CAP);

  const keywords = intentKeywords(intent);
  let intentHits: readonly string[] = [];
  if (keywords.length > 0) {
    const pattern = keywords.map(escapeEreLiteral).join('|');
    if (pattern.length <= 200) {
      intentHits = (await deps.grepTrusted(repo, pattern, { maxLines: INTENT_HIT_CAP })).slice(
        0,
        INTENT_HIT_CAP,
      );
    }
  }

  return trimListsToBudget({
    repoKey: repo.key,
    archetype: repoArchetype(repo),
    agentsMd,
    workflowGates,
    protectedPaths,
    evidenceAnchors,
    testFiles,
    intentHits,
  });
}
