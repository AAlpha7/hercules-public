import { useState, type JSX } from 'react';
import type {
  EvidenceSummaryDto,
  ReviewExperienceCapabilitiesV1,
  ReviewPackageV2Dto,
} from './reviewTypes.js';
import { AcceptanceMatrix } from './AcceptanceMatrix.js';
import { DecisionBanner } from './DecisionBanner.js';
import { IterationHistory } from './IterationHistory.js';
import { OutcomeAssertions } from './OutcomeAssertions.js';
import { OutcomeHeader } from './OutcomeHeader.js';
import { OutcomeSummary } from './OutcomeSummary.js';
import { RiskSummary } from './RiskSummary.js';
import { StatusToken } from './StatusToken.js';
import { EvidenceDrawer } from './EvidenceDrawer.js';
import { LearningProposalPanel } from './LearningProposalPanel.js';
import { useLearningProposals } from './useLearningProposals.js';
import { SafeDecisionBar } from './SafeDecisionBar.js';
import type { ReviewDecisionRequestDto } from './reviewDecisionTypes.js';
import type { ReviewDecisionSubmitState } from './useReviewDecision.js';

const AXES = [
  ['Contract', 'contractBinding'],
  ['Mechanical', 'mechanical'],
  ['Real surface', 'realSurface'],
  ['Independent review', 'independentReview'],
  ['Evaluation', 'independentEvaluation'],
  ['Human', 'human'],
] as const;

const NOOP = (): void => undefined;

export function OutcomeReviewPanel({
  packageValue,
  capabilities,
  evidenceEnabled = false,
  learningEnabled = false,
  decisionState = { kind: 'idle' },
  decisionRoute = 'legacy',
  taskBody,
  onSubmitDecision = NOOP,
  onRetryDecision = NOOP,
  onUnauthorized = NOOP,
  onStale = NOOP,
}: {
  readonly packageValue: ReviewPackageV2Dto;
  readonly capabilities?: ReviewExperienceCapabilitiesV1;
  readonly evidenceEnabled?: boolean;
  readonly learningEnabled?: boolean;
  readonly decisionState?: ReviewDecisionSubmitState;
  /** Which route a submitted decision takes; the control route needs no legacy boundDecisions authority. */
  readonly decisionRoute?: 'legacy' | 'control_v2';
  /** Legacy task body for control-route human-ack checkbox labels. */
  readonly taskBody?: string;
  readonly onSubmitDecision?: (request: ReviewDecisionRequestDto) => void;
  readonly onRetryDecision?: () => void;
  readonly onUnauthorized?: () => void;
  readonly onStale?: () => void;
}): JSX.Element {
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceSummaryDto | null>(null);
  const effectiveCapabilities: ReviewExperienceCapabilitiesV1 = capabilities ?? {
    schema: 'hercules-review-experience-capabilities/v1',
    outcomeReviewRead: true,
    boundDecisions: false,
    evidenceContent: evidenceEnabled,
    learningProposals: learningEnabled,
    controlApiV2: false,
  };
  const proposals = useLearningProposals({
    packageValue,
    enabled: effectiveCapabilities.learningProposals,
    onUnauthorized,
    onStale,
  });
  return (
    <div
      className="outcome-review"
      data-review-surface="outcome-v2"
      data-evidence="outcome-review"
    >
      <OutcomeHeader packageValue={packageValue} />
      <section className="outcome-review-band" aria-label="Trust axes">
        <div className="outcome-review-axis-grid">
          {AXES.map(([label, key]) => (
            <div className="outcome-review-axis" key={key}>
              <span>{label}</span>
              <StatusToken status={packageValue.trustAxes[key].status} />
            </div>
          ))}
        </div>
      </section>
      <OutcomeSummary packageValue={packageValue} />
      <DecisionBanner
        packageValue={packageValue}
        writeAvailable={decisionRoute === 'control_v2' || effectiveCapabilities.boundDecisions}
      />
      <SafeDecisionBar
        packageValue={packageValue}
        capabilities={effectiveCapabilities}
        decisionRoute={decisionRoute}
        {...(taskBody !== undefined ? { taskBody } : {})}
        submitState={decisionState}
        onSubmit={onSubmitDecision}
        onRetry={onRetryDecision}
      />
      <OutcomeAssertions packageValue={packageValue} />
      <div className={selectedEvidence === null ? '' : 'outcome-review-evidence-columns'}>
        <AcceptanceMatrix
          packageValue={packageValue}
          {...(effectiveCapabilities.evidenceContent ? { onOpenEvidence: setSelectedEvidence } : {})}
        />
        {selectedEvidence !== null ? (
          <EvidenceDrawer
            key={`${packageValue.projectionHash}:${selectedEvidence.artifactRefId}`}
            packageValue={packageValue}
            evidence={selectedEvidence}
            onClose={() => setSelectedEvidence(null)}
            onUnauthorized={onUnauthorized}
            onStale={onStale}
          />
        ) : null}
      </div>
      <RiskSummary packageValue={packageValue} />
      <IterationHistory packageValue={packageValue} />
      <LearningProposalPanel proposals={proposals} />
    </div>
  );
}
