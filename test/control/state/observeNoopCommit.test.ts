/**
 * C3.58: a control commit that changes no projected field (priority bump,
 * lease advance, note fold) must not append a projection envelope; the
 * observe pass records the revision in the durable cursor instead and does
 * not re-walk Git history on the next pass.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import type { Task } from '../../../src/domain/task.js';
import { SqliteStateStore } from '../../../src/control/state/sqliteStateStore.js';
import { createM4ObserverMemo } from '../../../src/control/state/shadowObserverMemo.js';
import { serializeTask } from '../../../src/control/taskFile.js';
import { buildSnapshot } from '../../../src/control/snapshot.js';
import { observeM4AuthoritySnapshot } from '../../../src/main.js';
import {
  deliverShadowProjection,
  shadowDeliveryForGitRevision,
} from '../../../src/control/state/shadowReconciler.js';
import { rmSync as rmFile } from 'node:fs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, title: `Project ${id}`, repo: 'app', state: 'todo', priority: 1, blockedBy: [], labels: [],
    adapter: null, agentSession: null, pendingSteer: null, attempts: 0, lastEventAt: null,
    createdAt: '2026-08-28T00:00:00Z', startedAt: null, endedAt: null, prUrl: null, prStatus: null,
    planPending: false, verifiedSha: null,
    body: '## Definition of Done\n- [ ] (mechanical) tests pass @gate:test',
    ...overrides,
  };
}

describe('observe pass: no-op commits append no envelope (C3.58)', { timeout: 60_000 }, () => {
  it('records the cursor, skips the envelope, and does not re-walk history next pass', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c358-observe-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const tasks = [task('NOOP-A'), task('NOOP-B')];
    for (const item of tasks) writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed');
    const seedRevision = (await git.revparse(['HEAD'])).trim();

    const parent = mkdtempSync(join(tmpdir(), 'hercules-c358-store-'));
    roots.push(parent);
    const store = new SqliteStateStore({
      trustedRoot: join(parent, 'state'),
      databasePath: join(parent, 'state', 'shadow.sqlite'),
    });
    store.initialize();
    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>();
    let historyBuilds = 0;
    const hooks = { onHistoryBuild: () => { historyBuilds += 1; }, log: () => undefined };

    const seed = { revision: seedRevision, tasks: (await buildSnapshot(control)).tasks, shadowPending: false };
    const first = await observeM4AuthoritySnapshot(store, control, seed, failures, memo, hooks);
    expect(first.parity).toBe(true);
    const envelopesAfterSeed = store.listProjectionEnvelopeKeys().map((k) => k.deliveryId);
    expect(envelopesAfterSeed).toHaveLength(1); // the seed reconcile projected the roots
    expect(store.observedAuthorityRevision()).toBe(seedRevision);

    // A priority bump changes bytes but projects nothing.
    writeFileSync(join(control, 'tasks', 'NOOP-B.md'), serializeTask({ ...tasks[1]!, priority: 5 }));
    await git.add('.');
    await git.commit('bump priority');
    const bumpRevision = (await git.revparse(['HEAD'])).trim();
    const bumped = { revision: bumpRevision, tasks: (await buildSnapshot(control)).tasks, shadowPending: false };
    const second = await observeM4AuthoritySnapshot(store, control, bumped, failures, memo, hooks);
    expect(second.parity).toBe(true);
    expect(store.listProjectionEnvelopeKeys().map((k) => k.deliveryId)).toEqual(envelopesAfterSeed);
    expect(store.observedAuthorityRevision()).toBe(bumpRevision);
    expect(store.latestProjectionEnvelopeRevision()).toBe(seedRevision);

    // Same revision again: fully caught up through the cursor → cached, no history rebuild.
    const buildsBefore = historyBuilds;
    const third = await observeM4AuthoritySnapshot(store, control, bumped, failures, memo, hooks);
    expect(third).toEqual(second);
    expect(historyBuilds).toBe(buildsBefore);
    store.close();
  });

  it('a stale cursor behind a later envelope never re-delivers the skipped range (Codex C3.58 B1)', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c358-stale-cursor-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const tasks = [task('STALE-A'), task('STALE-B')];
    for (const item of tasks) writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed');
    const seedRevision = (await git.revparse(['HEAD'])).trim();
    const parent = mkdtempSync(join(tmpdir(), 'hercules-c358-stale-store-'));
    roots.push(parent);
    const store = new SqliteStateStore({
      trustedRoot: join(parent, 'state'),
      databasePath: join(parent, 'state', 'shadow.sqlite'),
    });
    store.initialize();
    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>();
    const hooks = { log: () => undefined };
    await observeM4AuthoritySnapshot(
      store, control, { revision: seedRevision, tasks: (await buildSnapshot(control)).tasks, shadowPending: false },
      failures, memo, hooks,
    );
    expect(store.observedAuthorityRevision()).toBe(seedRevision); // cursor = A

    // B: priority-only change of STALE-A (projects nothing).
    writeFileSync(join(control, 'tasks', 'STALE-A.md'), serializeTask({ ...tasks[0]!, priority: 9 }));
    await git.add('.');
    await git.commit('B: priority only');
    // C: STALE-A deleted → retirement envelope, delivered by the live path…
    rmFile(join(control, 'tasks', 'STALE-A.md'));
    await git.add('.');
    await git.commit('C: retire STALE-A');
    const cRevision = (await git.revparse(['HEAD'])).trim();
    const live = (await shadowDeliveryForGitRevision(control, cRevision, `sync-${cRevision}`))!;
    expect(live.retiredTaskIds).toEqual(['STALE-A']);
    expect(deliverShadowProjection(store, live).skipped).toBeUndefined();
    // …and the process crashed BEFORE recording cursor C: cursor still A.
    expect(store.observedAuthorityRevision()).toBe(seedRevision);
    expect(store.latestProjectionEnvelopeRevision()).toBe(cRevision);

    const head = { revision: cRevision, tasks: (await buildSnapshot(control)).tasks, shadowPending: false };
    const report = await observeM4AuthoritySnapshot(store, control, head, failures, createM4ObserverMemo(), hooks);
    expect(report.parity).toBe(true);
    // B was never re-delivered after C: no envelope for it, ordering intact.
    expect(store.listProjectionEnvelopeKeys().map((k) => k.authorityRevision)).toEqual([seedRevision, cRevision]);
    expect(store.observedAuthorityRevision()).toBe(cRevision);
    // A later pass at the same head is a cached no-op.
    expect(await observeM4AuthoritySnapshot(store, control, head, failures, memo, hooks)).toEqual(report);
    store.close();
  });
});
