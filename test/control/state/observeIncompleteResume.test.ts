/**
 * Codex round-3b: a live commit refused over an incomplete bridge envelope
 * leaves the outbox pending (`shadowPending`); the observe pass must still
 * resume the incomplete envelope, and startup must not lay a second bridge.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { contractNeedsBridge } from '../../../src/domain/approvalPolicyBridge.js';
import type { Task } from '../../../src/domain/task.js';
import { SqliteStateStore } from '../../../src/control/state/sqliteStateStore.js';
import {
  assertNoIncompleteEnvelopes,
  buildBridgeDelivery,
  deliverShadowProjection,
  reconciliationDeliveryId,
} from '../../../src/control/state/shadowReconciler.js';
import { createM4ObserverMemo } from '../../../src/control/state/shadowObserverMemo.js';
import { serializeTask } from '../../../src/control/taskFile.js';
import { buildSnapshot } from '../../../src/control/snapshot.js';
import { observeM4AuthoritySnapshot } from '../../../src/main.js';

const roots: string[] = [];

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Project ${id}`,
    repo: 'app',
    state: 'todo',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: '2026-08-28T00:00:00Z',
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: '## Definition of Done\n- [ ] (mechanical) tests pass @gate:test',
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('observe pass resumes an incomplete bridge envelope while the outbox is pending', () => {
  it('resumes first, refuses a second bridge, then advances when the outbox clears', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c3-observe-resume-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const tasks = Array.from({ length: 257 }, (_, index) => task(`OBS-${String(index).padStart(3, '0')}`));
    for (const item of tasks) writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed 257 tasks');
    const seedRevision = (await git.revparse(['HEAD'])).trim();

    const parent = mkdtempSync(join(tmpdir(), 'hercules-c3-observe-resume-store-'));
    roots.push(parent);
    const store = new SqliteStateStore({
      trustedRoot: join(parent, 'state'),
      databasePath: join(parent, 'state', 'shadow.sqlite'),
    });
    store.initialize();
    const initial = { revision: seedRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(store, {
      deliveryId: reconciliationDeliveryId(initial),
      revision: seedRevision,
      writes: initial.tasks,
      retiredTaskIds: [],
    });
    const bridge = buildBridgeDelivery(store, seedRevision)!;
    const originalCommitBatch = store.commitBatch.bind(store);
    store.commitBatch = ((deliveryIdArg, batchOrdinal, inputs) => {
      if (deliveryIdArg === bridge.deliveryId && batchOrdinal === 1) {
        throw new Error('injected bridge interruption after 256');
      }
      return originalCommitBatch(deliveryIdArg, batchOrdinal, inputs);
    }) as typeof store.commitBatch;
    expect(() => deliverShadowProjection(store, bridge)).toThrow('injected bridge interruption after 256');
    store.commitBatch = originalCommitBatch;
    expect(store.listIncompleteEnvelopes().map((envelope) => envelope.deliveryId)).toEqual([bridge.deliveryId]);

    // The straggler is bumped at a new revision; the live path refused it, so
    // the outbox holds it (shadowPending) and the shadow store did not move.
    const straggler = tasks.at(-1)!;
    writeFileSync(join(control, 'tasks', `${straggler.id}.md`), serializeTask({ ...straggler, priority: 2 }));
    await git.add('.');
    await git.commit('bump straggler priority');
    const bumpRevision = (await git.revparse(['HEAD'])).trim();
    const bumped = { revision: bumpRevision, tasks: (await buildSnapshot(control)).tasks };

    // Startup-shaped second bridge at the new revision is refused while the
    // first is incomplete (main's deliverC3Bridge guards with the same call).
    const second = buildBridgeDelivery(store, bumpRevision)!;
    expect(second.deliveryId).not.toBe(bridge.deliveryId);
    expect(() => assertNoIncompleteEnvelopes(store, second.deliveryId)).toThrow('must resume first');

    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>([[straggler.id, 'shadow_delivery_failed']]);
    const pendingReport = await observeM4AuthoritySnapshot(
      store, control, { ...bumped, shadowPending: true }, failures, memo,
    );
    // Resumed despite the pending outbox; history not advanced (outbox owns it).
    expect(store.listIncompleteEnvelopes()).toEqual([]);
    expect(store.readEnvelope(bridge.deliveryId)).toMatchObject({ completed: true, acknowledgedCommands: 257 });
    expect(contractNeedsBridge(store.readTask(straggler.id)!.contracts)).toBe(false);
    expect(buildBridgeDelivery(store, bumpRevision)).toBeNull();
    expect(pendingReport.parity).toBe(false);
    expect(store.listProjectionEnvelopes().map((envelope) => envelope.deliveryId))
      .toEqual([reconciliationDeliveryId(initial), bridge.deliveryId]);

    // Outbox cleared (delivered elsewhere or discarded): the observe pass advances.
    failures.clear();
    const clearedReport = await observeM4AuthoritySnapshot(
      store, control, { ...bumped, shadowPending: false }, failures, memo,
    );
    expect(clearedReport.parity).toBe(true);
    expect(clearedReport.cutoverBlockers).toEqual(['m4_shadow_only']);
    expect(store.readTask(straggler.id)!.contracts.map((contract) => contract.version)).toEqual([1, 2]);
    store.close();
  }, 60_000);
});
