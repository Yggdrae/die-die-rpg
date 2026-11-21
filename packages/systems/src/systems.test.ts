import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITY_KEYS } from '@rpg/contracts';
import { type ExpressionValidators, loadSystemPackage, type PackageLoadCode } from './load.ts';
import { aspectSystem, slotSystem } from './paradigms.test-support.ts';
import { hasCapability, SystemRegistry, systemDefinitionOf, systemSummaryOf } from './registry.ts';
import type { SystemPackage } from './schema.ts';
import { runConformance } from './testing/conformance.ts';

// biome-ignore lint/suspicious/noExplicitAny: these tests deliberately write outside the contract
type Mutable = Record<string, any>;

function broken(
  change: (system: Mutable) => void,
  base: () => SystemPackage = slotSystem,
): unknown {
  const system = structuredClone(base()) as Mutable;
  change(system);
  return system;
}

function errorsOf(candidate: unknown, validators?: ExpressionValidators) {
  const loaded = loadSystemPackage(candidate, validators);
  if (loaded.ok) throw new Error('expected the package to be rejected');
  return loaded.error;
}

function expectRejected(candidate: unknown, code: PackageLoadCode, path: string) {
  const errors = errorsOf(candidate);
  expect(errors.map((error) => `${error.code} ${error.path}`)).toContain(`${code} ${path}`);
}

describe('validation at load', () => {
  test('both paradigms load', () => {
    expect(loadSystemPackage(slotSystem()).ok).toBe(true);
    expect(loadSystemPackage(aspectSystem()).ok).toBe(true);
  });

  const INVALID: readonly [string, (system: Mutable) => void, PackageLoadCode, string][] = [
    ['a missing block', (s) => delete s.resources, 'schema', '/resources'],
    ['an unknown property', (s) => (s.manifest.surprise = 1), 'schema', '/manifest/surprise'],
    [
      'an unknown property inside a union branch',
      (s) => (s.resources[0].current = 3),
      'schema',
      '/resources/0/current',
    ],
    [
      'a capability outside the set',
      (s) => s.capabilities.push('hit_points'),
      'schema',
      '/capabilities/6',
    ],
    [
      'a field naming an undeclared resource',
      (s) => (s.characterSchema.fields[4].resourceKey = 'nope'),
      'unknown_reference',
      '/characterSchema/fields/4/resourceKey',
    ],
    [
      'an inventory field naming nothing',
      (s) => (s.characterSchema.fields[6].inventoryKey = 'nope'),
      'unknown_reference',
      '/characterSchema/fields/6/inventoryKey',
    ],
    [
      'an action reading an undeclared field',
      (s) => (s.actions[0].inputs = ['MISSING']),
      'unknown_reference',
      '/actions/0/inputs/0',
    ],
    [
      'a summary naming an undeclared field',
      (s) => s.characterSchema.summaryFields.push('MISSING'),
      'unknown_reference',
      '/characterSchema/summaryFields/2',
    ],
    [
      'a section referencing nothing',
      (s) => (s.rules.sections[0].references = ['nope']),
      'unknown_reference',
      '/rules/sections/0/references/0',
    ],
    [
      'two fields with one key',
      (s) => (s.characterSchema.fields[1].key = 'name'),
      'duplicate_key',
      '/characterSchema/fields/1/key',
    ],
    [
      'a default outside the constraints',
      (s) => (s.characterSchema.fields[1].default = 99),
      'out_of_range',
      '/characterSchema/fields/1/default',
    ],
    [
      'min above max on a field',
      (s) => (s.characterSchema.fields[1].min = 19),
      'out_of_range',
      '/characterSchema/fields/1/min',
    ],
    [
      'min above max on a resource',
      (s) => {
        s.resources[0].min = 5;
        s.resources[0].max = 1;
      },
      'out_of_range',
      '/resources/0/min',
    ],
    [
      'a bad licence permission',
      (s) => (s.manifest.license.assets.officialLogo = 'sure'),
      'schema',
      '/manifest/license/assets/officialLogo',
    ],
    [
      'a bad system identifier',
      (s) => (s.manifest.ref.systemId = 'Not Valid'),
      'schema',
      '/manifest/ref/systemId',
    ],
    [
      'a bad version',
      (s) => (s.manifest.ref.version = 'latest'),
      'schema',
      '/manifest/ref/version',
    ],
    ['no game mode', (s) => (s.gameModes = []), 'schema', '/gameModes'],
  ];
  for (const [name, change, code, path] of INVALID) {
    test(`rejects ${name}`, () => expectRejected(broken(change), code, path));
  }

  test('a ladder must strictly increase', () => {
    expectRejected(
      broken((s) => (s.mechanics.ladders[0].steps[1].value = 0), aspectSystem),
      'out_of_range',
      '/mechanics/ladders/0/steps/1/value',
    );
  });

  test('every error is reported, not only the first', () => {
    const errors = errorsOf(
      broken((s) => {
        s.characterSchema.fields[1].key = 'name';
        s.actions[0].inputs = ['MISSING'];
      }),
    );
    expect(new Set(errors.map((error) => error.code))).toEqual(
      new Set(['duplicate_key', 'unknown_reference']),
    );
  });

  test('a loaded package is a frozen copy at every depth', () => {
    const source = slotSystem();
    const loaded = loadSystemPackage(source);
    if (!loaded.ok) throw new Error('rejected');
    expect(Object.isFrozen(loaded.value.manifest.license.assets)).toBe(true);
    expect(() => {
      (loaded.value.manifest.ref as Mutable).version = '9.9.9';
    }).toThrow();
    source.manifest.name = 'Changed afterwards';
    expect(loaded.value.manifest.name).toBe('Slot Delve');
  });
});

describe('no executable content', () => {
  test('strings that look like code stay inert text', () => {
    let ran = false;
    (globalThis as Mutable).__systemsTestRan = () => {
      ran = true;
    };
    const loaded = loadSystemPackage(
      broken((s) => {
        s.manifest.shortDescription = 'globalThis.__systemsTestRan()';
        s.actions[0].roll.dice = 'globalThis.__systemsTestRan()';
        s.actions[0].success.formula = '(() => globalThis.__systemsTestRan())()';
      }),
    );
    expect(loaded.ok).toBe(true);
    expect(ran).toBe(false);
    delete (globalThis as Mutable).__systemsTestRan;
  });

  const NOT_DATA: readonly [string, unknown][] = [
    ['a function', () => 1],
    ['a symbol', Symbol('x')],
    ['a class instance', new Date()],
    ['undefined', undefined],
    ['a non-finite number', Number.POSITIVE_INFINITY],
    ['a bigint', 1n],
  ];
  for (const [name, value] of NOT_DATA) {
    test(`refuses ${name}`, () => {
      const candidate = slotSystem() as Mutable;
      candidate.manifest = { ...candidate.manifest, name: value };
      expectRejected(candidate, 'not_plain_data', '/manifest/name');
    });
  }

  test('an accessor is refused without ever being invoked', () => {
    let reads = 0;
    const candidate = slotSystem() as Mutable;
    const manifest = { ...candidate.manifest };
    Object.defineProperty(manifest, 'name', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'x';
      },
    });
    candidate.manifest = manifest;
    expectRejected(candidate, 'not_plain_data', '/manifest/name');
    expect(reads).toBe(0);
  });

  test('symbol keys, array holes, and cycles are refused', () => {
    const withSymbol = slotSystem() as Mutable;
    withSymbol.manifest = { ...withSymbol.manifest, [Symbol('x')]: 1 };
    expectRejected(withSymbol, 'not_plain_data', '/manifest');

    const withHole = slotSystem() as Mutable;
    // biome-ignore lint/suspicious/noSparseArray: the defect under test
    withHole.gameModes = [, { id: 'x', label: 'X' }];
    expectRejected(withHole, 'not_plain_data', '/gameModes/0');

    const cyclic = slotSystem() as Mutable;
    cyclic.manifest = { ...cyclic.manifest, self: cyclic };
    expectRejected(cyclic, 'not_plain_data', '/manifest/self');
  });

  test('a value nested past the limit is refused', () => {
    let deep: unknown = 'end';
    for (let index = 0; index < 20; index += 1) deep = { nested: deep };
    const candidate = slotSystem() as Mutable;
    candidate.manifest = { ...candidate.manifest, deep };
    expect(errorsOf(candidate)[0]?.code).toBe('not_plain_data');
  });

  test('a package over the size limit is refused', () => {
    const candidate = slotSystem() as Mutable;
    candidate.manifest.shortDescription = 'x'.repeat(1024 * 1024 + 1);
    expectRejected(candidate, 'not_plain_data', '');
  });

  test('prototype keys are refused and shared prototypes stay clean', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const candidate = JSON.parse(
        JSON.stringify(slotSystem()).replace(
          '"manifest":{',
          `"manifest":{"${key}":{"polluted":1},`,
        ),
      );
      expectRejected(candidate, 'not_plain_data', `/manifest/${key}`);
    }
    expect(({} as Mutable).polluted).toBeUndefined();
  });

  test('the package source evaluates nothing', () => {
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (!entry.includes('.test')) files.push(path);
      }
    };
    walk(import.meta.dir);
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\beval\s*\(|new\s+Function\b|\bimport\s*\(/);
    }
  });
});

describe('capabilities', () => {
  test('a generic consumer gets its answer from the declaration alone', () => {
    const slots = slotSystem();
    const aspects = aspectSystem();
    expect(hasCapability(slots, 'inventory_slots')).toBe(true);
    expect(hasCapability(aspects, 'inventory_slots')).toBe(false);
    expect(hasCapability(slots, 'resource_tracks')).toBe(false);
    expect(hasCapability(aspects, 'resource_tracks')).toBe(true);
  });

  test('every key has a documented meaning', () => {
    for (const [key, meaning] of Object.entries(CAPABILITY_KEYS)) {
      expect(key).toMatch(/^[a-z_]+$/);
      expect(meaning.length).toBeGreaterThan(10);
    }
  });

  test('a claim without a declaration, and a declaration without a claim, are refused', () => {
    const claimed = errorsOf(broken((s) => s.capabilities.push('rating_ladders')));
    expect(claimed.map((error) => error.code)).toContain('capability_mismatch');
    expect(claimed.map((error) => error.message).join()).toContain('rating_ladders');

    const unclaimed = errorsOf(
      broken((s) => {
        s.capabilities = s.capabilities.filter((key: string) => key !== 'conditions');
      }),
    );
    expect(unclaimed.map((error) => error.message).join()).toContain('conditions');
  });

  test('turn order is a pure claim with no block', () => {
    expect(loadSystemPackage(broken((s) => s.capabilities.push('turn_order'))).ok).toBe(true);
  });
});

describe('declared mechanics', () => {
  test('a pool and a box track are each their own shape', () => {
    const [favor, strain] = aspectSystem().resources;
    expect(favor?.shape).toBe('pool');
    expect(strain?.shape).toBe('track');
    expectRejected(
      broken((s) => (s.resources[1].max = 2), aspectSystem),
      'schema',
      '/resources/1/max',
    );
  });

  test('free text is not an enumeration; entry types and slots are declared', () => {
    const truths = aspectSystem().characterSchema.fields.find((field) => field.key === 'truths');
    expect(truths?.type === 'repeater' && truths.entryTypes?.map((type) => type.id)).toEqual([
      'core',
      'situation',
    ]);
    expectRejected(
      broken((s) => (s.characterSchema.fields[1].entryTypes[1].id = 'core'), aspectSystem),
      'duplicate_key',
      '/characterSchema/fields/1/entryTypes/1/id',
    );
  });

  test('without validators, expressions stay text; with them, a bad one refuses the package', () => {
    const seen: string[] = [];
    const validators: ExpressionValidators = {
      dice: (source) => {
        seen.push(source);
        return source === '1d20' ? undefined : 'bad dice';
      },
      formula: (source) => (source.includes('roll') ? undefined : 'bad formula'),
      effect: (kind) => (kind === 'forbidden' ? 'bad effect' : undefined),
    };
    const candidate = broken((s) => {
      s.actions[1].roll.dice = '1d20';
      s.resources[0].max = { formula: 'level + 3 + roll' };
      s.actions[1].outcomes[0].resolution.effects[0].params.amount.formula = 'roll';
      s.actions[1].outcomes[1].resolution.effects[0].params.dice = 'not an expression';
    });
    expect(loadSystemPackage(candidate, validators).ok).toBe(true);
    expect(seen).not.toContain('not an expression');

    const errors = errorsOf(
      broken((s) => {
        s.actions[0].roll.dice = '1d21';
        s.actions[1].outcomes[1].resolution.effects[0].effect = 'forbidden';
      }),
      validators,
    );
    const codes = errors.filter((error) => error.code === 'invalid_expression');
    expect(codes.map((error) => error.path)).toContain('/actions/0/roll');
    expect(codes.map((error) => error.message)).toContain('bad effect');
  });

  test('a table choice is marked as one, so nothing applies automatically', () => {
    const [attack] = aspectSystem().actions;
    expect(attack?.outcomes[0]?.resolution.mode).toBe('choice');
  });
});

describe('licence and integration', () => {
  test('integrated rules text is refused when the licence does not allow it', () => {
    for (const permission of ['forbidden', 'review-required']) {
      const errors = errorsOf(
        broken((s) => {
          s.manifest.license.assets.rulesText = permission;
        }),
      );
      expect(errors.map((error) => `${error.code} ${error.path}`)).toEqual(
        expect.arrayContaining([
          'license_contradiction /manifest/integration/rulesTextIntegrated',
          'license_contradiction /rules/sections',
        ]),
      );
    }
  });

  test('integration status must match what ships', () => {
    expectRejected(
      broken((s) => (s.manifest.integration.compendiumIntegrated = true)),
      'integration_mismatch',
      '/manifest/integration/compendiumIntegrated',
    );
    expectRejected(
      broken((s) => (s.rules.sections[0].body = undefined)),
      'not_plain_data',
      '/rules/sections/0/body',
    );
    expectRejected(
      broken((s) => {
        delete s.rules.sections[0].body;
        s.capabilities = s.capabilities.filter((key: string) => key !== 'integrated_rules');
      }),
      'integration_mismatch',
      '/manifest/integration/rulesTextIntegrated',
    );
  });

  test('a quick rule is rules text: it alone integrates, and the licence gates it (feature 14 D-05)', () => {
    const quickOnly = broken((s) => {
      s.rules.sections = s.rules.sections.map((section: Record<string, unknown>) => {
        const { body: _body, ...rest } = section;
        return rest;
      });
      s.rules.sections[0].summary = 'A short quick rule.';
    });
    expect(loadSystemPackage(quickOnly).ok).toBe(true);
    const forbidden = broken((s) => {
      s.rules.sections = s.rules.sections.map((section: Record<string, unknown>) => {
        const { body: _body, ...rest } = section;
        return rest;
      });
      s.rules.sections[0].summary = 'A short quick rule.';
      s.manifest.license.assets.rulesText = 'forbidden';
    });
    expect(errorsOf(forbidden).map((error) => `${error.code} ${error.path}`)).toEqual(
      expect.arrayContaining(['license_contradiction /rules/sections']),
    );
    expectRejected(
      broken((s) => (s.rules.sections[0].summary = 'x'.repeat(501))),
      'schema',
      '/rules/sections/0/summary',
    );
  });

  test('documentation status comes from integration, never from a separate claim', () => {
    expect(systemSummaryOf(slotSystem()).documentationStatus).toBe('integrated');
    expect(systemSummaryOf(aspectSystem()).documentationStatus).toBe('external');
    const none = broken((s) => delete s.manifest.integration.externalDocumentation, aspectSystem);
    expect(systemSummaryOf(none as SystemPackage).documentationStatus).toBe('unavailable');
  });
});

describe('registry versions', () => {
  const version = (value: string, name = 'Slot Delve') =>
    broken((s) => {
      s.manifest.ref.version = value;
      s.manifest.name = name;
    });

  test('versions are served side by side; the list shows the numerically highest once', () => {
    const registry = new SystemRegistry();
    for (const value of ['1.0.0', '1.9.0', '1.10.0']) registry.load(version(value));
    registry.load(aspectSystem());
    expect(
      registry.resolve({ systemId: 'slot-delve', version: '1.0.0' })?.manifest.ref.version,
    ).toBe('1.0.0');
    expect(registry.list().map((system) => system.manifest.ref)).toEqual([
      { systemId: 'slot-delve', version: '1.10.0' },
      { systemId: 'aspect-tale', version: '2.1.0' },
    ]);
  });

  test('an unknown reference is not installed, never another version', () => {
    const registry = new SystemRegistry();
    registry.load(slotSystem());
    expect(registry.resolve({ systemId: 'slot-delve', version: '1.0.1' })).toBeUndefined();
    expect(registry.resolve({ systemId: 'other', version: '1.0.0' })).toBeUndefined();
  });

  test('other content under a published version is a conflict; the original stays', () => {
    const registry = new SystemRegistry();
    registry.load(slotSystem());
    const conflict = registry.load(version('1.0.0', 'Tampered'));
    expect(conflict.ok).toBe(false);
    expect(!conflict.ok && conflict.error[0]?.code).toBe('version_conflict');
    expect(registry.resolve({ systemId: 'slot-delve', version: '1.0.0' })?.manifest.name).toBe(
      'Slot Delve',
    );
  });

  test('the same content again, whatever its key order, is no conflict', () => {
    const registry = new SystemRegistry();
    const first = registry.load(slotSystem());
    const source = slotSystem();
    const reversed = (value: object) => Object.fromEntries(Object.entries(value).reverse());
    const reordered = { ...reversed(source), manifest: reversed(source.manifest) };
    const again = registry.load(reordered);
    expect(again.ok).toBe(true);
    expect(first.ok && again.ok && first.value === again.value).toBe(true);
  });

  test('one bad package never takes the others down', () => {
    const registry = new SystemRegistry();
    const report = registry.loadAll([
      slotSystem(),
      broken((s) => delete s.manifest),
      aspectSystem(),
    ]);
    expect(report.loaded.map((ref) => ref.systemId)).toEqual(['slot-delve', 'aspect-tale']);
    expect(report.rejected.map((entry) => entry.index)).toEqual([1]);
    expect(report.rejected[0]?.errors[0]?.path).toBe('/manifest');
    expect(registry.list()).toHaveLength(2);
  });

  test('a consumer cannot change what the registry serves next', () => {
    const registry = new SystemRegistry();
    registry.load(slotSystem());
    const served = registry.resolve({ systemId: 'slot-delve', version: '1.0.0' }) as Mutable;
    expect(() => {
      served.manifest.name = 'Changed';
    }).toThrow();
    const definition = systemDefinitionOf(served as SystemPackage);
    definition.gameModes[0] = { id: 'changed', label: 'Changed' };
    expect(registry.resolve({ systemId: 'slot-delve', version: '1.0.0' })?.gameModes[0]?.id).toBe(
      'standard',
    );
  });
});

describe('conformance kit', () => {
  test('both paradigms pass every check', () => {
    for (const system of [slotSystem(), aspectSystem()]) {
      const report = runConformance(system);
      expect(report.checks.filter((check) => !check.passed)).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.checks.length).toBeGreaterThanOrEqual(11);
    }
  });

  const FAILS: readonly [string, (system: Mutable) => void, string][] = [
    ['pure declarative data', (s) => (s.manifest.name = () => 'x'), '/manifest/name'],
    ['matches the contract', (s) => (s.surprise = 1), '/surprise'],
    ['keys are unique', (s) => (s.gameModes[1] = s.gameModes[0]), '/gameModes/1/id'],
    ['references resolve', (s) => (s.actions[0].inputs = ['MISSING']), '/actions/0/inputs/0'],
    [
      'defaults and ranges hold',
      (s) => (s.characterSchema.fields[1].default = 99),
      '/characterSchema/fields/1/default',
    ],
    ['capabilities match declarations', (s) => s.capabilities.push('compendium'), '/capabilities'],
    [
      'licence permits what ships',
      (s) => (s.manifest.license.assets.rulesText = 'forbidden'),
      '/rules/sections',
    ],
    [
      'integration status is honest',
      (s) => (s.manifest.integration.compendiumIntegrated = true),
      '/manifest/integration/compendiumIntegrated',
    ],
  ];
  for (const [name, change, path] of FAILS) {
    test(`names the failed check: ${name}`, () => {
      const candidate = slotSystem() as Mutable;
      candidate.gameModes = [...candidate.gameModes, { id: 'second', label: 'Second' }];
      const source = structuredClone({ ...candidate }) as Mutable;
      change(source);
      const report = runConformance(source);
      expect(report.passed).toBe(false);
      const check = report.checks.find((entry) => entry.name === name);
      expect(check?.passed).toBe(false);
      expect(check?.failures.map((failure) => failure.path)).toContain(path);
    });
  }

  test('the kit knows no system', () => {
    const source = readFileSync(join(import.meta.dir, 'testing', 'conformance.ts'), 'utf8');
    // Real system identifiers are the guard's `no-system-identity`, which covers this package.
    for (const id of ['slot-delve', 'aspect-tale']) {
      expect(source.toLowerCase()).not.toContain(id);
    }
  });
});
