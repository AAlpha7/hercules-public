import { parseDefinitionOfDone, type CriterionKind } from './acceptance.js';
import {
  canonicalClone,
  CanonicalJsonError,
  hashCanonicalJson,
} from './canonicalJson.js';
import { computeTaskContractHash, assertTaskContractHash } from './contractHash.js';
import {
  criterionIdFromHash,
  criterionIdRecord,
} from './legacyCriterionId.js';
import { parseMechProofBinding } from './mechProof.js';
import {
  assertTaskContract,
  type ActorRef,
  type ApprovalPolicy,
  type BudgetPolicy,
  type CapabilityPolicy,
  type ContextRef,
  type ContractCriterion,
  type CriterionAuthority,
  type ProofBinding,
  type TaskContract,
  type VerificationPolicy,
} from './taskContract.js';

export { criterionIdFromHash, criterionIdRecord } from './legacyCriterionId.js';

export const LEGACY_MISSING_DOD_TEXT =
  'Legacy task has no explicit acceptance criteria; human definition and approval are required';

export const CONTRACT_COMPILE_DIAGNOSTIC_CODES = [
  'untyped_criterion_as_human',
  'missing_definition_of_done',
] as const;
export type ContractCompileDiagnosticCode =
  (typeof CONTRACT_COMPILE_DIAGNOSTIC_CODES)[number];

export interface ContractCompileDiagnostic {
  readonly code: ContractCompileDiagnosticCode;
  readonly message: string;
}

export interface LegacyTaskContractInput {
  readonly taskId: string;
  readonly objective: string;
  readonly body: string;
  readonly context: readonly ContextRef[];
  readonly constraints: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly capabilityPolicy: CapabilityPolicy;
  readonly verificationPolicy: VerificationPolicy;
  readonly approvalPolicy: ApprovalPolicy;
  readonly budgetPolicy: BudgetPolicy;
  readonly createdBy: ActorRef;
  readonly createdAt: string;
}

export interface CompiledTaskContract {
  readonly contract: TaskContract;
  readonly diagnostics: readonly ContractCompileDiagnostic[];
}

export class ContractCompilerError extends Error {
  override readonly name = 'ContractCompilerError';
}

function mapAuthority(kind: CriterionKind): CriterionAuthority {
  if (kind === 'reviewer') return 'evaluator';
  if (kind === 'checkpoint') return 'human';
  return kind;
}

function mapProofBinding(text: string): { readonly text: string; readonly binding: ProofBinding | null } {
  const binding = parseMechProofBinding(text);
  if (binding.kind === 'unbound') return { text: binding.cleanText, binding: null };
  let proofType: string;
  let requirement = binding.ref;
  if (binding.kind === 'test-path') {
    proofType = 'test_path';
  } else if (binding.kind === 'test-case') {
    proofType = 'test_case';
    requirement =
      binding.title !== undefined && binding.title.length > 0
        ? `${binding.ref}#${binding.title}`
        : binding.ref;
  } else if (binding.kind === 'probe') {
    proofType = 'probe';
    requirement =
      binding.probeKind !== undefined
        ? `${binding.probeKind}:${binding.ref}`
        : binding.ref;
  } else {
    proofType = binding.kind;
  }
  return {
    text: binding.cleanText,
    binding: { proofType, requirement },
  };
}

function criterionId(
  semantic: Omit<ContractCriterion, 'id'>,
  occurrence: number,
): string {
  return criterionIdFromHash(hashCanonicalJson(criterionIdRecord(semantic, occurrence)));
}

function compileCriteria(body: string): {
  readonly criteria: readonly ContractCriterion[];
  readonly diagnostics: readonly ContractCompileDiagnostic[];
} {
  const dod = parseDefinitionOfDone(body);
  const diagnostics: ContractCompileDiagnostic[] = dod.warnings.map((message) => ({
    code: 'untyped_criterion_as_human',
    message,
  }));

  if (dod.criteria.length === 0) {
    const semantic = {
      text: LEGACY_MISSING_DOD_TEXT,
      authority: 'human' as const,
      required: true,
      proofBinding: null,
    };
    diagnostics.push({
      code: 'missing_definition_of_done',
      message: dod.hasSection
        ? 'legacy Definition of Done section contains no checklist criteria'
        : 'legacy task has no recognized Definition of Done section',
    });
    return {
      criteria: [{ id: criterionId(semantic, 1), ...semantic }],
      diagnostics,
    };
  }

  const occurrences = new Map<string, number>();
  const criteria = dod.criteria.map((legacy): ContractCriterion => {
    const mappedProof = legacy.kind === 'mechanical'
      ? mapProofBinding(legacy.text)
      : { text: legacy.text, binding: null };
    const semantic = {
      text: mappedProof.text,
      authority: mapAuthority(legacy.kind),
      // (human, after deploy) never gates Approve — owner decision 2026-09-03.
      required: legacy.afterDeploy !== true,
      proofBinding: mappedProof.binding,
    };
    const occurrenceKey = hashCanonicalJson(semantic);
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    return { id: criterionId(semantic, occurrence), ...semantic };
  });
  return { criteria, diagnostics };
}

/** Compile the immutable root V2 contract. Later versions require a change request. */
export function compileLegacyTaskContract(input: LegacyTaskContractInput): CompiledTaskContract {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.taskId !== 'string' ||
    input.taskId.length === 0 ||
    typeof input.objective !== 'string' ||
    input.objective.trim().length === 0 ||
    typeof input.body !== 'string'
  ) {
    throw new ContractCompilerError('legacy contract input identities, objective, and body are invalid');
  }

  try {
    const compiled = compileCriteria(input.body);
    const draft: TaskContract = {
      taskId: input.taskId,
      version: 1,
      contractHash: 'pending',
      objective: input.objective.trim(),
      context: canonicalClone(input.context),
      acceptanceCriteria: canonicalClone(compiled.criteria),
      constraints: canonicalClone(input.constraints),
      forbiddenActions: canonicalClone(input.forbiddenActions),
      capabilityPolicy: canonicalClone(input.capabilityPolicy),
      verificationPolicy: canonicalClone(input.verificationPolicy),
      approvalPolicy: canonicalClone(input.approvalPolicy),
      budgetPolicy: canonicalClone(input.budgetPolicy),
      createdBy: canonicalClone(input.createdBy),
      createdAt: input.createdAt,
      supersedesVersion: null,
    };
    const contract: TaskContract = {
      ...draft,
      contractHash: computeTaskContractHash(draft),
    };
    assertTaskContract(contract);
    assertTaskContractHash(contract);
    return { contract, diagnostics: canonicalClone(compiled.diagnostics) };
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new ContractCompilerError(`legacy contract input is not canonical JSON: ${error.message}`);
    }
    throw error;
  }
}
