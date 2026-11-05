/**
 * Domain — extract the human-meaningful failure reason from raw gate output.
 *
 * A failed gate's `reason` reaches the CEO's phone; it must name the actual
 * failure (for cargo test output, the failing test path), never an incidental
 * progress line like `running 5986 tests`. Preference order: cargo `failures:`
 * summary names → first `error:` / `error[…]` line → last non-empty line that
 * is not build/test progress. Pure — no IO.
 */

/** Progress/noise lines that must never be surfaced as a failure reason. */
const PROGRESS_NOISE: readonly RegExp[] = [
  /^running \d+ tests?$/,
  /^test .* \.\.\. (?:ok|ignored)$/,
  /^(?:Compiling|Finished|Blocking waiting|Running|Checking|Downloading|Downloaded|Updating|Fresh)\b/,
];

const MAX_NAMED_FAILURES = 3;

function cap(reason: string, maxLen: number): string {
  return reason.length > maxLen ? `${reason.slice(0, maxLen)}…` : reason;
}

export function extractGateFailureReason(output: string, maxLen = 200): string {
  const lines = output.split('\n').map((l) => l.trim());

  // 1. Cargo prints two `failures:` sections; the last one lists bare test
  //    paths — the exact thing the human wants to see.
  let names: readonly string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== 'failures:') continue;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length && /^[A-Za-z0-9_:]+$/.test(lines[j]!); j += 1) {
      block.push(lines[j]!);
    }
    if (block.length > 0) names = block;
  }
  if (names.length > 0) {
    const head = names.slice(0, MAX_NAMED_FAILURES).join(', ');
    const rest = names.length - MAX_NAMED_FAILURES;
    return cap(rest > 0 ? `${head} +${rest} more` : head, maxLen);
  }

  // 2. Compiler/tool error lines (`error: …`, `error[E0308]: …`).
  const err = lines.find((l) => /^error(?::|\[)/.test(l));
  if (err) return cap(err, maxLen);

  // 3. Last non-empty line that is not progress noise.
  const last = [...lines].reverse().find((l) => l.length > 0 && !PROGRESS_NOISE.some((re) => re.test(l)));
  return cap(last ?? '', maxLen);
}
