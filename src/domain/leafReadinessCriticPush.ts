/** Bounded reason accumulation for leaf readiness. */
import {
  MAX_LEAF_READINESS_REASONS,
  boundLeafEvidence,
  boundLeafText,
  type LeafReadinessReason,
  type LeafReadinessReasonCode,
} from './leafReadinessCritic.js';

export function pushLeafReason(
  reasons: LeafReadinessReason[],
  code: LeafReadinessReasonCode,
  detail: string,
  evidence: readonly string[] = [],
): void {
  if (reasons.length >= MAX_LEAF_READINESS_REASONS) return;
  const d = boundLeafText(detail);
  if (reasons.some((r) => r.code === code && r.detail === d)) return;
  reasons.push({ code, detail: d, evidence: boundLeafEvidence(evidence) });
}
