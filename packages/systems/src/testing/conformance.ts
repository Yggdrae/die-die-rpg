import { Value } from '@sinclair/typebox/value';
import { type ExpressionValidators, loadSystemPackage, type PackageLoadCode } from '../load.ts';
import { canonicalJson } from '../plain-data.ts';
import { systemDefinitionOf, systemSummaryOf } from '../registry.ts';
import { SystemDefinition, SystemSummary } from '../schema.ts';

/**
 * What any system package must satisfy (FR-013). Packages run it; it knows none of them, and asserts
 * nothing about any particular system's content.
 */

export interface ConformanceCheck {
  readonly name: string;
  readonly passed: boolean;
  /** JSON pointers to what failed, with why. */
  readonly failures: readonly { readonly path: string; readonly message: string }[];
}

export interface ConformanceReport {
  readonly passed: boolean;
  readonly checks: readonly ConformanceCheck[];
}

const CODE_CHECKS: readonly {
  readonly name: string;
  readonly codes: readonly PackageLoadCode[];
}[] = [
  { name: 'pure declarative data', codes: ['not_plain_data'] },
  { name: 'matches the contract', codes: ['schema'] },
  { name: 'keys are unique', codes: ['duplicate_key'] },
  { name: 'references resolve', codes: ['unknown_reference'] },
  { name: 'defaults and ranges hold', codes: ['out_of_range'] },
  { name: 'capabilities match declarations', codes: ['capability_mismatch'] },
  { name: 'licence permits what ships', codes: ['license_contradiction'] },
  { name: 'integration status is honest', codes: ['integration_mismatch'] },
  {
    name: 'expressions are valid',
    codes: ['invalid_expression', 'formula_cycle', 'invalid_effect'],
  },
];

/** Features 12 and 13 pass the real engines' validators, so a bad expression fails the kit too. */
export function runConformance(
  candidate: unknown,
  validators: ExpressionValidators = {},
): ConformanceReport {
  const loaded = loadSystemPackage(candidate, validators);
  const errors = loaded.ok ? [] : loaded.error;
  const checks: ConformanceCheck[] = CODE_CHECKS.map(({ name, codes }) => {
    const failures = errors
      .filter((error) => codes.includes(error.code))
      .map(({ path, message }) => ({ path, message }));
    return { name, passed: failures.length === 0, failures };
  });
  if (loaded.ok) {
    const check = (name: string, path: string, message: string, passed: boolean) =>
      checks.push({ name, passed, failures: passed ? [] : [{ path, message }] });
    check(
      'survives a JSON round trip',
      '',
      'The package holds a value JSON does not preserve.',
      canonicalJson(JSON.parse(JSON.stringify(loaded.value))) === canonicalJson(loaded.value),
    );
    check(
      'derives a valid summary',
      '/manifest',
      'The summary feature 02 reads does not validate.',
      Value.Check(SystemSummary, systemSummaryOf(loaded.value)),
    );
    check(
      'derives a valid campaign definition',
      '/manifest',
      'The definition the creation wizard reads does not validate.',
      Value.Check(SystemDefinition, systemDefinitionOf(loaded.value)),
    );
  }
  return { passed: checks.every((check) => check.passed), checks };
}
