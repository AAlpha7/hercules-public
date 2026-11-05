/**
 * Bounded accumulation for agent stream text. Unbounded `fullText += chunk`
 * OOM'd the daemon (grok --resume replayed megabytes instantly after each
 * crash → 4GB heap, SIGABRT ×3, 2026-07-18). Consumers read the FINAL
 * message, so the tail is what matters — keep it, drop the middle.
 */

/** Hard cap for one run's accumulated agent text. */
export const MAX_AGENT_TEXT = 4 * 1024 * 1024;

/**
 * Cap for captured agent stderr tail used in death diagnosis.
 * Keep small (~2KB) — only the tail matters; unbounded stderr can OOM the daemon.
 */
export const MAX_STDERR_TAIL = 2 * 1024;

/** Hard cap for a single buffered (newline-less) stream line. */
export const MAX_STREAM_LINE_BUFFER = 32 * 1024 * 1024;

/**
 * Append with a tail-keeping cap. Hysteresis (25% slack) so a capped string
 * is not re-sliced on every subsequent token.
 */
export function boundedAppend(current: string, add: string, max = MAX_AGENT_TEXT): string {
  const next = current + add;
  if (next.length <= max * 1.25) return next;
  const kept = next.slice(next.length - max);
  return `…[truncated ${next.length - kept.length} chars]…\n${kept}`;
}
