import { describe, it, expect } from 'vitest';
import { parseTaskFile, serializeTask, TaskFileError } from '../../src/control/taskFile.js';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import type { Task } from '../../src/domain/task.js';

const FULL = `---
id: ABC-12
title: Fix flaky upload retry
repo: my-app
state: todo
priority: 2
blocked_by: [ABC-09]
labels: [backend]
agent_session: null
attempts: 0
last_event_at: null
---

## Task
Fix the thing.

## Acceptance criteria
- [ ] it works
`;

describe('cost_run_id round trip', () => {
  it('persists the daemon-owned dispatch identity and omits it for legacy tasks', () => {
    const runId = 'a4a1e0db-80c1-4c55-8bb7-dae28d980ae6';
    const task = parseTaskFile(
      FULL.replace('last_event_at: null', `last_event_at: null\ncost_run_id: ${runId}`),
      'ABC-12',
    );
    expect(task.costRunId).toBe(runId);
    expect(serializeTask(task)).toContain(`cost_run_id: ${runId}`);
    expect(serializeTask(parseTaskFile(FULL, 'ABC-12'))).not.toContain('cost_run_id');
  });
});

describe('salvage_source_* round trip', () => {
  it('serializes and re-parses clean-salvage provenance', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const withProv = `${FULL.replace(
      'last_event_at: null',
      `last_event_at: null\nsalvage_source_task: SRC-OLD\nsalvage_source_sha: ${sha}`,
    )}`;
    const task = parseTaskFile(withProv, 'ABC-12');
    expect(task.salvageSourceTask).toBe('SRC-OLD');
    expect(task.salvageSourceSha).toBe(sha);
    const out = serializeTask(task);
    expect(out).toContain('salvage_source_task: SRC-OLD');
    expect(out).toContain(`salvage_source_sha: ${sha}`);
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect(legacy.salvageSourceTask ?? null).toBeNull();
    expect(legacy.salvageSourceSha ?? null).toBeNull();
    expect(serializeTask(legacy)).not.toContain('salvage_source_');
  });

  it('seed_from_sha (verify-from-ref, C3.43) round-trips and is OMITTED when absent — never null', () => {
    const sha = 'ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD';
    const seeded = FULL.replace('last_event_at: null', `last_event_at: null\nseed_from_sha: ${sha}`);
    const task = parseTaskFile(seeded, 'ABC-12');
    expect(task.seedFromSha).toBe(sha.toLowerCase());
    expect(serializeTask(task)).toContain(`seed_from_sha: ${sha.toLowerCase()}`);
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect('seedFromSha' in legacy).toBe(false);
    expect(serializeTask(legacy)).not.toContain('seed_from_sha');
    expect(() => parseTaskFile(
      FULL.replace('last_event_at: null', 'last_event_at: null\nseed_from_sha: nothex'), 'ABC-12',
    )).toThrow();
  });

  it('verified_gates_green (C3.57) is emitted only when true and OMITTED otherwise — never null', () => {
    const sha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const green = FULL.replace(
      'last_event_at: null',
      `last_event_at: null\nverified_sha: ${sha}\nverified_gates_green: true`,
    );
    const task = parseTaskFile(green, 'ABC-12');
    expect(task.verifiedGatesGreen).toBe(true);
    expect(serializeTask(task)).toContain('verified_gates_green: true');
    // Cleared in memory (null, like packet_nonce) → not emitted.
    expect(serializeTask({ ...task, verifiedGatesGreen: null })).not.toContain('verified_gates_green');
    // Never emitted without a verified sha.
    expect(serializeTask({ ...task, verifiedSha: null })).not.toContain('verified_gates_green');
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect('verifiedGatesGreen' in legacy).toBe(false);
    expect(serializeTask(legacy)).not.toContain('verified_gates_green');
    expect(() =>
      parseTaskFile(FULL.replace('last_event_at: null', 'last_event_at: null\nverified_gates_green: false'), 'ABC-12'),
    ).toThrow();
  });

  it('rejects partial salvage provenance', () => {
    const onlyTask = FULL.replace(
      'last_event_at: null',
      'last_event_at: null\nsalvage_source_task: SRC-OLD',
    );
    expect(() => parseTaskFile(onlyTask, 'ABC-12')).toThrow(/both be set/i);
  });
});

/**
 * Keys that are `null` on a legacy task parsed from the FULL fixture — the
 * exact set that existed when the production shadow store's envelopes were
 * first written (schema ≤ 6). A new optional field must be OMITTED when
 * absent, never `null`: `null` changes hashCanonicalJson(task) and the
 * reconciler then refuses to boot (production rollback 2026-09-06).
 */
const LEGACY_NULL_KEYS: readonly string[] = [
  'adapter',
  'agentSession',
  'agentSessionAdapter',
  'createdAt',
  'dependencyMode',
  'endedAt',
  'fakeBehavior',
  'hostApprovedAt',
  'hostCommandScope',
  'hostExecutionStartedAt',
  'lastEventAt',
  'mergedSha',
  'mergedVia',
  'pendingSteer',
  'prStatus',
  'prUrl',
  'salvageSourceSha',
  'salvageSourceTask',
  'startedAt',
  'verifiedSha',
];

describe('packet_nonce round trip + canonical-hash stability (2026-09-06 production rollback)', () => {
  it('a legacy task without packet_nonce parses WITHOUT the key, so its canonical hash is unchanged', () => {
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect('packetNonce' in legacy).toBe(false);
    // Golden: the parsed shape must hash exactly like a copy with the key deleted —
    // i.e. the key is absent, not null (null would change hashCanonicalJson and
    // break the reconciler's envelope binding on boot).
    const copy = { ...legacy } as Record<string, unknown>;
    delete copy['packetNonce'];
    expect(hashCanonicalJson(legacy)).toBe(hashCanonicalJson(copy));
    expect(serializeTask(legacy)).not.toContain('packet_nonce');
  });

  it('serializes and re-parses packetNonce when present', () => {
    const withNonce = `${FULL.replace('last_event_at: null', 'last_event_at: null\npacket_nonce: 0123456789abcdef0123456789abcdef')}`;
    const task = parseTaskFile(withNonce, 'ABC-12');
    expect(task.packetNonce).toBe('0123456789abcdef0123456789abcdef');
    expect(serializeTask(task)).toContain('packet_nonce: 0123456789abcdef0123456789abcdef');
  });

  it('pins the parsed key set of a legacy task — new optional fields must be omitted when absent', () => {
    const legacy = parseTaskFile(FULL, 'ABC-12');
    const nullKeys = Object.entries(legacy)
      .filter(([, v]) => v === null)
      .map(([k]) => k)
      .sort();
    // Keys that were ALREADY null on legacy tasks when the shadow store's first
    // envelopes were written (schema ≤ 6). Adding to this list changes the
    // canonical hash of every historical envelope — do not.
    expect(nullKeys).toEqual(LEGACY_NULL_KEYS);
  });
});

describe('verified_sha round trip', () => {
  it('serializes and re-parses verifiedSha (approve tip invariant)', () => {
    const withSha = `${FULL.replace('last_event_at: null', 'last_event_at: null\nverified_sha: cafe1234cafe1234cafe1234cafe1234cafe1234')}`;
    const task = parseTaskFile(withSha, 'ABC-12');
    expect(task.verifiedSha).toBe('cafe1234cafe1234cafe1234cafe1234cafe1234');
    const out = serializeTask(task);
    expect(out).toContain('verified_sha: cafe1234cafe1234cafe1234cafe1234cafe1234');
    // Legacy tasks without the field stay null and do not emit the key.
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect(legacy.verifiedSha ?? null).toBeNull();
    expect(serializeTask(legacy)).not.toContain('verified_sha');
  });
});

describe('packet_nonce round trip', () => {
  it('serializes and re-parses packetNonce (C3.28 provenance metadata)', () => {
    const nonce = 'a'.repeat(32);
    const withNonce = `${FULL.replace('last_event_at: null', `last_event_at: null\npacket_nonce: ${nonce}`)}`;
    const task = parseTaskFile(withNonce, 'ABC-12');
    expect(task.packetNonce).toBe(nonce);
    const out = serializeTask(task);
    expect(out).toContain(`packet_nonce: ${nonce}`);
    // Legacy tasks without the field stay null and do not emit the key.
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect(legacy.packetNonce ?? null).toBeNull();
    expect(serializeTask(legacy)).not.toContain('packet_nonce');
  });
});

describe('execution_class + host approval round trip', () => {
  it('defaults legacy omit to implement and does not re-emit the key', () => {
    const task = parseTaskFile(FULL, 'ABC-12');
    expect(task.executionClass).toBe('implement');
    expect(task.hostCommandScope ?? null).toBeNull();
    expect(task.hostApprovedAt ?? null).toBeNull();
    const out = serializeTask(task);
    expect(out).not.toMatch(/^\s*execution_class:/m);
    expect(out).not.toMatch(/^\s*host_command_scope:/m);
    expect(out).not.toMatch(/^\s*host_approved_at:/m);
  });

  it('round-trips host_operation with command scope + approved_at', () => {
    const content = `---
title: Restart unit
repo: app
state: todo
execution_class: host_operation
host_command_scope:
  - systemctl restart hercules
  - curl -sf http://localhost:8787/
host_approved_at: 2026-07-31T12:00:00.000Z
---
body
`;
    const task = parseTaskFile(content, 'HOST-1');
    expect(task.executionClass).toBe('host_operation');
    expect(task.hostCommandScope).toEqual([
      'systemctl restart hercules',
      'curl -sf http://localhost:8787/',
    ]);
    expect(task.hostApprovedAt).toBe('2026-07-31T12:00:00.000Z');
    expect(task.hostExecutionStartedAt).toBeNull();
    const out = serializeTask(task);
    expect(out).toContain('execution_class: host_operation');
    expect(out).toContain('systemctl restart hercules');
    expect(out).toContain('host_approved_at: 2026-07-31T12:00:00.000Z');
    expect(parseTaskFile(out, 'HOST-1').executionClass).toBe('host_operation');
  });

  it('round-trips host_execution_started_at durable marker', () => {
    // Use a non-boolean-looking command: bare YAML `true` is a boolean and
    // fails z.array(z.string()) on host_command_scope.
    const content = `---
title: Deploy
repo: app
state: in_progress
execution_class: deploy
host_command_scope:
  - systemctl is-active hercules
host_approved_at: 2026-07-31T12:00:00.000Z
host_execution_started_at: 2026-07-31T12:05:00.000Z
---
body
`;
    const task = parseTaskFile(content, 'HOST-2');
    expect(task.hostExecutionStartedAt).toBe('2026-07-31T12:05:00.000Z');
    expect(task.hostCommandScope).toEqual(['systemctl is-active hercules']);
    const out = serializeTask(task);
    expect(out).toContain('host_execution_started_at: 2026-07-31T12:05:00.000Z');
    expect(parseTaskFile(out, 'HOST-2').hostExecutionStartedAt).toBe(
      '2026-07-31T12:05:00.000Z',
    );
  });

  it('rejects unknown execution_class', () => {
    expect(() =>
      parseTaskFile(
        `---\ntitle: T\nrepo: app\nstate: todo\nexecution_class: root_shell\n---\nx\n`,
        'BAD-1',
      ),
    ).toThrow(/execution_class/);
  });

  it('rejects malformed or mismatched host approval fields', () => {
    expect(() =>
      parseTaskFile(
        `---\ntitle: T\nrepo: app\nstate: todo\nexecution_class: deploy\nhost_command_scope: [bash -c id]\nhost_approved_at: nope\n---\nx\n`,
        'BAD-HOST-1',
      ),
    ).toThrow(/host_command_scope|host_approved_at/);
    expect(() =>
      parseTaskFile(
        `---\ntitle: T\nrepo: app\nstate: todo\nexecution_class: deploy\nhost_command_scope: [systemctl restart hercules]\n---\nx\n`,
        'BAD-HOST-2',
      ),
    ).toThrow(/must either both be set/);
    expect(() =>
      parseTaskFile(
        `---\ntitle: T\nrepo: app\nstate: todo\nexecution_class: implement\nhost_command_scope: [systemctl restart hercules]\nhost_approved_at: 2026-07-31T12:00:00.000Z\n---\nx\n`,
        'BAD-HOST-3',
      ),
    ).toThrow(/only valid for host_operation or deploy/);
  });
});

describe('merged_sha round trip', () => {
  it('serializes and re-parses mergedSha (human Merge audit)', () => {
    const withSha = `${FULL.replace('last_event_at: null', 'last_event_at: null\nmerged_sha: abcd1234abcd1234abcd1234abcd1234abcd1234')}`;
    const task = parseTaskFile(withSha, 'ABC-12');
    expect(task.mergedSha).toBe('abcd1234abcd1234abcd1234abcd1234abcd1234');
    const out = serializeTask(task);
    expect(out).toContain('merged_sha: abcd1234abcd1234abcd1234abcd1234abcd1234');
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect(legacy.mergedSha ?? null).toBeNull();
    expect(serializeTask(legacy)).not.toContain('merged_sha');
  });

  it('round-trips merged_via gate stamp (promote trust-chain)', () => {
    const withVia = `${FULL.replace(
      'last_event_at: null',
      'last_event_at: null\nmerged_sha: abcd1234abcd1234abcd1234abcd1234abcd1234\nmerged_via: gate',
    )}`;
    const task = parseTaskFile(withVia, 'ABC-12');
    expect(task.mergedVia).toBe('gate');
    const out = serializeTask(task);
    expect(out).toContain('merged_via: gate');
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect(legacy.mergedVia ?? null).toBeNull();
    expect(serializeTask(legacy)).not.toContain('merged_via');
  });

  it('round-trips dependency_mode (gate-merge barrier)', () => {
    const withMode = FULL.replace(
      'blocked_by: [ABC-09]',
      'blocked_by: [ABC-09]\ndependency_mode: completion_only',
    );
    const task = parseTaskFile(withMode, 'ABC-12');
    expect(task.dependencyMode).toBe('completion_only');
    const out = serializeTask(task);
    expect(out).toContain('dependency_mode: completion_only');
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect(legacy.dependencyMode ?? null).toBeNull();
    expect(serializeTask(legacy)).not.toContain('dependency_mode');
  });
});

describe('parseTaskFile', () => {
  it('parses full front matter and body', () => {
    const task = parseTaskFile(FULL, 'ABC-12');
    expect(task.id).toBe('ABC-12');
    expect(task.title).toBe('Fix flaky upload retry');
    expect(task.repo).toBe('my-app');
    expect(task.state).toBe('todo');
    expect(task.priority).toBe(2);
    expect(task.blockedBy).toEqual(['ABC-09']);
    expect(task.labels).toEqual(['backend']);
    expect(task.adapter).toBeNull();
    expect(task.agentSession).toBeNull();
    expect(task.attempts).toBe(0);
    expect(task.lastEventAt).toBeNull();
    expect(task.body).toContain('## Task');
    expect(task.body).toContain('it works');
  });

  it('coerces an unquoted ISO timestamp (YAML parses it as a Date) back to a string', () => {
    const content = `---\ntitle: T\nrepo: app\nstate: in_progress\nstarted_at: 2026-06-23T01:00:00.000Z\n---\nbody`;
    const task = parseTaskFile(content, 'T-1');
    expect(task.startedAt).toBe('2026-06-23T01:00:00.000Z');
    expect(typeof task.startedAt).toBe('string');
  });

  it('derives id from the file stem and applies defaults for daemon-owned fields', () => {
    const minimal = `---
title: Minimal task
repo: my-app
state: todo
---
Body here.
`;
    const task = parseTaskFile(minimal, 'XYZ-1');
    expect(task.id).toBe('XYZ-1');
    expect(task.priority).toBe(100);
    expect(task.blockedBy).toEqual([]);
    expect(task.labels).toEqual([]);
    expect(task.agentSession).toBeNull();
    expect(task.attempts).toBe(0);
    expect(task.lastEventAt).toBeNull();
  });

  it('throws when front matter id disagrees with the file stem', () => {
    expect(() => parseTaskFile(FULL, 'OTHER-99')).toThrow(TaskFileError);
  });

  it('throws on an unsafe file stem', () => {
    expect(() => parseTaskFile(FULL, '../evil')).toThrow(TaskFileError);
  });

  it('throws on an invalid state', () => {
    const bad = `---
title: t
repo: my-app
state: banana
---
`;
    expect(() => parseTaskFile(bad, 'ABC-1')).toThrow(TaskFileError);
  });

  it('throws when required fields are missing', () => {
    const bad = `---
state: todo
---
`;
    expect(() => parseTaskFile(bad, 'ABC-1')).toThrow(TaskFileError);
  });

  it('throws when there is no front matter at all', () => {
    expect(() => parseTaskFile('just a body', 'ABC-1')).toThrow(TaskFileError);
  });
});

describe('serializeTask / round-trip', () => {
  it('round-trips a parsed task back to an equivalent task', () => {
    const task = parseTaskFile(FULL, 'ABC-12');
    const serialized = serializeTask(task);
    const reparsed = parseTaskFile(serialized, 'ABC-12');
    expect(reparsed).toEqual(task);
  });

  it('emits snake_case keys', () => {
    const task: Task = {
      id: 'ABC-12',
      title: 'T',
      repo: 'my-app',
      state: 'in_progress',
      priority: 5,
      blockedBy: ['A-1'],
      labels: ['x'],
      adapter: null,
      agentSession: 'sess-123',
      agentSessionAdapter: 'grok',
      pendingSteer: 'what about loop 58?',
      attempts: 2,
      lastEventAt: '2026-06-17T00:00:00.000Z',
      createdAt: '2026-06-17T00:00:00.000Z',
      startedAt: null,
      endedAt: null,
      prUrl: null,
      prStatus: null,
      planPending: false,
      body: 'hello',
    };
    const out = serializeTask(task);
    expect(out).toContain('blocked_by:');
    expect(out).toContain('agent_session: sess-123');
    expect(out).toContain('agent_session_adapter: grok');
    expect(out).toContain('pending_steer: what about loop 58?');
    expect(out).toContain('last_event_at:');
    expect(out).toContain('created_at:');
    expect(out).not.toContain('blockedBy');
    expect(out).not.toContain('agentSession');
    expect(out).not.toContain('pendingSteer');
  });

  it('round-trips pr_url / pr_status and omits them when null', () => {
    const withPr = parseTaskFile(
      `---\ntitle: T\nrepo: app\nstate: done\npr_url: https://github.com/o/r/pull/1\npr_status: open\n---\nbody\n`,
      'T-pr',
    );
    expect(withPr.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(withPr.prStatus).toBe('open');
    const ser = serializeTask(withPr);
    expect(ser).toContain('pr_url:');
    expect(ser).toContain('pr_status: open');

    const none = parseTaskFile(`---\ntitle: T\nrepo: app\nstate: done\n---\nx\n`, 'T-npr');
    expect(none.prUrl).toBeNull();
    expect(none.prStatus).toBeNull();
    expect(serializeTask(none)).not.toMatch(/^\s*pr_url:/m);
  });

  it('round-trips pending_steer and omits it when null', () => {
    const withSteer = parseTaskFile(
      `---\ntitle: T\nrepo: app\nstate: todo\npending_steer: follow up\n---\nbody\n`,
      'T-s',
    );
    expect(withSteer.pendingSteer).toBe('follow up');
    expect(serializeTask(withSteer)).toContain('pending_steer: follow up');

    const none = parseTaskFile(`---\ntitle: T\nrepo: app\nstate: todo\n---\nx\n`, 'T-n');
    expect(none.pendingSteer).toBeNull();
    expect(serializeTask(none)).not.toMatch(/^\s*pending_steer:/m);
  });

  it('round-trips provider ownership and rejects unknown owners', () => {
    const owned = parseTaskFile(
      `---\ntitle: T\nrepo: app\nstate: todo\nagent_session: sess-1\nagent_session_adapter: codex\n---\nbody\n`,
      'T-owned',
    );
    expect(owned.agentSessionAdapter).toBe('codex');
    expect(serializeTask(owned)).toContain('agent_session_adapter: codex');

    expect(() =>
      parseTaskFile(
        `---\ntitle: T\nrepo: app\nstate: todo\nagent_session: sess-1\nagent_session_adapter: alien\n---\nbody\n`,
        'T-bad-owner',
      ),
    ).toThrow(/unknown adapter/i);
  });

  it('round-trips a per-task adapter override and omits null on serialize', () => {
    const withAgent = parseTaskFile(
      `---\ntitle: T\nrepo: app\nstate: todo\nadapter: codex\n---\nbody\n`,
      'T-1',
    );
    expect(withAgent.adapter).toBe('codex');
    const out = serializeTask(withAgent);
    expect(out).toContain('adapter: codex');
    expect(parseTaskFile(out, 'T-1').adapter).toBe('codex');

    const noOverride = parseTaskFile(`---\ntitle: T\nrepo: app\nstate: todo\n---\nx\n`, 'T-2');
    expect(noOverride.adapter).toBeNull();
    expect(serializeTask(noOverride)).not.toMatch(/^\s*adapter:/m);
  });

  it('round-trips fake_behavior and omits when unset', () => {
    const withScript = parseTaskFile(
      `---\ntitle: T\nrepo: app\nstate: todo\nfake_behavior: die-immediately\n---\nbody\n`,
      'T-fb',
    );
    expect(withScript.fakeBehavior).toBe('die-immediately');
    const out = serializeTask(withScript);
    expect(out).toContain('fake_behavior: die-immediately');
    expect(parseTaskFile(out, 'T-fb').fakeBehavior).toBe('die-immediately');

    const none = parseTaskFile(`---\ntitle: T\nrepo: app\nstate: todo\n---\nx\n`, 'T-nfb');
    expect(none.fakeBehavior ?? null).toBeNull();
    expect(serializeTask(none)).not.toMatch(/^\s*fake_behavior:/m);
  });

  it('rejects unknown fake_behavior values', () => {
    expect(() =>
      parseTaskFile(
        `---\ntitle: T\nrepo: app\nstate: todo\nfake_behavior: explode\n---\nx\n`,
        'T-bad',
      ),
    ).toThrow(/fake_behavior/);
  });
});

describe('task branch lease provenance', () => {
  const base = 'a'.repeat(40);
  const tip = 'b'.repeat(40);

  it('round-trips an exact update lease and an explicit creation lease', () => {
    const update = parseTaskFile(
      `---\ntitle: Lease\nrepo: app\nstate: todo\nexpected_base_revision: ${base}\nexpected_remote_tip: ${tip}\n---\nbody\n`,
      'LEASE-1',
    );
    expect(update.expectedBaseRevision).toBe(base);
    expect(update.expectedRemoteTip).toBe(tip);
    expect(parseTaskFile(serializeTask(update), 'LEASE-1')).toMatchObject({
      expectedBaseRevision: base,
      expectedRemoteTip: tip,
    });

    const creation = { ...update, expectedRemoteTip: null };
    const serialized = serializeTask(creation);
    expect(serialized).toMatch(/^expected_remote_tip: null$/m);
    expect(parseTaskFile(serialized, 'LEASE-1').expectedRemoteTip).toBeNull();
  });

  it('keeps legacy absence distinct and rejects abbreviated or malformed SHAs', () => {
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect(legacy.expectedBaseRevision).toBeUndefined();
    expect(legacy.expectedRemoteTip).toBeUndefined();
    expect(serializeTask(legacy)).not.toContain('expected_remote_tip');

    for (const line of [
      'expected_base_revision: abc1234',
      'expected_remote_tip: not-a-sha',
    ]) {
      expect(() =>
        parseTaskFile(
          `---\ntitle: Lease\nrepo: app\nstate: todo\n${line}\n---\nbody\n`,
          'LEASE-bad',
        ),
      ).toThrow(TaskFileError);
    }
  });
});

describe('task path lease declarations', () => {
  const base = 'a'.repeat(40);

  it('round-trips base revision, affected paths, and protected snapshot', () => {
    const task = parseTaskFile(
      [
        '---',
        'title: Paths',
        'repo: app',
        'state: todo',
        `planned_base_revision: ${base}`,
        'affected_paths:',
        '  - src/domain/',
        '  - src/a.ts',
        'protected_paths_snapshot:',
        '  - WORKFLOW.md',
        '  - secrets/**',
        '---',
        'body',
        '',
      ].join('\n'),
      'PATH-1',
    );
    expect(task.plannedBaseRevision).toBe(base);
    // Canonical order + subtree trailing slash.
    expect(task.affectedPaths).toEqual(['src/a.ts', 'src/domain/']);
    expect(task.protectedPathsSnapshot).toEqual(['WORKFLOW.md', 'secrets/**']);
    const again = parseTaskFile(serializeTask(task), 'PATH-1');
    expect(again.affectedPaths).toEqual(task.affectedPaths);
    expect(again.protectedPathsSnapshot).toEqual(task.protectedPathsSnapshot);
    expect(again.plannedBaseRevision).toBe(base);
  });

  it('rejects overlapping or absolute affected_paths', () => {
    expect(() =>
      parseTaskFile(
        [
          '---',
          'title: Bad',
          'repo: app',
          'state: todo',
          'affected_paths:',
          '  - src/a.ts',
          '  - src/',
          '---',
          'x',
          '',
        ].join('\n'),
        'PATH-bad',
      ),
    ).toThrow(/affected_paths/);

    expect(() =>
      parseTaskFile(
        [
          '---',
          'title: Bad',
          'repo: app',
          'state: todo',
          'affected_paths:',
          '  - /abs/path.ts',
          '---',
          'x',
          '',
        ].join('\n'),
        'PATH-abs',
      ),
    ).toThrow(/affected_paths/);
  });

  it('keeps legacy tasks free of path-lease keys', () => {
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect(legacy.affectedPaths).toBeUndefined();
    expect(legacy.protectedPathsSnapshot).toBeUndefined();
    expect(legacy.plannedBaseRevision).toBeUndefined();
    expect(serializeTask(legacy)).not.toContain('affected_paths');
    expect(serializeTask(legacy)).not.toContain('protected_paths_snapshot');
    expect(serializeTask(legacy)).not.toContain('planned_base_revision');
  });

  it('rejects partial triples and unsafe protected snapshots', () => {
    expect(() =>
      parseTaskFile(
        `---\ntitle: Partial\nrepo: app\nstate: todo\nplanned_base_revision: ${base}\naffected_paths: [src/a.ts]\n---\nx\n`,
        'PATH-partial',
      ),
    ).toThrow(/all be set/);
    expect(() =>
      parseTaskFile(
        `---\ntitle: Unsafe\nrepo: app\nstate: todo\nplanned_base_revision: ${base}\naffected_paths: [src/a.ts]\nprotected_paths_snapshot: [../secret]\n---\nx\n`,
        'PATH-unsafe',
      ),
    ).toThrow(/invalid protected_paths_snapshot/);
  });
});

describe('reviewer infrastructure checkpoint', () => {
  it('round-trips the exact candidate recovery receipt', () => {
    const parsed = parseTaskFile(
      [
        '---',
        'title: Review recovery',
        'repo: app',
        'state: retrying',
        'reviewer_infrastructure:',
        '  version: 1',
        '  provider: grok',
        '  state: blocked',
        '  failure_kind: authentication',
        '  observed_at: 2026-08-03T16:00:00.000Z',
        '  detail: Not signed in',
        '  next_action: Run reviewer health check or explicitly recover grok',
        `  candidate_sha: ${'a'.repeat(40)}`,
        '  branch: hercules/review-recovery',
        '  worktree: /work/app/review-recovery',
        '  green_evidence: [typecheck, lint, test, behavioral]',
        '---',
        'body',
        '',
      ].join('\n'),
      'review-recovery',
    );

    expect(parsed.reviewerInfrastructure).toMatchObject({
      provider: 'grok',
      state: 'blocked',
      failureKind: 'authentication',
      candidateSha: 'a'.repeat(40),
    });
    expect(parseTaskFile(serializeTask(parsed), 'review-recovery')).toEqual(parsed);
  });
});

describe('platform_remediation_* round trip', () => {
  it('serializes and re-parses platform remediation chain fields', () => {
    const withChain = `${FULL.replace(
      'last_event_at: null',
      [
        'last_event_at: null',
        'platform_remediation_kind: bug',
        'platform_remediation_task: FIX-1',
        'platform_remediation_resumed_outcome: pending',
        'platform_remediation_recorded_at: 2026-08-03T00:00:00.000Z',
      ].join('\n'),
    )}`;
    const task = parseTaskFile(withChain, 'ABC-12');
    expect(task.platformRemediationKind).toBe('bug');
    expect(task.platformRemediationTask).toBe('FIX-1');
    expect(task.platformRemediationResumedOutcome).toBe('pending');
    expect(task.platformRemediationRecordedAt).toBe('2026-08-03T00:00:00.000Z');
    const out = serializeTask(task);
    expect(out).toContain('platform_remediation_kind: bug');
    expect(out).toContain('platform_remediation_task: FIX-1');
    expect(out).toContain('platform_remediation_resumed_outcome: pending');
    const round = parseTaskFile(out, 'ABC-12');
    expect(round.platformRemediationKind).toBe('bug');
    expect(round.platformRemediationTask).toBe('FIX-1');
    // Legacy without fields stays valid and omits keys.
    const legacy = parseTaskFile(FULL, 'ABC-12');
    expect(legacy.platformRemediationKind ?? null).toBeNull();
    expect(legacy.platformRemediationTask ?? null).toBeNull();
    expect(serializeTask(legacy)).not.toContain('platform_remediation_');
  });

  it('round-trips remediator + bootstrap escalation', () => {
    const content = `---
title: Fix platform
repo: hercules
state: failed
platform_remediation_kind: capability_gap
platform_remediation_of: ORIG-1
bootstrap_escalation: true
bootstrap_escalation_action: Deploy Hercules fix outside control plane
bootstrap_escalation_recorded_at: 2026-08-03T01:00:00.000Z
---
body
`;
    const task = parseTaskFile(content, 'FIX-1');
    expect(task.platformRemediationOf).toBe('ORIG-1');
    expect(task.bootstrapEscalation).toBe(true);
    expect(task.bootstrapEscalationAction).toMatch(/Deploy Hercules/);
    const out = serializeTask(task);
    expect(out).toContain('bootstrap_escalation: true');
    expect(out).toContain('platform_remediation_of: ORIG-1');
    expect(parseTaskFile(out, 'FIX-1').platformRemediationOf).toBe('ORIG-1');
  });

  it('rejects both original and remediator links on one task', () => {
    const bad = FULL.replace(
      'last_event_at: null',
      'last_event_at: null\nplatform_remediation_kind: bug\nplatform_remediation_task: FIX\nplatform_remediation_of: ORIG',
    );
    expect(() => parseTaskFile(bad, 'ABC-12')).toThrow(/both original and remediation/i);
  });
});
