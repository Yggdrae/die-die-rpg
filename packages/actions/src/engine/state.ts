import { err, ok, type Result, type SemanticOp } from '@rpg/contracts';

/**
 * Target state and what operations mean on it (`_techspec.md` D-09, D-10). One place: an owner's adapter
 * only loads and saves, and the device overlay runs the same code as the authority, so the two cannot
 * disagree. Numbers are safe integers, as everywhere in the rules engines.
 */

export interface TargetState {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly resources: Readonly<
    Record<string, { readonly current: number; readonly temporary?: number }>
  >;
  readonly tracks: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  readonly conditions: Readonly<Record<string, number>>;
  readonly inventory: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          {
            readonly slot: number;
            readonly name?: string;
            readonly size?: number;
            readonly removed?: boolean;
          }
        >
      >
    >
  >;
  readonly slots: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Repeater and list entries (feature 15 D-04): `entries.<field>.<entryId>.<subfield>`, with `_order`, `_type`, and
   * `_removed` beside the declared subfields. Optional, so a state written before it existed still reads.
   */
  readonly entries?: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
  >;
}

export const EMPTY_TARGET_STATE: TargetState = {
  fields: {},
  resources: {},
  tracks: {},
  conditions: {},
  inventory: {},
  slots: {},
  entries: {},
};

export type OperationGuard =
  | { readonly path: string; readonly atLeast: number }
  | { readonly path: string; readonly equals: string | number | boolean };

export interface PlannedOperation {
  readonly operation: SemanticOp;
  /** Must hold on the state this operation meets, or the whole application is refused. */
  readonly requires?: OperationGuard;
}

export interface StateChange {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface AppliedOperations {
  readonly state: TargetState;
  /** One entry per path: its value before the first operation and after the last. */
  readonly changes: readonly StateChange[];
}

export type ApplyFailureCode = 'invalid_path' | 'invalid_value' | 'target_changed';

export interface ApplyFailure {
  readonly code: ApplyFailureCode;
  readonly path: string;
}

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_TEXT = 500;

/** Segment count per root, with the fixed trailing segment where one exists. */
const SHAPES: Readonly<
  Record<string, { readonly length: number; readonly leaf?: readonly string[] }>
> = {
  fields: { length: 2 },
  resources: { length: 3, leaf: ['current', 'temporary'] },
  tracks: { length: 3 },
  conditions: { length: 2 },
  inventory: { length: 4, leaf: ['slot', 'name', 'size', 'removed'] },
  slots: { length: 3 },
  entries: { length: 4 },
};

function segmentsOf(path: unknown): readonly string[] | undefined {
  if (typeof path !== 'string') return undefined;
  const segments = path.split('.');
  const shape = SHAPES[segments[0] as string];
  if (shape === undefined || !Object.hasOwn(SHAPES, segments[0] as string)) return undefined;
  if (segments.length !== shape.length) return undefined;
  if (segments.some((segment) => !SEGMENT.test(segment) || FORBIDDEN.has(segment)))
    return undefined;
  if (shape.leaf !== undefined && !shape.leaf.includes(segments.at(-1) as string)) return undefined;
  return segments;
}

export function isOperationPath(path: unknown): boolean {
  return segmentsOf(path) !== undefined;
}

/** What a missing value reads as, so an empty target can receive any operation. */
function defaultFor(root: string): unknown {
  switch (root) {
    case 'resources':
    case 'conditions':
      return 0;
    case 'tracks':
      return false;
    case 'slots':
      return '';
    default:
      return undefined;
  }
}

function read(state: TargetState, segments: readonly string[]): unknown {
  let current: unknown = state;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
      return defaultFor(segments[0] as string);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function written(
  node: Readonly<Record<string, unknown>>,
  segments: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = segments as [string, ...string[]];
  if (rest.length === 0) return { ...node, [head]: value };
  const child = Object.hasOwn(node, head) ? node[head] : undefined;
  return {
    ...node,
    [head]: written(
      typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : {},
      rest,
      value,
    ),
  };
}

function isSettable(value: unknown): boolean {
  if (typeof value === 'string') return value.length <= MAX_TEXT;
  return typeof value === 'boolean' || Number.isSafeInteger(value);
}

function guardHolds(state: TargetState, guard: OperationGuard): boolean | undefined {
  const segments = segmentsOf(guard.path);
  if (segments === undefined) return undefined;
  const current = read(state, segments);
  return 'atLeast' in guard
    ? typeof current === 'number' && current >= guard.atLeast
    : current === guard.equals;
}

/**
 * Applies operations in order. All of them or a failure: nothing is partially applied, since the input is
 * never changed. A delta on a missing number starts from 0.
 */
export function applyPlannedOperations(
  state: TargetState,
  operations: readonly PlannedOperation[],
): Result<AppliedOperations, ApplyFailure> {
  let next: TargetState = state;
  const touched = new Map<string, { path: string; before: unknown }>();
  for (const { operation, requires } of operations) {
    const segments = segmentsOf(operation.path);
    if (segments === undefined) return err({ code: 'invalid_path', path: String(operation.path) });
    if (requires !== undefined) {
      const holds = guardHolds(next, requires);
      if (holds === undefined) return err({ code: 'invalid_path', path: requires.path });
      if (!holds) return err({ code: 'target_changed', path: requires.path });
    }
    const current = read(next, segments);
    if (!touched.has(operation.path)) {
      touched.set(operation.path, { path: operation.path, before: current ?? null });
    }
    let value: unknown;
    if (operation.op === 'set') {
      if (!isSettable(operation.value)) return err({ code: 'invalid_value', path: operation.path });
      value = operation.value;
    } else {
      if (typeof current !== 'number' && current !== undefined) {
        return err({ code: 'invalid_value', path: operation.path });
      }
      const base = current ?? 0;
      if (operation.op === 'delta') {
        value = base + operation.value;
      } else {
        value = Math.min(
          operation.max ?? Number.POSITIVE_INFINITY,
          Math.max(operation.min ?? Number.NEGATIVE_INFINITY, base),
        );
      }
      if (!Number.isSafeInteger(value)) return err({ code: 'invalid_value', path: operation.path });
      value = value === 0 ? 0 : value;
    }
    next = written(
      next as unknown as Record<string, unknown>,
      segments,
      value,
    ) as unknown as TargetState;
  }
  const changes = [...touched.values()].map(({ path, before }) => ({
    path,
    before,
    after: read(next, segmentsOf(path) as readonly string[]) ?? null,
  }));
  return ok({ state: next, changes });
}

/**
 * The target as displayed (D-11): the owner's replica plus applications the authority has not accepted,
 * oldest first. One the authority would refuse is skipped here too, so the display never shows a state
 * that cannot exist. Accepted applications are already inside `base`.
 */
export function projectTargetState(
  base: TargetState,
  pending: readonly {
    readonly operations: readonly PlannedOperation[];
    readonly appliedAt: string;
    readonly id: string;
  }[],
): TargetState {
  const ordered = [...pending].sort(
    (left, right) =>
      left.appliedAt.localeCompare(right.appliedAt) || left.id.localeCompare(right.id),
  );
  let state = base;
  for (const application of ordered) {
    const applied = applyPlannedOperations(state, application.operations);
    if (applied.ok) state = applied.value.state;
  }
  return state;
}
