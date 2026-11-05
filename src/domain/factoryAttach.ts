/**
 * Domain — Cursor Cloud factory restart reattach (pure).
 *
 * Rings 1–15 launch a new Cloud Agent whenever the coordinator loses the
 * in-memory run. A daemon restart (self-update after a factory merge, crash)
 * then orphans the still-running agent and opens a second PR. Reattach polls
 * the persisted agent id — not POST /followup, not a second launch.
 */
import { isValidIdentifier, type Task } from './task.js';
import { isFactoryConflictRework } from './factoryConflict.js';
import { isRemoteFactoryAdapter } from './agents.js';

const FACTORY_AGENT_ID_MAX = 128;

/** Cursor Cloud agent ids are durable handles, not path segments — still reject traversal. */
export function isSafeFactoryAgentId(id: string): boolean {
  const value = id.trim();
  if (value.length === 0 || value.length > FACTORY_AGENT_ID_MAX) return false;
  return isValidIdentifier(value);
}

/**
 * Attach to a live factory Cloud Agent after the coordinator lost the run.
 * Pending steer / rework still relaunches (not followup). Unsafe ids fail closed.
 */
export function factoryAttachAgentId(
  task: Pick<Task, 'adapter' | 'agentSessionAdapter' | 'agentSession' | 'pendingSteer'>,
): string | null {
  if ((task.pendingSteer ?? '').trim().length > 0) return null;
  if (
    !isFactoryConflictRework(task) &&
    !isRemoteFactoryAdapter(task.adapter ?? '')
  ) {
    return null;
  }
  const id = (task.agentSession ?? '').trim();
  if (!isSafeFactoryAgentId(id)) return null;
  return id;
}
