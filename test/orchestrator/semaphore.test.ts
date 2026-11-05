import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/orchestrator/semaphore.js';

describe('Semaphore', () => {
  it('grants permits immediately up to capacity', async () => {
    const sem = new Semaphore(2);
    expect(sem.available).toBe(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);
  });

  it('queues acquirers beyond capacity until a permit is released', async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    let granted = false;
    const pending = sem.acquire().then((r) => {
      granted = true;
      return r;
    });

    await Promise.resolve();
    expect(granted).toBe(false); // still waiting

    release1();
    await pending;
    expect(granted).toBe(true);
  });

  it('hands permits to waiters in FIFO order', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const order: number[] = [];
    const p1 = sem.acquire().then((r) => {
      order.push(1);
      return r;
    });
    const p2 = sem.acquire().then((r) => {
      order.push(2);
      return r;
    });

    release();
    (await p1)();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it('tryAcquire returns a release fn or null when exhausted', () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire();
    expect(release).not.toBeNull();
    expect(sem.tryAcquire()).toBeNull();
    release!();
    expect(sem.tryAcquire()).not.toBeNull();
  });

  it('treats a double release as a no-op (no over-crediting)', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.available).toBe(1);
  });
});
