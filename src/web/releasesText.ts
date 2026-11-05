/**
 * zh trust-chain statement, composed client-side from structured release
 * facts (same data the English domain statement uses — never invented).
 */

export function trustChainZh(row: {
  readonly aheadTasks: readonly { id: string; verified?: boolean | null }[];
  readonly operatorMergedCount?: number;
  readonly directCommits?: readonly unknown[];
}): string {
  const total = row.aheadTasks.length;
  const unverified = row.aheadTasks.filter((t) => t.verified === false);
  const verified = total - unverified.length;
  const operator = row.operatorMergedCount ?? 0;
  const direct = row.directCommits?.length ?? 0;
  const parts: string[] = [];

  if (total === 0) {
    parts.push('本次没有任务管线改动。');
  } else if (unverified.length === 0 && operator === 0) {
    parts.push(`共 ${total} 项任务改动,全部通过机器验证与人工批准。`);
  } else {
    parts.push(`共 ${total} 项任务改动 — ${verified} 项通过全套机器验证与人工批准`);
    if (unverified.length > 0) {
      parts.push(
        `;${unverified.length} 项无机器验证记录(前管线/人工打捞):${unverified
          .map((t) => t.id)
          .join('、')}`,
      );
    }
    if (operator > 0) parts.push(`;${operator} 项为操作员合并(未走合并闸)`);
    parts.push('。');
  }
  if (direct > 0) {
    parts.push(`另有 ${direct} 个直接提交未经任务管线(操作员推送)— 发布前请过目提交列表。`);
  }
  return parts.join('');
}
