import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveBehavioralRunner } from '../../src/verification/liveBehavioral.js';
import { Semaphore } from '../../src/orchestrator/semaphore.js';
import type { BrowserDriver } from '../../src/verification/browser.js';
import type { BootController } from '../../src/verification/behavioral.js';

class FakeBrowser implements BrowserDriver {
  async screenshot(_url: string, outPath: string): Promise<string[]> {
    return [outPath];
  }
  async domSnapshot(): Promise<string> {
    return '';
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hercules-shots-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LiveBehavioralRunner', () => {
  it('builds a boot controller, drives the verifier, and returns screenshot names', async () => {
    let bootInput: { bootCommands: readonly string[]; cwd: string } | null = null;
    const boot: BootController = {
      async boot() {},
      async waitHealthy() {
        return true;
      },
      async teardown() {},
    };
    const runner = new LiveBehavioralRunner({
      permit: new Semaphore(1),
      browser: new FakeBrowser(),
      screenshotsRoot: root,
      bootFactory: (i) => {
        bootInput = { bootCommands: i.bootCommands, cwd: i.cwd };
        return boot;
      },
    });

    const result = await runner.run({
      taskId: 'T-1',
      baseUrl: 'http://localhost:4100',
      bootCommands: ['pnpm dev --port 4100'],
      healthCommand: 'curl localhost:4100',
      captures: 2,
      cwd: '/ws/T-1',
    });

    expect(bootInput!.bootCommands).toEqual(['pnpm dev --port 4100']);
    expect(bootInput!.cwd).toBe('/ws/T-1');
    expect(result.healthy).toBe(true);
    // bare names (the packet renders them as /api URLs), persisted under root/<taskId>.
    // FakeBrowser returns a single path; multi-shot needs a multi-capable driver /
    // declarative evidence plan (auth + chromium). Fallback yields one shot.
    expect(result.screenshots).toEqual(['evidence-0.png']);
  });
});

describe('exact evidence-skip reason (the guess-list was a system defect, 2026-07-23)', () => {
  it('names the missing preconditions instead of guessing', async () => {
    const boot: BootController = {
      boot: async () => {}, waitHealthy: async () => true, teardown: async () => {},
    };
    const runner = new LiveBehavioralRunner({
      permit: new Semaphore(1),
      browser: new FakeBrowser(),
      screenshotsRoot: root,
      bootFactory: () => boot,
    });
    // No auth token + no evidence steps -> CDP path skipped; reason must say so.
    const r = await runner.run({
      taskId: 'T-1',
      baseUrl: 'http://127.0.0.1:1/',
      bootCommands: [],
      healthCommand: undefined,
      captures: 1,
      cwd: root,
    });
    expect(r.evidenceRun).toBeUndefined();
    expect(r.evidenceSkipReason).toMatch(/auth_token/);
  });
});
