import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  canonicalSerialize,
  hashCanonicalJson,
} from '../../src/domain/canonicalJson.js';

interface GoldenCanonicalFixture {
  readonly input: unknown;
  readonly canonical: string;
  readonly sha256: string;
}

const golden = JSON.parse(
  readFileSync(
    join(process.cwd(), 'test/fixtures/hercules-2-v1/canonical-json-v1.json'),
    'utf8',
  ),
) as GoldenCanonicalFixture;

describe('Hercules canonical JSON V1', () => {
  it('matches the committed golden bytes and SHA-256 digest', () => {
    expect(canonicalSerialize(golden.input)).toBe(golden.canonical);
    expect(hashCanonicalJson(golden.input)).toBe(golden.sha256);
  });

  it('is independent of object-key insertion order at every depth', () => {
    const left = {
      z: [{ second: 2, first: 1 }],
      a: { y: false, x: true },
    };
    const right = {
      a: { x: true, y: false },
      z: [{ first: 1, second: 2 }],
    };

    expect(canonicalSerialize(left)).toBe(canonicalSerialize(right));
    expect(hashCanonicalJson(left)).toBe(hashCanonicalJson(right));
  });

  it('preserves array order and avoids structural/type concatenation collisions', () => {
    expect(hashCanonicalJson(['a', 'bc'])).not.toBe(hashCanonicalJson(['ab', 'c']));
    expect(hashCanonicalJson({ a: 'bc' })).not.toBe(hashCanonicalJson({ ab: 'c' }));
    expect(hashCanonicalJson(['1'])).not.toBe(hashCanonicalJson([1]));
    expect(hashCanonicalJson([1, 2])).not.toBe(hashCanonicalJson([2, 1]));
  });

  it('uses JSON finite-number semantics including canonical negative zero', () => {
    expect(canonicalSerialize(-0)).toBe('0');
    expect(canonicalSerialize(1.25)).toBe('1.25');
  });

  it('fails closed on values that cannot have stable JSON meaning', () => {
    const sparse: unknown[] = [];
    sparse[1] = 'present';
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const accessor = Object.defineProperty({}, 'value', { get: () => 1, enumerable: true });
    const symbolRecord = { ok: true } as Record<PropertyKey, unknown>;
    symbolRecord[Symbol('hidden')] = true;

    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      sparse,
      cyclic,
      new Date('2026-08-28T00:00:00Z'),
      accessor,
      symbolRecord,
      { missing: undefined },
    ]) {
      expect(() => canonicalSerialize(value)).toThrow(CanonicalJsonError);
    }
  });
});
