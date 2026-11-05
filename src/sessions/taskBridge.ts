/**
 * Bridge free-session machinery ↔ orchestrator tasks for live task sessions.
 * Injected from the composition root so SessionManager stays free of control IO.
 */
import type { Task } from '../domain/task.js';

export interface TaskSessionBridge {
  /** Latest task snapshot (null if deleted). */
  getTask(taskId: string): Promise<Task | null>;
  /** True while the orchestrator has a live / stopping run. */
  isRunning(taskId: string): boolean;
  /** Live activity lines (empty if none). */
  activity(taskId: string): readonly string[];
  /**
   * Human chat already queued on a live task (for session.queued mirror).
   * Optional — when absent, reopen keeps whatever was last recorded.
   */
  pendingChat?(taskId: string): readonly string[];
  /**
   * Deliver a human message: queue while running, else steer/pending via actions.
   * Returns a short mode label for the transcript.
   * Optional clientMessageId makes retries of the same submission idempotent.
   */
  deliverMessage(
    taskId: string,
    message: string,
    opts?: { readonly clientMessageId?: string | null },
  ): Promise<{ mode: 'queued' | 'steer' | 'pending' | 'duplicate'; note?: string }>;
  /** Optional on-disk worktree for diff / attachment copy. */
  workspaceDir?(taskId: string): string | null;
}
