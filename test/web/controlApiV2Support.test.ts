import { describe, expect, it } from 'vitest';
import { browserControlApiV2Supported } from '../../src/web/review/controlApiV2Support.js';

describe('browserControlApiV2Supported', () => {
  it.each([
    [
      'secure + subtle.digest + randomUUID',
      {
        isSecureContext: true,
        crypto: {
          subtle: { digest: (): undefined => undefined },
          randomUUID: (): string => '00000000-0000-0000-0000-000000000000',
        },
      },
      true,
    ],
    [
      'insecure context',
      {
        isSecureContext: false,
        crypto: {
          subtle: { digest: (): undefined => undefined },
          randomUUID: (): string => '00000000-0000-0000-0000-000000000000',
        },
      },
      false,
    ],
    [
      'missing subtle.digest',
      {
        isSecureContext: true,
        crypto: {
          subtle: {},
          randomUUID: (): string => '00000000-0000-0000-0000-000000000000',
        },
      },
      false,
    ],
    [
      'missing randomUUID',
      {
        isSecureContext: true,
        crypto: {
          subtle: { digest: (): undefined => undefined },
        },
      },
      false,
    ],
  ] as const)('%s', (_label, scope, expected) => {
    expect(browserControlApiV2Supported(scope)).toBe(expected);
  });

  it('returns false when property access throws', () => {
    const scope = {
      get isSecureContext(): boolean {
        throw new Error('probe failed');
      },
    };
    expect(browserControlApiV2Supported(scope)).toBe(false);
  });
});
