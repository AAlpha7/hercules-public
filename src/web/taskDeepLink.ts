import { isValidIdentifier } from '../domain/task.js';

export function taskIdFromSearch(search: string): string | null {
  const taskId = new URLSearchParams(search).get('task')?.trim() ?? '';
  return isValidIdentifier(taskId) ? taskId : null;
}
