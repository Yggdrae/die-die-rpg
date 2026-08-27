/**
 * Architecture rules enforced by the build.
 *
 * Three rules, each traceable to a stated requirement. The guard cannot detect every
 * violation; it raises the cost of the obvious ones, which is enough to keep the pattern
 * visible in review (`.speckit/features/00-platform-foundation/tasks/task_09.md`).
 */

export interface SourceFile {
  /** Repository-relative, forward slashes. */
  readonly path: string;
  readonly content: string;
}

export interface Violation {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly remedy: string;
}

/**
 * Concrete system identifiers. Adding a system to the platform adds it here, which is the
 * point: the list should feel uncomfortable to grow.
 */
const SYSTEM_IDS = [
  'cairn',
  'fate-core',
  'fate-accelerated',
  'fate-condensed',
  'mausritter',
  'mork-borg',
  'morkborg',
  'pathfinder',
  'dnd',
  'srd-5e',
  'dragonbane',
  'year-zero',
  'forbidden-lands',
  'symbaroum',
];

/**
 * The guard's own test fixtures are deliberate violations. Exempt from every rule, and
 * the only global exemption there is. Adding a second one is a finding, not a fix.
 */
const GLOBAL_EXEMPT = ['tools/guard/'];

/**
 * Additionally permitted to name a system.
 *
 * `systems/` is where system packages live. `packages/fixtures` is permitted because its
 * job includes asserting that the fixture system is neither MVP system.
 */
const SYSTEM_ID_EXEMPT = [...GLOBAL_EXEMPT, 'systems/', 'packages/fixtures/'];

function isGloballyExempt(path: string): boolean {
  return GLOBAL_EXEMPT.some((prefix) => path.startsWith(prefix));
}

/** Remove comments so prose about Cairn is not mistaken for a branch on Cairn. */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_match, prefix: string) => prefix);
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/**
 * Rule 1 — no branch on system identity (`PRD.md` s.89).
 *
 * The central architectural criterion. A generic page reads `system.capabilities`; it
 * never asks which system this is. This is the rule most likely to be worked around under
 * deadline pressure in features 15, 18, and 19, so the message names the alternative.
 */
export function noSystemIdentity(file: SourceFile): Violation[] {
  if (SYSTEM_ID_EXEMPT.some((prefix) => file.path.startsWith(prefix))) {
    return [];
  }

  const code = stripComments(file.content);
  const violations: Violation[] = [];

  for (const systemId of SYSTEM_IDS) {
    const pattern = new RegExp(`['"\`]${systemId}[a-z0-9-]*['"\`]`, 'gi');
    for (const match of code.matchAll(pattern)) {
      violations.push({
        rule: 'no-system-identity',
        path: file.path,
        line: lineOf(code, match.index),
        message: `References the system identifier ${match[0]}.`,
        remedy:
          'Read system.capabilities instead. A generic screen must work with any conforming system (PRD.md s.89).',
      });
    }
  }

  return violations;
}

const IMPORT_PATTERN = /(?:from|import)\s+['"]([^'"]+)['"]/g;

/**
 * Rule 2 — a feature never imports internals of another package.
 *
 * A workspace package is reachable through its published entry points only. A deep path
 * into another package `src/` couples two features to each other rather than to a
 * contract (`.speckit/features/_index.md`, rules 1 and 2).
 */
export function noDeepPackageImports(file: SourceFile): Violation[] {
  if (isGloballyExempt(file.path)) {
    return [];
  }

  const violations: Violation[] = [];
  const owner = file.path.split('/').slice(0, 2).join('/');

  for (const match of file.content.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.startsWith('@rpg/')) {
      continue;
    }
    if (!specifier.includes('/src/')) {
      continue;
    }
    // A package reaching into its own source is not a cross-package violation.
    const targetPackage = specifier.split('/').slice(0, 2).join('/');
    if (owner.endsWith(targetPackage.replace('@rpg/', ''))) {
      continue;
    }

    violations.push({
      rule: 'no-deep-package-imports',
      path: file.path,
      line: lineOf(file.content, match.index),
      message: `Imports package internals: ${specifier}.`,
      remedy: 'Import the package entry point, or add what you need to its public contract.',
    });
  }

  return violations;
}

/**
 * Rule 3 — packages must not depend on applications.
 *
 * Dependencies point inward. `packages/contracts` in particular must not know about
 * Fastify, React, or any application (`docs/SPEC_GUIDELINE.md`, Architecture).
 */
export function noPackageToAppImports(file: SourceFile): Violation[] {
  if (isGloballyExempt(file.path) || !file.path.startsWith('packages/')) {
    return [];
  }

  const violations: Violation[] = [];
  for (const match of file.content.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined) {
      continue;
    }
    const importsApp =
      specifier.startsWith('@rpg/api') ||
      specifier.startsWith('@rpg/web') ||
      specifier.includes('../../apps/');
    if (!importsApp) {
      continue;
    }

    violations.push({
      rule: 'no-package-to-app-imports',
      path: file.path,
      line: lineOf(file.content, match.index),
      message: `Package imports an application: ${specifier}.`,
      remedy: 'Move the shared code into a package, or invert the dependency.',
    });
  }

  return violations;
}

export const RULES = [noSystemIdentity, noDeepPackageImports, noPackageToAppImports];

export function checkFile(file: SourceFile): Violation[] {
  return RULES.flatMap((rule) => rule(file));
}

export function checkAll(files: readonly SourceFile[]): Violation[] {
  return files.flatMap(checkFile);
}
