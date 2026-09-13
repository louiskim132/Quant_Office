import { createHash } from 'node:crypto';

/** Deterministic JSON: plain objects only, ordered keys, no lossy JSON values. */
export function canonical(value: unknown): string {
  const ancestors = new Set<object>();
  function visit(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || (Number.isInteger(input) && !Number.isSafeInteger(input))) throw new Error('Unsafe canonical number');
      return JSON.stringify(input);
    }
    if (typeof input !== 'object') throw new Error('Unsupported canonical value');
    if (ancestors.has(input)) throw new Error('Circular canonical value');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length) throw new Error('Sparse or decorated arrays are not canonical');
        return `[${input.map(visit).join(',')}]`;
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new Error('Canonical objects must be plain');
      if (Reflect.ownKeys(input).some(key => typeof key !== 'string')) throw new Error('Symbol keys are not canonical');
      return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${visit((input as Record<string, unknown>)[key])}`).join(',')}}`;
    } finally { ancestors.delete(input); }
  }
  return visit(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalHash(value: unknown): string { return sha256(canonical(value)); }
