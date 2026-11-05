/**
 * One observable step of an analyst run. Streamed from the grok process
 * (tool calls, text/thought deltas) and the Analyst (phases) to whoever is
 * watching the draft job — never persisted, never fed back into a task body.
 */
export type AnalystPhase = 'context' | 'draft' | 'retry' | 'repair' | 'done';

export type AnalystActivity =
  | { readonly kind: 'phase'; readonly phase: AnalystPhase }
  | { readonly kind: 'tool'; readonly tool: string; readonly target: string }
  | { readonly kind: 'text'; readonly delta: string }
  | { readonly kind: 'thought'; readonly delta: string };

export type AnalystActivityListener = (activity: AnalystActivity) => void;
