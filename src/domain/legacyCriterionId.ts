/**
 * Node-free legacy criterion-id helpers shared by the contract compiler
 * (node hash) and the SPA human-ack label resolver (subtle hash).
 */

export interface LegacyCriterionIdSemantic {
  readonly text: string;
  readonly authority: string;
  readonly required: boolean;
  readonly proofBinding: {
    readonly proofType: string;
    readonly requirement: string;
  } | null;
}

/** Record hashed into a legacy criterion id. */
export function criterionIdRecord(
  semantic: LegacyCriterionIdSemantic,
  occurrence: number,
): {
  readonly schema: 'legacy-criterion-id-v1';
  readonly criterion: LegacyCriterionIdSemantic;
  readonly occurrence: number;
} {
  return {
    schema: 'legacy-criterion-id-v1',
    criterion: semantic,
    occurrence,
  };
}

/** Format a `sha256:…` digest as the stable `legacy-<hex>` criterion id. */
export function criterionIdFromHash(hash: string): string {
  return `legacy-${hash.slice('sha256:'.length)}`;
}
