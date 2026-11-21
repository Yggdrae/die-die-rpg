import { err, ok, type Result } from '@rpg/contracts';
import { type ValueError, ValueErrorType } from '@sinclair/typebox/errors';
import { Value } from '@sinclair/typebox/value';
import { deepFreeze, plainDataIssues } from './plain-data.ts';
import { SystemPackage } from './schema.ts';
import { type SemanticCode, semanticIssues } from './semantics.ts';

export type PackageLoadCode =
  | 'not_plain_data'
  | 'schema'
  | SemanticCode
  | 'invalid_expression'
  | 'formula_cycle'
  | 'invalid_effect'
  | 'version_conflict';

/** `path` is a JSON pointer into the package. */
export interface PackageLoadError {
  readonly code: PackageLoadCode;
  readonly path: string;
  readonly message: string;
}

/**
 * How features 09, 10, and 11 refuse a bad expression at load, without this package depending on
 * them. Each returns an error message, or `undefined` when the source is valid.
 */
export interface ExpressionValidators {
  readonly dice?: (source: string) => string | undefined;
  readonly formula?: (source: string) => string | undefined;
  readonly effect?: (kind: string) => string | undefined;
  /** Feature 10: one entry per dependency cycle among formulas that share a namespace. */
  readonly formulaCycles?: (
    nodes: readonly { readonly key: string; readonly source: string }[],
  ) => readonly { readonly key: string; readonly message: string }[];
  /** Feature 11: what a package's effects imply across its declarations. */
  readonly effects?: (
    system: SystemPackage,
  ) => readonly { readonly path: string; readonly message: string }[];
}

const DISCRIMINATORS = new Set(['type', 'shape', 'mode']);

/** A union error alone says only "no branch matched"; report the branch the value meant. */
function flatten(error: ValueError): readonly ValueError[] {
  if (error.type !== ValueErrorType.Union || error.errors.length === 0) return [error];
  const branches = error.errors.map((branch) => [...branch]);
  const meant = branches.find(
    (branch) =>
      !branch.some(
        (nested) =>
          nested.path.startsWith(`${error.path}/`) &&
          DISCRIMINATORS.has(nested.path.slice(error.path.length + 1)),
      ),
  );
  const closest = meant ?? [...branches].sort((left, right) => left.length - right.length)[0] ?? [];
  const flattened = closest.flatMap(flatten);
  return flattened.length === 0 ? [error] : flattened;
}

function expressionIssues(
  value: unknown,
  path: string,
  validators: ExpressionValidators,
): readonly PackageLoadError[] {
  if (value === null || typeof value !== 'object') return [];
  const found: PackageLoadError[] = [];
  const entry = value as Record<string, unknown>;
  const refuse = (message: string | undefined) => {
    if (message !== undefined) found.push({ code: 'invalid_expression', path, message });
  };
  if (typeof entry.dice === 'string') refuse(validators.dice?.(entry.dice));
  if (typeof entry.formula === 'string') refuse(validators.formula?.(entry.formula));
  if (typeof entry.effect === 'string') refuse(validators.effect?.(entry.effect));
  for (const [key, nested] of Object.entries(entry)) {
    if (key === 'params' && typeof nested === 'object' && nested !== null) {
      // Argument names are the package's own: one called `dice` is not a dice expression.
      for (const [name, argument] of Object.entries(nested)) {
        found.push(...expressionIssues(argument, `${path}/params/${name}`, validators));
      }
    } else {
      found.push(...expressionIssues(nested, `${path}/${key}`, validators));
    }
  }
  return found;
}

interface FormulaNode {
  readonly key: string;
  readonly source: string;
  readonly path: string;
}

/**
 * Named formulas by namespace. A sheet's fields, resources, and inventory read each other by key; the
 * fields inside a repeater entry read each other and form a namespace of their own.
 */
function formulaNamespaces(system: SystemPackage): readonly (readonly FormulaNode[])[] {
  const shared: FormulaNode[] = [];
  const namespaces: FormulaNode[][] = [shared];
  system.characterSchema.fields.forEach((field, index) => {
    const path = `/characterSchema/fields/${index}`;
    if (field.type === 'computed') {
      shared.push({ key: field.key, source: field.value.formula, path: `${path}/value` });
    }
    if (field.type === 'repeater') {
      namespaces.push(
        field.of.flatMap((nested, nestedIndex) =>
          nested.type === 'computed'
            ? [
                {
                  key: nested.key,
                  source: nested.value.formula,
                  path: `${path}/of/${nestedIndex}/value`,
                },
              ]
            : [],
        ),
      );
    }
  });
  system.resources.forEach((resource, index) => {
    if (resource.shape === 'pool' && typeof resource.max === 'object') {
      shared.push({
        key: resource.key,
        source: resource.max.formula,
        path: `/resources/${index}/max`,
      });
    }
  });
  const inventory = system.mechanics.inventory;
  if (inventory !== undefined && typeof inventory.capacity === 'object') {
    shared.push({
      key: inventory.key,
      source: inventory.capacity.formula,
      path: '/mechanics/inventory/capacity',
    });
  }
  return namespaces;
}

function cycleIssues(
  system: SystemPackage,
  validators: ExpressionValidators,
): readonly PackageLoadError[] {
  if (validators.formulaCycles === undefined) return [];
  const check = validators.formulaCycles;
  return formulaNamespaces(system).flatMap((nodes) =>
    check(nodes.map(({ key, source }) => ({ key, source }))).map(({ key, message }) => ({
      code: 'formula_cycle' as const,
      path: nodes.find((node) => node.key === key)?.path ?? '',
      message,
    })),
  );
}

/**
 * The only way untrusted content becomes a package (`PRD.md` s.16, s.75): all of it or none of it,
 * every error reported, nothing evaluated. The result is a frozen copy the caller cannot change.
 */
export function loadSystemPackage(
  candidate: unknown,
  validators: ExpressionValidators = {},
): Result<SystemPackage, readonly PackageLoadError[]> {
  const plain = plainDataIssues(candidate);
  if (plain.length > 0) {
    return err(plain.map((issue) => ({ code: 'not_plain_data', ...issue })));
  }
  const copy: unknown = structuredClone(candidate);
  if (!Value.Check(SystemPackage, copy)) {
    return err(
      [...Value.Errors(SystemPackage, copy)].flatMap(flatten).map((error) => ({
        code: 'schema' as const,
        path: error.path,
        message: error.message,
      })),
    );
  }
  const errors: PackageLoadError[] = [
    ...semanticIssues(copy),
    ...expressionIssues(copy, '', validators),
    ...cycleIssues(copy, validators),
    ...(validators.effects?.(copy) ?? []).map(({ path, message }) => ({
      code: 'invalid_effect' as const,
      path,
      message,
    })),
  ];
  return errors.length > 0 ? err(errors) : ok(deepFreeze(copy));
}
