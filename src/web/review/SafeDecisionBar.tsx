import { useEffect, useMemo, useState, type JSX } from 'react';
import { ConfirmButton } from '../ConfirmButton.js';
import { newReviewDecisionRequestId } from '../api.js';
import { resolveHumanCriterionLabels } from './humanCriterionLabels.js';
import type { ReviewDecisionRequestDto } from './reviewDecisionTypes.js';
import type { ReviewDecisionSubmitState } from './useReviewDecision.js';
import type {
  OutcomeDecision,
  ReviewExperienceCapabilitiesV1,
  ReviewPackageV2Dto,
} from './reviewTypes.js';

const ACTION_LABELS: Readonly<Record<OutcomeDecision, string>> = {
  approve_outcome: 'Approve outcome',
  reject_outcome: 'Reject outcome',
  request_changes: 'Request changes',
};

function riskCodes(packageValue: ReviewPackageV2Dto): readonly string[] {
  return [
    ...packageValue.blockingFindings.map((finding) => finding.code),
    ...packageValue.remainingRisks.map((finding) => finding.code),
  ].sort();
}

function humanAcknowledgementRows(packageValue: ReviewPackageV2Dto): readonly {
  readonly code: string;
  readonly criterionId: string;
}[] {
  const human = packageValue.criteria.filter((criterion) => criterion.authority === 'human');
  const required = human.some((criterion) => typeof criterion.required === 'boolean')
    ? human.filter((criterion) => criterion.required)
    : human;
  return required
    .map((criterion) => ({
      code: `human:${criterion.criterionId}`,
      criterionId: criterion.criterionId,
    }))
    .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
}

function requestFor(input: Readonly<{
  packageValue: ReviewPackageV2Dto;
  clientRequestId: string;
  action: OutcomeDecision;
  reason: string | null;
  acknowledgedRiskCodes: readonly string[];
}>): ReviewDecisionRequestDto | null {
  if (input.packageValue.decisionBinding === null) return null;
  return {
    schema: 'hercules-review-decision-request/v1',
    clientRequestId: input.clientRequestId,
    taskId: input.packageValue.task.id,
    projectionHash: input.packageValue.projectionHash,
    decisionBinding: input.packageValue.decisionBinding,
    action: input.action,
    reason: input.reason,
    acknowledgedRiskCodes: input.acknowledgedRiskCodes,
  };
}

export function SafeDecisionBar({
  packageValue,
  capabilities,
  decisionRoute = 'legacy',
  taskBody,
  submitState,
  onSubmit,
  onRetry,
}: Readonly<{
  packageValue: ReviewPackageV2Dto;
  capabilities: ReviewExperienceCapabilitiesV1;
  /** Control-route decisions are authorized by the controlApiV2 capability, not the legacy boundDecisions bit. */
  decisionRoute?: 'legacy' | 'control_v2';
  /** Legacy task body — used on the control route to label `human:<id>` checkboxes. */
  taskBody?: string;
  submitState: ReviewDecisionSubmitState;
  onSubmit: (request: ReviewDecisionRequestDto) => void;
  onRetry: () => void;
}>): JSX.Element {
  const [confirmation, setConfirmation] = useState<
    'approve_outcome' | 'reject_outcome' | null
  >(null);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState('');
  // Control-route decisions carry a mandatory non-empty reason on the wire, so
  // approve/reject confirmations collect one; the legacy route keeps reason null.
  const [confirmReason, setConfirmReason] = useState('');
  const [requestIdUnavailable, setRequestIdUnavailable] = useState(false);
  const [humanLabels, setHumanLabels] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const risks = useMemo(() => riskCodes(packageValue), [packageValue]);
  const humanRows = useMemo(
    () => (decisionRoute === 'control_v2' ? humanAcknowledgementRows(packageValue) : []),
    [decisionRoute, packageValue],
  );
  useEffect(() => {
    if (decisionRoute !== 'control_v2' || taskBody === undefined || humanRows.length === 0) {
      setHumanLabels(new Map());
      return;
    }
    let cancelled = false;
    void resolveHumanCriterionLabels(
      taskBody,
      humanRows.map((row) => row.criterionId),
    ).then((labels) => {
      if (!cancelled) setHumanLabels(labels);
    });
    return () => {
      cancelled = true;
    };
  }, [decisionRoute, taskBody, humanRows]);
  const requiredAcknowledgementCodes = useMemo(
    () => [...new Set([...risks, ...humanRows.map((row) => row.code)])].sort(),
    [risks, humanRows],
  );
  const secureRequestIdsAvailable = typeof globalThis.crypto?.randomUUID === 'function';
  const busy = submitState.kind === 'submitting';
  const decisionLocked = submitState.kind === 'accepted' || submitState.kind === 'error';

  const submit = (
    action: OutcomeDecision,
    decisionReason: string | null,
    acknowledgedRiskCodes: readonly string[],
  ): void => {
    const clientRequestId = newReviewDecisionRequestId();
    if (clientRequestId === null) {
      setRequestIdUnavailable(true);
      return;
    }
    const request = requestFor({
      packageValue,
      clientRequestId,
      action,
      reason: decisionReason,
      acknowledgedRiskCodes,
    });
    if (request !== null) onSubmit(request);
  };

  if (submitState.kind === 'accepted' || submitState.kind === 'error') {
    const submittedCandidate = submitState.request.decisionBinding.candidateRef;
    const submittedRevision = submittedCandidate?.kind === 'git'
      ? submittedCandidate.revision.slice(0, 12)
      : 'unavailable';
    return (
      <section
        className="outcome-review-band safe-decision-bar"
        aria-label="Outcome decisions"
        data-evidence={submitState.kind === 'accepted' ? 'review-decision-recorded' : 'review-decision-error'}
      >
        <div className="outcome-review-section-head">
          <h4>Submitted decision</h4>
          <span className="muted">Bound to {submittedRevision}</span>
        </div>
        <dl className="safe-decision-binding">
          <div><dt>Task</dt><dd>{submitState.request.taskId}</dd></div>
          <div><dt>Candidate</dt><dd>{submittedRevision}</dd></div>
          <div><dt>Action</dt><dd>{ACTION_LABELS[submitState.request.action]}</dd></div>
        </dl>
        {submitState.kind === 'accepted' ? (
          <div role="status" className="safe-decision-status">
            {submitState.response.schema === 'hercules-control-api-receipt/v2'
              ? `Decision committed at state version ${String(submitState.response.receipt.stateVersion)}. Refreshing authoritative state.`
              : `Decision recorded as ${submitState.response.receipt.humanDecisionId}. Refreshing authoritative state.`}
          </div>
        ) : (
          <div role="alert" className="safe-decision-status">
            <span>{submitState.message}</span>
            {submitState.retryable && (capabilities.boundDecisions || decisionRoute === 'control_v2') ? (
              <button type="button" onClick={onRetry}>Retry same request</button>
            ) : null}
          </div>
        )}
      </section>
    );
  }

  if (decisionRoute === 'legacy' && !capabilities.boundDecisions) {
    return (
      <section
        className="outcome-review-band safe-decision-bar"
        aria-label="Outcome decisions"
        data-evidence="review-read-only"
      >
        <strong>Decision submission is unavailable.</strong>
        <span className="muted">This outcome view remains read-only.</span>
      </section>
    );
  }
  if (packageValue.validDecisions.length === 0 || packageValue.decisionBinding === null) {
    return (
      <section
        className="outcome-review-band safe-decision-bar"
        aria-label="Outcome decisions"
        data-evidence="review-more-evidence"
      >
        <strong>More evidence required</strong>
        <span className="muted">No outcome decision is eligible for this exact package.</span>
      </section>
    );
  }

  const candidate = packageValue.decisionBinding.candidateRef;
  const shortRevision = candidate?.kind === 'git' ? candidate.revision.slice(0, 12) : 'unavailable';
  const allAcknowledgementsChecked = requiredAcknowledgementCodes.every((code) =>
    acknowledged.has(code),
  );
  const reasonBytes = new TextEncoder().encode(reason).byteLength;
  const confirmReasonBytes = new TextEncoder().encode(confirmReason).byteLength;

  return (
    <section
      className="outcome-review-band safe-decision-bar"
      aria-label="Outcome decisions"
      data-evidence="review-actions"
    >
      <div className="outcome-review-section-head">
        <h4>Outcome decision</h4>
        <span className="muted">Bound to {shortRevision}</span>
      </div>
      {!secureRequestIdsAvailable || requestIdUnavailable ? (
        <div role="alert" className="safe-decision-status">
          Secure decision request IDs are unavailable in this browser.
        </div>
      ) : null}
      {!decisionLocked ? (
        <div className="safe-decision-actions">
          {packageValue.validDecisions.includes('approve_outcome') ? (
            <button
              type="button"
              data-evidence="review-open-approve"
              onClick={() => { setConfirmation('approve_outcome'); setAcknowledged(new Set()); setConfirmReason(''); }}
              disabled={busy || !secureRequestIdsAvailable}
            >
              Approve outcome
            </button>
          ) : null}
          {packageValue.validDecisions.includes('reject_outcome') ? (
            <button
              type="button"
              className="danger"
              data-evidence="review-open-reject"
              onClick={() => { setConfirmation('reject_outcome'); setAcknowledged(new Set()); setConfirmReason(''); }}
              disabled={busy || !secureRequestIdsAvailable}
            >
              Reject outcome
            </button>
          ) : null}
        </div>
      ) : null}

      {confirmation !== null && !decisionLocked ? (
        <div className="safe-decision-confirm" role="group" aria-label={`${ACTION_LABELS[confirmation]} confirmation`}>
          <strong>{ACTION_LABELS[confirmation]}</strong>
          <dl>
            <div><dt>Task</dt><dd>{packageValue.task.id}</dd></div>
            <div><dt>Candidate</dt><dd>{shortRevision}</dd></div>
            <div><dt>Action</dt><dd>{ACTION_LABELS[confirmation]}</dd></div>
          </dl>
          <p>Approval is not merge or deployment.</p>
          {risks.length === 0 && humanRows.length === 0 ? (
            <p className="muted">No structured risks require acknowledgement.</p>
          ) : null}
          {risks.map((code) => (
            <label key={code} className="safe-decision-risk">
              <input
                type="checkbox"
                data-evidence="review-risk-acknowledgement"
                checked={acknowledged.has(code)}
                onChange={(event) => setAcknowledged((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(code);
                  else next.delete(code);
                  return next;
                })}
              />
              <span>Acknowledge {code}</span>
            </label>
          ))}
          {humanRows.map((row) => (
            <label key={row.code} className="safe-decision-risk">
              <input
                type="checkbox"
                data-evidence="review-human-acknowledgement"
                checked={acknowledged.has(row.code)}
                onChange={(event) => setAcknowledged((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(row.code);
                  else next.delete(row.code);
                  return next;
                })}
              />
              <span>{humanLabels.get(row.code) ?? row.code}</span>
            </label>
          ))}
          {decisionRoute === 'control_v2' ? (
            <div className="safe-decision-request-changes">
              <label htmlFor="review-confirm-reason">Reason for decision</label>
              <textarea
                id="review-confirm-reason"
                data-evidence="review-confirm-reason"
                value={confirmReason}
                maxLength={8192}
                onChange={(event) => setConfirmReason(event.target.value)}
                disabled={busy}
              />
            </div>
          ) : null}
          <div className="safe-decision-confirm-actions">
            <button type="button" onClick={() => setConfirmation(null)} disabled={busy}>Cancel</button>
            <ConfirmButton
              label={ACTION_LABELS[confirmation]}
              confirmLabel={`Confirm ${ACTION_LABELS[confirmation].toLowerCase()}`}
              onConfirm={() => submit(
                confirmation,
                decisionRoute === 'control_v2' ? confirmReason : null,
                requiredAcknowledgementCodes,
              )}
              disabled={
                !allAcknowledgementsChecked ||
                busy ||
                !secureRequestIdsAvailable ||
                (decisionRoute === 'control_v2' &&
                  (confirmReason.trim().length === 0 || confirmReasonBytes > 8 * 1024))
              }
              loading={busy}
              data-evidence={`review-${confirmation}`}
            />
          </div>
        </div>
      ) : null}

      {packageValue.validDecisions.includes('request_changes') &&
      !decisionLocked ? (
        <div className="safe-decision-request-changes">
          <label htmlFor="review-request-changes-reason">Reason for changes</label>
          <textarea
            id="review-request-changes-reason"
            value={reason}
            maxLength={8192}
            onChange={(event) => setReason(event.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => submit('request_changes', reason, [])}
            disabled={
              busy ||
              reason.trim().length === 0 ||
              reasonBytes > 8 * 1024 ||
              !secureRequestIdsAvailable
            }
            data-evidence="review-request-changes"
          >
            {busy ? 'Submitting...' : 'Request changes'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
