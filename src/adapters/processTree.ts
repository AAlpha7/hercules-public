/**
 * Sample the OS process tree under an agent child for a live "alive hint"
 * (cargo, rustc, pnpm, …). Best-effort Linux /proc; returns null on failure.
 *
 * Pure pick lives in domain/aliveHint.ts — this module is I/O only.
 * Stall policy lives in domain/stall.ts — processAlive uses {@link isOsProcessAlive}.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { pickWorkerName } from '../domain/aliveHint.js';

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_NODES = 80;

/**
 * True when `pid` still exists (signal 0). Used so a missed exit event does not
 * keep processAlive forever, and so OS liveness can establish "alive" for stall.
 */
export function isOsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface OsProcessIdentity {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly bootId: string;
}

/**
 * Restart-only proof for the narrow acquire-before-bind crash window.
 *
 * Managed adapter roots are spawned with the task worktree as cwd and with a
 * task marker inherited by descendants. Until the root PID is durably bound,
 * at least one of those identities must remain present. This is not a generic
 * process ownership oracle: any incomplete same-uid /proc read returns null so
 * callers retain the lease fail-closed.
 */
export function hasManagedProcessForTask(
  worktree: string,
  taskId: string,
  probes: {
    readonly platform?: string;
    readonly getUid?: () => number;
    readonly readProcFile?: (path: string) => string;
    readonly readProcEntries?: () => string[];
    readonly realpath?: (path: string) => string;
  } = {},
): boolean | null {
  const platform = probes.platform ?? process.platform;
  const getUid = probes.getUid ?? process.getuid;
  const readProcFile = probes.readProcFile ?? ((path) => readFileSync(path, 'utf8'));
  const readProcEntries = probes.readProcEntries ?? (() => readdirSync('/proc'));
  const realpath = probes.realpath ?? realpathSync;
  if (platform !== 'linux' || !getUid || !Number.isInteger(getUid())) return null;
  let canonicalWorktree: string | null = null;
  let worktreeProbeIncomplete = false;
  let procEntries: string[];
  try {
    canonicalWorktree = realpath(worktree);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') worktreeProbeIncomplete = true;
  }
  try {
    procEntries = readProcEntries();
  } catch {
    return null;
  }
  const uid = getUid();
  const markerA = `HERCULES_TASK_ID=${taskId}`;
  const markerB = `HERCULES_SLUG=${taskId}`;
  let incomplete = worktreeProbeIncomplete;

  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const base = `/proc/${entry}`;
    let status: string;
    try {
      status = readProcFile(`${base}/status`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH') incomplete = true;
      continue;
    }
    const uidMatch = /^Uid:\s+(\d+)/m.exec(status);
    if (!uidMatch) {
      incomplete = true;
      continue;
    }
    if (Number(uidMatch[1]) !== uid) continue;

    if (canonicalWorktree !== null) {
      try {
        const cwd = realpath(`${base}/cwd`);
        if (cwd === canonicalWorktree || cwd.startsWith(`${canonicalWorktree}/`)) return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ESRCH') incomplete = true;
      }
    }
    try {
      const env = readProcFile(`${base}/environ`).split('\0');
      if (env.includes(markerA) || env.includes(markerB)) return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH') incomplete = true;
    }
  }
  return incomplete ? null : false;
}

function readOsBootId(): string | null {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return bootId.length > 0 ? bootId : null;
  } catch {
    return null;
  }
}

/**
 * Stable identity for a detached process-group leader. PID alone is unsafe
 * across daemon restarts because Linux may reuse it.
 */
export function readOsProcessIdentity(pid: number): OsProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return null;
    // Fields after comm begin at field 3 (state); starttime is field 22.
    const fields = stat.slice(commEnd + 1).trim().split(/\s+/);
    const startTimeTicks = fields[19];
    const bootId = readOsBootId();
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks) || !bootId) return null;
    return { pid, startTimeTicks, bootId };
  } catch {
    return null;
  }
}

/** Exact process identity plus detached process-group liveness. */
export function isOsProcessGroupIdentityAlive(
  identity: OsProcessIdentity,
  probes: {
    readonly readBootId?: () => string | null;
    readonly signalGroup?: (pgid: number) => void;
    readonly readIdentity?: (pid: number) => OsProcessIdentity | null;
  } = {},
): boolean | null {
  const bootId = (probes.readBootId ?? readOsBootId)();
  if (!bootId) return null;
  if (bootId !== identity.bootId) return false;
  try {
    (probes.signalGroup ?? ((pgid) => process.kill(-pgid, 0)))(identity.pid);
  } catch (err) {
    // EPERM proves the group exists even though this process cannot signal it.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return null;
  }
  // A detached child may keep the process group alive after its leader exits.
  const current = (probes.readIdentity ?? readOsProcessIdentity)(identity.pid);
  if (!current) return true;
  if (current.startTimeTicks !== identity.startTimeTicks) return null;
  return current.bootId === identity.bootId ? true : null;
}

/**
 * True when the agent root has at least one descendant process (worker child).
 * Best-effort Linux /proc; false on failure / non-Linux.
 */
export function hasProcessDescendants(
  rootPid: number,
  opts?: { readonly maxDepth?: number; readonly maxNodes?: number },
): boolean {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return false;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts?.maxNodes ?? DEFAULT_MAX_NODES;
  const seen = new Set<number>();
  const queue: { pid: number; depth: number }[] = [{ pid: rootPid, depth: 0 }];

  while (queue.length > 0 && seen.size < maxNodes) {
    const next = queue.shift();
    if (next === undefined) break;
    const { pid, depth } = next;
    if (seen.has(pid)) continue;
    seen.add(pid);

    if (depth > 0) return true; // any descendant counts as active work

    if (depth >= maxDepth) continue;
    for (const child of listChildren(pid)) {
      if (!seen.has(child)) queue.push({ pid: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Walk /proc from rootPid, collect `comm` names, return a known worker label.
 */
export function sampleProcessTreeHint(
  rootPid: number,
  opts?: { readonly maxDepth?: number; readonly maxNodes?: number },
): string | null {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts?.maxNodes ?? DEFAULT_MAX_NODES;
  const comms: string[] = [];
  const seen = new Set<number>();
  const queue: { pid: number; depth: number }[] = [{ pid: rootPid, depth: 0 }];

  while (queue.length > 0 && seen.size < maxNodes) {
    const next = queue.shift();
    if (next === undefined) break;
    const { pid, depth } = next;
    if (seen.has(pid)) continue;
    seen.add(pid);

    const comm = readComm(pid);
    if (comm !== null && depth > 0) {
      // Skip the agent root itself — children are the interesting workers.
      comms.push(comm);
    }

    if (depth >= maxDepth) continue;
    for (const child of listChildren(pid)) {
      if (!seen.has(child)) queue.push({ pid: child, depth: depth + 1 });
    }
  }

  return pickWorkerName(comms);
}

/**
 * Parse one /proc/<pid>/stat line into cumulative CPU jiffies and RSS pages.
 * Jiffies include utime+stime AND cutime+cstime: cargo reaps each short-lived
 * rustc, so its CPU time only survives in the parent's reaped-children
 * counters — summing live processes alone made a full-tilt dependency build
 * read as "CPU 0%" (operator saw a 9-minute quiet build as a hang, 2026-07-24).
 */
export function jiffiesFromProcStat(
  stat: string,
): { readonly jiffies: number; readonly rssPages: number } | null {
  // comm can contain spaces/parens — fields start after the closing paren.
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const fields = stat.slice(close + 2).split(' ');
  // 0-based after state: utime 11, stime 12, cutime 13, cstime 14, rss 21.
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const cutime = Number(fields[13]);
  const cstime = Number(fields[14]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  const reaped = (Number.isFinite(cutime) ? cutime : 0) + (Number.isFinite(cstime) ? cstime : 0);
  const rssPages = Number(fields[21]);
  return {
    jiffies: utime + stime + reaped,
    rssPages: Number.isFinite(rssPages) && rssPages > 0 ? rssPages : 0,
  };
}

/**
 * Cumulative CPU jiffies and total RSS across the process tree rooted at
 * `rootPid` (root included — its own CPU counts as work). Null when the root
 * is gone / non-Linux. CPU% needs two samples; see
 * domain/aliveHint.cpuPctFromSamples.
 */
export function sampleProcessTreeStats(
  rootPid: number,
  opts?: { readonly maxDepth?: number; readonly maxNodes?: number },
): { readonly jiffies: number; readonly rssBytes: number } | null {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts?.maxNodes ?? DEFAULT_MAX_NODES;
  const pageSize = 4096;
  let jiffies = 0;
  let rssBytes = 0;
  let found = 0;
  const seen = new Set<number>();
  const queue: { pid: number; depth: number }[] = [{ pid: rootPid, depth: 0 }];

  while (queue.length > 0 && seen.size < maxNodes) {
    const next = queue.shift();
    if (next === undefined) break;
    const { pid, depth } = next;
    if (seen.has(pid)) continue;
    seen.add(pid);

    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const parsed = jiffiesFromProcStat(stat);
      if (parsed !== null) {
        jiffies += parsed.jiffies;
        rssBytes += parsed.rssPages * pageSize;
        found += 1;
      }
    } catch {
      // process disappeared mid-walk
    }

    if (depth >= maxDepth) continue;
    for (const child of listChildren(pid)) {
      if (!seen.has(child)) queue.push({ pid: child, depth: depth + 1 });
    }
  }
  return found > 0 ? { jiffies, rssBytes } : null;
}

function readComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Children via /proc/<pid>/task/<tid>/children (Linux). Empty on non-Linux. */
function listChildren(pid: number): number[] {
  const out = new Set<number>();
  try {
    const tasks = readdirSync(`/proc/${pid}/task`);
    for (const tid of tasks) {
      try {
        const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
        if (!raw) continue;
        for (const part of raw.split(/\s+/)) {
          const n = Number(part);
          if (Number.isInteger(n) && n > 0) out.add(n);
        }
      } catch {
        // task disappeared mid-walk
      }
    }
  } catch {
    return [];
  }
  return [...out];
}
