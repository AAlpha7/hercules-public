/**
 * Isolation layer — port allocation (SPEC §8.3).
 *
 * Hands a unique port to each live worktree so booted apps don't collide. A
 * plain in-memory pool over a fixed range; ports are reclaimed on teardown.
 *
 * Also probes the OS (bind attempt) so we skip ports already held by foreign
 * processes — e.g. orphaned L2 boots that survived teardown (2026-07-29:
 * acme on 4100/4101 made Hercules L2 health_check hit the wrong app).
 *
 * Probe outcomes are distinguished:
 * - EADDRINUSE → candidate busy; allocator may try the next port
 * - EPERM / EACCES / unexpected bind errors → typed PortProbeError (do not
 *   scan the rest of the range and claim "no free port" / OS-busy — that
 *   misreports sandbox policy as port exhaustion)
 */
import { createServer } from 'node:net';

/** Loopback host used for bind probes. */
export const PORT_PROBE_HOST = '127.0.0.1';

export type PortProbeOperation = 'listen';

export class PortExhaustedError extends Error {
  override readonly name = 'PortExhaustedError';
}

/**
 * Bind/listen probe failed for a reason other than "port already in use".
 * Preserves errno code, host, port, and operation so phone operators can tell
 * sandbox policy (EPERM/EACCES) from genuine pool exhaustion.
 */
export class PortProbeError extends Error {
  override readonly name = 'PortProbeError';
  readonly code: string;
  readonly host: string;
  readonly port: number;
  readonly operation: PortProbeOperation;

  constructor(opts: {
    readonly code: string;
    readonly host: string;
    readonly port: number;
    readonly operation: PortProbeOperation;
  }) {
    super(
      `port probe ${opts.operation} ${opts.host}:${opts.port} failed with ${opts.code}`,
    );
    this.code = opts.code;
    this.host = opts.host;
    this.port = opts.port;
    this.operation = opts.operation;
  }
}

/**
 * Map a bind/listen errno to either "busy" (caller may try next port) or a
 * thrown {@link PortProbeError} (stop allocation; surface diagnostic).
 */
export function classifyPortProbeFailure(
  err: Pick<NodeJS.ErrnoException, 'code'>,
  ctx: {
    readonly host: string;
    readonly port: number;
    readonly operation: PortProbeOperation;
  },
): 'busy' {
  if (err.code === 'EADDRINUSE') return 'busy';
  throw new PortProbeError({
    code: typeof err.code === 'string' && err.code.length > 0 ? err.code : 'UNKNOWN',
    host: ctx.host,
    port: ctx.port,
    operation: ctx.operation,
  });
}

/**
 * Returns true when this process can bind `port` on loopback right now.
 * Returns false only for EADDRINUSE (genuinely occupied).
 * Throws {@link PortProbeError} for EPERM/EACCES and unexpected bind errors.
 */
export function isPortBindable(port: number): Promise<boolean> {
  const host = PORT_PROBE_HOST;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (err: NodeJS.ErrnoException) => {
      try {
        const outcome = classifyPortProbeFailure(err, {
          host,
          port,
          operation: 'listen',
        });
        if (outcome === 'busy') resolve(false);
      } catch (probeErr) {
        reject(probeErr);
      }
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Optional probe inject for tests; default binds to check OS availability.
 * - `true` → free
 * - `false` → busy (EADDRINUSE equivalent); allocator continues
 * - throw {@link PortProbeError} → fail immediately (permission / unexpected)
 */
export type PortProbe = (port: number) => boolean | Promise<boolean>;

export class PortAllocator {
  private readonly inUse = new Set<number>();
  private readonly probe: PortProbe;

  constructor(
    private readonly base: number,
    private readonly count: number,
    probe?: PortProbe,
  ) {
    this.probe = probe ?? isPortBindable;
  }

  /** Free ports remaining in the in-memory pool (ignores OS state). */
  get available(): number {
    return this.count - this.inUse.size;
  }

  /**
   * Acquire the lowest pool port that is neither in-use by Hercules nor
   * OS-busy. Throws {@link PortExhaustedError} when the pool is exhausted or
   * every candidate is taken. Throws {@link PortProbeError} immediately when
   * probing is forbidden or otherwise fails for a non-busy reason.
   */
  async acquire(): Promise<number> {
    let sawOsBusy = false;
    for (let port = this.base; port < this.base + this.count; port += 1) {
      if (this.inUse.has(port)) continue;
      // PortProbeError (and other probe failures) propagate — do not convert
      // permission denial into "no free port / OS-busy".
      const free = await this.probe(port);
      if (!free) {
        sawOsBusy = true;
        continue;
      }
      this.inUse.add(port);
      return port;
    }
    const range = `[${this.base}, ${this.base + this.count})`;
    throw new PortExhaustedError(
      sawOsBusy
        ? `no free port in ${range} (pool empty or OS-busy)`
        : `no free port in ${range}`,
    );
  }

  /** Return a port to the pool. Releasing an unallocated port is a no-op. */
  release(port: number): void {
    this.inUse.delete(port);
  }
}
