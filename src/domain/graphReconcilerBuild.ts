/** Build graph reconciler results from raw planner/runtime input (pure). */
import { validateTaskGraph } from './taskGraph.js';
import { evaluateGraphReconciler } from './graphReconcilerEval.js';
import { isNodeEvidenceStatus } from './graphReconcilerSubgraph.js';
import {
  boundReconcilerText,
  type GraphAcceptedProvenance,
  type GraphIntegrationEvidence,
  type GraphNodeEvidence,
  type GraphReconcilerBuildResult,
  type GraphReconcilerInput,
} from './graphReconcilerTypes.js';

export function buildGraphReconcilerResult(raw: unknown): GraphReconcilerBuildResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ code: 'schema', message: 'graph reconciler input must be an object' }],
    };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o['evaluatedAtMs'] !== 'number' || !Number.isFinite(o['evaluatedAtMs'])) {
    return { ok: false, errors: [{ code: 'schema', message: 'evaluatedAtMs required' }] };
  }
  if (o['graph'] === undefined) {
    return { ok: false, errors: [{ code: 'schema', message: 'graph required' }] };
  }
  const validated = validateTaskGraph(o['graph']);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  if (!Array.isArray(o['nodeEvidence'])) {
    return { ok: false, errors: [{ code: 'schema', message: 'nodeEvidence array required' }] };
  }
  const nodeEvidence: GraphNodeEvidence[] = [];
  for (const item of o['nodeEvidence']) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    if (typeof e['nodeId'] !== 'string' || !isNodeEvidenceStatus(e['status'])) continue;
    if (typeof e['attemptCount'] !== 'number' || !Number.isInteger(e['attemptCount'])) continue;
    const row: GraphNodeEvidence = {
      nodeId: e['nodeId'],
      status: e['status'],
      attemptCount: e['attemptCount'],
      ...(typeof e['evidenceDigest'] === 'string' || e['evidenceDigest'] === null
        ? { evidenceDigest: e['evidenceDigest'] as string | null }
        : {}),
      ...(typeof e['failureKind'] === 'string' || e['failureKind'] === null
        ? { failureKind: e['failureKind'] as string | null }
        : {}),
      ...(typeof e['failureDetail'] === 'string' || e['failureDetail'] === null
        ? { failureDetail: e['failureDetail'] as string | null }
        : {}),
      ...(Array.isArray(e['discoveredCouplingNodeIds'])
        ? {
            discoveredCouplingNodeIds: e['discoveredCouplingNodeIds'].filter(
              (x): x is string => typeof x === 'string',
            ),
          }
        : {}),
      ...(Array.isArray(e['discoveredCycleNodeIds'])
        ? {
            discoveredCycleNodeIds: e['discoveredCycleNodeIds'].filter(
              (x): x is string => typeof x === 'string',
            ),
          }
        : {}),
    };
    nodeEvidence.push(row);
  }
  let integrationEvidence: GraphIntegrationEvidence | undefined;
  if (o['integrationEvidence'] !== undefined && o['integrationEvidence'] !== null) {
    if (typeof o['integrationEvidence'] !== 'object' || Array.isArray(o['integrationEvidence'])) {
      return { ok: false, errors: [{ code: 'schema', message: 'integrationEvidence invalid' }] };
    }
    const ie = o['integrationEvidence'] as Record<string, unknown>;
    if (
      ie['status'] !== 'unproven'
      && ie['status'] !== 'passed'
      && ie['status'] !== 'failed'
      && ie['status'] !== 'uncertain'
    ) {
      return {
        ok: false,
        errors: [{ code: 'schema', message: 'integrationEvidence.status invalid' }],
      };
    }
    integrationEvidence = {
      status: ie['status'],
      ...(typeof ie['detail'] === 'string' || ie['detail'] === null
        ? { detail: ie['detail'] as string | null }
        : {}),
      ...(Array.isArray(ie['proofDigests'])
        ? { proofDigests: ie['proofDigests'].filter((x): x is string => typeof x === 'string') }
        : {}),
    };
  }
  const acceptedProvenance: GraphAcceptedProvenance[] = [];
  if (Array.isArray(o['acceptedProvenance'])) {
    for (const item of o['acceptedProvenance']) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const p = item as Record<string, unknown>;
      if (typeof p['nodeId'] !== 'string' || typeof p['evidenceDigest'] !== 'string') continue;
      if (!Array.isArray(p['leaseKeys'])) continue;
      acceptedProvenance.push({
        nodeId: p['nodeId'],
        evidenceDigest: p['evidenceDigest'],
        leaseKeys: p['leaseKeys'].filter((x): x is string => typeof x === 'string'),
      });
    }
  }
  const input: GraphReconcilerInput = {
    graph: validated.graph,
    nodeEvidence,
    evaluatedAtMs: o['evaluatedAtMs'] as number,
    ...(acceptedProvenance.length > 0 ? { acceptedProvenance } : {}),
    ...(integrationEvidence !== undefined ? { integrationEvidence } : {}),
  };
  try {
    return { ok: true, result: evaluateGraphReconciler(input) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'evaluation failed';
    return { ok: false, errors: [{ code: 'schema', message: boundReconcilerText(message) }] };
  }
}
