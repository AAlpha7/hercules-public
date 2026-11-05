import { isValidIdentifier, type Task } from './task.js';

export type ExplicitDependencyMode = 'gate_merge' | 'completion_only';

/** Complete replacement for one task's dependency metadata. */
export interface DependencyRewireChange {
  readonly id: string;
  readonly expectedBlockedBy: readonly string[];
  readonly blockedBy: readonly string[];
  readonly dependencyMode: ExplicitDependencyMode;
}

export type DependencyRewireValidation =
  | { readonly ok: true; readonly tasks: readonly Task[] }
  | { readonly ok: false; readonly reason: string };

function duplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function cycleIn(tasks: readonly Task[]): readonly string[] | null {
  const deps = new Map(tasks.map((task) => [task.id, task.blockedBy]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): readonly string[] | null => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of deps.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/** Validate the entire proposed graph and return dependency-only task copies. */
export function validateDependencyRewire(
  tasks: readonly Task[],
  changes: readonly DependencyRewireChange[],
): DependencyRewireValidation {
  if (changes.length === 0) return { ok: false, reason: 'at least one dependency change is required' };
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selected = new Set<string>();
  const replacements = new Map<string, Task>();

  for (const change of changes) {
    if (!isValidIdentifier(change.id)) return { ok: false, reason: `unsafe task id '${change.id}'` };
    if (selected.has(change.id)) return { ok: false, reason: `duplicate selected task '${change.id}'` };
    selected.add(change.id);
    const current = byId.get(change.id);
    if (!current) return { ok: false, reason: `missing task '${change.id}'` };
    if (current.state === 'in_progress') {
      return { ok: false, reason: `task '${change.id}' is running` };
    }
    if (change.dependencyMode !== 'gate_merge' && change.dependencyMode !== 'completion_only') {
      return { ok: false, reason: `invalid dependency mode for '${change.id}'` };
    }
    const expectedDuplicate = duplicate(change.expectedBlockedBy);
    if (expectedDuplicate) {
      return { ok: false, reason: `duplicate expected dependency '${expectedDuplicate}'` };
    }
    const nextDuplicate = duplicate(change.blockedBy);
    if (nextDuplicate) return { ok: false, reason: `duplicate dependency '${nextDuplicate}'` };
    if (!sameSet(current.blockedBy, change.expectedBlockedBy)) {
      return { ok: false, reason: `stale expected dependency set for '${change.id}'` };
    }
    for (const dep of change.blockedBy) {
      if (!isValidIdentifier(dep)) return { ok: false, reason: `unsafe dependency id '${dep}'` };
      if (dep === change.id) return { ok: false, reason: `task '${change.id}' cannot depend on itself` };
      if (!byId.has(dep)) return { ok: false, reason: `missing dependency '${dep}'` };
    }
    replacements.set(change.id, {
      ...current,
      blockedBy: [...change.blockedBy],
      dependencyMode: change.dependencyMode,
    });
  }

  const proposed = tasks.map((task) => replacements.get(task.id) ?? task);
  const cycle = cycleIn(proposed);
  if (cycle) return { ok: false, reason: `dependency cycle: ${cycle.join(' -> ')}` };
  return { ok: true, tasks: changes.map((change) => replacements.get(change.id)!) };
}
