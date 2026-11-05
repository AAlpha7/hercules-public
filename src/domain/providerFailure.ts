/** Typed provider infrastructure failures that do not describe implementation quality. */
export type ProviderInfrastructureFailure = 'session_missing';

/** Conservative restore/missing-session classifier for provider CLI surfaces. */
export function classifyProviderInfrastructureFailure(input: {
  readonly wasResume: boolean;
  readonly evidence: string;
}): ProviderInfrastructureFailure | null {
  if (!input.wasResume) return null;
  const text = input.evidence;
  return /(?:restore|resume|session)[^\n]{0,100}(?:404|not found|unknown|expired)|(?:404|not found)[^\n]{0,100}(?:restore|resume|session)/i.test(text)
    ? 'session_missing'
    : null;
}
