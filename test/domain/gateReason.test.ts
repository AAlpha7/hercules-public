/**
 * extractGateFailureReason: name the actual failure, never a progress line.
 */
import { describe, it, expect } from 'vitest';
import { extractGateFailureReason } from '../../src/domain/gateReason.js';

/** Production R2 cargo output (multi-line, progress + failures summary). */
const R2_CARGO_OUTPUT = `
   Compiling orbit-core v0.4.2
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 42.11s
     Running unittests src/lib.rs

running 5986 tests
test memory::tests::snapshot_roundtrip ... ok

failures:

---- memory::tests::circuit_breaker_event_emitted_on_trip stdout ----
assertion \`left == right\` failed
  left: 0
 right: 1

failures:
    memory::tests::circuit_breaker_event_emitted_on_trip

test result: FAILED. 5972 passed; 1 failed; 13 ignored; 0 measured; 0 filtered out; finished in 38.20s
`;

describe('extractGateFailureReason', () => {
  it('picks cargo failures: summary test path, not running N tests', () => {
    const reason = extractGateFailureReason(R2_CARGO_OUTPUT);
    expect(reason).toContain('memory::tests::circuit_breaker_event_emitted_on_trip');
    expect(reason).not.toContain('running 5986 tests');
  });

  it('joins first 3 of many failures and appends +N more', () => {
    const output = `
failures:
    a::one
    b::two
    c::three
    d::four
    e::five

test result: FAILED. 0 passed; 5 failed
`;
    const reason = extractGateFailureReason(output);
    expect(reason).toBe('a::one, b::two, c::three +2 more');
  });

  it('picks first error: / error[E0xxx]: line when no failures block', () => {
    const plain = `
Compiling foo v0.1.0
error: cannot find value \`x\` in this scope
  --> src/lib.rs:3:5
`;
    expect(extractGateFailureReason(plain)).toBe('error: cannot find value `x` in this scope');

    const coded = `
error[E0308]: mismatched types
  --> src/main.rs:1:1
error[E0382]: borrow of moved value
`;
    expect(extractGateFailureReason(coded)).toBe('error[E0308]: mismatched types');
  });

  it('falls back to last non-empty non-noise line for non-cargo output', () => {
    const eslint = `
/src/foo.ts
  12:3  error  Unexpected var  no-var

✖ 1 problem (1 error, 0 warnings)
`;
    expect(extractGateFailureReason(eslint)).toBe('✖ 1 problem (1 error, 0 warnings)');
  });

  it('returns empty string when output is only progress noise', () => {
    const onlyNoise = `
running 3 tests
Compiling foo v0.1.0
Finished test profile [unoptimized + debuginfo] target(s) in 1.0s
Blocking waiting for file lock on build directory
`;
    expect(extractGateFailureReason(onlyNoise)).toBe('');
  });

  it('truncates at maxLen with a trailing ellipsis', () => {
    const long = 'x'.repeat(50);
    const reason = extractGateFailureReason(long, 20);
    expect(reason).toBe(`${'x'.repeat(20)}…`);
    expect(reason.length).toBe(21);
  });
});
