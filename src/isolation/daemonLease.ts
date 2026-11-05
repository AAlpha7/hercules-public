/**
 * Public facade for exclusive daemon/work-root lease (Guardian).
 *
 * Responsibility map (keep this set small):
 * - domain/daemonLease.ts          pure identity + classification
 * - isolation/daemonLeaseErrors.ts typed errors + flock constants
 * - isolation/daemonLeasePaths.ts  canonical paths + owner I/O
 * - isolation/daemonLeaseFlock.ts  util-linux flock transport + lifetime loss
 * - isolation/daemonLeaseInspect.ts process probes + ownership inspect
 * - isolation/daemonLeaseLifecycle.ts atomic acquire/release + startup helper
 * - isolation/daemonLease.ts       this public barrel
 *
 * Ownership primitive: util-linux `/usr/bin/flock` held by a long-lived
 * child (`flock -n -E 73 <lock> /usr/bin/cat`). Control artifacts never
 * land in the control worktree (git common-dir or sibling sidecar).
 */
export {
  DaemonLeaseError,
  DaemonLeaseIOError,
  daemonLeaseIoError,
  errnoCodeFrom,
  logDaemonLeaseIo,
  DaemonLeaseConflictError,
  DaemonLeaseLostError,
  FlockBusyError,
  FLOCK_BIN,
  FLOCK_CONFLICT_EXIT,
  FLOCK_HOLDER_BIN,
  type DaemonLeaseScopeKind,
} from './daemonLeaseErrors.js';

export {
  flockChildEnv,
  acquireFlockHold,
  releaseFlockHold,
  hasExactNonceLine,
  type FlockHold,
  type FlockFaultHooks,
} from './daemonLeaseFlock.js';

export {
  resolveCanonicalPath,
  resolveGitCommonDir,
  workLeasePaths,
  controlLeasePaths,
  readOwnerFile,
  writeOwnerFile,
  type LeasePathPair,
} from './daemonLeasePaths.js';

export {
  pidAlive,
  readBootId,
  readProcStarttime,
  probeOwner,
  inspectWorkRootOwnership,
} from './daemonLeaseInspect.js';

export {
  acquireDaemonLease,
  defaultWorkRoot,
  acquireMainDaemonLease,
  acquireLeaseForDaemonStartup,
  releaseDaemonLease,
  type HeldDaemonLease,
  type DaemonLeaseFaultHooks,
  type AcquireDaemonLeaseOptions,
} from './daemonLeaseLifecycle.js';
