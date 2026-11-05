/**
 * Domain tests — SSH heavy-worker pure types + path chokepoint (SPEC §10, §11).
 */
import { describe, it, expect } from 'vitest';
import {
  remoteJobDir,
  DEFAULT_HEAVY_REMOTE_ROOT,
  type HeavyWorkerMode,
  type HeavyJobRequest,
  type HeavyJobResult,
} from '../../src/domain/heavyWorker.js';
import { IdentifierError } from '../../src/domain/task.js';

describe('remoteJobDir', () => {
  it('joins remote root with a validated task id segment', () => {
    expect(remoteJobDir('/var/hercules-heavy', 'task-1')).toBe(
      '/var/hercules-heavy/task-1',
    );
    expect(remoteJobDir(DEFAULT_HEAVY_REMOTE_ROOT, 'future-ssh-heavy-worker')).toBe(
      `${DEFAULT_HEAVY_REMOTE_ROOT}/future-ssh-heavy-worker`,
    );
  });

  it('strips a trailing slash on the root', () => {
    expect(remoteJobDir('/tmp/jobs/', 'T-1')).toBe('/tmp/jobs/T-1');
  });

  it('rejects unsafe task ids via IdentifierError (path chokepoint)', () => {
    expect(() => remoteJobDir('/r', '../etc')).toThrow(IdentifierError);
    expect(() => remoteJobDir('/r', 'a/b')).toThrow(IdentifierError);
    expect(() => remoteJobDir('/r', '')).toThrow(IdentifierError);
    expect(() => remoteJobDir('/r', '.')).toThrow(IdentifierError);
  });
});

describe('heavy worker domain shapes', () => {
  it('modes are local | remote only (single remote host, not a mesh)', () => {
    const modes: readonly HeavyWorkerMode[] = ['local', 'remote'];
    expect(modes).toEqual(['local', 'remote']);
  });

  it('job result records where the heavy work ran', () => {
    const req: HeavyJobRequest = {
      taskId: 'T-1',
      baseUrl: 'http://127.0.0.1:4100',
      bootCommands: ['pnpm start'],
      healthCommand: undefined,
      captures: 1,
    };
    const ok: HeavyJobResult = {
      where: 'remote',
      healthy: true,
      screenshots: ['shell.png'],
      request: req,
    };
    expect(ok.where).toBe('remote');
    expect(ok.healthy).toBe(true);

    const fail: HeavyJobResult = {
      where: 'remote',
      healthy: false,
      screenshots: [],
      error: 'ssh: connection refused',
      request: req,
    };
    expect(fail.error).toMatch(/connection refused/);
  });
});
