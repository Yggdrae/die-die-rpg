import { check, SemanticOp, type SemanticOp as SemanticOperation } from '@rpg/contracts';
import type { AuthorityMutationContext, MutationApplier } from './model.ts';

export function applySemanticOperations(
  source: Readonly<Record<string, unknown>>,
  operations: readonly SemanticOperation[],
): Readonly<Record<string, unknown>> {
  const result = structuredClone(source) as Record<string, unknown>;
  for (const operation of operations) {
    if (operation.op === 'set') {
      setPath(result, operation.path, structuredClone(operation.value));
      continue;
    }
    const current = getPath(result, operation.path);
    if (typeof current !== 'number') throw new Error('semantic_target_not_number');
    if (operation.op === 'delta') {
      setPath(result, operation.path, current + operation.value);
      continue;
    }
    setPath(
      result,
      operation.path,
      Math.min(
        operation.max ?? Number.POSITIVE_INFINITY,
        Math.max(operation.min ?? Number.NEGATIVE_INFINITY, current),
      ),
    );
  }
  return result;
}

export interface VersionedResource {
  readonly value: Readonly<Record<string, unknown>>;
  readonly version: number;
}

export interface SemanticAuthorityStore {
  get(recordId: string): Promise<VersionedResource | undefined>;
  compareAndSet(
    recordId: string,
    expectedVersion: number,
    next: VersionedResource,
  ): Promise<boolean>;
}

export class InMemorySemanticAuthorityStore implements SemanticAuthorityStore {
  readonly #records = new Map<string, VersionedResource>();

  seed(recordId: string, record: VersionedResource): void {
    this.#records.set(recordId, structuredClone(record));
  }

  async get(recordId: string): Promise<VersionedResource | undefined> {
    const value = this.#records.get(recordId);
    return value === undefined ? undefined : structuredClone(value);
  }

  async compareAndSet(
    recordId: string,
    expectedVersion: number,
    next: VersionedResource,
  ): Promise<boolean> {
    if (this.#records.get(recordId)?.version !== expectedVersion) return false;
    this.#records.set(recordId, structuredClone(next));
    return true;
  }
}

export class SemanticMutationApplier implements MutationApplier {
  constructor(
    readonly featureId: string,
    readonly tableName: string,
    private readonly store: SemanticAuthorityStore,
    private readonly cursor: () => string,
  ) {}

  async apply({ mutation }: AuthorityMutationContext) {
    if (mutation.operation !== 'semantic' || !isSemanticPayload(mutation.payload)) {
      return { status: 'error' as const, code: 'invalid_semantic_mutation', retryable: false };
    }
    const hasAbsoluteSet = mutation.payload.operations.some((operation) => operation.op === 'set');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.get(mutation.recordId);
      if (current === undefined) {
        return { status: 'error' as const, code: 'not_found_or_forbidden', retryable: false };
      }
      if (
        hasAbsoluteSet &&
        (mutation.expectedVersion === null || mutation.expectedVersion !== current.version)
      ) {
        return {
          status: 'conflict' as const,
          expectedVersion: mutation.expectedVersion ?? 0,
          actualVersion: current.version,
          currentValue: current.value,
        };
      }
      let value: Readonly<Record<string, unknown>>;
      try {
        value = applySemanticOperations(current.value, mutation.payload.operations);
      } catch {
        return { status: 'error' as const, code: 'invalid_semantic_target', retryable: false };
      }
      const next = { value, version: current.version + 1 };
      if (await this.store.compareAndSet(mutation.recordId, current.version, next)) {
        return { status: 'accepted' as const, version: next.version, cursor: this.cursor() };
      }
      if (hasAbsoluteSet) {
        const actual = await this.store.get(mutation.recordId);
        return {
          status: 'conflict' as const,
          expectedVersion: mutation.expectedVersion ?? 0,
          actualVersion: actual?.version ?? current.version + 1,
          currentValue: actual?.value ?? current.value,
        };
      }
    }
    return { status: 'error' as const, code: 'semantic_concurrency_exhausted', retryable: true };
  }
}

function isSemanticPayload(
  value: unknown,
): value is { readonly operations: readonly SemanticOperation[] } {
  if (value === null || typeof value !== 'object' || !('operations' in value)) return false;
  const operations = (value as { readonly operations?: unknown }).operations;
  return (
    Array.isArray(operations) &&
    operations.length > 0 &&
    operations.every((op) => check(SemanticOp, op))
  );
}

function getPath(record: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !(segment in current)) throw new Error('semantic_path_not_found');
    current = current[segment];
  }
  return current;
}

function setPath(record: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const leaf = segments.pop();
  if (leaf === undefined || leaf.length === 0) throw new Error('semantic_path_not_found');
  let current = record;
  for (const segment of segments) {
    const next = current[segment];
    if (!isRecord(next)) throw new Error('semantic_path_not_found');
    current = next;
  }
  current[leaf] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
