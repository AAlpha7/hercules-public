/**
 * Extract the LATEST 决策摘要 (packet-embedded zh executive block) from a
 * task body so the Decide panel can pin it above the buttons — the summary
 * existed but was buried inside the collapsed Proof (user, 2026-07-23).
 */

export interface DecisionSummary {
  readonly change: string;
  readonly trust: string;
  readonly risk: string;
}

export function extractDecisionSummary(body: string): DecisionSummary | null {
  const sections = body.split(/^## 决策摘要\s*$/m);
  const last = sections.length > 1 ? sections[sections.length - 1]! : null;
  if (last === null) return null;
  const grab = (label: string): string | null => {
    const m = new RegExp(`^-\\s*\\*\\*${label}\\*\\*[::]\\s*(.+)$`, 'm').exec(last);
    return m?.[1]?.trim() ?? null;
  };
  const change = grab('改动');
  const trust = grab('可信度');
  const risk = grab('风险');
  if (!change && !trust && !risk) return null;
  return {
    change: change ?? '(未记录)',
    trust: trust ?? '(未记录)',
    risk: risk ?? '(未记录)',
  };
}
