export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
}

function fail(path: string, reason: string): never {
  throw new CanonicalJsonError(`canonical JSON rejected ${path}: ${reason}`);
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'numbers must be finite');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    fail(path, `unsupported ${typeof value} value`);
  }
  if (ancestors.has(value)) fail(path, 'cycles are not allowed');
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        fail(path, 'symbol properties are not allowed');
      }
      const names = Object.getOwnPropertyNames(value);
      const expectedNames = new Set(['length']);
      const parts: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) fail(`${path}[${index}]`, 'sparse arrays are not allowed');
        const key = String(index);
        expectedNames.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          fail(`${path}[${index}]`, 'array elements must be enumerable data properties');
        }
        parts.push(serialize(descriptor.value, `${path}[${index}]`, ancestors));
      }
      if (names.some((name) => !expectedNames.has(name))) {
        fail(path, 'custom array properties are not allowed');
      }
      return `[${parts.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, 'only plain records are allowed');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail(path, 'symbol properties are not allowed');
    }

    const entries: string[] = [];
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        fail(`${path}.${key}`, 'record fields must be enumerable data properties');
      }
      entries.push(
        `${JSON.stringify(key)}:${serialize(descriptor.value, `${path}.${key}`, ancestors)}`,
      );
    }
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Deterministic JSON bytes for the fail-closed Hercules canonical JSON V1 subset. */
export function canonicalSerialize(value: unknown): string {
  return serialize(value, '$', new Set<object>());
}

/** Validate and detach JSON-compatible input from mutable caller-owned references. */
export function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalSerialize(value)) as T;
}
