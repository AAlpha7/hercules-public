import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const FLOCK = '/usr/bin/flock';
const HOLDER = '/usr/bin/cat';
const CONFLICT_EXIT = 73;
const HANDSHAKE_TIMEOUT_MS = 5_000;

type ArchiveLockFailureCode =
  | 'archive_lock_busy'
  | 'archive_lock_io'
  | 'archive_lock_lost';

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function errno(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = (error as { readonly code: unknown }).code;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'UNKNOWN';
}

export class ArchiveLockError extends Error {
  readonly code: ArchiveLockFailureCode;

  constructor(code: ArchiveLockFailureCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ArchiveLockError';
    this.code = code;
  }
}

export class ArchiveLockBusyError extends ArchiveLockError {
  constructor() {
    super('archive_lock_busy', 'another archive process holds the lease');
    this.name = 'ArchiveLockBusyError';
  }
}

export class ArchiveLockLostError extends ArchiveLockError {
  constructor() {
    super('archive_lock_lost', 'archive flock holder exited unexpectedly');
    this.name = 'ArchiveLockLostError';
  }
}

export class ArchiveLockIOError extends ArchiveLockError {
  readonly operation: string;
  readonly pathFingerprint: string;
  readonly errno: string;

  constructor(operation: string, path: string, error?: unknown) {
    const pathFingerprint = fingerprint(path);
    const errorCode = error === undefined ? 'UNKNOWN' : errno(error);
    super(
      'archive_lock_io',
      `operation=${operation} path=${pathFingerprint} errno=${errorCode}`,
    );
    this.name = 'ArchiveLockIOError';
    this.operation = operation;
    this.pathFingerprint = pathFingerprint;
    this.errno = errorCode;
  }
}

const managerBrand = new WeakMap<ArchiveLockLease, object>();

export class ArchiveLockLease {
  readonly pid: number;
  readonly whenLost: Promise<ArchiveLockLostError>;
  readonly #child: ChildProcessWithoutNullStreams;
  #released = false;
  #lost: ArchiveLockLostError | null = null;
  #resolveLost: (error: ArchiveLockLostError) => void = () => undefined;
  readonly #onRelease: () => void;

  constructor(
    child: ChildProcessWithoutNullStreams,
    owner: object,
    onRelease: () => void,
  ) {
    if (child.pid === undefined) throw new ArchiveLockIOError('missing_pid', FLOCK);
    this.#child = child;
    this.#onRelease = onRelease;
    this.pid = child.pid;
    this.whenLost = new Promise((resolve) => {
      this.#resolveLost = resolve;
    });
    managerBrand.set(this, owner);
    child.once('exit', () => {
      if (this.#released || this.#lost !== null) return;
      this.#lost = new ArchiveLockLostError();
      this.#resolveLost(this.#lost);
    });
  }

  assertHealthy(): void {
    if (this.#released || this.#lost !== null || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      throw this.#lost ?? new ArchiveLockLostError();
    }
  }

  isReleased(): boolean {
    return this.#released;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    this.#onRelease();
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.#child.once('exit', finish);
      this.#child.stdin.once('error', finish);
      this.#child.stdin.end();
    });
  }
}

function safeChildEnv(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) result[key] = value;
  }
  return result;
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface LockFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

async function prepareLockFile(path: string): Promise<LockFileIdentity> {
  let created = false;
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    try {
      await handle.sync();
      created = true;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw new ArchiveLockIOError('create', path, error);
  }
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    throw new ArchiveLockIOError('lstat', path, error);
  }
  const currentUid = process.getuid?.();
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600 || (currentUid !== undefined && entry.uid !== currentUid)) {
    throw new ArchiveLockIOError('unsafe_file', path);
  }
  if (created) await fsyncDirectory(dirname(path));
  return { dev: entry.dev, ino: entry.ino };
}

function earlyExit(code: number | null, path: string): ArchiveLockError {
  return code === CONFLICT_EXIT
    ? new ArchiveLockBusyError()
    : new ArchiveLockIOError('early_exit', path, { code: code === null ? 'UNKNOWN' : String(code) });
}

async function acquireChild(path: string): Promise<ChildProcessWithoutNullStreams> {
  const nonce = randomBytes(24).toString('hex');
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      FLOCK,
      ['-n', '-E', String(CONFLICT_EXIT), path, HOLDER],
      { env: safeChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;
  } catch (error) {
    throw new ArchiveLockIOError('spawn', path, error);
  }
  child.stderr.resume();

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const timer = setTimeout(() => fail(new ArchiveLockIOError('handshake_timeout', path)), HANDSHAKE_TIMEOUT_MS);
    const cleanup = (): void => clearTimeout(timer);
    const fail = (error: ArchiveLockError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      reject(error);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(child);
    };
    child.once('error', (error) => fail(new ArchiveLockIOError('spawn', path, error)));
    child.once('exit', (code) => fail(earlyExit(code, path)));
    child.stdin.on('error', () => {
      if (child.exitCode !== null) fail(earlyExit(child.exitCode, path));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output = (output + chunk).slice(-256);
      if (output.split('\n').some((line) => line === nonce)) succeed();
    });
    child.stdin.write(`${nonce}\n`, (error) => {
      if (error !== null && child.exitCode !== null) fail(earlyExit(child.exitCode, path));
    });
  });
}

export class ArchiveLockManager {
  readonly #path: string;
  readonly #identity: LockFileIdentity;
  readonly #owner = {};
  #active: ArchiveLockLease | null = null;
  #poisoned: ArchiveLockError | null = null;

  constructor(path: string, identity: LockFileIdentity) {
    this.#path = path;
    this.#identity = identity;
  }

  async #assertLockIdentity(): Promise<void> {
    let current;
    try {
      current = await lstat(this.#path);
    } catch (error) {
      const failure = new ArchiveLockIOError('lock_identity', this.#path, error);
      this.#poisoned ??= failure;
      throw this.#poisoned;
    }
    if (
      current.dev !== this.#identity.dev ||
      current.ino !== this.#identity.ino ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      (current.mode & 0o777) !== 0o600
    ) {
      const failure = new ArchiveLockIOError('lock_identity', this.#path);
      this.#poisoned ??= failure;
      throw this.#poisoned;
    }
  }

  async acquire(): Promise<ArchiveLockLease> {
    if (this.#poisoned !== null) throw this.#poisoned;
    if (this.#active !== null && !this.#active.isReleased()) {
      throw new ArchiveLockBusyError();
    }
    await this.#assertLockIdentity();
    const child = await acquireChild(this.#path);
    const lease = new ArchiveLockLease(child, this.#owner, () => {
      if (this.#active === lease) this.#active = null;
    });
    this.#active = lease;
    void lease.whenLost.then((error) => {
      this.#poisoned ??= error;
    });
    try {
      await this.#assertLockIdentity();
      lease.assertHealthy();
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async assertOwns(lease: ArchiveLockLease): Promise<void> {
    if (this.#poisoned !== null) throw this.#poisoned;
    if (managerBrand.get(lease) !== this.#owner) throw new ArchiveLockLostError();
    if (this.#active !== lease) throw new ArchiveLockLostError();
    lease.assertHealthy();
    await this.#assertLockIdentity();
    lease.assertHealthy();
  }

  async withLease<T>(operation: (lease: ArchiveLockLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      const result = await operation(lease);
      await this.assertOwns(lease);
      return result;
    } finally {
      await lease.release();
    }
  }
}

export async function openArchiveLockManager(path: string): Promise<ArchiveLockManager> {
  const identity = await prepareLockFile(path);
  const parent = await stat(dirname(path));
  if (!parent.isDirectory()) throw new ArchiveLockIOError('parent_not_directory', path);
  return new ArchiveLockManager(path, identity);
}
