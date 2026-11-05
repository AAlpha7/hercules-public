/**
 * Domain — phone-visible notes when provisional workspace provisioning
 * fail-closes repeatedly (same reason every tick).
 *
 * Pure: no IO. Orchestrator counts consecutive discards and calls this when
 * the threshold is reached.
 */

/** Threshold of consecutive same-reason discards before the task body is annotated. */
export const PROVISION_DISCARD_NOTE_AFTER = 2;

/**
 * Append a `**provision** ❌` row to the latest `## Run timeline`, or a
 * `## Provision blocked` section when there is none. Returns `body` unchanged
 * when the same `reason` was already noted (idempotent per reason).
 */
export function appendProvisionDiscardNote(
  body: string,
  stamp: string,
  reason: string,
  count: number,
): string {
  const clean = reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (clean.length === 0) return body;
  if (body.includes(`**provision** ❌ — ${clean}`)) return body;

  const at = stamp.trim() || new Date().toISOString();
  const row =
    `- \`${at}\` **provision** ❌ — ${clean} (×${count}, retried every tick until resolved)`;

  const lower = body.toLowerCase();
  const idx = lower.lastIndexOf('## run timeline');
  if (idx >= 0) {
    const from = body.slice(idx);
    const nextRel = from.slice(1).search(/^##\s+/m);
    if (nextRel >= 0) {
      const insertAt = idx + 1 + nextRel;
      let end = insertAt;
      while (end > idx && (body[end - 1] === '\n' || body[end - 1] === '\r')) end--;
      return `${body.slice(0, end)}\n${row}\n\n${body.slice(insertAt)}`;
    }
    const trimmed = body.trimEnd();
    return `${trimmed}\n${row}\n`;
  }

  const block = ['## Provision blocked', '', row, ''].join('\n');
  return `${body.trimEnd()}\n\n${block}\n`;
}

/** Operator-facing detail for the untrusted-remote-tip discard. */
export function untrustedRemoteTipReason(branch: string, tip: string): string {
  const short = tip.trim().slice(0, 7);
  return (
    `unpinned task found a pre-existing remote branch \`${branch}\` at ${short} ` +
    'not created by this task — delete or rename that branch to continue'
  );
}
