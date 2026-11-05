/**
 * Execution layer — an async counting semaphore (SPEC §6).
 *
 * Used for the heavy-validation permit: a worker must acquire one to enter its
 * boot + browser-driving phase, so only one headless browser runs at a time on
 * the constrained target box. Generic enough to back any of the caps. FIFO so a
 * waiter cannot be starved.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`semaphore capacity must be a positive integer, got ${capacity}`);
    }
    this.permits = capacity;
  }

  /** Permits currently available (not counting queued waiters). */
  get available(): number {
    return this.permits;
  }

  /** Acquire a permit, waiting if necessary. Resolves with a release function. */
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return this.makeRelease();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => resolve(this.makeRelease()));
    });
  }

  /** Acquire without waiting; returns a release function or null if exhausted. */
  tryAcquire(): (() => void) | null {
    if (this.permits > 0) {
      this.permits -= 1;
      return this.makeRelease();
    }
    return null;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent — double release must not over-credit
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // hand the permit straight to the next waiter
      } else {
        this.permits += 1;
      }
    };
  }
}
