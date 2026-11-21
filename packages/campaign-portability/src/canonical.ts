import { JSON_LIMITS, type JsonLimits } from './limits.ts';

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, `undefined` object members
 * omitted. Deterministic for equal logical content, so entry checksums are reproducible across
 * runtimes (online server, offline browser worker).
 */
export function canonicalJson(value: unknown): string {
  return write(value, 0);
}

function write(value: unknown, depth: number): string {
  if (depth > JSON_LIMITS.maxDepth) throw new CanonicalJsonError('too_deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('non_finite_number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : write(item, depth + 1))).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonError('unsupported_value');
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${write(record[key], depth + 1)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError('unsupported_value');
  }
}

export class CanonicalJsonError extends Error {
  constructor(readonly code: 'too_deep' | 'non_finite_number' | 'unsupported_value') {
    super(`canonical_json: ${code}`);
    this.name = 'CanonicalJsonError';
  }
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonicalJson(value));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type BoundedJsonFailure = 'malformed_json' | 'json_limits_exceeded';

/**
 * Parses untrusted UTF-8 JSON within `limits`. Nesting depth is measured on the raw text before
 * `JSON.parse`, so a hostile nesting depth never reaches the parser's recursion. The parsed value
 * is plain data: `__proto__`/`constructor`/`prototype` keys are refused rather than trusted.
 */
export function parseBoundedJson(
  bytes: Uint8Array,
  limits: JsonLimits = JSON_LIMITS,
): { ok: true; value: unknown } | { ok: false; error: BoundedJsonFailure } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, error: 'malformed_json' };
  }
  if (rawDepth(text) > limits.maxDepth) return { ok: false, error: 'json_limits_exceeded' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'malformed_json' };
  }
  return withinLimits(value, limits)
    ? { ok: true, value }
    : { ok: false, error: 'json_limits_exceeded' };
}

function rawDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (char === 0x5c) index += 1;
      else if (char === 0x22) inString = false;
    } else if (char === 0x22) inString = true;
    else if (char === 0x5b || char === 0x7b) {
      depth += 1;
      if (depth > max) max = depth;
    } else if (char === 0x5d || char === 0x7d) depth -= 1;
  }
  return max;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function withinLimits(root: unknown, limits: JsonLimits): boolean {
  let nodes = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    nodes += 1;
    if (nodes > limits.maxNodes) return false;
    if (typeof value === 'string') {
      if (value.length > limits.maxStringLength) return false;
    } else if (Array.isArray(value)) {
      if (value.length > limits.maxArrayLength) return false;
      for (const item of value) stack.push(item);
    } else if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length > limits.maxObjectKeys) return false;
      for (const key of keys) {
        if (FORBIDDEN_KEYS.has(key) || key.length > limits.maxStringLength) return false;
        stack.push((value as Record<string, unknown>)[key]);
      }
    }
  }
  return true;
}
