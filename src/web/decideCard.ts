/**
 * Decide-card derivations: answer the CEO's four questions mechanically from
 * the task body — 目的 / 为什么没全过 / 出了什么 / (选项后果 rendered in UI).
 */
import { extractGateFailureReason } from '../domain/gateReason.js';

/** First paragraph under ## Goal (preferred) or ## Task — the task's purpose. */
export function extractTaskPurpose(body: string): string | null {
  for (const heading of ['Goal', '目标', 'Task', '任务']) {
    const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
    const m = re.exec(body);
    if (!m) continue;
    const rest = body.slice(m.index + m[0].length);
    const stop = rest.search(/^##\s+/m);
    const section = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
    const firstLine = section.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    if (firstLine) return firstLine;
  }
  return null;
}

const GATE_ZH: Record<string, string> = {
  setup: '环境安装',
  install: '环境安装',
  typecheck: '类型检查',
  lint: '代码规范',
  test: '测试套件',
  build: '构建',
  'held-out-smoke': '保留冒烟测试',
  behavioral: '行为验证(启动应用拿证据)',
  delivery: '交付诚实性',
  'anti-cheat': '反作弊扫描',
  'base-drift': '分支与主干同步',
  'pr-mergeable': 'PR 可合并性',
};

/** Condensed zh reasons for known canned gate failures. */
function condenseReason(name: string, raw: string): string {
  if (name === 'behavioral') {
    // New packets carry the EXACT reason after 具体原因: — show it verbatim.
    const exact = /具体原因[::]\s*(.+?)。/.exec(raw)?.[1];
    if (exact) return `没有产出浏览器证据 — ${exact}。`;
    if (/produced no evidence/i.test(raw)) {
      return '仓库声明了行为验证,但这次没有产出浏览器证据(本次运行未记录精确原因;Re-verify 会给出)——应用没有被机器亲自跑过。';
    }
    if (/failed/i.test(raw)) return '启动应用后的界面证据步骤未通过。';
  }
  return extractGateFailureReason(raw, 90);
}

export interface FailingGate {
  readonly name: string;
  readonly nameZh: string;
  readonly reasonZh: string;
}

/** ❌ gates from the LATEST **Gates** block, with zh name + condensed reason. */
export function failingGatesZh(body: string): FailingGate[] {
  const blocks = body.split(/^\*\*Gates\*\*\s*$/m);
  if (blocks.length < 2) return [];
  const latest = blocks[blocks.length - 1]!;
  const out: FailingGate[] = [];
  const lines = latest.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^-\s*❌\s*([A-Za-z0-9_-]+)/.exec(lines[i]!.trim());
    if (!m) {
      // Stop at the next section heading to stay inside this Gates block.
      if (/^\S/.test(lines[i]!) && /^\*\*|^##/.test(lines[i]!.trim()) ) break;
      continue;
    }
    const name = m[1]!;
    // Fenced explanation directly below, if present. Keep line structure —
    // reason extraction needs it (cargo `failures:` blocks are line-oriented).
    let reason = '';
    if (lines[i + 1]?.trim().startsWith('```')) {
      const buf: string[] = [];
      for (let j = i + 2; j < lines.length && !lines[j]!.trim().startsWith('```'); j += 1) {
        buf.push(lines[j]!.trim());
      }
      reason = buf.join('\n');
    }
    out.push({
      name,
      nameZh: GATE_ZH[name] ?? name,
      reasonZh: condenseReason(name, reason),
    });
  }
  return out;
}
