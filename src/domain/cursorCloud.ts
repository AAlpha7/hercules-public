/**
 * Domain — Cursor Cloud Agent factory types (first ring).
 *
 * Pure: no fetch/fs. The adapter talks to an injected {@link CursorCloudClient};
 * the HTTP mapper lives in `src/adapters/`. The done artifact is a GitHub PR.
 */
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';
import { parseGithubPrUrl } from './prIdentity.js';
import { hasOpenPr } from './task.js';

export const CURSOR_CLOUD_REMOTE_STATUSES = [
  'creating',
  'running',
  'finished',
  'failed',
  'stopped',
] as const;

export type CursorCloudRemoteStatus = (typeof CURSOR_CLOUD_REMOTE_STATUSES)[number];

export interface FactoryPrArtifact {
  readonly prUrl: string;
  readonly prNumber: number;
}

export interface CursorCloudLaunchRequest {
  readonly prompt: string;
  readonly repository: string;
  readonly ref?: string;
  /**
   * Open factory PR this launch must update. When set, the HTTP mapper
   * sends v0 `source.prUrl` so `autoBranch: false` applies and Cursor
   * pushes that head instead of opening a second PR.
   */
  readonly existingPr?: FactoryPrArtifact;
}

/** v0 `target` flags. First launch opens a PR; rework updates the tracked one. */
export interface FactoryCloudLaunchTarget {
  readonly autoCreatePr: boolean;
  readonly autoBranch: boolean;
}

/**
 * v0 `source`. `autoBranch` only applies when `prUrl` is set — repository
 * + ref + `autoBranch: false` is ignored and Cursor may fork a new branch.
 */
export type FactoryCloudLaunchSource =
  | { readonly prUrl: string }
  | { readonly repository: string; readonly ref?: string };

export function factoryCloudLaunchTarget(
  existingPr: FactoryPrArtifact | null,
): FactoryCloudLaunchTarget {
  if (existingPr) {
    return { autoCreatePr: false, autoBranch: false };
  }
  return { autoCreatePr: true, autoBranch: true };
}

/**
 * Done artifact for a factory run. Rework never replaces the tracked PR
 * with a newly opened one from a second autoCreatePr.
 */
export function resolveFactoryCloudPr(
  snapshot: CursorCloudSnapshot,
  existingPr?: FactoryPrArtifact | null,
): FactoryPrArtifact | undefined {
  if (existingPr) return existingPr;
  return snapshot.pr;
}

export interface CursorCloudSnapshot {
  readonly id: string;
  readonly status: CursorCloudRemoteStatus;
  readonly pr?: FactoryPrArtifact;
  readonly summary?: string;
}

/**
 * Injected Cursor Cloud transport. Tests supply a fake; production wires HTTP.
 * Never put API keys on this interface — the implementation holds them.
 */
export interface CursorCloudClient {
  launch(request: CursorCloudLaunchRequest): Promise<CursorCloudSnapshot>;
  get(id: string): Promise<CursorCloudSnapshot>;
  stop(id: string): Promise<void>;
}

export function factoryPrFromUrl(url: string | null | undefined): FactoryPrArtifact | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  const parsed = parseGithubPrUrl(trimmed);
  if (!parsed) return null;
  return { prUrl: trimmed, prNumber: parsed.number };
}

/** Pin rework to the tracked PR. First launch stays repository + optional ref. */
export function factoryCloudLaunchSource(input: {
  readonly repository: string;
  readonly ref?: string;
  readonly existingPr?: FactoryPrArtifact | null;
}): FactoryCloudLaunchSource {
  const bound = factoryPrFromUrl(input.existingPr?.prUrl);
  if (bound) {
    return { prUrl: bound.prUrl };
  }
  const ref = input.ref?.trim() ?? '';
  if (ref.length > 0) {
    return { repository: input.repository, ref };
  }
  return { repository: input.repository };
}

export function factoryPrArtifact(input: {
  readonly prUrl?: string;
  readonly prNumber?: number;
}): FactoryPrArtifact | null {
  const fromUrl = factoryPrFromUrl(input.prUrl);
  if (!fromUrl) return null;
  if (input.prNumber !== undefined && input.prNumber !== fromUrl.prNumber) return null;
  return fromUrl;
}

/**
 * When a Cloud Agent dies after opening a PR, keep that handle so retry
 * pins (`autoCreatePr: false`) instead of orphaning a second PR.
 * An already-open tracked PR wins over a newly observed one.
 */
export function factoryPrFieldsOnFailure(
  existing: {
    readonly prUrl: string | null;
    readonly prStatus: 'open' | 'merged' | 'closed' | null;
  },
  observed?: FactoryPrArtifact | null,
): { readonly prUrl: string; readonly prStatus: 'open' } | undefined {
  if (hasOpenPr(existing)) {
    const kept = factoryPrFromUrl(existing.prUrl);
    return kept ? { prUrl: kept.prUrl, prStatus: 'open' } : undefined;
  }
  if (!observed) return undefined;
  return { prUrl: observed.prUrl, prStatus: 'open' };
}

export function isCursorCloudTerminal(status: CursorCloudRemoteStatus): boolean {
  return status === 'finished' || status === 'failed' || status === 'stopped';
}

/**
 * Done rule: finished + a PR handle. First launch requires the snapshot PR.
 * Rework of an open factory PR may finish without a new prUrl — the tracked
 * handle is the artifact (`autoCreatePr` is off so Cursor does not open #N+1).
 */
export function isCursorCloudSuccess(
  snapshot: CursorCloudSnapshot,
  existingPr?: FactoryPrArtifact | null,
): boolean {
  if (snapshot.status !== 'finished') return false;
  return resolveFactoryCloudPr(snapshot, existingPr) !== undefined;
}

export function formatCursorCloudFinalMessage(
  snapshot: CursorCloudSnapshot,
  opts?: { readonly taskId?: string | null },
): string {
  const neutOpts =
    typeof opts?.taskId === 'string' && opts.taskId.length > 0
      ? { taskId: opts.taskId }
      : undefined;
  const safeSummary = (raw: string | undefined): string => {
    const trimmed = raw?.trim() ?? '';
    if (trimmed.length === 0) return '';
    return neutralizeUntrustedPacketText(trimmed, neutOpts);
  };
  if (snapshot.pr) {
    const lines = [
      'Cursor Cloud Agent finished.',
      '',
      `PR: ${neutralizeUntrustedPacketText(snapshot.pr.prUrl, neutOpts)}`,
      `PR number: ${snapshot.pr.prNumber}`,
    ];
    const summary = safeSummary(snapshot.summary);
    if (summary) {
      lines.push('', summary);
    }
    return lines.join('\n');
  }
  if (snapshot.status === 'finished') {
    return 'Cursor Cloud Agent finished without a pull request.';
  }
  const summary = safeSummary(snapshot.summary);
  return summary.length > 0
    ? `Cursor Cloud Agent ${snapshot.status}: ${summary}`
    : `Cursor Cloud Agent ${snapshot.status}.`;
}

const V0_RUNNING = new Set(['CREATING', 'RUNNING', 'QUEUED', 'PENDING']);
const V0_FINISHED = new Set(['FINISHED', 'COMPLETED']);
const V0_STOPPED = new Set(['STOPPED', 'CANCELLED', 'CANCELED']);
const V0_FAILED = new Set(['ERROR', 'FAILED', 'EXPIRED']);

/** Map a Cursor Cloud Agents v0 status string onto the domain snapshot. */
export function mapCursorCloudV0Status(raw: string): CursorCloudRemoteStatus {
  const key = raw.trim().toUpperCase();
  if (V0_RUNNING.has(key)) return key === 'CREATING' || key === 'QUEUED' || key === 'PENDING'
    ? 'creating'
    : 'running';
  if (V0_FINISHED.has(key)) return 'finished';
  if (V0_STOPPED.has(key)) return 'stopped';
  if (V0_FAILED.has(key)) return 'failed';
  return 'running';
}
