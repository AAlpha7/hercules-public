const MAX_METADATA_BYTES = 64 * 1024;
const MAX_METADATA_ITEMS = 128;
const MAX_METADATA_ITEM_BYTES = 8 * 1024;
const MAX_FINDINGS = 16;

export type ArtifactSecretRule =
  | 'authorization_bearer'
  | 'authorization_basic'
  | 'url_userinfo'
  | 'private_key'
  | 'credential_assignment'
  | 'provider_token_prefix';

export interface ArtifactSecretFinding {
  readonly code: ArtifactSecretRule;
  readonly source: 'content' | 'metadata';
  readonly sourceIndex: number;
  readonly start: number;
  readonly end: number;
}

export class ArtifactSecretError extends Error {
  readonly code = 'artifact_secret';
  readonly findings: readonly ArtifactSecretFinding[];

  constructor(findings: readonly ArtifactSecretFinding[]) {
    const codes = [...new Set(findings.map((finding) => finding.code))];
    super(`artifact secret scan rejected content: ${codes.join(',')}`);
    this.name = 'ArtifactSecretError';
    this.findings = findings.map((finding) => Object.freeze({ ...finding }));
  }

  toJSON(): { readonly code: string; readonly findings: readonly ArtifactSecretFinding[] } {
    return { code: this.code, findings: this.findings };
  }
}

export class ArtifactSecretInputError extends Error {
  readonly code = 'artifact_secret_input';
  readonly reason: 'metadata_too_large' | 'invalid_metadata';

  constructor(reason: 'metadata_too_large' | 'invalid_metadata') {
    super(`artifact secret scan input rejected: ${reason}`);
    this.name = 'ArtifactSecretInputError';
    this.reason = reason;
  }

  toJSON(): { readonly code: string; readonly reason: string } {
    return { code: this.code, reason: this.reason };
  }
}

interface SecretRule {
  readonly code: ArtifactSecretRule;
  readonly pattern: RegExp;
}

// Latin-1 decoding preserves one code unit per input byte, so match offsets are
// byte offsets even for nominally binary artifacts.
const RULES: readonly SecretRule[] = [
  {
    code: 'authorization_bearer',
    pattern: /\bauthorization\s*:\s*bearer\s+[!-~]{6,}/giu,
  },
  {
    code: 'authorization_basic',
    pattern: /\bauthorization\s*:\s*basic\s+[a-z0-9+/=]{8,}/giu,
  },
  {
    code: 'url_userinfo',
    pattern: /\bhttps?:\/\/[^\s/:@]{1,128}:[^\s/@]{1,256}@/giu,
  },
  {
    code: 'private_key',
    pattern: /-----begin (?:[a-z0-9 ]+ )?private key-----/giu,
  },
  {
    code: 'provider_token_prefix',
    pattern: /\b(?:xai-|sk-|ghp_|github_pat_|akia)[a-z0-9_-]{8,}/giu,
  },
  {
    code: 'credential_assignment',
    // The value must not be a TypeScript/JSDoc type annotation
    // (`contains(token: string)`, `token?: string`, `password: Buffer`) —
    // a real diff of a unit test tripped this rule (2026-09-06 false positive).
    pattern:
      // A type annotation is a WHOLE type expression (`string`, `string[]`,
      // `Promise<string>`, `readonly string[]`) followed by a type-position
      // delimiter (`;` `,` `)` `>` `|` `&` `=` `}` whitespace or end) — a value
      // that merely STARTS with a type name (`string-abc-…`) is still a secret
      // (Grok R17 B1). Rust/Go signatures are type annotations too:
      // `token: &NumberToken`, `secret: &'a Secret`, `key: impl AsRef<str>`,
      // `password: Option<String>`, `sources: &[NumberToken]` — an unquoted
      // reference/pointer/impl/dyn prefix or a PascalCase path WITHOUT digits
      // followed by a type-position delimiter is a type, never a credential
      // (2026-09-12 false positive on an a downstream project diff hunk header).
      /\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential)["']?\??\s*[:=]\s*["']?(?!(?:readonly\s+)?(?:&(?:'[a-z_]+\s+)?(?:mut\s+)?|\*(?:const\s+|mut\s+)?|impl\s+|dyn\s+)?(?:string|number|boolean|any|unknown|never|void|null|undefined|object|symbol|bigint|Buffer|Uint8Array|Record|Array|Promise|Readonly|Date|str|[A-Z][A-Za-z_]*(?:::[A-Z][A-Za-z_]*)*|\[[^\]\n]{0,80}\])(?:<[^>\n]{0,80}>)?(?:\[\])*(?=[\s;,)>|&=}\]]|$))[^\s"';,}]{6,}/giu,
  },
];

function scanOne(
  bytes: Uint8Array,
  source: ArtifactSecretFinding['source'],
  sourceIndex: number,
  findings: ArtifactSecretFinding[],
): void {
  const text = Buffer.from(bytes).toString('latin1');
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(text); match !== null; match = rule.pattern.exec(text)) {
      findings.push({
        code: rule.code,
        source,
        sourceIndex,
        start: match.index,
        end: match.index + match[0].length,
      });
      if (findings.length >= MAX_FINDINGS) return;
    }
    if (findings.length >= MAX_FINDINGS) return;
  }
}

export function scanArtifactSecrets(input: {
  readonly bytes: Uint8Array;
  readonly metadata?: readonly string[];
}): readonly ArtifactSecretFinding[] {
  const ownedBytes = Uint8Array.from(input.bytes);
  const sourceMetadata = input.metadata ?? [];
  if (!Array.isArray(sourceMetadata) || sourceMetadata.length > MAX_METADATA_ITEMS) {
    throw new ArtifactSecretInputError('invalid_metadata');
  }
  const metadata: string[] = [];
  let totalBytes = 0;
  for (let index = 0; index < sourceMetadata.length; index += 1) {
    if (!(index in sourceMetadata)) throw new ArtifactSecretInputError('invalid_metadata');
    const value = sourceMetadata[index];
    if (typeof value !== 'string') throw new ArtifactSecretInputError('invalid_metadata');
    const byteLength = Buffer.byteLength(value, 'utf8');
    if (byteLength > MAX_METADATA_ITEM_BYTES) {
      throw new ArtifactSecretInputError('metadata_too_large');
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_METADATA_BYTES) {
      throw new ArtifactSecretInputError('metadata_too_large');
    }
    metadata.push(value);
  }
  const metadataBytes = metadata.map((value) => Buffer.from(value, 'utf8'));

  const findings: ArtifactSecretFinding[] = [];
  scanOne(ownedBytes, 'content', 0, findings);
  for (let index = 0; index < metadataBytes.length && findings.length < MAX_FINDINGS; index += 1) {
    const bytes = metadataBytes[index];
    if (bytes !== undefined) scanOne(bytes, 'metadata', index, findings);
  }
  if (findings.length > 0) throw new ArtifactSecretError(findings);
  return [];
}
