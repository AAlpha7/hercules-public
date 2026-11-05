import { describe, it, expect } from 'vitest';
import { BehavioralVerifier, type BootController } from '../../src/verification/behavioral.js';
import { Semaphore } from '../../src/orchestrator/semaphore.js';
import type { BrowserDriver } from '../../src/verification/browser.js';
import { effectiveRepoExecutionPolicy } from '../../src/domain/repoExecutionPolicy.js';

class FakeBrowser implements BrowserDriver {
  readonly shots: string[] = [];
  readonly policies: unknown[] = [];
  async screenshot(
    _url: string,
    outPath: string,
    opts?: Parameters<BrowserDriver['screenshot']>[2],
  ): Promise<string[]> {
    this.shots.push(outPath);
    this.policies.push(opts?.executionPolicy);
    return [outPath];
  }
  async domSnapshot(): Promise<string> {
    return '<html></html>';
  }
}

function fakeBoot(healthy: boolean, log: string[]): BootController {
  return {
    async boot() {
      log.push('boot');
    },
    async waitHealthy() {
      log.push('health');
      return healthy;
    },
    async teardown() {
      log.push('teardown');
    },
  };
}

describe('BehavioralVerifier', () => {
  it('boots, screenshots when healthy, tears down, and releases the permit', async () => {
    const permit = new Semaphore(1);
    const browser = new FakeBrowser();
    const log: string[] = [];
    const v = new BehavioralVerifier({ permit, browser });

    const result = await v.verify({
      boot: fakeBoot(true, log),
      baseUrl: 'http://localhost:4100',
      screenshotDir: '/tmp/ev',
      captures: 1,
    });

    expect(result.healthy).toBe(true);
    expect(result.screenshots).toHaveLength(1);
    expect(log).toEqual(['boot', 'health', 'teardown']);
    expect(permit.available).toBe(1); // released
  });

  it('forwards the repository execution policy to the browser child path', async () => {
    const policy = effectiveRepoExecutionPolicy({ envAllowlist: ['PATH'] });
    const browser = new FakeBrowser();
    const v = new BehavioralVerifier({ permit: new Semaphore(1), browser });

    const result = await v.verify({
      boot: fakeBoot(true, []),
      baseUrl: 'http://localhost:4100',
      screenshotDir: '/tmp/ev',
      captures: 1,
      executionPolicy: policy,
    });

    expect(result.healthy).toBe(true);
    expect(browser.policies).toEqual([policy]);
  });

  it('skips screenshots and still tears down when unhealthy', async () => {
    const log: string[] = [];
    const v = new BehavioralVerifier({ permit: new Semaphore(1), browser: new FakeBrowser() });
    const result = await v.verify({
      boot: fakeBoot(false, log),
      baseUrl: 'http://x',
      screenshotDir: '/tmp/ev',
      captures: 1,
    });
    expect(result.healthy).toBe(false);
    expect(result.screenshots).toEqual([]);
    expect(log).toContain('teardown');
  });

  it('serializes behind the heavy-validation permit (one browser at a time, §6.3)', async () => {
    const permit = new Semaphore(1);
    const v = new BehavioralVerifier({ permit, browser: new FakeBrowser() });
    const order: string[] = [];
    const slowBoot = (tag: string): BootController => ({
      async boot() {
        order.push(`${tag}:boot`);
      },
      async waitHealthy() {
        return true;
      },
      async teardown() {
        order.push(`${tag}:done`);
      },
    });

    const p1 = v.verify({ boot: slowBoot('A'), baseUrl: 'x', screenshotDir: '/tmp', captures: 0 });
    const p2 = v.verify({ boot: slowBoot('B'), baseUrl: 'x', screenshotDir: '/tmp', captures: 0 });
    await Promise.all([p1, p2]);

    // A fully completes (boot..done) before B boots — no overlap.
    expect(order.indexOf('A:done')).toBeLessThan(order.indexOf('B:boot'));
  });

  it('releases the permit even if booting throws', async () => {
    const permit = new Semaphore(1);
    const v = new BehavioralVerifier({ permit, browser: new FakeBrowser() });
    const throwingBoot: BootController = {
      async boot() {
        throw new Error('boot failed');
      },
      async waitHealthy() {
        return false;
      },
      async teardown() {},
    };
    const result = await v.verify({ boot: throwingBoot, baseUrl: 'x', screenshotDir: '/tmp', captures: 1 });
    expect(result.healthy).toBe(false);
    expect(result.error).toContain('boot failed');
    expect(permit.available).toBe(1);
  });

  it('waits while heavy is disallowed (memory pressure), then proceeds', async () => {
    const permit = new Semaphore(1);
    let allowed = false;
    let sleeps = 0;
    const log: string[] = [];
    const v = new BehavioralVerifier({
      permit,
      browser: new FakeBrowser(),
      isHeavyAllowed: () => allowed,
      heavyWaitMs: 1,
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 2) allowed = true;
      },
    });

    const result = await v.verify({
      boot: fakeBoot(true, log),
      baseUrl: 'http://x',
      screenshotDir: '/tmp/ev',
      captures: 0,
    });

    expect(result.healthy).toBe(true);
    expect(sleeps).toBeGreaterThanOrEqual(2);
    expect(log).toEqual(['boot', 'health', 'teardown']);
    expect(permit.available).toBe(1);
  });
});
