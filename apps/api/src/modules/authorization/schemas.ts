import type { TSchema } from '@sinclair/typebox';

/**
 * Contract schemas carry a `$id`; reusing one across routes makes Ajv resolve the reference to
 * more than one schema. Route schemas use an id-free copy (same shape as the identity routes).
 */
export function inline<T extends TSchema>(schema: T): T {
  const cloned = structuredClone(schema);
  removeIds(cloned);
  return cloned;
}

function removeIds(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) removeIds(item);
    return;
  }
  const record = value as Record<string, unknown>;
  delete record.$id;
  for (const child of Object.values(record)) removeIds(child);
}
