/** Secure-context probe: the Control API V2 browser client needs WebCrypto digests and UUIDs, which browsers expose only on secure origins. */
export function browserControlApiV2Supported(scope: {
  readonly isSecureContext?: unknown;
  readonly crypto?: { readonly subtle?: { readonly digest?: unknown }; readonly randomUUID?: unknown };
} = globalThis as never): boolean {
  try {
    return (
      scope.isSecureContext === true &&
      typeof scope.crypto?.subtle?.digest === 'function' &&
      typeof scope.crypto?.randomUUID === 'function'
    );
  } catch {
    return false;
  }
}
