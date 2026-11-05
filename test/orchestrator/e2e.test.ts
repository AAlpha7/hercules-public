import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { GitControlPort } from '../../src/orchestrator/gitControlPort.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { makeConfig } from '../../src/config.js';
import { parseTaskFile } from '../../src/control/taskFile.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hercules-e2e-'));
  const git = simpleGit(dir);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 't@hercules.local');
  await git.addConfig('user.name', 'T');
  await writeFile(
    join(dir, 'repos.yaml'),
    `repos:\n  app:\n    url: git@github.com:me/app.git\n    default_branch: main\n`,
  );
  await mkdir(join(dir, 'tasks'), { recursive: true });
  await writeFile(
    join(dir, 'tasks', 'T-1.md'),
    `---\ntitle: First task\nrepo: app\nstate: todo\npriority: 1\n---\nimplement the thing\n`,
  );
  await git.add('.');
  await git.commit('seed');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readTaskState(stem: string): Promise<string> {
  const content = await readFile(join(dir, 'tasks', `${stem}.md`), 'utf8');
  return parseTaskFile(content, stem).state;
}

describe('end to end: Orchestrator + GitControlPort + FakeAdapter', () => {
  it('drives a task todo → in_progress → review against a real git control repo', async () => {
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig(dir),
      control: new GitControlPort(dir),
      adapter: new FakeAdapter({ durationMs: 100 }),
      clock: () => now,
    });

    const dispatch = await orch.tick();
    expect(dispatch.dispatched).toEqual(['T-1']);
    expect(await readTaskState('T-1')).toBe('in_progress');

    now = 100;
    const complete = await orch.tick();
    expect(complete.completed).toEqual(['T-1']);
    expect(await readTaskState('T-1')).toBe('review');

    // Every transition was recorded as a real commit (the audit log, SPEC §1).
    const messages = (await simpleGit(dir).log()).all.map((c) => c.message);
    expect(messages).toContain('hercules: T-1 todo → in_progress');
    expect(messages).toContain('hercules: T-1 in_progress → review');
  });
});
