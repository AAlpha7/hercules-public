import type { TaskState } from './task.js';
import { costWeight } from './scheduling.js';

/** States that compete in the dispatch queue (todo / retrying). */
export function isQueueState(state: TaskState): boolean {
  return state === 'todo' || state === 'retrying';
}

export interface QueueFrontTask {
  readonly id: string;
  readonly priority: number;
  readonly labels: readonly string[];
  readonly state: TaskState;
}

export function peerEffective(task: QueueFrontTask): number {
  return task.priority + costWeight(task.labels);
}

/**
 * Priority that places task at the front of the dispatch queue among all
 * todo/retrying peers (lower number = higher urgency).
 */
export function computeQueueFrontPriority(
  task: QueueFrontTask,
  allTasks: readonly QueueFrontTask[],
): { readonly nextPriority: number; readonly alreadyFront: boolean } {
  if (!isQueueState(task.state)) {
    return { nextPriority: task.priority, alreadyFront: true };
  }
  const peers = allTasks.filter((t) => t.id !== task.id && isQueueState(t.state));
  if (peers.length === 0) {
    return { nextPriority: task.priority, alreadyFront: true };
  }
  let minPeerEff = Number.POSITIVE_INFINITY;
  for (const p of peers) {
    const eff = peerEffective(p);
    if (eff < minPeerEff) minPeerEff = eff;
  }
  const myEff = peerEffective(task);
  if (myEff < minPeerEff) {
    return { nextPriority: task.priority, alreadyFront: true };
  }
  const myWeight = costWeight(task.labels);
  return { nextPriority: minPeerEff - myWeight - 1, alreadyFront: false };
}
