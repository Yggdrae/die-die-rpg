import { describe, expect, test } from 'bun:test';
import {
  checkFile,
  noDeepPackageImports,
  noPackageToAppImports,
  noSystemIdentity,
} from './rules.ts';

/**
 * Every rule is demonstrated failing against a deliberately violating fixture.
 * A guard that has never failed has not been tested (task 09).
 */

describe('rule: no-system-identity', () => {
  test('FAILS on a branch over a system id', () => {
    const violations = noSystemIdentity({
      path: 'apps/web/src/CharacterSheet.tsx',
      content: `
        export function sheet(system: { id: string }) {
          if (system.id === 'cairn-2e') {
            return renderCairnSheet();
          }
          return renderDefault();
        }
      `,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-system-identity');
    // The message must name the alternative, not only report a violation.
    expect(violations[0]?.remedy).toContain('system.capabilities');
  });

  test('FAILS on a lookup table keyed by system', () => {
    const violations = noSystemIdentity({
      path: 'packages/sheet-engine/src/layouts.ts',
      content: `const layouts = { 'fate-core': fateLayout, 'cairn': cairnLayout };`,
    });

    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  test('PASSES on capability-driven code', () => {
    const violations = noSystemIdentity({
      path: 'apps/web/src/CharacterSheet.tsx',
      content: `
        export function sheet(system: { capabilities: string[] }) {
          return system.capabilities.includes('inventory-slots') ? withSlots() : plain();
        }
      `,
    });

    expect(violations).toEqual([]);
  });

  test('PASSES when a system is named in prose, not in code', () => {
    const violations = noSystemIdentity({
      path: 'apps/web/src/CharacterSheet.tsx',
      content: `
        // Validated against cairn and fate-core in wave 3.
        /* Neither cairn nor fate-core may be named below this line. */
        export const sheet = () => null;
      `,
    });

    expect(violations).toEqual([]);
  });

  test('PASSES inside systems/, which is where a system may name itself', () => {
    const violations = noSystemIdentity({
      path: 'systems/cairn/src/manifest.ts',
      content: `export const manifest = { systemId: 'cairn-2e', version: '1.0.0' };`,
    });

    expect(violations).toEqual([]);
  });
});

describe('rule: no-deep-package-imports', () => {
  test('FAILS on reaching into another package src', () => {
    const violations = noDeepPackageImports({
      path: 'apps/web/src/Session.tsx',
      content: `import { secret } from '@rpg/contracts/src/internal/secret.ts';`,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-deep-package-imports');
  });

  test('PASSES on importing a package entry point', () => {
    const violations = noDeepPackageImports({
      path: 'apps/web/src/Session.tsx',
      content: `import { EntityEnvelope } from '@rpg/contracts';`,
    });

    expect(violations).toEqual([]);
  });

  test('PASSES on a declared subpath export', () => {
    const violations = noDeepPackageImports({
      path: 'apps/web/src/Session.test.tsx',
      content: `import { InMemoryRepository } from '@rpg/contracts/testing';`,
    });

    expect(violations).toEqual([]);
  });
});

describe('rule: no-package-to-app-imports', () => {
  test('FAILS when a package imports an app', () => {
    const violations = noPackageToAppImports({
      path: 'packages/contracts/src/entity.ts',
      content: `import { buildApp } from '@rpg/api';`,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-package-to-app-imports');
  });

  test('FAILS on a relative climb into apps', () => {
    const violations = noPackageToAppImports({
      path: 'packages/fixtures/src/index.ts',
      content: `import { App } from '../../apps/web/src/App.tsx';`,
    });

    expect(violations).toHaveLength(1);
  });

  test('PASSES when an app imports a package', () => {
    const violations = noPackageToAppImports({
      path: 'apps/api/src/app.ts',
      content: `import { ApiError } from '@rpg/contracts';`,
    });

    expect(violations).toEqual([]);
  });
});

describe('checkFile', () => {
  test('reports violations from every rule at once', () => {
    const violations = checkFile({
      path: 'packages/sheet-engine/src/bad.ts',
      content: `
        import { buildApp } from '@rpg/api';
        import { x } from '@rpg/contracts/src/internal.ts';
        export const layout = { 'cairn-2e': 1 };
      `,
    });

    const rules = new Set(violations.map((violation) => violation.rule));
    expect(rules).toEqual(
      new Set(['no-system-identity', 'no-deep-package-imports', 'no-package-to-app-imports']),
    );
  });
});
