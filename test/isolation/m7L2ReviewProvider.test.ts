import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalSerialize,
  hashCanonicalJson,
} from '../../src/domain/canonicalJson.js';
import {
  reviewDecisionBindingHash,
  reviewDecisionIdempotencyKey,
  reviewDecisionRequestHash,
  type ReviewDecisionApplyResultV1,
  type ReviewDecisionAction,
  type ReviewDecisionCommandV1,
  type ReviewDecisionReceiptV1,
  type ReviewDecisionRequestV1,
} from '../../src/domain/reviewDecision.js';
import { projectAndAssertReviewPackageV2 } from '../../src/domain/reviewPackageV2.js';
import {
  M7_L2_REVIEW_FIXTURE_ENVELOPE_SCHEMA,
  M7_L2_REVIEW_FIXTURE_SCHEMA,
  openM7L2ReviewProvider,
  type M7L2ReviewFixtureEnvelope,
  type M7L2ReviewFaultPoint,
} from '../../src/isolation/m7L2ReviewProvider.js';
import {
  REVIEW_EVIDENCE_FIXTURE_BYTES,
  reviewPackageV2SourceFixture,
} from '../fixtures/reviewPackageV2Source.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }));
});

async function fixture(overrides: Readonly<{
  taskId?: string;
  requiresHumanDecision?: boolean;
  remainingRiskCode?: string;
}> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hercules-m7-provider-'));
  roots.push(root);
  const workRoot = join(root, 'work');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workRoot);
  const source = reviewPackageV2SourceFixture(overrides);
  const projected = projectAndAssertReviewPackageV2(source);
  const payload = {
    schema: M7_L2_REVIEW_FIXTURE_SCHEMA,
    actor: { kind: 'human' as const, id: 'reviewer-1', issuer: 'l2-fixture' },
    tasks: [{
      source,
      evidence: [{
        artifactRefId: source.artifacts[0]!.id,
        sha256: source.artifacts[0]!.sha256,
        mediaType: source.artifacts[0]!.mediaType,
        redactionState: source.artifacts[0]!.redactionState,
        contentBase64: Buffer.from(REVIEW_EVIDENCE_FIXTURE_BYTES).toString('base64'),
      }],
      learningProposals: [{
        id: 'proposal-1',
        title: 'Keep the unit gate',
        advisorySummary: 'A scratch-only proposal.',
        status: 'proposed' as const,
        evidenceArtifactIds: [source.artifacts[0]!.id],
      }],
    }],
  };
  const envelope: M7L2ReviewFixtureEnvelope = {
    schema: M7_L2_REVIEW_FIXTURE_ENVELOPE_SCHEMA,
    payload,
    fixtureHash: hashCanonicalJson(payload),
  };
  const fixturePath = join(workRoot, 'review-fixture.json');
  await writeFile(fixturePath, JSON.stringify(envelope));
  return { root, workRoot, fixturePath, source, projected, envelope };
}

async function open(input: Awaited<ReturnType<typeof fixture>>, extra: Readonly<{
  now?: () => string;
  fault?: (point: M7L2ReviewFaultPoint) => void | Promise<void>;
}> = {}) {
  const provider = await openM7L2ReviewProvider({
    env: {
      HERCULES_ADAPTER: 'fake',
      HERCULES_FAKE_FAULT_INJECTION: '1',
      HERCULES_L2_ISOLATED: '1',
    },
    workRoot: input.workRoot,
    fixturePath: input.fixturePath,
    inspectSource: projectAndAssertReviewPackageV2,
    ...extra,
  });
  expect(provider).not.toBeNull();
  return provider!;
}

function command(
  input: Awaited<ReturnType<typeof fixture>>,
  action: ReviewDecisionAction,
  clientRequestId = `request-${action}`,
): ReviewDecisionCommandV1 {
  const reason = action === 'request_changes' ? 'Please revise the implementation.' : null;
  const acknowledgedRiskCodes = action === 'request_changes' ? [] : [
    ...input.projected.blockingFindings.map((risk) => risk.code),
    ...input.projected.remainingRisks.map((risk) => risk.code),
  ].sort();
  const request: ReviewDecisionRequestV1 = {
    schema: 'hercules-review-decision-request/v1',
    clientRequestId,
    taskId: input.source.task.id,
    projectionHash: input.projected.projectionHash,
    decisionBinding: input.source.currentBinding,
    action,
    reason,
    acknowledgedRiskCodes,
  };
  return {
    request,
    requestHash: reviewDecisionRequestHash(request),
    actor: { kind: 'human', id: 'reviewer-1', issuer: 'l2-fixture' },
    expectedProjectionHash: request.projectionHash,
    expectedDecisionBindingHash: reviewDecisionBindingHash(request.decisionBinding),
  };
}

function statePath(input: Awaited<ReturnType<typeof fixture>>): string {
  return join(
    input.workRoot,
    '.hercules-m7-review-state',
    input.envelope.fixtureHash.slice('sha256:'.length),
    'state.json',
  );
}

function stateDirectoryPath(input: Awaited<ReturnType<typeof fixture>>): string {
  return join(
    input.workRoot,
    '.hercules-m7-review-state',
    input.envelope.fixtureHash.slice('sha256:'.length),
  );
}

function lockPath(input: Awaited<ReturnType<typeof fixture>>): string {
  return join(
    input.workRoot,
    '.hercules-m7-review-state',
    `.${input.envelope.fixtureHash.slice('sha256:'.length)}.lock`,
  );
}

function anchorPath(input: Awaited<ReturnType<typeof fixture>>): string {
  return join(stateDirectoryPath(input), 'anchor.json');
}

function pendingPath(input: Awaited<ReturnType<typeof fixture>>): string {
  return join(stateDirectoryPath(input), 'pending.json');
}

interface MutableDecisionEvent {
  request: Record<string, unknown>;
  requestHash: string;
  receipt: Record<string, unknown>;
}

interface MutableStateEnvelope {
  payload: {
    tasks: Array<{
      source: {
        humanDecisions: Array<Record<string, unknown>>;
        iterationHistory: Array<Record<string, unknown>>;
      };
      events: MutableDecisionEvent[];
    }>;
  };
  stateHash: string;
}

async function readMutableState(
  input: Awaited<ReturnType<typeof fixture>>,
): Promise<MutableStateEnvelope> {
  return JSON.parse(await readFile(statePath(input), 'utf8')) as MutableStateEnvelope;
}

async function writeRehashedState(
  input: Awaited<ReturnType<typeof fixture>>,
  envelope: MutableStateEnvelope,
): Promise<void> {
  envelope.stateHash = hashCanonicalJson(envelope.payload);
  await writeFile(statePath(input), canonicalSerialize(envelope));
}

function rehashRequestAndReceipt(event: MutableDecisionEvent): void {
  event.requestHash = hashCanonicalJson(event.request);
  event.receipt['requestHash'] = event.requestHash;
  const { receiptHash: _receiptHash, ...receiptBody } = event.receipt;
  event.receipt['receiptHash'] = hashCanonicalJson(receiptBody);
}

describe('M7 isolated L2 review provider', () => {
  it('performs zero filesystem IO unless every isolation guard is exact', async () => {
    const missing = join(tmpdir(), 'definitely-missing-m7-root');
    await expect(openM7L2ReviewProvider({
      env: { HERCULES_ADAPTER: 'grok', HERCULES_FAKE_FAULT_INJECTION: '1' },
      workRoot: missing,
      fixturePath: join(missing, 'fixture.json'),
      inspectSource: projectAndAssertReviewPackageV2,
    })).resolves.toBeNull();
    await expect(openM7L2ReviewProvider({
      env: { HERCULES_ADAPTER: 'fake', HERCULES_FAKE_FAULT_INJECTION: 'true' },
      workRoot: missing,
      fixturePath: join(missing, 'fixture.json'),
      inspectSource: projectAndAssertReviewPackageV2,
    })).resolves.toBeNull();
    await expect(openM7L2ReviewProvider({
      env: { HERCULES_ADAPTER: 'fake', HERCULES_FAKE_FAULT_INJECTION: '1' },
      workRoot: missing,
      fixturePath: join(missing, 'fixture.json'),
      inspectSource: projectAndAssertReviewPackageV2,
    })).resolves.toBeNull();
  });

  it('rejects altered, relative, outside-root, and symlink fixture inputs', async () => {
    const input = await fixture();
    const altered = { ...input.envelope, fixtureHash: `sha256:${'0'.repeat(64)}` };
    await writeFile(input.fixturePath, JSON.stringify(altered));
    await expect(open(input)).rejects.toThrow(/fixture hash/i);
    await writeFile(input.fixturePath, JSON.stringify(input.envelope));
    await expect(openM7L2ReviewProvider({
      env: {
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '1',
        HERCULES_L2_ISOLATED: '1',
      },
      workRoot: input.workRoot,
      fixturePath: 'relative.json',
      inspectSource: projectAndAssertReviewPackageV2,
    })).rejects.toThrow(/absolute/i);
    const outside = join(input.root, 'outside.json');
    await writeFile(outside, JSON.stringify(input.envelope));
    await expect(openM7L2ReviewProvider({
      env: {
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '1',
        HERCULES_L2_ISOLATED: '1',
      },
      workRoot: input.workRoot,
      fixturePath: outside,
      inspectSource: projectAndAssertReviewPackageV2,
    })).rejects.toThrow(/confined/i);
    const link = join(input.workRoot, 'linked.json');
    await symlink(input.fixturePath, link);
    await expect(openM7L2ReviewProvider({
      env: {
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '1',
        HERCULES_L2_ISOLATED: '1',
      },
      workRoot: input.workRoot,
      fixturePath: link,
      inspectSource: projectAndAssertReviewPackageV2,
    })).rejects.toThrow();
  });

  it('owns one immutable seed and exposes binding-aware shared read ports', async () => {
    const input = await fixture();
    const provider = await open(input);
    await writeFile(input.fixturePath, '{"mutated":true}');
    const source = await provider.read(input.source.task.id);
    expect(source).toEqual({ status: 'available', source: input.source });
    expect(await provider.actor.resolveActor()).toEqual({
      kind: 'human', id: 'reviewer-1', issuer: 'l2-fixture',
    });
    expect(await provider.evidence.read({
      schema: 'hercules-review-evidence-read/v1',
      actor: { kind: 'human', id: 'reviewer-1', issuer: 'l2-fixture' },
      taskId: input.source.task.id,
      projectionHash: input.projected.projectionHash,
      artifactRefId: input.source.artifacts[0]!.id,
      sha256: input.source.artifacts[0]!.sha256,
      redactionState: 'none',
      purpose: 'operator_review',
    })).toMatchObject({ status: 'available', bytes: REVIEW_EVIDENCE_FIXTURE_BYTES });
    expect(await provider.learning.read({
      taskId: input.source.task.id,
      projectionHash: input.projected.projectionHash,
    })).toMatchObject({ status: 'available', proposals: [{ taskId: input.source.task.id }] });
  });

  it.each(['approve_outcome', 'reject_outcome'] as const)(
    'records exactly one %s decision without changing iteration',
    async (action) => {
      const input = await fixture({ requiresHumanDecision: true });
      const provider = await open(input, { now: () => '2026-08-29T01:00:00.000Z' });
      const applied = await provider.apply(command(input, action));
      expect(applied.kind).toBe('committed');
      const next = await provider.read(input.source.task.id);
      expect(next.status).toBe('available');
      if (next.status !== 'available') return;
      expect(next.source.currentIteration).toEqual(input.source.currentIteration);
      expect(next.source.humanDecisions).toMatchObject([{
        decision: action, actor: { kind: 'human', id: 'reviewer-1' },
      }]);
      expect(projectAndAssertReviewPackageV2(next.source).projectionHash)
        .not.toBe(input.projected.projectionHash);
    },
  );

  it('request_changes closes the prior iteration and creates one empty planned successor', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input, { now: () => '2026-08-29T01:00:00.000Z' });
    const applied = await provider.apply(command(input, 'request_changes'));
    expect(applied).toMatchObject({ kind: 'committed' });
    const next = await provider.read(input.source.task.id);
    expect(next.status).toBe('available');
    if (next.status !== 'available') return;
    expect(next.source.iterationHistory).toHaveLength(2);
    expect(next.source.iterationHistory[0]).toMatchObject({ state: 'failed' });
    expect(next.source.currentIteration).toMatchObject({
      state: 'planned', ordinal: 2, candidateRef: null, evidenceManifestId: null,
      finalVerdictId: null, supersedesIterationId: input.source.currentIteration.id,
    });
    expect(next.source.evidenceManifest).toBeNull();
    expect(next.source.evaluation).toBeNull();
    expect(projectAndAssertReviewPackageV2(next.source).validDecisions).toEqual([]);
    expect(await (await open(input)).apply(command(input, 'request_changes')))
      .toMatchObject({ kind: 'duplicate' });
  });

  it('request_changes remains eligible when the package carries a verified risk', async () => {
    const input = await fixture({
      requiresHumanDecision: true,
      remainingRiskCode: 'risk-a',
    });
    const provider = await open(input);
    expect(await provider.apply(command(input, 'request_changes')))
      .toMatchObject({ kind: 'committed' });
  });

  it('scopes idempotency by issuer, replays across restart, and validates durable receipts', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    const firstCommand = command(input, 'approve_outcome', 'same-id');
    const first = await provider.apply(firstCommand);
    expect(first.kind).toBe('committed');
    expect(await provider.apply(firstCommand)).toMatchObject({ kind: 'duplicate' });
    const restarted = await open(input);
    const key = reviewDecisionIdempotencyKey(firstCommand.actor, firstCommand.request);
    const receipt = await restarted.lookup(key);
    expect(receipt).not.toBeNull();
    expect(await restarted.validateCommittedReceipt({
      key, requestHash: firstCommand.requestHash, receipt: receipt!,
    })).toEqual({ kind: 'valid' });
    expect(await restarted.apply(command(input, 'reject_outcome', 'same-id')))
      .toMatchObject({ kind: 'idempotency_conflict' });
    expect(await restarted.lookup({ ...key, actorIssuer: 'other-issuer' })).toBeNull();
    expect(await restarted.apply({
      ...firstCommand,
      actor: { ...firstCommand.actor, issuer: 'other-issuer' },
    })).toMatchObject({ kind: 'unavailable', reason: 'provider_contract_violation' });
  });

  it('serializes concurrent CAS so only one changed request commits', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    const results = await Promise.all([
      provider.apply(command(input, 'approve_outcome', 'race-a')),
      provider.apply(command(input, 'reject_outcome', 'race-b')),
    ]);
    expect(results.filter((result) => result.kind === 'committed')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'stale')).toHaveLength(1);
  });

  it('serializes concurrent exact retries into one commit and one duplicate', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    const exact = command(input, 'approve_outcome', 'same-concurrent-id');
    const results = await Promise.all([provider.apply(exact), provider.apply(exact)]);
    expect(results.map((result) => result.kind).sort()).toEqual(['committed', 'duplicate']);
    const receipts = results.flatMap((result) =>
      result.kind === 'committed' || result.kind === 'duplicate' ? [result.receipt] : []);
    expect(receipts[0]).toEqual(receipts[1]);
  });

  it('serializes changed commands across two independent provider instances', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    await open(input);
    const firstProvider = await open(input);
    const secondProvider = await open(input);
    const results = await Promise.all([
      firstProvider.apply(command(input, 'approve_outcome', 'cross-instance-a')),
      secondProvider.apply(command(input, 'reject_outcome', 'cross-instance-b')),
    ]);
    expect(results.filter((result) => result.kind === 'committed')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'stale')).toHaveLength(1);
  });

  it('serializes exact retries across two independent provider instances', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    await open(input);
    const firstProvider = await open(input);
    const secondProvider = await open(input);
    const exact = command(input, 'approve_outcome', 'cross-instance-exact');
    const results = await Promise.all([
      firstProvider.apply(exact),
      secondProvider.apply(exact),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['committed', 'duplicate']);
    const receipts = results.flatMap((result) =>
      result.kind === 'committed' || result.kind === 'duplicate' ? [result.receipt] : []);
    expect(receipts[0]).toEqual(receipts[1]);
  });

  it('serializes concurrent first initialization across independent opens', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const [first, second] = await Promise.all([open(input), open(input)]);
    await expect(first.read(input.source.task.id)).resolves.toMatchObject({ status: 'available' });
    await expect(second.read(input.source.task.id)).resolves.toMatchObject({ status: 'available' });
  });

  it('keeps an active durable writer fenced after its flock holder dies', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const unrelated = execFile('/usr/bin/flock', [
      '-n', join(input.workRoot, 'unrelated.lock'), '/usr/bin/sleep', '30',
    ]);
    await new Promise<void>((resolve, reject) => {
      unrelated.once('spawn', resolve);
      unrelated.once('error', reject);
    });
    let second: Awaited<ReturnType<typeof open>> | null = null;
    let competing: Promise<ReviewDecisionApplyResultV1> | null = null;
    let faulted = false;
    try {
      const first = await open(input, { fault: async (point) => {
        if (point !== 'after_temp_write' || faulted) return;
        faulted = true;
        const { stdout } = await execFileAsync('ps', [
          '-ww', '-o', 'pid=,args=', '--ppid', String(process.pid),
        ]);
        const expectedLockPath = lockPath(input);
        const flock = stdout.split('\n').map((line) => line.trim()).find((line) =>
          line.includes('/usr/bin/flock ') && line.includes(` ${expectedLockPath} `));
        const flockPid = flock?.match(/^(\d+)\s+/)?.[1];
        if (flockPid === undefined) throw new Error('active fixture flock holder not found');
        process.kill(Number(flockPid), 'SIGKILL');
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (second === null) throw new Error('competing provider unavailable');
        competing = second.apply(command(input, 'reject_outcome', 'holder-loss-competitor'));
        await new Promise((resolve) => setTimeout(resolve, 30));
      } });
      second = await open(input);
      await expect(first.apply(command(input, 'approve_outcome', 'holder-loss-writer')))
        .rejects.toThrow();
      expect(unrelated.exitCode).toBeNull();
      expect(competing).not.toBeNull();
      await expect(competing!).resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'transaction_unavailable',
      });
      const restarted = await open(input);
      await expect(restarted.apply(command(input, 'approve_outcome', 'holder-loss-writer')))
        .resolves.toMatchObject({ kind: 'duplicate' });
      await expect(restarted.apply(command(input, 'reject_outcome', 'holder-loss-competitor')))
        .resolves.toMatchObject({ kind: 'stale' });
    } finally {
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        await new Promise<void>((resolve) => {
          unrelated.once('exit', () => resolve());
          unrelated.kill('SIGKILL');
        });
      }
    }
  });

  it('keeps the old state before rename and makes post-rename uncertainty replayable', async () => {
    const before = await fixture({ requiresHumanDecision: true });
    let beforeEnabled = true;
    const beforeProvider = await open(before, { fault: (point) => {
      if (beforeEnabled && point === 'before_rename') throw new Error('before rename');
    } });
    expect(await beforeProvider.apply(command(before, 'approve_outcome')))
      .toMatchObject({ kind: 'unavailable' });
    beforeEnabled = false;
    expect(await (await open(before)).read(before.source.task.id))
      .toEqual({ status: 'available', source: before.source });

    const after = await fixture({ requiresHumanDecision: true });
    let afterEnabled = true;
    const afterProvider = await open(after, { fault: (point) => {
      if (afterEnabled && point === 'after_rename') throw new Error('after rename');
    } });
    const afterCommand = command(after, 'approve_outcome');
    expect(await afterProvider.apply(afterCommand)).toMatchObject({ kind: 'unavailable' });
    afterEnabled = false;
    expect(await (await open(after)).apply(afterCommand)).toMatchObject({ kind: 'duplicate' });
  });

  it.each([
    ['after_temp_write', false],
    ['after_file_sync', false],
    ['before_rename', false],
    ['after_rename', true],
    ['after_directory_sync', true],
  ] as const)('recovers the exact transaction side after %s failure', async (point, committed) => {
    const input = await fixture({ requiresHumanDecision: true });
    let enabled = true;
    const provider = await open(input, { fault: (seen) => {
      if (enabled && seen === point) throw new Error(`fault at ${point}`);
    } });
    const exact = command(input, 'approve_outcome', `fault-${point}`);
    await expect(provider.apply(exact)).resolves.toMatchObject({ kind: 'unavailable' });
    enabled = false;
    const restarted = await open(input);
    await expect(restarted.apply(exact)).resolves.toMatchObject({
      kind: committed ? 'duplicate' : 'committed',
    });
  });

  it('validates receipts in a read-only transaction without recovering pending state', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    let enabled = true;
    const provider = await open(input, { fault: (point) => {
      if (enabled && point === 'after_rename') throw new Error('leave pending commit');
    } });
    const exact = command(input, 'approve_outcome', 'readonly-validator');
    await expect(provider.apply(exact)).resolves.toMatchObject({ kind: 'unavailable' });
    enabled = false;
    const envelope = await readMutableState(input);
    const receipt = envelope.payload.tasks[0]!.events[0]!.receipt as unknown as ReviewDecisionReceiptV1;
    const before = await Promise.all([
      readFile(statePath(input)),
      readFile(anchorPath(input)),
      readFile(pendingPath(input)),
    ]);
    const metadataBefore = await Promise.all([
      stat(statePath(input)),
      stat(anchorPath(input)),
      stat(pendingPath(input)),
    ]);
    await expect(provider.validateCommittedReceipt({
      key: reviewDecisionIdempotencyKey(exact.actor, exact.request),
      requestHash: exact.requestHash,
      receipt,
    })).resolves.toEqual({ kind: 'unavailable' });
    const after = await Promise.all([
      readFile(statePath(input)),
      readFile(anchorPath(input)),
      readFile(pendingPath(input)),
    ]);
    const metadataAfter = await Promise.all([
      stat(statePath(input)),
      stat(anchorPath(input)),
      stat(pendingPath(input)),
    ]);
    expect(after).toEqual(before);
    expect(metadataAfter.map(({ dev, ino, mode, nlink, size, mtimeMs, ctimeMs }) => ({
      dev, ino, mode, nlink, size, mtimeMs, ctimeMs,
    }))).toEqual(metadataBefore.map(({ dev, ino, mode, nlink, size, mtimeMs, ctimeMs }) => ({
      dev, ino, mode, nlink, size, mtimeMs, ctimeMs,
    })));
  });

  it('fails reads and validation closed when durable bytes are corrupted', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    const applied = await provider.apply(command(input, 'approve_outcome'));
    expect(applied.kind).toBe('committed');
    const stateLocation = statePath(input);
    const bytes = await readFile(stateLocation, 'utf8');
    await writeFile(stateLocation, `${bytes} `);
    expect(await provider.read(input.source.task.id)).toMatchObject({ status: 'unavailable' });
  });

  it('rejects rollback to an older valid state after a later commit', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    const oldState = await readFile(statePath(input), 'utf8');
    expect(await provider.apply(command(input, 'approve_outcome', 'rollback-source')))
      .toMatchObject({ kind: 'committed' });
    await writeFile(statePath(input), oldState);
    await expect(open(input)).rejects.toThrow();
  });

  it('rejects restart after durable state deletion instead of reinitializing', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    expect(await provider.apply(command(input, 'approve_outcome', 'deletion-source')))
      .toMatchObject({ kind: 'committed' });
    await unlink(statePath(input));
    await expect(open(input)).rejects.toThrow();
  });

  it('rejects restart after anchor deletion or rollback', async () => {
    const deleted = await fixture({ requiresHumanDecision: true });
    const deletedProvider = await open(deleted);
    expect(await deletedProvider.apply(command(deleted, 'approve_outcome', 'anchor-delete')))
      .toMatchObject({ kind: 'committed' });
    await unlink(anchorPath(deleted));
    await expect(open(deleted)).rejects.toThrow(/anchor/i);

    const rolledBack = await fixture({ requiresHumanDecision: true });
    const rollbackProvider = await open(rolledBack);
    const oldAnchor = await readFile(anchorPath(rolledBack), 'utf8');
    expect(await rollbackProvider.apply(command(rolledBack, 'approve_outcome', 'anchor-rollback')))
      .toMatchObject({ kind: 'committed' });
    await writeFile(anchorPath(rolledBack), oldAnchor);
    await expect(open(rolledBack)).rejects.toThrow(/anchor/i);
  });

  it('rejects deletion of an initialized fixture state directory', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    await open(input);
    await rm(stateDirectoryPath(input), { recursive: true });
    await expect(open(input)).rejects.toThrow(/deleted/i);
  });

  it('rejects invalid UTF-8 in fixture and durable state bytes', async () => {
    const badFixture = await fixture();
    await writeFile(badFixture.fixturePath, Buffer.from([0xff]));
    await expect(open(badFixture)).rejects.toThrow();

    const badState = await fixture({ requiresHumanDecision: true });
    await open(badState);
    await writeFile(statePath(badState), Buffer.from([0xff]));
    await expect(open(badState)).rejects.toThrow();
  });

  it('pins state writes to the opened directory and fails closed on parent replacement', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const published = stateDirectoryPath(input);
    const moved = `${published}.moved`;
    let swapped = false;
    const provider = await open(input, { fault: async (point) => {
      if (point !== 'before_rename' || swapped) return;
      swapped = true;
      await rename(published, moved);
      await mkdir(published, { mode: 0o700 });
    } });
    await expect(provider.apply(command(input, 'approve_outcome', 'path-swap'))).rejects.toThrow();
    await expect(readFile(join(published, 'state.json'))).rejects.toThrow();
    expect(provider.isReady()).toBe(false);
  });

  it('rejects a rehashed durable decision whose comment no longer matches the stored request', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    expect(await provider.apply(command(input, 'request_changes')))
      .toMatchObject({ kind: 'committed' });
    const stateLocation = statePath(input);
    const envelope = JSON.parse(await readFile(stateLocation, 'utf8')) as {
      payload: {
        tasks: Array<{ source: { humanDecisions: Array<{ comment: string | null }> } }>;
      };
      stateHash: string;
    };
    envelope.payload.tasks[0]!.source.humanDecisions[0]!.comment = 'tampered reason';
    envelope.stateHash = hashCanonicalJson(envelope.payload);
    await writeFile(stateLocation, canonicalSerialize(envelope));
    await expect(open(input)).rejects.toThrow(/transition|bound/i);
  });

  it.each([
    ['id', 'forged-reviewer'],
    ['issuer', 'forged-issuer'],
  ] as const)('rejects a rehashed durable receipt with a forged actor %s', async (field, value) => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    expect(await provider.apply(command(input, 'approve_outcome', `actor-${field}`)))
      .toMatchObject({ kind: 'committed' });
    const envelope = await readMutableState(input);
    const task = envelope.payload.tasks[0]!;
    const event = task.events[0]!;
    const actor = event.receipt['actor'] as Record<string, unknown>;
    actor[field] = value;
    if (field === 'id') {
      const decisionActor = task.source.humanDecisions[0]!['actor'] as Record<string, unknown>;
      decisionActor['id'] = value;
    }
    const { receiptHash: _receiptHash, ...receiptBody } = event.receipt;
    event.receipt['receiptHash'] = hashCanonicalJson(receiptBody);
    await writeRehashedState(input, envelope);
    await expect(open(input)).rejects.toThrow();
  });

  it.each([
    ['candidateRef', {
      kind: 'git', repository: 'example-org/acme',
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }],
    ['evidenceManifestId', 'tampered-manifest'],
    ['finalVerdictId', 'tampered-verdict'],
    ['contractVersion', 2],
    ['createdAt', '2026-08-28T23:59:59.000Z'],
  ] as const)(
    'rejects a rehashed request_changes transition with changed prior %s',
    async (field, value) => {
      const input = await fixture({ requiresHumanDecision: true });
      const provider = await open(input);
      expect(await provider.apply(command(input, 'request_changes', `closed-${field}`)))
        .toMatchObject({ kind: 'committed' });
      const envelope = await readMutableState(input);
      envelope.payload.tasks[0]!.source.iterationHistory[0]![field] = value;
      await writeRehashedState(input, envelope);
      await expect(open(input)).rejects.toThrow();
    },
  );

  it('rejects a rehashed request_changes successor with a forged creation time', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    expect(await provider.apply(command(input, 'request_changes', 'successor-created-at')))
      .toMatchObject({ kind: 'committed' });
    const envelope = await readMutableState(input);
    envelope.payload.tasks[0]!.source.iterationHistory[1]!['createdAt'] =
      '2026-08-29T01:00:01.000Z';
    await writeRehashedState(input, envelope);
    await expect(open(input)).rejects.toThrow();
  });

  it('rejects rehashed durable approval that omits required risk acknowledgements', async () => {
    const input = await fixture({ requiresHumanDecision: true, remainingRiskCode: 'risk-a' });
    const provider = await open(input);
    expect(await provider.apply(command(input, 'approve_outcome', 'ack-tamper')))
      .toMatchObject({ kind: 'committed' });
    const envelope = await readMutableState(input);
    const event = envelope.payload.tasks[0]!.events[0]!;
    event.request['acknowledgedRiskCodes'] = [];
    rehashRequestAndReceipt(event);
    await writeRehashedState(input, envelope);
    await expect(open(input)).rejects.toThrow();
  });

  it('rejects rehashed durable request_changes with a blank reason', async () => {
    const input = await fixture({ requiresHumanDecision: true });
    const provider = await open(input);
    expect(await provider.apply(command(input, 'request_changes', 'reason-tamper')))
      .toMatchObject({ kind: 'committed' });
    const envelope = await readMutableState(input);
    const task = envelope.payload.tasks[0]!;
    const event = task.events[0]!;
    event.request['reason'] = '   ';
    task.source.humanDecisions[0]!['comment'] = '   ';
    rehashRequestAndReceipt(event);
    await writeRehashedState(input, envelope);
    await expect(open(input)).rejects.toThrow();
  });
});
