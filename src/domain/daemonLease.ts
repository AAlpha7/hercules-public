/**
 * Domain layer -- exclusive daemon / work-root lease (Guardian B-022).
 *
 * Pure types + decision logic for single-daemon ownership of a canonical
 * (control-repo, work-root) scope. No fs/git/network. Identity resists PID
 * reuse by binding instance UUID + pid + process starttime + boot id.
 *
 * Ownership primitive (isolation layer): util-linux flock held by a
 * long-lived child process. Domain only classifies diagnostic owner
 * records + identity (no fs/git/network).
 */

/** On-disk lease schema version. */
export const DAEMON_LEASE_VERSION = 1 as const;

/**
 * Advisory lock file under the work root.
 * Exclusivity is util-linux flock on this path - not directory rename.
 */
export const DAEMON_LEASE_LOCK_FILENAME = '.hercules-daemon.lease.lock';

/** Diagnostic owner record beside the work-root lock (not the ownership primitive). */
export const DAEMON_LEASE_OWNER_FILENAME = '.hercules-daemon.lease.json';

/** Advisory lock under the control repo git common dir (never tracked). */
export const DAEMON_LEASE_GIT_LOCK_FILENAME = 'hercules-daemon.lease.lock';

/** Diagnostic owner record under the control git common dir. */
export const DAEMON_LEASE_GIT_OWNER_FILENAME = 'hercules-daemon.lease.json';

/**
 * Sidecar directory name (sibling of a non-git control root) for control-side
 * lease artifacts. Never place control lease files inside the control worktree
 * - they must not become tracked when the root later gains a .git.
 */
export const DAEMON_LEASE_CONTROL_SIDECAR_DIR = '.hercules-daemon-leases';

/**
 * Legacy pid-only lock written by older reclaimOrphans (2026-07-17 incident).
 * Still recognized as a foreign live owner during transition.
 */
export const LEGACY_OWNER_LOCK_FILENAME = '.hercules-owner.lock';

/** Process identity that resists simple PID reuse. */
export interface DaemonLeaseIdentity {
  readonly instanceId: string;
  readonly pid: number;
  /** `/proc/<pid>/stat` starttime (jiffies since boot), or empty when unknown. */
  readonly starttime: string;
  /** `/proc/sys/kernel/random/boot_id`, or empty when unknown. */
  readonly bootId: string;
}

/** Durable lease record written to disk. */
export interface DaemonLeaseRecord {
  readonly version: typeof DAEMON_LEASE_VERSION;
  readonly instanceId: string;
  readonly pid: number;
  readonly starttime: string;
  readonly bootId: string;
  /** Canonical absolute control-repo path. */
  readonly controlRepo: string;
  /** Canonical absolute work-root path. */
  readonly workRoot: string;
  readonly acquiredAtMs: number;
}

/** Liveness probe results for a recorded owner pid (injected by isolation). */
export interface OwnerLivenessProbe {
  /** Whether `kill(pid, 0)` suggests the pid exists (incl. EPERM). */
  readonly pidAlive: boolean;
  /** Current starttime for that pid, or null if unreadable / dead. */
  readonly currentStarttime: string | null;
  /** Current machine boot id (for compare against record). */
  readonly currentBootId: string;
}

export type LeaseOwnerStatus =
  | { readonly kind: 'ours' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly detail: string }
  | {
      readonly kind: 'live_foreign';
      readonly owner: DaemonLeaseRecord;
    }
  | {
      readonly kind: 'stale';
      readonly owner: DaemonLeaseRecord;
      readonly reason: string;
    };

export function isDaemonLeaseRecord(value: unknown): value is DaemonLeaseRecord {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    o['version'] === DAEMON_LEASE_VERSION &&
    typeof o['instanceId'] === 'string' &&
    o['instanceId'].length > 0 &&
    typeof o['pid'] === 'number' &&
    Number.isInteger(o['pid']) &&
    o['pid'] > 0 &&
    typeof o['starttime'] === 'string' &&
    typeof o['bootId'] === 'string' &&
    typeof o['controlRepo'] === 'string' &&
    o['controlRepo'].length > 0 &&
    typeof o['workRoot'] === 'string' &&
    o['workRoot'].length > 0 &&
    typeof o['acquiredAtMs'] === 'number' &&
    Number.isFinite(o['acquiredAtMs'])
  );
}

/** Parse lease JSON; empty/malformed => null (reclaimable). */
export function parseLeaseRecord(raw: string): DaemonLeaseRecord | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  return isDaemonLeaseRecord(parsed) ? parsed : null;
}

export function serializeLeaseRecord(record: DaemonLeaseRecord): string {
  return JSON.stringify(record, null, 2) + '\n';
}

export function buildLeaseRecord(
  identity: DaemonLeaseIdentity,
  scope: { readonly controlRepo: string; readonly workRoot: string },
  acquiredAtMs: number,
): DaemonLeaseRecord {
  return {
    version: DAEMON_LEASE_VERSION,
    instanceId: identity.instanceId,
    pid: identity.pid,
    starttime: identity.starttime,
    bootId: identity.bootId,
    controlRepo: scope.controlRepo,
    workRoot: scope.workRoot,
    acquiredAtMs,
  };
}

/** Parse legacy `.hercules-owner.lock` (single pid line). */
export function parseLegacyOwnerPid(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Classify an on-disk lease relative to *us* and a liveness probe of the
 * recorded owner.
 */
export function classifyLeaseOwner(
  record: DaemonLeaseRecord | null,
  us: DaemonLeaseIdentity,
  probe: OwnerLivenessProbe,
): LeaseOwnerStatus {
  if (record === null) return { kind: 'absent' };
  if (record.instanceId === us.instanceId && record.pid === us.pid) {
    return { kind: 'ours' };
  }
  if (!probe.pidAlive) {
    return { kind: 'stale', owner: record, reason: 'owner pid not alive' };
  }
  if (
    record.starttime.length > 0 &&
    probe.currentStarttime !== null &&
    probe.currentStarttime !== record.starttime
  ) {
    return {
      kind: 'stale',
      owner: record,
      reason: 'owner pid recycled (starttime mismatch)',
    };
  }
  if (
    record.bootId.length > 0 &&
    probe.currentBootId.length > 0 &&
    record.bootId !== probe.currentBootId
  ) {
    return {
      kind: 'stale',
      owner: record,
      reason: 'system boot id changed since lease was acquired',
    };
  }
  return { kind: 'live_foreign', owner: record };
}

/**
 * Classify a legacy pid-only lock. Without starttime we cannot prove reuse,
 * so a live pid is treated as a live foreign owner (fail closed).
 */
export function classifyLegacyOwnerPid(
  pid: number | null,
  ourPid: number,
  pidAliveFlag: boolean,
): LeaseOwnerStatus {
  if (pid === null) return { kind: 'absent' };
  if (pid === ourPid) return { kind: 'ours' };
  if (!pidAliveFlag) {
    return {
      kind: 'stale',
      owner: legacyRecordStub(pid),
      reason: 'legacy owner pid not alive',
    };
  }
  return { kind: 'live_foreign', owner: legacyRecordStub(pid) };
}

function legacyRecordStub(pid: number): DaemonLeaseRecord {
  return {
    version: DAEMON_LEASE_VERSION,
    instanceId: 'legacy-pid-' + String(pid),
    pid,
    starttime: '',
    bootId: '',
    controlRepo: '(legacy)',
    workRoot: '(legacy)',
    acquiredAtMs: 0,
  };
}

/** Whether *we* may safely release a lease whose owner record is `record`. */
export function mayReleaseLease(
  record: DaemonLeaseRecord | null,
  us: DaemonLeaseIdentity,
): boolean {
  if (record === null) return false;
  return record.instanceId === us.instanceId;
}

/**
 * Stable non-reversible fingerprint of a canonical path for diagnostics.
 * Never log raw paths (final segments may embed secrets).
 */
export function scopeFingerprint(canonicalPath: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < canonicalPath.length; i++) {
    h ^= canonicalPath.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Operator-facing conflict message -- typed, no secrets / raw paths. */
export function formatLeaseConflictDiagnostic(input: {
  readonly scopeControl: string;
  readonly scopeWork: string;
  readonly owner: DaemonLeaseRecord;
  readonly scopeKind: 'control' | 'work' | 'legacy';
}): string {
  const wantCtrl = scopeFingerprint(input.scopeControl);
  const wantWork = scopeFingerprint(input.scopeWork);
  const holdCtrl = scopeFingerprint(input.owner.controlRepo);
  const holdWork = scopeFingerprint(input.owner.workRoot);
  const idShort =
    input.owner.instanceId.length > 12
      ? input.owner.instanceId.slice(0, 8) + '...'
      : input.owner.instanceId;
  return (
    'daemon lease conflict: live owner pid=' +
    String(input.owner.pid) +
    ' instance=' +
    idShort +
    ' holds controlFp=' +
    holdCtrl +
    ' workFp=' +
    holdWork +
    ' (scope=' +
    input.scopeKind +
    '); this process wanted controlFp=' +
    wantCtrl +
    ' workFp=' +
    wantWork +
    '. Stop the other daemon or wait for stale recovery after it exits.'
  );
}

/** Audit line when a stale lease is replaced -- fingerprints only. */
export function formatStaleRecoveryDiagnostic(input: {
  readonly owner: DaemonLeaseRecord;
  readonly reason: string;
  readonly scopeKind: 'control' | 'work' | 'legacy';
}): string {
  const idShort =
    input.owner.instanceId.length > 12
      ? input.owner.instanceId.slice(0, 8) + '...'
      : input.owner.instanceId;
  return (
    'daemon lease stale recovery: replaced pid=' +
    String(input.owner.pid) +
    ' instance=' +
    idShort +
    ' controlFp=' +
    scopeFingerprint(input.owner.controlRepo) +
    ' workFp=' +
    scopeFingerprint(input.owner.workRoot) +
    ' scope=' +
    input.scopeKind +
    ' reason=' +
    input.reason
  );
}

/**
 * Operator-facing lease filesystem diagnostic — operation, scope kind,
 * path fingerprint, and errno only. Never include raw paths or Error.message
 * (Node errno messages embed the user path).
 */
export function formatDaemonLeaseIoDiagnostic(input: {
  readonly operation: string;
  readonly scopeKind: 'control' | 'work' | 'legacy';
  readonly path: string;
  readonly code?: string | null;
}): string {
  const code =
    typeof input.code === 'string' && input.code.length > 0
      ? input.code
      : 'UNKNOWN';
  return (
    'daemon lease io: op=' +
    input.operation +
    ' scope=' +
    input.scopeKind +
    ' fp=' +
    scopeFingerprint(input.path) +
    ' code=' +
    code
  );
}
