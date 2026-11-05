import { redactHostOutput } from './hostExecutor.js';

/** Safe one-line text for stale-dependency recovery receipts and logs. */
export function redactDependencyRecoveryText(raw: string, max: number): string {
  let safe = redactHostOutput(raw, Math.max(max * 3, 900));
  safe = safe.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>`]+/gi, '[url]');
  safe = safe.replace(/<!--[\s\S]*?-->/g, '[control-redacted]');
  safe = safe.replace(/<!--|-->|<\/?(?:script|style)\b[^>]*>/gi, '[control-redacted]');
  safe = safe.replace(/[`\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (safe.length === 0) return 'recovery failed without a safe diagnostic';
  return safe.length > max ? `${safe.slice(0, Math.max(0, max - 1))}…` : safe;
}
