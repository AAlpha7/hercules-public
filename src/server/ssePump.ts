/**
 * Latest-wins write pump for SSE state streams.
 *
 * Why: pushing every runtime snapshot into every connection with no
 * backpressure let a stalled client (phone asleep behind the tunnel) queue
 * hours of full-state JSON in memory — 4GB heap, SIGABRT (2026-07-24). A
 * state stream only needs the newest view, so per connection we keep at most
 * one write in flight and one pending view; intermediate views are dropped.
 * After a write error the pump stops for good — the connection is gone and
 * onAbort tears down the subscription.
 */
export interface LatestWinsPump<T> {
  push(view: T): void;
}

export function makeLatestWinsPump<T>(write: (view: T) => Promise<void>): LatestWinsPump<T> {
  let pending: T | null = null;
  let inFlight = false;
  let dead = false;

  const drain = async (): Promise<void> => {
    if (inFlight || dead) return;
    inFlight = true;
    try {
      while (pending !== null) {
        const view = pending;
        pending = null;
        await write(view);
      }
    } catch {
      dead = true;
      pending = null;
    } finally {
      inFlight = false;
    }
  };

  return {
    push(view: T): void {
      if (dead) return;
      pending = view;
      void drain();
    },
  };
}
