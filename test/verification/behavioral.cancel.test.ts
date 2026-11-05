import { describe, it, expect } from 'vitest';
import { BehavioralVerifier, type BootController } from '../../src/verification/behavioral.js';
import {
  isVerificationAborted,
  VerificationAbortedError,
} from '../../src/domain/verificationRun.js';
import { Semaphore } from '../../src/orchestrator/semaphore.js';
import type { BrowserDriver } from '../../src/verification/browser.js';

describe('BehavioralVerifier cancel (signal)', () => {
  it('aborts while waiting for heavy permit and never boots', async () => {
    const ac = new AbortController();
    let boots = 0;
    const boot: BootController = {
      boot: async () => {
        boots += 1;
      },
      waitHealthy: async () => true,
      teardown: async () => undefined,
    };
    const browser: BrowserDriver = {
      screenshot: async () => [],
      domSnapshot: async () => '',
    };
    const v = new BehavioralVerifier({
      permit: new Semaphore(1),
      browser,
      isHeavyAllowed: () => {
        // First poll: still blocked; cancel mid-wait.
        ac.abort();
        return false;
      },
      heavyWaitMs: 5,
      sleep: async () => undefined,
    });
    await expect(
      v.verify({
        boot,
        baseUrl: 'http://127.0.0.1:1',
        screenshotDir: '/tmp',
        captures: 1,
        signal: ac.signal,
      }),
    ).rejects.toSatisfy((err: unknown) => isVerificationAborted(err));
    expect(boots).toBe(0);
  });

  it('aborts while the semaphore itself is exhausted', async () => {
    const ac = new AbortController();
    const permit = new Semaphore(1);
    const releaseHeld = permit.tryAcquire();
    expect(releaseHeld).not.toBeNull();
    let boots = 0;
    let waits = 0;
    const v = new BehavioralVerifier({
      permit,
      browser: {
        screenshot: async () => [],
        domSnapshot: async () => '',
      },
      heavyWaitMs: 5,
      sleep: async () => {
        waits += 1;
        ac.abort();
      },
    });

    try {
      await expect(
        v.verify({
          boot: {
            boot: async () => {
              boots += 1;
            },
            waitHealthy: async () => true,
            teardown: async () => undefined,
          },
          baseUrl: 'http://127.0.0.1:1',
          screenshotDir: '/tmp',
          captures: 1,
          signal: ac.signal,
        }),
      ).rejects.toSatisfy((err: unknown) => isVerificationAborted(err));
      expect(waits).toBe(1);
      expect(boots).toBe(0);
    } finally {
      releaseHeld?.();
    }
  });

  it('tears down boot when cancel fires mid-browser and rethrows abort', async () => {
    const ac = new AbortController();
    let torn = 0;
    const boot: BootController = {
      boot: async () => undefined,
      waitHealthy: async () => true,
      teardown: async () => {
        torn += 1;
      },
    };
    let seenSignal: AbortSignal | undefined;
    const browser: BrowserDriver = {
      screenshot: async (_url, _path, opts) => {
        seenSignal = opts?.signal;
        ac.abort();
        throw new VerificationAbortedError('browser aborted');
      },
      domSnapshot: async () => '',
    };
    const v = new BehavioralVerifier({
      permit: new Semaphore(1),
      browser,
    });
    await expect(
      v.verify({
        boot,
        baseUrl: 'http://127.0.0.1:1',
        screenshotDir: '/tmp',
        captures: 1,
        signal: ac.signal,
      }),
    ).rejects.toBeInstanceOf(VerificationAbortedError);
    expect(seenSignal).toBe(ac.signal);
    expect(torn).toBe(1);
  });
});
