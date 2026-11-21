/**
 * First gate on an untrusted package (`PRD.md` s.75): declarations only, nothing that can run.
 * Works from property descriptors, so no getter is ever invoked. Runs before the schema, which reads
 * values and would otherwise trigger them.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 16;
const MAX_BYTES = 1024 * 1024;

export interface PlainDataIssue {
  readonly path: string;
  readonly message: string;
}

function pointerSegment(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function plainDataIssues(root: unknown): readonly PlainDataIssue[] {
  const found: PlainDataIssue[] = [];
  const ancestors = new Set<object>();

  const visit = (value: unknown, path: string, depth: number): void => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) found.push({ path, message: 'Not a finite number.' });
      return;
    }
    if (typeof value !== 'object') {
      found.push({ path, message: `A ${typeof value} is not declarative data.` });
      return;
    }
    if (depth > MAX_DEPTH) {
      found.push({ path, message: `Nested deeper than ${MAX_DEPTH} levels.` });
      return;
    }
    if (ancestors.has(value)) {
      found.push({ path, message: 'A value contains itself.' });
      return;
    }
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    const plainPrototype = isArray
      ? prototype === Array.prototype
      : prototype === Object.prototype || prototype === null;
    if (!plainPrototype) {
      found.push({ path, message: 'Only plain objects and arrays are declarative data.' });
      return;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      found.push({ path, message: 'A symbol key is not declarative data.' });
      return;
    }
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    if (isArray) {
      for (let index = 0; index < value.length; index += 1) {
        if (descriptors[String(index)] === undefined) {
          found.push({ path: `${path}/${index}`, message: 'An array may not have holes.' });
        }
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (isArray && key === 'length') continue;
      const childPath = `${path}/${pointerSegment(key)}`;
      if (!isArray && FORBIDDEN_KEYS.has(key)) {
        found.push({ path: childPath, message: 'This key could reach shared object prototypes.' });
      } else if (descriptor.get !== undefined || descriptor.set !== undefined) {
        found.push({ path: childPath, message: 'An accessor property is not declarative data.' });
      } else {
        visit(descriptor.value, childPath, depth + 1);
      }
    }
    ancestors.delete(value);
  };

  visit(root, '', 0);
  if (found.length === 0 && JSON.stringify(root).length > MAX_BYTES) {
    found.push({ path: '', message: `Larger than ${MAX_BYTES} bytes.` });
  }
  return found;
}

/** Recursively sorted keys, so equal content compares equal whatever order it was written in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const source = entry as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, source[key]]),
    );
  });
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
