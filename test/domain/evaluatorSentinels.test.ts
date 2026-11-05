import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UNEVALUATED_EVALUATOR_MODEL,
  UNEVALUATED_EVALUATOR_RUNTIME,
  UNEVALUATED_EVALUATOR_VERSION,
} from '../../src/domain/evaluatorSentinels.js';

const ROOT = process.cwd();
const MAX_IDENTIFIER_BYTES = 256;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isDomainIdentifier(value: string): boolean {
  const size = utf8Bytes(value);
  return size >= 1 && size <= MAX_IDENTIFIER_BYTES;
}

describe('evaluator sentinels (C2.3)', () => {
  it('pins the three exact unevaluated sentinel values', () => {
    expect(UNEVALUATED_EVALUATOR_VERSION).toBe('hercules-unevaluated/v1');
    expect(UNEVALUATED_EVALUATOR_RUNTIME).toBe('hercules-unevaluated/v1');
    expect(UNEVALUATED_EVALUATOR_MODEL).toBeNull();
  });

  it('keeps the string sentinels inside the domain identifier bound (1..256 UTF-8 bytes)', () => {
    expect(isDomainIdentifier(UNEVALUATED_EVALUATOR_VERSION)).toBe(true);
    expect(isDomainIdentifier(UNEVALUATED_EVALUATOR_RUNTIME)).toBe(true);
  });

  it('does not collide with isolation seed or spine fixture evaluator identifiers', () => {
    const seed = readFileSync(join(ROOT, 'src/isolation/controlApiV2ReviewSeed.ts'), 'utf8');
    const spine = readFileSync(join(ROOT, 'src/proofs/spine.ts'), 'utf8');
    expect(seed).toContain("'evaluator-v1'");
    expect(seed).toContain("'runtime-v1'");
    expect(spine).toContain("'evaluator-v1'");
    expect(spine).toContain("'runtime-v1'");
    expect(UNEVALUATED_EVALUATOR_VERSION).not.toBe('evaluator-v1');
    expect(UNEVALUATED_EVALUATOR_RUNTIME).not.toBe('runtime-v1');
    expect(UNEVALUATED_EVALUATOR_VERSION).not.toBe('runtime-v1');
    expect(UNEVALUATED_EVALUATOR_RUNTIME).not.toBe('evaluator-v1');
  });
});
