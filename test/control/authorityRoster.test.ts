import { describe, it, expect } from 'vitest';
import {
  AUTHORITY_ROSTER_SCHEMA,
  AuthorityRosterError,
  parseAuthorityRoster,
  serializeAuthorityRoster,
  type AuthorityRoster,
} from '../../src/control/authorityRoster.js';

const VALID_YAML = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: verifier-prod-1
  implementation: hercules-l1-gates
evaluator:
  runId: evaluator-prod-1
  implementationId: independent-evaluation-v1
  version: "1.0.0"
  model: gpt-5.6
  runtime: node22
`;

const validRoster = (): AuthorityRoster => ({
  schema: AUTHORITY_ROSTER_SCHEMA,
  verifier: { runId: 'verifier-prod-1', implementation: 'hercules-l1-gates' },
  evaluator: {
    runId: 'evaluator-prod-1',
    implementationId: 'independent-evaluation-v1',
    version: '1.0.0',
    model: 'gpt-5.6',
    runtime: 'node22',
  },
});

describe('parseAuthorityRoster', () => {
  it('parses a complete roster', () => {
    const roster = parseAuthorityRoster(VALID_YAML);
    expect(roster).toEqual(validRoster());
  });

  it('accepts explicit null model', () => {
    const yaml = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: verifier-a
  implementation: impl-v
evaluator:
  runId: evaluator-a
  implementationId: impl-e
  version: "1"
  model: null
  runtime: node
`;
    const roster = parseAuthorityRoster(yaml);
    expect(roster.evaluator.model).toBeNull();
  });

  it('accepts a string model', () => {
    const yaml = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: verifier-a
  implementation: impl-v
evaluator:
  runId: evaluator-a
  implementationId: impl-e
  version: "1"
  model: claude-opus
  runtime: node
`;
    const roster = parseAuthorityRoster(yaml);
    expect(roster.evaluator.model).toBe('claude-opus');
  });

  it('rejects malformed yaml', () => {
    expect(() => parseAuthorityRoster(': : :\n  - [')).toThrow(AuthorityRosterError);
  });

  it('rejects an empty document', () => {
    expect(() => parseAuthorityRoster('')).toThrow(AuthorityRosterError);
    expect(() => parseAuthorityRoster('\n')).toThrow(AuthorityRosterError);
  });

  it('rejects wrong schema', () => {
    const bad = VALID_YAML.replace(AUTHORITY_ROSTER_SCHEMA, 'hercules-authority-roster/v0');
    expect(() => parseAuthorityRoster(bad)).toThrow(AuthorityRosterError);
  });

  it('rejects unknown keys at root', () => {
    const bad = `${VALID_YAML}extra: true\n`;
    expect(() => parseAuthorityRoster(bad)).toThrow(AuthorityRosterError);
  });

  it('rejects unknown keys on verifier', () => {
    const bad = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: verifier-a
  implementation: impl-v
  unexpected: x
evaluator:
  runId: evaluator-a
  implementationId: impl-e
  version: "1"
  model: null
  runtime: node
`;
    expect(() => parseAuthorityRoster(bad)).toThrow(AuthorityRosterError);
  });

  it('rejects unknown keys on evaluator', () => {
    const bad = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: verifier-a
  implementation: impl-v
evaluator:
  runId: evaluator-a
  implementationId: impl-e
  version: "1"
  model: null
  runtime: node
  unexpected: x
`;
    expect(() => parseAuthorityRoster(bad)).toThrow(AuthorityRosterError);
  });

  it('rejects an invalid identifier runId', () => {
    const bad = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: "../evil"
  implementation: impl-v
evaluator:
  runId: evaluator-a
  implementationId: impl-e
  version: "1"
  model: null
  runtime: node
`;
    expect(() => parseAuthorityRoster(bad)).toThrow(AuthorityRosterError);
  });

  it('rejects implementation identities that are not safe identifiers', () => {
    const text = serializeAuthorityRoster({
      ...validRoster(),
      evaluator: { ...validRoster().evaluator, implementationId: 'hercules-control/reviewEvaluation/v1' },
    });
    expect(() => parseAuthorityRoster(text)).toThrow(AuthorityRosterError);
  });

  it('rejects overlapping verifier and evaluator runIds', () => {
    const bad = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: shared-run
  implementation: impl-v
evaluator:
  runId: shared-run
  implementationId: impl-e
  version: "1"
  model: null
  runtime: node
`;
    expect(() => parseAuthorityRoster(bad)).toThrow(AuthorityRosterError);
  });

  it('rejects an over-long string field', () => {
    const long = 'a'.repeat(257);
    const bad = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: verifier-a
  implementation: ${long}
evaluator:
  runId: evaluator-a
  implementationId: impl-e
  version: "1"
  model: null
  runtime: node
`;
    expect(() => parseAuthorityRoster(bad)).toThrow(AuthorityRosterError);
  });

  it('rejects a non-NFC string field', () => {
    // U+0065 U+0301 is NFD "é"; NFC is U+00E9.
    const nfd = 'e\u0301';
    const bad = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: verifier-a
  implementation: ${nfd}
evaluator:
  runId: evaluator-a
  implementationId: impl-e
  version: "1"
  model: null
  runtime: node
`;
    expect(() => parseAuthorityRoster(bad)).toThrow(AuthorityRosterError);
  });

  it('rejects missing required fields', () => {
    expect(() => parseAuthorityRoster('schema: hercules-authority-roster/v1\n')).toThrow(
      AuthorityRosterError,
    );
  });
});

describe('serializeAuthorityRoster', () => {
  it('round-trips through parseAuthorityRoster', () => {
    const roster = validRoster();
    expect(parseAuthorityRoster(serializeAuthorityRoster(roster))).toEqual(roster);
  });

  it('round-trips with null model', () => {
    const roster: AuthorityRoster = {
      ...validRoster(),
      evaluator: { ...validRoster().evaluator, model: null },
    };
    expect(parseAuthorityRoster(serializeAuthorityRoster(roster))).toEqual(roster);
  });

  it('emits deterministic key order regardless of object insertion order', () => {
    const a: AuthorityRoster = {
      schema: AUTHORITY_ROSTER_SCHEMA,
      verifier: { runId: 'v-1', implementation: 'impl-v' },
      evaluator: {
        runId: 'e-1',
        implementationId: 'impl-e',
        version: '1',
        model: null,
        runtime: 'node',
      },
    };
    // Different property insertion order on the source objects.
    const b = {
      evaluator: {
        version: '1',
        runtime: 'node',
        model: null as string | null,
        runId: 'e-1',
        implementationId: 'impl-e',
      },
      verifier: {
        implementation: 'impl-v',
        runId: 'v-1',
      },
      schema: AUTHORITY_ROSTER_SCHEMA,
    } as AuthorityRoster;

    expect(serializeAuthorityRoster(a)).toBe(serializeAuthorityRoster(b));
  });
});
