import { createHash } from 'node:crypto';

import { canonicalSerialize } from './canonicalSerialize.js';

export { CanonicalJsonError, canonicalSerialize, canonicalClone } from './canonicalSerialize.js';

/** SHA-256 of canonical JSON V1, with an explicit algorithm prefix. */
export function hashCanonicalJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalSerialize(value), 'utf8').digest('hex')}`;
}
