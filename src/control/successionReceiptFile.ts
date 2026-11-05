/** Strict integrity-sealed persistence for `successions/<repoKey>.json`. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isValidIdentifier } from '../domain/task.js';
import {
  WORKSPACE_SUCCESSION_VERSION,
  type WorkspaceSuccessionLedger,
} from '../domain/workspaceSuccession.js';

export class SuccessionFileError extends Error {
  override readonly name = 'SuccessionFileError';
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const nullableSha = sha.nullable();
const guidance = z.object({
  code: z.enum(['no_action', 'fast_forward_optional', 'preserve_local_commits',
    'inspect_divergence', 'stash_or_commit_dirty', 'reregister_or_skip', 'reobserve']),
  text: z.string().max(280),
  destructive: z.literal(false),
}).strict();
const receipt = z.object({
  id: z.string().refine(isValidIdentifier),
  repoKey: z.string().refine(isValidIdentifier),
  createdAt: z.string().datetime(),
  priorDefaultRevision: sha,
  gateMergeSha: sha,
  canonicalDefaultRevision: sha,
  candidates: z.array(z.object({
    taskId: z.string().refine(isValidIdentifier),
    verifiedSha: sha,
    lease: z.object({
      branch: z.string(),
      expectedBaseRevision: sha,
      expectedRemoteTip: sha,
    }).strict(),
  }).strict()).min(1).max(32),
  managed: z.array(z.object({
    taskId: z.string().refine(isValidIdentifier),
    disposition: z.enum(['live', 'preserved', 'removed', 'absent', 'unknown']),
  }).strict()).max(32),
  external: z.array(z.object({
    registrationId: z.string().refine(isValidIdentifier),
    classification: z.enum(['current', 'clean-behind', 'local-ahead', 'diverged',
      'dirty', 'unavailable', 'unknown']),
    headSha: nullableSha,
    dirty: z.boolean(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    concurrentChange: z.boolean(),
    guidance: z.array(guidance).max(3),
  }).strict()).max(16),
  supersedesReceiptId: z.string().refine(isValidIdentifier).nullable(),
}).strict();
const ledgerSchema = z.object({
  version: z.literal(WORKSPACE_SUCCESSION_VERSION),
  repoKey: z.string().refine(isValidIdentifier),
  receipts: z.array(receipt).max(32),
}).strict();
const fileSchema = z.object({
  version: z.literal(WORKSPACE_SUCCESSION_VERSION),
  repoKey: z.string().refine(isValidIdentifier),
  receipts: z.array(receipt).max(32),
  integrity: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

function seal(payload: WorkspaceSuccessionLedger): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

export function serializeSuccessionLedger(ledger: WorkspaceSuccessionLedger): string {
  const parsed = ledgerSchema.safeParse(ledger);
  if (!parsed.success) throw new SuccessionFileError(`invalid ledger: ${parsed.error.message}`);
  return `${JSON.stringify({ ...parsed.data, integrity: seal(parsed.data) })}\n`;
}

export function parseSuccessionLedger(text: string, stem: string): WorkspaceSuccessionLedger {
  if (!isValidIdentifier(stem)) throw new SuccessionFileError('unsafe receipt stem');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SuccessionFileError(`torn or invalid JSON: ${(err as Error).message}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new SuccessionFileError(`invalid receipt: ${parsed.error.message}`);
  const { integrity, ...ledger } = parsed.data;
  if (ledger.repoKey !== stem) throw new SuccessionFileError('receipt repo mismatch');
  if (integrity !== seal(ledger)) throw new SuccessionFileError('receipt integrity mismatch');
  const receiptIds = new Set<string>();
  for (const [index, item] of ledger.receipts.entries()) {
    if (item.repoKey !== stem || item.id !== `succ-${stem}-${item.gateMergeSha}`) {
      throw new SuccessionFileError('receipt identity mismatch');
    }
    if (receiptIds.has(item.id)) throw new SuccessionFileError('duplicate receipt id');
    receiptIds.add(item.id);
    if (index > 0 && item.supersedesReceiptId !== ledger.receipts[index - 1]!.id) {
      throw new SuccessionFileError('receipt succession link mismatch');
    }
    if (item.candidates.some((candidate) => candidate.lease.branch !== `hercules/${candidate.taskId}`)) {
      throw new SuccessionFileError('receipt lease mismatch');
    }
    const candidateIds = item.candidates.map((candidate) => candidate.taskId);
    const managedIds = item.managed.map((managed) => managed.taskId);
    const registrationIds = item.external.map((external) => external.registrationId);
    if (new Set(candidateIds).size !== candidateIds.length ||
        new Set(managedIds).size !== managedIds.length ||
        new Set(registrationIds).size !== registrationIds.length) {
      throw new SuccessionFileError('duplicate receipt member id');
    }
    if (candidateIds.length !== managedIds.length ||
        candidateIds.some((id) => !managedIds.includes(id))) {
      throw new SuccessionFileError('managed tasks do not match candidates');
    }
  }
  return ledger;
}
