/**
 * C3.9 exit criterion — real M4-compiled contract through bridge → evidence →
 * evaluation → Control API V2 approve_outcome → decision-effect drive.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { createControlApiV2Client } from '../../src/client/controlApiV2Client.js';
import {
  CONTROL_API_V2_AUTHORITY_ENV,
  openControlApiV2Deps,
} from '../../src/control/controlApiV2Provider.js';
import {
  adaptDecisionEffectStore,
  createDecisionEffectDriver,
} from '../../src/control/decisionEffects.js';
import {
  createUnavailableEvaluatorPort,
  evaluateAllAwaiting,
  type ReviewEvaluationPorts,
} from '../../src/control/reviewEvaluation.js';
import { createReviewPackageRefreshSeam } from '../../src/control/reviewPackageSource.js';
import { buildSnapshot } from '../../src/control/snapshot.js';
import {
  buildBridgeDelivery,
  deliverShadowProjection,
  reconciliationDeliveryId,
  shadowDeliveryForGitRevision,
} from '../../src/control/state/shadowReconciler.js';
import { SqliteStateStore } from '../../src/control/state/sqliteStateStore.js';
import { serializeTask } from '../../src/control/taskFile.js';
import {
  produceAllVerifiedEvidence,
  type VerifiedEvidenceProducerPorts,
} from '../../src/control/verifiedEvidence.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReviewPacket } from '../../src/domain/verification.js';
import {
  loadAuthorityRoster,
  openC3EvidenceStack,
} from '../../src/main.js';
import type { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import { createApi } from '../../src/server/api.js';

const TOKEN = 'c3-exit-criterion-token';
const REPOSITORY = 'app';
const SEED_ID = 'C3-EXIT-SEED';
const TASK_ID = 'C3-EXIT-REAL';
const BODY =
  '## Definition of Done\n' +
  '- [ ] (mechanical) Unit tests pass @test:test/example.test.ts\n' +
  '- [ ] (human) Owner accepts the change\n';
const AFTER_DEPLOY_BODY =
  '## Definition of Done\n' +
  '- [ ] (mechanical) Unit tests pass @test:test/example.test.ts\n' +
  '- [ ] (human) Owner accepts the change\n' +
  '- [ ] (human, after deploy) Latency dashboard stays green\n';
const CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();
const FIXED_CLOCK = (): string => new Date().toISOString();

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Exit criterion ${id}`,
    repo: REPOSITORY,
    state: 'todo',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: '2026-08-28T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: BODY,
    ...overrides,
  };
}

function runtimeStub(): RuntimeView {
  return {
    snapshot: { repos: { repos: {} }, tasks: [], problems: [] },
    running: [],
    stopping: [],
    activity: {},
    pendingChat: {},
    liveRuns: {},
    lastReport: null,
    agents: { default: 'fake', available: ['fake'] },
  };
}

function honoFetch(app: ReturnType<typeof createApi>) {
  return async (
    path: string,
    init: {
      readonly method: 'GET' | 'POST';
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string;
    },
  ) => {
    const requestInit: RequestInit = { method: init.method, headers: init.headers };
    if (init.body !== undefined) requestInit.body = init.body;
    const response = await app.request(path, requestInit);
    return { status: response.status, json: () => response.json() };
  };
}

describe('C3.9 exit criterion on a real M4-compiled contract', () => {
  it('bridges, evidences, evaluates, commits approve_outcome, drives once, refuses stale, replays', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-c3-exit-'));
    cleanup.push(parent);
    const control = join(parent, 'control');
    const work = join(parent, 'work');
    const shadowRoot = join(parent, 'shadow');
    const shadowDatabase = join(shadowRoot, 'shadow.sqlite');
    const evidence = join(parent, 'evidence');
    mkdirSync(join(control, 'tasks'), { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(shadowRoot, { mode: 0o700 });

    writeFileSync(
      join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n',
    );

    // Roster ships with the code checkout; control repos carry none.
    const roster = loadAuthorityRoster(process.cwd());
    expect(roster).not.toBeNull();
    expect(roster!.verifier.runId).toBe('hercules-legacy-verifier-v1');

    const seed = task(SEED_ID);
    writeFileSync(join(control, 'tasks', `${seed.id}.md`), serializeTask(seed));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'exit@hercules.local');
    await git.addConfig('user.name', 'ExitCriterion');
    await git.add('.');
    await git.commit('seed bridge-active task');
    const seedRevision = (await git.revparse(['HEAD'])).trim();

    const store = new SqliteStateStore({
      trustedRoot: shadowRoot,
      databasePath: shadowDatabase,
      busyTimeoutMs: 100,
      clock: FIXED_CLOCK,
      refreshReviewPackage: createReviewPackageRefreshSeam(FIXED_CLOCK, { roster: roster! }),
    });
    store.initialize();

    const initial = { revision: seedRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(store, {
      deliveryId: reconciliationDeliveryId(initial),
      revision: seedRevision,
      writes: initial.tasks,
      retiredTaskIds: [],
    });
    const bridge = buildBridgeDelivery(store, seedRevision);
    expect(bridge).not.toBeNull();
    deliverShadowProjection(store, bridge!);
    expect(store.readTask(SEED_ID)?.contracts).toHaveLength(2);

    // Post-bridge task under C3.8c bridge-active: root + successor + iteration v2.
    const verifiedSha = 'd'.repeat(40);
    const realTask = task(TASK_ID, {
      state: 'review',
      verifiedSha,
      startedAt: '2026-09-05T11:00:00.000Z',
      lastEventAt: '2026-09-05T11:30:00.000Z',
    });
    writeFileSync(join(control, 'tasks', `${realTask.id}.md`), serializeTask(realTask));
    await git.add(`tasks/${realTask.id}.md`);
    await git.commit('post-bridge real exit-criterion task at review');
    const reviewRevision = (await git.revparse(['HEAD'])).trim();
    const reviewDelivery = await shadowDeliveryForGitRevision(
      control,
      reviewRevision,
      `git-${reviewRevision}`,
    );
    expect(reviewDelivery).not.toBeNull();
    const envelope = deliverShadowProjection(store, reviewDelivery!);
    expect(envelope.acknowledgedCommands).toBeGreaterThanOrEqual(3);

    const shadow = store.readTask(TASK_ID)!;
    expect(shadow.contracts).toHaveLength(2);
    const contract = shadow.contracts.at(-1)!;
    expect(contract.version).toBe(2);
    expect(contract.approvalPolicy.requiredDecisions).toEqual(['approve_outcome']);
    expect(contract.verificationPolicy.independentEvaluatorRequired).toBe(false);
    expect(
      contract.acceptanceCriteria
        .filter((criterion) => criterion.authority === 'mechanical')
        .every((criterion) => criterion.proofBinding === null),
    ).toBe(true);
    const currentIteration = shadow.iterations.at(-1)!;
    expect(currentIteration.contractVersion).toBe(2);
    expect(currentIteration.state).toBe('verifying');
    expect(currentIteration.candidateRef).toEqual({
      kind: 'git',
      repository: REPOSITORY,
      revision: verifiedSha,
    });

    const humanIds = contract.acceptanceCriteria
      .filter((criterion) => criterion.authority === 'human')
      .map((criterion) => criterion.id);
    expect(humanIds).toHaveLength(1);
    const humanCodes = humanIds.map((id) => `human:${id}`).sort();

    const stack = await openC3EvidenceStack({
      evidenceRoot: evidence,
      controlRepoDir: control,
      workRoot: work,
      shadowRoot,
      shadowDatabasePath: shadowDatabase,
      clock: FIXED_CLOCK,
    });

    try {
      const mechanicalText = contract.acceptanceCriteria.find(
        (criterion) => criterion.authority === 'mechanical',
      )!.text;
      const humanText = contract.acceptanceCriteria.find(
        (criterion) => criterion.authority === 'human',
      )!.text;
      const packet: ReviewPacket = {
        taskId: TASK_ID,
        branch: `hercules/${TASK_ID}`,
        filesTouched: ['src/example.ts', 'test/example.test.ts'],
        diffSummary: '2 files changed',
        diff:
          'diff --git a/src/example.ts b/src/example.ts\n+export const ok = true;\n' +
          'diff --git a/test/example.test.ts b/test/example.test.ts\n+test("ok", () => {});\n',
        gates: [
          {
            name: 'unit',
            command: 'pnpm test:unit',
            passed: true,
            output: 'unit ok\ntest/example.test.ts\n',
            exitCode: 0,
          },
        ],
        cheatFindings: [],
        screenshots: [],
        evidenceRun: { source: 'workflow', ok: true, steps: [] },
        reviewerVerdict: null,
        selfAssessment: 'ok',
        finalReport: '## Report\nDone.\n',
        green: true,
        noChanges: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'n/a',
          human: 'pending',
          criteria: [
            {
              text: mechanicalText,
              kind: 'mechanical',
              status: 'pass',
              proof: 'test:test/example.test.ts',
            },
            {
              text: humanText,
              kind: 'human',
              status: 'pending',
              proof: 'awaiting owner',
            },
          ],
          warnings: [],
        },
        autoRework: false,
        reworkPath: null,
        reworkPathReason: null,
        reportPolluted: false,
        activityLog: [],
        runKind: 'implementer',
        reviewerSkipReason: null,
        diffUrl: null,
        evidenceMatrix: [],
        verifiedSha,
      };

      await stack.intake.stage({
        task: { id: TASK_ID, repo: REPOSITORY },
        packet,
        verifiedSha,
        branch: `hercules/${TASK_ID}`,
        capturedAt: CAPTURED_AT,
      });

      const evidencePorts: VerifiedEvidenceProducerPorts = {
        store,
        archive: stack.archive,
        intake: stack.intake,
        roster: roster!,
        clock: FIXED_CLOCK,
        log: () => undefined,
        archiveContexts: stack.archiveContexts,
      };
      const produced = await produceAllVerifiedEvidence(evidencePorts);
      expect(produced).toEqual([
        expect.objectContaining({
          kind: 'bound',
          aggregateId: TASK_ID,
          iterationId: currentIteration.id,
        }),
      ]);

      const boundEvidence = store.readBoundEvidence(TASK_ID, currentIteration.id);
      expect(boundEvidence).not.toBeNull();
      expect(boundEvidence!.evidenceIntegrity.result).toBe('intact');

      const evaluationPorts: ReviewEvaluationPorts = {
        store,
        roster: roster!,
        clock: FIXED_CLOCK,
        evaluatorPort: createUnavailableEvaluatorPort(),
        deadlineMs: 5_000,
        log: () => undefined,
      };
      const evaluated = await evaluateAllAwaiting(evaluationPorts);
      expect(evaluated).toEqual([
        expect.objectContaining({
          kind: 'bound',
          aggregateId: TASK_ID,
          iterationId: currentIteration.id,
        }),
      ]);

      const boundEvaluation = store.readBoundEvaluation(TASK_ID, currentIteration.id);
      expect(boundEvaluation).not.toBeNull();

      const aggregate = store.readV2Aggregate(TASK_ID);
      expect(aggregate).not.toBeNull();
      expect(aggregate!.projectionState).toBe('projected');
      expect(boundEvidence!.evidenceIntegrity.result).toBe('intact');
      expect(boundEvaluation!.evaluation).not.toBeNull();
      expect(aggregate!.reviewPackage).not.toBeNull();
      const pkg = aggregate!.reviewPackage!;
      expect(pkg.outcome.status).toBe('needs_human');
      expect(pkg.validDecisions).toEqual([
        'approve_outcome',
        'reject_outcome',
        'request_changes',
      ]);
      expect(pkg.decisionBinding).not.toBeNull();

      const legacyTasks: Array<{ id: string; state: TaskState; body: string; title: string; createdAt: string }> = [
        {
          id: TASK_ID,
          state: 'review',
          body: BODY,
          title: realTask.title,
          createdAt: realTask.createdAt!,
        },
      ];
      const approveCalls: Array<{ id: string; opts?: unknown }> = [];
      const actions = {
        async approve(id: string, opts?: { readonly humanAcknowledged?: readonly string[] }) {
          approveCalls.push({ id, opts });
          const found = legacyTasks.find((entry) => entry.id === id);
          if (found) found.state = 'done';
          return found;
        },
        async reject() {
          throw new Error('reject must not be called');
        },
        async steer() {
          throw new Error('steer must not be called');
        },
      };
      const decisionEffects = createDecisionEffectDriver({
        store: adaptDecisionEffectStore(store),
        actions,
        legacy: {
          async read() {
            return { tasks: legacyTasks.map((entry) => ({ ...entry })) };
          },
        },
        listAggregateIds: () => store.listTaskIds(),
        log: () => undefined,
      });

      const provider = openControlApiV2Deps({
        store,
        env: { [CONTROL_API_V2_AUTHORITY_ENV]: '1' },
        log: () => undefined,
      });
      expect(provider).toEqual(expect.objectContaining({
        controlApiV2Reader: expect.anything(),
        controlApiV2Mutator: expect.anything(),
        controlApiV2Events: expect.anything(),
      }));

      const app = createApi({
        runtime: {
          getState: () => runtimeStub(),
          subscribe: () => () => {},
          forceAbort: () => {},
        },
        actions: actions as unknown as ActionService,
        token: TOKEN,
        ...provider,
        decisionEffects,
      });
      const client = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(app) });
      const issuedAt = FIXED_CLOCK();

      const review = await client.readReview({ aggregateId: TASK_ID, issuedAt });
      expect(review.status).toBe(200);
      const reviewView = review.body as {
        stateVersion: number;
        reviewPackage: {
          projectionHash: string;
          validDecisions: readonly string[];
          decisionBinding: unknown;
          outcome: { status: string };
        };
      };
      expect(reviewView.reviewPackage.outcome.status).toBe('needs_human');
      expect(reviewView.reviewPackage.validDecisions).toEqual([
        'approve_outcome',
        'reject_outcome',
        'request_changes',
      ]);
      expect(reviewView.reviewPackage.decisionBinding).not.toBeNull();

      const decisionPayload = {
        kind: 'decision' as const,
        action: 'approve_outcome' as const,
        reason: 'Owner accepts the change on the control surface',
        acknowledgedRiskCodes: humanCodes,
      };
      const committed = await client.submitDecision({
        aggregateId: TASK_ID,
        stateVersion: reviewView.stateVersion,
        projectionHash: reviewView.reviewPackage.projectionHash,
        actorIssuer: 'hercules-cli',
        actorId: 'exit-criterion-owner',
        clientRequestId: 'c3-exit-approve-1',
        payload: decisionPayload,
        issuedAt,
      });
      expect(committed.status).toBe(200);
      const committedBody = committed.body as {
        outcome: string;
        keyHash: string;
        receiptHash?: string;
      };
      expect(committedBody.outcome).toBe('committed');
      expect(approveCalls).toHaveLength(1);
      expect(approveCalls[0]).toMatchObject({ id: TASK_ID });
      const marker = store.readPendingEffect(committedBody.keyHash);
      expect(marker).not.toBeNull();
      expect(marker!.effectState).toBe('applied');
      expect(legacyTasks[0]!.state).toBe('done');

      const stale = await client.submitDecision({
        aggregateId: TASK_ID,
        stateVersion: reviewView.stateVersion,
        projectionHash: reviewView.reviewPackage.projectionHash,
        actorIssuer: 'hercules-cli',
        actorId: 'exit-criterion-owner',
        clientRequestId: 'c3-exit-stale-1',
        payload: {
          kind: 'decision',
          action: 'approve_outcome',
          reason: 'stale attempt',
          acknowledgedRiskCodes: humanCodes,
        },
        issuedAt: FIXED_CLOCK(),
      });
      expect(stale.status).toBe(409);
      expect((stale.body as { reason: string }).reason).toBe('stale_version');
      expect(approveCalls).toHaveLength(1);

      const replay = await client.submitDecision({
        aggregateId: TASK_ID,
        stateVersion: reviewView.stateVersion,
        projectionHash: reviewView.reviewPackage.projectionHash,
        actorIssuer: 'hercules-cli',
        actorId: 'exit-criterion-owner',
        clientRequestId: 'c3-exit-approve-1',
        payload: decisionPayload,
        issuedAt,
      });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(committed.body);
      expect(approveCalls).toHaveLength(1);
    } finally {
      await stack.close();
      store.close();
    }
  });

  it('after-deploy human is non-required: one human: code commits and drives Owner accepts the change', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-c3-exit-ad-'));
    cleanup.push(parent);
    const control = join(parent, 'control');
    const work = join(parent, 'work');
    const shadowRoot = join(parent, 'shadow');
    const shadowDatabase = join(shadowRoot, 'shadow.sqlite');
    const evidence = join(parent, 'evidence');
    mkdirSync(join(control, 'tasks'), { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(shadowRoot, { mode: 0o700 });

    writeFileSync(
      join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n',
    );

    // Roster ships with the code checkout; control repos carry none.
    const roster = loadAuthorityRoster(process.cwd());
    expect(roster).not.toBeNull();

    const seed = task(SEED_ID, { body: AFTER_DEPLOY_BODY });
    writeFileSync(join(control, 'tasks', `${seed.id}.md`), serializeTask(seed));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'exit@hercules.local');
    await git.addConfig('user.name', 'ExitCriterion');
    await git.add('.');
    await git.commit('seed bridge-active after-deploy task');
    const seedRevision = (await git.revparse(['HEAD'])).trim();

    const store = new SqliteStateStore({
      trustedRoot: shadowRoot,
      databasePath: shadowDatabase,
      busyTimeoutMs: 100,
      clock: FIXED_CLOCK,
      refreshReviewPackage: createReviewPackageRefreshSeam(FIXED_CLOCK, { roster: roster! }),
    });
    store.initialize();

    const initial = { revision: seedRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(store, {
      deliveryId: reconciliationDeliveryId(initial),
      revision: seedRevision,
      writes: initial.tasks,
      retiredTaskIds: [],
    });
    const bridge = buildBridgeDelivery(store, seedRevision);
    expect(bridge).not.toBeNull();
    deliverShadowProjection(store, bridge!);

    const verifiedSha = 'e'.repeat(40);
    const realTask = task(TASK_ID, {
      state: 'review',
      verifiedSha,
      body: AFTER_DEPLOY_BODY,
      startedAt: '2026-09-05T11:00:00.000Z',
      lastEventAt: '2026-09-05T11:30:00.000Z',
    });
    writeFileSync(join(control, 'tasks', `${realTask.id}.md`), serializeTask(realTask));
    await git.add(`tasks/${realTask.id}.md`);
    await git.commit('post-bridge after-deploy exit-criterion task at review');
    const reviewRevision = (await git.revparse(['HEAD'])).trim();
    const reviewDelivery = await shadowDeliveryForGitRevision(
      control,
      reviewRevision,
      `git-${reviewRevision}`,
    );
    expect(reviewDelivery).not.toBeNull();
    deliverShadowProjection(store, reviewDelivery!);

    const shadow = store.readTask(TASK_ID)!;
    const contract = shadow.contracts.at(-1)!;
    const currentIteration = shadow.iterations.at(-1)!;

    const humanCriteria = contract.acceptanceCriteria.filter(
      (criterion) => criterion.authority === 'human',
    );
    expect(humanCriteria).toHaveLength(2);
    const requiredHuman = humanCriteria.filter((criterion) => criterion.required);
    const afterDeployHuman = humanCriteria.filter((criterion) => !criterion.required);
    expect(requiredHuman).toHaveLength(1);
    expect(afterDeployHuman).toHaveLength(1);
    expect(requiredHuman[0]!.text).toBe('Owner accepts the change');
    expect(afterDeployHuman[0]!.text).toBe('Latency dashboard stays green');
    const humanCodes = requiredHuman.map((criterion) => `human:${criterion.id}`).sort();
    expect(humanCodes).toHaveLength(1);

    const stack = await openC3EvidenceStack({
      evidenceRoot: evidence,
      controlRepoDir: control,
      workRoot: work,
      shadowRoot,
      shadowDatabasePath: shadowDatabase,
      clock: FIXED_CLOCK,
    });

    try {
      const mechanicalText = contract.acceptanceCriteria.find(
        (criterion) => criterion.authority === 'mechanical',
      )!.text;
      const packet: ReviewPacket = {
        taskId: TASK_ID,
        branch: `hercules/${TASK_ID}`,
        filesTouched: ['src/example.ts', 'test/example.test.ts'],
        diffSummary: '2 files changed',
        diff:
          'diff --git a/src/example.ts b/src/example.ts\n+export const ok = true;\n' +
          'diff --git a/test/example.test.ts b/test/example.test.ts\n+test("ok", () => {});\n',
        gates: [
          {
            name: 'unit',
            command: 'pnpm test:unit',
            passed: true,
            output: 'unit ok\ntest/example.test.ts\n',
            exitCode: 0,
          },
        ],
        cheatFindings: [],
        screenshots: [],
        evidenceRun: { source: 'workflow', ok: true, steps: [] },
        reviewerVerdict: null,
        selfAssessment: 'ok',
        finalReport: '## Report\nDone.\n',
        green: true,
        noChanges: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'n/a',
          human: 'pending',
          criteria: [
            {
              text: mechanicalText,
              kind: 'mechanical',
              status: 'pass',
              proof: 'test:test/example.test.ts',
            },
            {
              text: requiredHuman[0]!.text,
              kind: 'human',
              status: 'pending',
              proof: 'awaiting owner',
            },
            {
              text: afterDeployHuman[0]!.text,
              kind: 'human',
              status: 'pending',
              proof: 'after deploy',
            },
          ],
          warnings: [],
        },
        autoRework: false,
        reworkPath: null,
        reworkPathReason: null,
        reportPolluted: false,
        activityLog: [],
        runKind: 'implementer',
        reviewerSkipReason: null,
        diffUrl: null,
        evidenceMatrix: [],
        verifiedSha,
      };

      await stack.intake.stage({
        task: { id: TASK_ID, repo: REPOSITORY },
        packet,
        verifiedSha,
        branch: `hercules/${TASK_ID}`,
        capturedAt: CAPTURED_AT,
      });

      const evidencePorts: VerifiedEvidenceProducerPorts = {
        store,
        archive: stack.archive,
        intake: stack.intake,
        roster: roster!,
        clock: FIXED_CLOCK,
        log: () => undefined,
        archiveContexts: stack.archiveContexts,
      };
      expect(await produceAllVerifiedEvidence(evidencePorts)).toEqual([
        expect.objectContaining({ kind: 'bound', aggregateId: TASK_ID }),
      ]);

      const evaluationPorts: ReviewEvaluationPorts = {
        store,
        roster: roster!,
        clock: FIXED_CLOCK,
        evaluatorPort: createUnavailableEvaluatorPort(),
        deadlineMs: 5_000,
        log: () => undefined,
      };
      expect(await evaluateAllAwaiting(evaluationPorts)).toEqual([
        expect.objectContaining({ kind: 'bound', aggregateId: TASK_ID }),
      ]);

      const aggregate = store.readV2Aggregate(TASK_ID)!;
      const pkg = aggregate.reviewPackage!;
      expect(pkg.outcome.status).toBe('needs_human');
      expect(pkg.validDecisions).toEqual([
        'approve_outcome',
        'reject_outcome',
        'request_changes',
      ]);

      const legacyTasks: Array<{
        id: string;
        state: TaskState;
        body: string;
        title: string;
        createdAt: string;
      }> = [
        {
          id: TASK_ID,
          state: 'review',
          body: AFTER_DEPLOY_BODY,
          title: realTask.title,
          createdAt: realTask.createdAt!,
        },
      ];
      const approveCalls: Array<{ id: string; opts?: unknown }> = [];
      const actions = {
        async approve(id: string, opts?: { readonly humanAcknowledged?: readonly string[] }) {
          approveCalls.push({ id, opts });
          const found = legacyTasks.find((entry) => entry.id === id);
          if (found) found.state = 'done';
          return found;
        },
        async reject() {
          throw new Error('reject must not be called');
        },
        async steer() {
          throw new Error('steer must not be called');
        },
      };
      const decisionEffects = createDecisionEffectDriver({
        store: adaptDecisionEffectStore(store),
        actions,
        legacy: {
          async read() {
            return { tasks: legacyTasks.map((entry) => ({ ...entry })) };
          },
        },
        listAggregateIds: () => store.listTaskIds(),
        log: () => undefined,
      });

      const provider = openControlApiV2Deps({
        store,
        env: { [CONTROL_API_V2_AUTHORITY_ENV]: '1' },
        log: () => undefined,
      });
      const app = createApi({
        runtime: {
          getState: () => runtimeStub(),
          subscribe: () => () => {},
          forceAbort: () => {},
        },
        actions: actions as unknown as ActionService,
        token: TOKEN,
        ...provider,
        decisionEffects,
      });
      const client = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(app) });
      const issuedAt = FIXED_CLOCK();

      const review = await client.readReview({ aggregateId: TASK_ID, issuedAt });
      expect(review.status).toBe(200);
      const reviewView = review.body as {
        stateVersion: number;
        reviewPackage: {
          projectionHash: string;
          validDecisions: readonly string[];
          decisionBinding: unknown;
          outcome: { status: string };
          criteria: readonly {
            criterionId: string;
            authority: string;
            required: boolean;
          }[];
        };
      };
      expect(reviewView.reviewPackage.outcome.status).toBe('needs_human');
      expect(reviewView.reviewPackage.validDecisions).toEqual([
        'approve_outcome',
        'reject_outcome',
        'request_changes',
      ]);
      const packageRequiredHuman = reviewView.reviewPackage.criteria.filter(
        (criterion) => criterion.authority === 'human' && criterion.required,
      );
      expect(packageRequiredHuman).toHaveLength(1);

      const committed = await client.submitDecision({
        aggregateId: TASK_ID,
        stateVersion: reviewView.stateVersion,
        projectionHash: reviewView.reviewPackage.projectionHash,
        actorIssuer: 'hercules-cli',
        actorId: 'exit-criterion-owner',
        clientRequestId: 'c3-exit-after-deploy-approve-1',
        payload: {
          kind: 'decision',
          action: 'approve_outcome',
          reason: 'Owner accepts the change on the control surface',
          acknowledgedRiskCodes: humanCodes,
        },
        issuedAt,
      });
      expect(committed.status).toBe(200);
      expect((committed.body as { outcome: string }).outcome).toBe('committed');
      expect(approveCalls).toHaveLength(1);
      expect(approveCalls[0]).toEqual({
        id: TASK_ID,
        opts: { humanAcknowledged: ['Owner accepts the change'] },
      });
      const keyHash = (committed.body as { keyHash: string }).keyHash;
      const marker = store.readPendingEffect(keyHash);
      expect(marker).not.toBeNull();
      expect(marker!.effectState).toBe('applied');
      expect(legacyTasks[0]!.state).toBe('done');
      expect(currentIteration.id).toBeTruthy();
    } finally {
      await stack.close();
      store.close();
    }
  });
});
