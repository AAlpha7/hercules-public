/**
 * Resolve `human:<criterionId>` checkbox labels from the legacy task body
 * using the same id scheme as `contractCompiler.criterionId` (browser-safe).
 */
import { parseDefinitionOfDone } from '../../domain/acceptance.js';
import {
  criterionIdFromHash,
  criterionIdRecord,
} from '../../domain/legacyCriterionId.js';
import { browserHashCanonicalJson } from '../controlApiV2Client.js';

/**
 * Recompute legacy human/checkpoint criterion ids for `body` and return a map
 * from `human:<id>` → criterion text for the ids that match `criterionIds`.
 * Ids with no match are absent (caller shows the bare code).
 */
export async function resolveHumanCriterionLabels(
  body: string,
  criterionIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const wanted = new Set(criterionIds);
  if (wanted.size === 0) return new Map();

  const dod = parseDefinitionOfDone(body);
  const occurrences = new Map<string, number>();
  const labels = new Map<string, string>();

  for (const legacy of dod.criteria) {
    if (legacy.kind !== 'human' && legacy.kind !== 'checkpoint') continue;
    const semantic = {
      text: legacy.text,
      authority: 'human' as const,
      required: legacy.afterDeploy !== true,
      proofBinding: null,
    };
    const occurrenceKey = await browserHashCanonicalJson(semantic);
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    const id = criterionIdFromHash(
      await browserHashCanonicalJson(criterionIdRecord(semantic, occurrence)),
    );
    if (!wanted.has(id)) continue;
    labels.set(`human:${id}`, legacy.text);
  }

  return labels;
}
