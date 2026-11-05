import { describe, expect, it } from 'vitest';
import {
  ArtifactSecretError,
  scanArtifactSecrets,
} from '../../../src/control/artifacts/secretScanner.js';

describe('artifact secret scanner', () => {
  it.each([
    ['authorization_bearer', 'Authorization: Bearer synthetic-token-value'],
    ['authorization_basic', 'authorization: basic dXNlcjpwYXNz'],
    ['url_userinfo', 'https://alice:synthetic-password@example.invalid/path'],
    ['private_key', '-----BEGIN PRIVATE KEY-----'],
    ['credential_assignment', 'api_key = synthetic-api-key-value'],
    ['provider_token_prefix', 'token=xai-synthetic-provider-token'],
  ] as const)('detects %s without echoing matched bytes', (code, secret) => {
    const bytes = Buffer.from(`prefix\0${secret}\0suffix`, 'utf8');

    expect(() => scanArtifactSecrets({ bytes })).toThrow(ArtifactSecretError);
    try {
      scanArtifactSecrets({ bytes });
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactSecretError);
      const finding = (error as ArtifactSecretError).findings[0];
      expect(finding?.code).toBe(code);
      expect(finding?.start).toBeGreaterThanOrEqual(0);
      expect(finding?.end).toBeGreaterThan(finding?.start ?? 0);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(error instanceof Error ? error.message : '').not.toContain(secret);
    }
  });

  it('scans bounded textual metadata as bytes without retaining caller buffers', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const metadata = ['surface=cli', 'password: synthetic-password'];

    expect(() => scanArtifactSecrets({ bytes, metadata })).toThrowError(
      /credential_assignment/,
    );
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('accepts ordinary binary and redacted textual content', () => {
    expect(
      scanArtifactSecrets({
        bytes: new Uint8Array([0, 255, 13, 10, 65, 66, 67]),
        metadata: ['image/png', 'redacted by verifier'],
      }),
    ).toEqual([]);
  });

  it('does not flag TypeScript type annotations as credential assignments (2026-09-06 false positive)', () => {
    const okSamples = [
      'contains(token: string): boolean {',
      'readonly token?: string;',
      'password: Buffer | undefined',
      'apiKey: Promise<string>',
      'secret: readonly string[]',
      'token: string | undefined;',
      'token: Record<string, string>,',
      'password: string[]',
    ];
    for (const sample of okSamples) {
      expect(() => scanArtifactSecrets({ bytes: Buffer.from(sample, 'utf8') }), sample).not.toThrow();
    }
    // A value that merely starts with a type name is still a secret (Grok R17 B1).
    for (const secret of [
      'token = stringy-real-value-1234',
      'token: string-abc-def-ghij',
      'password: undefined-but-real-value',
      'token: string.notatype.value.here',
      'api_key: number-42-notatypexx',
      'secret: Buffer/something-long',
      'token: "string-is-my-actual-value"',
      'token: void-notatype-abcdef',
    ]) {
      expect(() => scanArtifactSecrets({ bytes: Buffer.from(secret, 'utf8') }), secret).toThrow(
        ArtifactSecretError,
      );
    }
  });

  it('does not flag Rust/Go type annotations either — references, impl/dyn, PascalCase paths, slices (2026-09-12 a downstream project false positive)', () => {
    for (const sample of [
      'fn token_is_supported(token: &NumberToken, sources: &[NumberToken]) -> bool {',
      "fn check(secret: &'a Secret) {",
      'fn accept(key: impl AsRef<str>) {',
      'password: Option<String>,',
      'token: &mut Token,',
      'token: *const Token)',
      'credential: crate::auth::Credential,',
      'api_key: Box<dyn Provider>',
      'token: &str) -> bool',
    ]) {
      expect(() => scanArtifactSecrets({ bytes: Buffer.from(sample, 'utf8') }), sample).not.toThrow();
    }
    // Digits or quotes make it a value again; a PascalCase word with digits is not a type.
    for (const secret of [
      'token: SuperSecret1234,',
      'token: &Xk9Q2mLp7Rt4,',
      'password: Option1234567',
      "token: 'NumberToken'",
    ]) {
      expect(() => scanArtifactSecrets({ bytes: Buffer.from(secret, 'utf8') }), secret).toThrow(
        ArtifactSecretError,
      );
    }
  });

  it('detects quoted JSON assignments without echoing their value', () => {
    const json = '{"apiKey":"synthetic-json-credential"}';
    expect(() =>
      scanArtifactSecrets({ bytes: Buffer.from(json, 'utf8') }),
    ).toThrowError(/credential_assignment/);
    try {
      scanArtifactSecrets({ bytes: Buffer.from(json, 'utf8') });
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain(
        'synthetic-json-credential',
      );
      expect(JSON.stringify(error)).not.toContain('synthetic-json-credential');
    }
  });

  it('rejects metadata item, count, density, and total bounds before encoding', () => {
    const oversized = 'z'.repeat(8 * 1024 + 1);
    expect(() =>
      scanArtifactSecrets({ bytes: new Uint8Array(), metadata: [oversized] }),
    ).toThrowError(/metadata_too_large/);
    expect(() =>
      scanArtifactSecrets({
        bytes: new Uint8Array(),
        metadata: Array.from({ length: 129 }, () => 'ok'),
      }),
    ).toThrowError(/invalid_metadata/);
    expect(() =>
      scanArtifactSecrets({
        bytes: new Uint8Array(),
        metadata: Array.from({ length: 100 }, () => 'z'.repeat(700)),
      }),
    ).toThrowError(/metadata_too_large/);
    const sparse = new Array<string>(2);
    sparse[1] = 'present';
    expect(() =>
      scanArtifactSecrets({ bytes: new Uint8Array(), metadata: sparse }),
    ).toThrowError(/invalid_metadata/);
    try {
      scanArtifactSecrets({ bytes: new Uint8Array(), metadata: [oversized] });
    } catch (error) {
      expect(error instanceof Error ? error.message : '').not.toContain(oversized);
      expect(JSON.stringify(error)).not.toContain(oversized);
    }
  });
});
