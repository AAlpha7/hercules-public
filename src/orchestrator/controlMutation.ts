import type { ControlMutation, ControlPort } from './orchestrator.js';

export class ControlMutationBoundaryError extends Error {
  override readonly name = 'ControlMutationBoundaryError';
}

/**
 * Use the ownership-scoped real-git boundary in production. The fallback keeps
 * lightweight test ports source-compatible; it is never used by GitControlPort.
 */
export async function mutateControl(
  control: ControlPort,
  mutation: ControlMutation,
  message: string,
): Promise<{ committed: boolean; hash?: string }> {
  if (control.mutateCommitted) return control.mutateCommitted(mutation, message);
  for (const { next } of mutation.writeTasks ?? []) await control.writeTask(next);
  for (const id of mutation.deleteTaskIds ?? []) await control.deleteTask(id);
  if (mutation.repos) await control.writeRepos(mutation.repos);
  if (mutation.writeReleases) {
    if (!control.writeRelease) {
      throw new ControlMutationBoundaryError('control port lacks release persistence');
    }
    for (const release of mutation.writeReleases) await control.writeRelease(release);
  }
  if (mutation.writeSuccessions) {
    if (!control.writeSuccession) {
      throw new ControlMutationBoundaryError('control port lacks succession persistence');
    }
    for (const { next } of mutation.writeSuccessions) await control.writeSuccession(next);
  }
  return control.commit(message);
}
