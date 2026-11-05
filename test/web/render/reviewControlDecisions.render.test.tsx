import './setup.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ControlApiV2ReceiptV1 } from '../../../src/domain/controlApiV2Wire.js';
import type { ReviewPackageV2Dto } from '../../../src/web/review/reviewTypes.js';
import { reviewPackageFixture } from './reviewPackageFixture.js';

const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = '2026-09-01T00:00:00.000Z';

const {
  fetchControlApiV2Review,
  fetchReviewPackageV2,
  controlApiV2BrowserClient,
  prepareDecision,
  execute,
  newReviewDecisionRequestId,
} = vi.hoisted(() => {
  const prepareDecision = vi.fn();
  const execute = vi.fn();
  return {
    fetchControlApiV2Review: vi.fn(),
    fetchReviewPackageV2: vi.fn(),
    prepareDecision,
    execute,
    controlApiV2BrowserClient: vi.fn(() => ({
      prepareDecision,
      execute,
    })),
    newReviewDecisionRequestId: vi.fn(() => 'review-request-1'),
  };
});

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchControlApiV2Review,
    fetchReviewPackageV2,
    controlApiV2BrowserClient,
    newReviewDecisionRequestId,
    submitReviewDecision: vi.fn(),
  };
});

import {
  ReviewPresentationBoundary,
  type ReviewPresentationConfig,
} from '../../../src/web/review/ReviewPresentationBoundary.js';

// The C2 staging composition: only the control ports are wired, so the legacy
// outcomeReviewRead / boundDecisions bits are false while controlApiV2 is true.
// Control-route decisions must not depend on either legacy bit.
const capabilities = {
  schema: 'hercules-review-experience-capabilities/v1' as const,
  outcomeReviewRead: false,
  boundDecisions: false,
  evidenceContent: false,
  learningProposals: false,
  controlApiV2: true,
};

function config(): ReviewPresentationConfig {
  return {
    preference: 'control_v2',
    capabilities,
    onPreferenceChange: vi.fn(),
    onUnauthorized: vi.fn(),
    controlApiV2Supported: true,
  };
}

function packageWithRisk(): ReviewPackageV2Dto {
  const value = reviewPackageFixture({ outcome: 'needs_human' });
  return {
    ...value,
    remainingRisks: [{
      code: 'risk-a',
      criterionIds: ['criterion-1'],
      assertionIds: ['assertion-1'],
      classification: 'verified',
      reasonCodes: [],
      advisorySummary: 'A remaining verified risk.',
    }],
  };
}

function committedReceipt(stateVersion = 4): ControlApiV2ReceiptV1 {
  return {
    schema: 'hercules-control-api-receipt/v2',
    outcome: 'committed',
    resource: 'decision',
    aggregateId: 'review-1',
    keyHash: HASH_A,
    requestHash: HASH_B,
    stateVersion,
    eventSequence: 4,
    reason: null,
    decidedAt: NOW,
    receiptHash: HASH_B,
  };
}

function refusedReceipt(reason: ControlApiV2ReceiptV1['reason']): ControlApiV2ReceiptV1 {
  return {
    schema: 'hercules-control-api-receipt/v2',
    outcome: 'refused',
    resource: 'decision',
    aggregateId: 'review-1',
    keyHash: HASH_A,
    requestHash: HASH_B,
    stateVersion: null,
    eventSequence: null,
    reason,
    decidedAt: NOW,
    receiptHash: HASH_B,
  };
}

describe('Control API V2 bound decision render path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    newReviewDecisionRequestId.mockReturnValue('review-request-1');
    controlApiV2BrowserClient.mockImplementation(() => ({
      prepareDecision,
      execute,
    }));
    const pkg = packageWithRisk();
    fetchControlApiV2Review.mockResolvedValue({
      aggregateId: 'review-1',
      stateVersion: 2,
      package: pkg,
    });
    fetchReviewPackageV2.mockResolvedValue(pkg);
    prepareDecision.mockImplementation(async (input) => ({
      schema: 'hercules-control-api-request/v2',
      prepared: true,
      clientRequestId: input.clientRequestId,
    }));
    execute.mockResolvedValue({
      status: 200,
      body: committedReceipt(),
    });
  });

  it('maps 422 need_more_evidence to the evidence message and refetches once', async () => {
    const user = userEvent.setup();
    let releaseRefetch!: (value: {
      readonly aggregateId: string;
      readonly stateVersion: number;
      readonly package: ReviewPackageV2Dto;
    }) => void;
    execute.mockResolvedValueOnce({
      status: 422,
      body: refusedReceipt('need_more_evidence'),
    });
    fetchControlApiV2Review
      .mockResolvedValueOnce({
        aggregateId: 'review-1',
        stateVersion: 2,
        package: packageWithRisk(),
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefetch = resolve;
          }),
      );

    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(prepareDecision).toHaveBeenCalledOnce();
    expect(
      await screen.findByText(/More evidence is required before this decision can be accepted/),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchControlApiV2Review).toHaveBeenCalledTimes(2));
    releaseRefetch({
      aggregateId: 'review-1',
      stateVersion: 3,
      package: {
        ...reviewPackageFixture({ outcome: 'need_more_evidence' }),
        projectionHash: `sha256:${'c'.repeat(64)}`,
      },
    });
  });

  it('maps 409 stale_version to the stale message and refetches', async () => {
    const user = userEvent.setup();
    let releaseRefetch!: (value: {
      readonly aggregateId: string;
      readonly stateVersion: number;
      readonly package: ReviewPackageV2Dto;
    }) => void;
    execute.mockResolvedValueOnce({
      status: 409,
      body: refusedReceipt('stale_version'),
    });
    fetchControlApiV2Review
      .mockResolvedValueOnce({
        aggregateId: 'review-1',
        stateVersion: 2,
        package: packageWithRisk(),
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefetch = resolve;
          }),
      );

    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(
      await screen.findByText(/The review changed before this decision was accepted/),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchControlApiV2Review).toHaveBeenCalledTimes(2));
    releaseRefetch({
      aggregateId: 'review-1',
      stateVersion: 3,
      package: packageWithRisk(),
    });
  });

  it('shows committed state-version text on accepted receipt', async () => {
    const user = userEvent.setup();
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(
      await screen.findByText(/Decision committed at state version 4/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Refreshing authoritative state/)).toBeInTheDocument();
  });

  it('requires a reason for control-route approvals: confirm stays disabled until one is typed, then the NFC-normalized reason is sent', async () => {
    const user = userEvent.setup();
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);

    await user.click(await screen.findByRole('button', { name: 'Approve outcome' }));
    const confirmation = screen.getByRole('group', { name: 'Approve outcome confirmation' });
    await user.click(within(confirmation).getByRole('checkbox', { name: 'Acknowledge risk-a' }));
    const confirmButton = within(confirmation).getByRole('button', { name: 'Approve outcome' });
    expect(confirmButton).toBeDisabled();
    expect(prepareDecision).not.toHaveBeenCalled();

    await user.type(within(confirmation).getByLabelText('Reason for decision'), 'cafe\u0301 ok');
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm approve outcome' }));

    await waitFor(() => expect(prepareDecision).toHaveBeenCalledOnce());
    const input = prepareDecision.mock.calls[0]![0] as {
      payload: { action: string; reason: string; acknowledgedRiskCodes: readonly string[] };
      stateVersion: number;
      aggregateId: string;
    };
    expect(input.aggregateId).toBe('review-1');
    expect(input.stateVersion).toBe(2);
    expect(input.payload.action).toBe('approve_outcome');
    expect(input.payload.reason).toBe('caf\u00e9 ok');
    expect(input.payload.acknowledgedRiskCodes).toEqual(['risk-a']);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('blocks approve until each human-authority criterion is ticked and sends human:<id> codes', async () => {
    const user = userEvent.setup();
    const base = packageWithRisk();
    const pkg: ReviewPackageV2Dto = {
      ...base,
      criteria: [
        ...base.criteria,
        {
          criterionId: 'human-ui',
          authority: 'human',
          required: true,
          status: 'needs_human',
          assertionIds: [],
          evidenceArtifactIds: [],
          reasonCodes: ['human_decision_required'],
          advisoryExplanation: 'Human authority criterion remains pending; evaluator never decides it.',
        },
      ],
      trustAxes: {
        ...base.trustAxes,
        human: {
          status: 'needs_human',
          assertionIds: [],
          evidenceArtifactIds: [],
          reasonCodes: ['human_decision_required'],
        },
      },
    };
    fetchControlApiV2Review.mockResolvedValue({
      aggregateId: 'review-1',
      stateVersion: 2,
      package: pkg,
    });
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);

    await user.click(await screen.findByRole('button', { name: 'Approve outcome' }));
    const confirmation = screen.getByRole('group', { name: 'Approve outcome confirmation' });
    // Without taskBody the label is the bare human:<id> code (never advisoryExplanation).
    const humanBox = within(confirmation).getByRole('checkbox', { name: 'human:human-ui' });
    expect(humanBox).toHaveAttribute('data-evidence', 'review-human-acknowledgement');
    await user.click(within(confirmation).getByRole('checkbox', { name: 'Acknowledge risk-a' }));
    await user.type(within(confirmation).getByLabelText('Reason for decision'), 'Looks good');
    const confirmButton = within(confirmation).getByRole('button', { name: 'Approve outcome' });
    expect(confirmButton).toBeDisabled();

    await user.click(humanBox);
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);
    await user.click(within(confirmation).getByRole('button', { name: 'Confirm approve outcome' }));

    await waitFor(() => expect(prepareDecision).toHaveBeenCalledOnce());
    const input = prepareDecision.mock.calls[0]![0] as {
      payload: { acknowledgedRiskCodes: readonly string[] };
    };
    expect(input.payload.acknowledgedRiskCodes).toEqual(['human:human-ui', 'risk-a']);
  });

  it('labels human acknowledgement checkboxes with legacy criterion texts from taskBody', async () => {
    const user = userEvent.setup();
    const { compileLegacyTaskContract } = await import(
      '../../../src/domain/contractCompiler.js'
    );
    const taskBody =
      '## Definition of Done\n' +
      '- [ ] (mechanical) tests pass @gate:test\n' +
      '- [ ] (human) Owner accepts the change\n' +
      '- [ ] (human) Risks acknowledged on the control surface\n';
    const humanIds = compileLegacyTaskContract({
      taskId: 'review-1',
      objective: 'Label proof',
      body: taskBody,
      context: [],
      constraints: [],
      forbiddenActions: [],
      capabilityPolicy: { version: '1', grants: [] },
      verificationPolicy: {
        version: '1',
        requiredEvidence: [],
        independentEvaluatorRequired: false,
      },
      approvalPolicy: { version: '1', requiredDecisions: ['approve_outcome'] },
      budgetPolicy: {
        version: '1',
        maxCostUsd: null,
        maxTokens: null,
        maxDurationMs: null,
      },
      createdBy: { kind: 'control_plane', id: 'test' },
      createdAt: '2026-09-05T00:00:00.000Z',
    }).contract.acceptanceCriteria
      .filter((criterion) => criterion.authority === 'human')
      .map((criterion) => criterion.id);
    expect(humanIds).toHaveLength(2);

    const base = packageWithRisk();
    const pkg: ReviewPackageV2Dto = {
      ...base,
      criteria: [
        ...base.criteria,
        ...humanIds.map((criterionId) => ({
          criterionId,
          authority: 'human' as const,
          required: true,
          status: 'needs_human' as const,
          assertionIds: [] as string[],
          evidenceArtifactIds: [] as string[],
          reasonCodes: ['human_decision_required'] as ReviewPackageV2Dto['criteria'][number]['reasonCodes'],
          advisoryExplanation:
            'Human authority criterion remains pending; evaluator never decides it.',
        })),
      ],
      remainingRisks: [],
      trustAxes: {
        ...base.trustAxes,
        human: {
          status: 'needs_human',
          assertionIds: [],
          evidenceArtifactIds: [],
          reasonCodes: ['human_decision_required'],
        },
      },
    };
    fetchControlApiV2Review.mockResolvedValue({
      aggregateId: 'review-1',
      stateVersion: 2,
      package: pkg,
    });
    render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={config()}
        taskBody={taskBody}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Approve outcome' }));
    const confirmation = screen.getByRole('group', { name: 'Approve outcome confirmation' });
    expect(
      await within(confirmation).findByRole('checkbox', { name: 'Owner accepts the change' }),
    ).toHaveAttribute('data-evidence', 'review-human-acknowledgement');
    expect(
      within(confirmation).getByRole('checkbox', {
        name: 'Risks acknowledged on the control surface',
      }),
    ).toHaveAttribute('data-evidence', 'review-human-acknowledgement');
    expect(
      within(confirmation).queryByRole('checkbox', {
        name: 'Human authority criterion remains pending; evaluator never decides it.',
      }),
    ).toBeNull();
  });

  it('falls back to the bare human:<id> code when the id has no body match', async () => {
    const user = userEvent.setup();
    const base = packageWithRisk();
    const pkg: ReviewPackageV2Dto = {
      ...base,
      criteria: [
        ...base.criteria,
        {
          criterionId: 'legacy-deadbeef',
          authority: 'human',
          required: true,
          status: 'needs_human',
          assertionIds: [],
          evidenceArtifactIds: [],
          reasonCodes: ['human_decision_required'],
          advisoryExplanation: 'should not appear',
        },
      ],
      remainingRisks: [],
    };
    fetchControlApiV2Review.mockResolvedValue({
      aggregateId: 'review-1',
      stateVersion: 2,
      package: pkg,
    });
    render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={config()}
        taskBody={'## Definition of Done\n- [ ] (human) Something else\n'}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Approve outcome' }));
    const confirmation = screen.getByRole('group', { name: 'Approve outcome confirmation' });
    expect(
      await within(confirmation).findByRole('checkbox', { name: 'human:legacy-deadbeef' }),
    ).toBeInTheDocument();
    expect(within(confirmation).queryByRole('checkbox', { name: 'should not appear' })).toBeNull();
  });

  it('legacy route shows no human acknowledgement checkboxes', async () => {
    const user = userEvent.setup();
    const base = packageWithRisk();
    const pkg: ReviewPackageV2Dto = {
      ...base,
      criteria: [
        ...base.criteria,
        {
          criterionId: 'human-ui',
          authority: 'human',
          required: true,
          status: 'needs_human',
          assertionIds: [],
          evidenceArtifactIds: [],
          reasonCodes: ['human_decision_required'],
          advisoryExplanation: 'Operator reviewed the UI',
        },
      ],
    };
    fetchReviewPackageV2.mockResolvedValue(pkg);
    const legacyCaps = {
      ...capabilities,
      outcomeReviewRead: true,
      boundDecisions: true,
      controlApiV2: false,
    };
    render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={{ ...config(), preference: 'outcome_v2', capabilities: legacyCaps, controlApiV2Supported: false }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Approve outcome' }));
    const confirmation = screen.getByRole('group', { name: 'Approve outcome confirmation' });
    expect(within(confirmation).queryByRole('checkbox', { name: 'human:human-ui' })).toBeNull();
    expect(document.querySelector('[data-evidence="review-human-acknowledgement"]')).toBeNull();
  });

  it('refuses client-side without a network call when the hook receives an empty reason', async () => {
    // Defense in depth below the UI: the legacy request-changes path can only submit a
    // non-empty reason, so drive the hook through a whitespace-only reason directly.
    const user = userEvent.setup();
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    const reasonField = await screen.findByLabelText('Reason for changes');
    await user.type(reasonField, '   ');
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeDisabled();
    expect(prepareDecision).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(controlApiV2BrowserClient).not.toHaveBeenCalled();
  });

  it('marks a failure before anything reached the wire as not retryable', async () => {
    const user = userEvent.setup();
    prepareDecision.mockRejectedValueOnce(new Error('prepare exploded'));
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(await screen.findByText('prepare exploded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('retries with the same prepared request object without calling prepareDecision again', async () => {
    const user = userEvent.setup();
    const prepared = {
      schema: 'hercules-control-api-request/v2' as const,
      frozen: true,
      clientRequestId: 'review-request-1',
    };
    prepareDecision.mockResolvedValueOnce(prepared);
    execute
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({
        status: 200,
        body: committedReceipt(5),
      });

    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    const retry = await screen.findByRole('button', { name: 'Retry same request' });
    await user.click(retry);

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(prepareDecision).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toBe(prepared);
    expect(execute.mock.calls[1]![0]).toBe(prepared);
    expect(
      await screen.findByText(/Decision committed at state version 5/),
    ).toBeInTheDocument();
  });
});

describe('legacy-origin retry after switching to the control surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    newReviewDecisionRequestId.mockReturnValue('review-request-legacy-1');
    controlApiV2BrowserClient.mockImplementation(() => ({ prepareDecision, execute }));
    const pkg = packageWithRisk();
    fetchReviewPackageV2.mockResolvedValue(pkg);
    fetchControlApiV2Review.mockResolvedValue({ aggregateId: 'review-1', stateVersion: 2, package: pkg });
  });

  it('retries a legacy attempt through the legacy route, never the control client', async () => {
    const user = userEvent.setup();
    const api = await import('../../../src/web/api.js');
    const submitReviewDecision = vi.mocked(api.submitReviewDecision);
    submitReviewDecision.mockRejectedValueOnce(new api.ApiError(503, 'unavailable'));
    submitReviewDecision.mockResolvedValueOnce({
      schema: 'hercules-review-decision-response/v1',
      duplicate: false,
      receipt: {
        schema: 'hercules-review-decision-receipt/v1',
        clientRequestId: 'review-request-legacy-1',
        requestHash: HASH_A,
        taskId: 'review-1',
        actor: { kind: 'human', id: 'operator', issuer: 'hercules' },
        acceptedProjectionHash: packageWithRisk().projectionHash,
        acceptedDecisionBindingHash: HASH_B,
        action: 'request_changes',
        humanDecisionId: 'hd-1',
        eventId: 'ev-1',
        priorIterationId: 'it-1',
        resultingIterationId: 'it-2',
        recordedAt: NOW,
        receiptHash: HASH_B,
      },
    });
    const legacyCaps = { ...capabilities, outcomeReviewRead: true, boundDecisions: true };
    const base = config();
    const { rerender } = render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={{ ...base, preference: 'outcome_v2', capabilities: legacyCaps }}
      />,
    );
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(submitReviewDecision).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Decision outcome is unknown/)).toBeInTheDocument();

    // Operator switches to the control surface on the same task.
    rerender(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={{ ...base, preference: 'control_v2', capabilities: legacyCaps }}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Retry same request' }));
    await waitFor(() => expect(submitReviewDecision).toHaveBeenCalledTimes(2));
    expect(submitReviewDecision.mock.calls[1]![0]).toEqual(submitReviewDecision.mock.calls[0]![0]);
    expect(prepareDecision).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await screen.findByText(/Decision recorded as hd-1/)).toBeInTheDocument();
  });
});
