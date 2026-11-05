/**
 * Plain-language failure brief for the phone (CEO lens): the packet records
 * WHAT failed in engineer terms; this translates the LAST recorded kind into
 * one zh sentence + one recommendation. Pure body parsing, no new data.
 */

export interface FailureBrief {
  readonly kind: string;
  readonly kindZh: string;
  readonly adviceZh: string;
  readonly attempts: number;
}

const KIND_ZH: Record<string, { kindZh: string; adviceZh: string }> = {
  provision: {
    kindZh: '环境准备失败(工作区/依赖没就绪)',
    adviceZh:
      '多为环境问题 — 环境修复后优先 Retry(重置 attempts,复用 hercules/<id>);不必新建任务',
  },
  stall: {
    kindZh: '运行长时间无响应,被系统回收',
    adviceZh:
      '偶发优先 Retry(复用保留分支);反复出现则 Steer 缩小范围,或 Clean salvage 开新任务',
  },
  agent_exit: {
    kindZh: 'agent 进程异常退出',
    adviceZh:
      '偶发优先 Retry;连续出现可换 agent 或 Clean salvage 从保留 tip 开新任务',
  },
  verify_l1: {
    kindZh: '机械门禁未通过(测试/构建/类型检查红)',
    adviceZh:
      '优先 Retry/Steer 在同一保留分支上修;需要全新任务时用 Clean salvage(勿手贴 diff)',
  },
  verify_l2: {
    kindZh: '行为验证未通过(应用启动/界面证据失败)',
    adviceZh: '看截图证据后优先 Retry/Steer;跨任务续作只用 Clean salvage',
  },
  verify_l3: {
    kindZh: '独立审稿多次要求修改仍未达标',
    adviceZh: '审稿意见在包里 — 读后 Retry/Steer;或 Clean salvage 收紧 DoD',
  },
  verify_infra: {
    kindZh: '验证系统自身出错(不是任务的错)',
    adviceZh: '直接 Re-verify 或 Retry;反复出现请报告系统问题',
  },
};

/** Last recorded failure kind in the body (packets append chronologically). */
export function failureBrief(body: string, attempts: number): FailureBrief | null {
  const matches = [...body.matchAll(/\*\*(?:Failure kind|Kind):\*\*\s*`([a-z0-9_-]+)`/gi)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) return null;
  const zh = KIND_ZH[last] ?? {
    kindZh: `失败类型:${last}`,
    adviceZh: '查看下方失败详情后选择重试或打回',
  };
  return { kind: last, attempts, ...zh };
}
