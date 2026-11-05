/**
 * Control layer — authority-roster.yaml parse/validate (cutover Phase C3).
 *
 * Reviewed configuration naming the production verifier and evaluator
 * identities. Pure text → typed; fail-closed; no I/O. Composition root wires
 * this into authorityContext in a later slice.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { isValidIdentifier } from '../domain/task.js';

export const AUTHORITY_ROSTER_SCHEMA = 'hercules-authority-roster/v1' as const;

/** File name at the control repository root, beside repos.yaml. */
export const AUTHORITY_ROSTER_FILE = 'authority-roster.yaml' as const;

export interface AuthorityRoster {
  readonly schema: typeof AUTHORITY_ROSTER_SCHEMA;
  readonly verifier: { readonly runId: string; readonly implementation: string };
  readonly evaluator: {
    readonly runId: string;
    readonly implementationId: string;
    readonly version: string;
    readonly model: string | null;
    readonly runtime: string;
  };
}

export class AuthorityRosterError extends Error {
  override readonly name = 'AuthorityRosterError';
}

const MAX_FIELD_BYTES = 256;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isBoundedNfc(value: string, { nonEmpty }: { nonEmpty: boolean }): boolean {
  const bytes = utf8Bytes(value);
  if (nonEmpty && bytes < 1) return false;
  if (bytes > MAX_FIELD_BYTES) return false;
  return value.normalize('NFC') === value;
}

const boundedNfcNonEmpty = z.string().refine(
  (v) => isBoundedNfc(v, { nonEmpty: true }),
  { message: 'must be a non-empty NFC string of at most 256 UTF-8 bytes' },
);

const runIdSchema = boundedNfcNonEmpty.refine(
  (v) => isValidIdentifier(v),
  { message: 'must be a safe identifier' },
);

/** Model: bounded NFC string (may be empty) or explicit null — never omitted. */
const modelSchema = z.union([
  z.null(),
  z.string().refine(
    (v) => utf8Bytes(v) <= MAX_FIELD_BYTES && v.normalize('NFC') === v,
    { message: 'must be an NFC string of at most 256 UTF-8 bytes or null' },
  ),
]);

const rosterSchema = z
  .object({
    schema: z.literal(AUTHORITY_ROSTER_SCHEMA),
    verifier: z
      .object({
        runId: runIdSchema,
        implementation: runIdSchema,
      })
      .strict(),
    evaluator: z
      .object({
        runId: runIdSchema,
        implementationId: runIdSchema,
        version: boundedNfcNonEmpty,
        model: modelSchema,
        runtime: boundedNfcNonEmpty,
      })
      .strict(),
  })
  .strict();

/** Pure text → typed; fail-closed; no I/O. */
export function parseAuthorityRoster(yamlText: string): AuthorityRoster {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new AuthorityRosterError(
      `could not parse authority-roster.yaml: ${(err as Error).message}`,
    );
  }

  // Absence is the caller's decision; a present document must be complete.
  if (raw === null || raw === undefined) {
    throw new AuthorityRosterError(
      'invalid authority-roster.yaml: (root): empty document',
    );
  }

  const result = rosterSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new AuthorityRosterError(`invalid authority-roster.yaml: ${issues}`);
  }

  const data = result.data;
  if (data.verifier.runId === data.evaluator.runId) {
    throw new AuthorityRosterError(
      'invalid authority-roster.yaml: verifier.runId and evaluator.runId must differ',
    );
  }

  return {
    schema: data.schema,
    verifier: {
      runId: data.verifier.runId,
      implementation: data.verifier.implementation,
    },
    evaluator: {
      runId: data.evaluator.runId,
      implementationId: data.evaluator.implementationId,
      version: data.evaluator.version,
      model: data.evaluator.model,
      runtime: data.evaluator.runtime,
    },
  };
}

/** Inverse with sorted keys; parse(serialize(x)) deep-equals x. */
export function serializeAuthorityRoster(roster: AuthorityRoster): string {
  // Insert keys in sorted order at every level so output is insertion-order stable.
  const doc: Record<string, unknown> = {
    evaluator: {
      implementationId: roster.evaluator.implementationId,
      model: roster.evaluator.model,
      runId: roster.evaluator.runId,
      runtime: roster.evaluator.runtime,
      version: roster.evaluator.version,
    },
    schema: roster.schema,
    verifier: {
      implementation: roster.verifier.implementation,
      runId: roster.verifier.runId,
    },
  };
  return stringifyYaml(doc, { lineWidth: 0 });
}
