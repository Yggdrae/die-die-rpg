import type { CapabilityKey } from '@rpg/contracts';
import type { CharacterField, SystemPackage } from './schema.ts';

/**
 * What a schema cannot say: keys unique within a block, references that resolve, defaults within
 * their own constraints, claims that match declarations.
 */

export type SemanticCode =
  | 'duplicate_key'
  | 'unknown_reference'
  | 'out_of_range'
  | 'capability_mismatch'
  | 'license_contradiction'
  | 'integration_mismatch';

export interface SemanticIssue {
  readonly code: SemanticCode;
  readonly path: string;
  readonly message: string;
}

/** Every key names what must be declared for the claim to be true (techspec "Capabilities"). */
function capabilityEvidence(
  system: SystemPackage,
): Readonly<Record<CapabilityKey, boolean | null>> {
  const fields = system.characterSchema.fields;
  return {
    character_sheet: fields.length > 0,
    dice_rolls: system.actions.some((action) => action.roll !== undefined),
    resource_pools: system.resources.some((resource) => resource.shape === 'pool'),
    resource_tracks: system.resources.some((resource) => resource.shape === 'track'),
    spendable_points: system.resources.some((resource) => resource.spendable),
    conditions: system.mechanics.conditions.length > 0,
    inventory_slots: system.mechanics.inventory !== undefined,
    rating_ladders: system.mechanics.ladders.length > 0,
    freeform_entries: fields.some(
      (field) => field.type === 'repeater' && field.entryTypes !== undefined,
    ),
    outcome_choices: system.actions.some((action) =>
      action.outcomes.some((outcome) => outcome.resolution.mode === 'choice'),
    ),
    integrated_rules: system.rules.sections.some(
      (section) => section.body !== undefined || section.summary !== undefined,
    ),
    compendium: system.compendiums.length > 0,
    // How a generic tracker behaves; declares no block of its own.
    turn_order: null,
  };
}

export function semanticIssues(system: SystemPackage): readonly SemanticIssue[] {
  const found: SemanticIssue[] = [];
  const add = (code: SemanticCode, path: string, message: string) =>
    found.push({ code, path, message });

  const unique = (keys: readonly string[], path: (index: number) => string, what: string) => {
    const seen = new Set<string>();
    keys.forEach((key, index) => {
      if (seen.has(key)) add('duplicate_key', path(index), `Duplicate ${what} "${key}".`);
      seen.add(key);
    });
  };

  const fields = system.characterSchema.fields;
  const resourceKeys = new Set(system.resources.map((resource) => resource.key));
  const ladderKeys = new Set(system.mechanics.ladders.map((ladder) => ladder.key));
  const fieldKeys = new Set(fields.map((field) => field.key));
  const sectionIds = new Set(system.rules.sections.map((section) => section.id));

  unique(
    fields.map((field) => field.key),
    (index) => `/characterSchema/fields/${index}/key`,
    'field',
  );
  unique(
    system.resources.map((resource) => resource.key),
    (index) => `/resources/${index}/key`,
    'resource',
  );
  unique(
    system.actions.map((action) => action.key),
    (index) => `/actions/${index}/key`,
    'action',
  );
  unique(
    system.mechanics.conditions.map((condition) => condition.key),
    (index) => `/mechanics/conditions/${index}/key`,
    'condition',
  );
  unique(
    system.mechanics.ladders.map((ladder) => ladder.key),
    (index) => `/mechanics/ladders/${index}/key`,
    'ladder',
  );
  unique(
    system.rules.sections.map((section) => section.id),
    (index) => `/rules/sections/${index}/id`,
    'rules section',
  );
  unique(
    system.compendiums.map((compendium) => compendium.key),
    (index) => `/compendiums/${index}/key`,
    'compendium',
  );
  unique(
    system.options.map((option) => option.key),
    (index) => `/options/${index}/key`,
    'option',
  );
  unique(
    system.gameModes.map((mode) => mode.id),
    (index) => `/gameModes/${index}/id`,
    'game mode',
  );
  unique(
    system.manifest.compatibleModules.map((module) => `${module.id}@${module.version}`),
    (index) => `/manifest/compatibleModules/${index}`,
    'module',
  );

  const checkField = (field: CharacterField, path: string) => {
    switch (field.type) {
      case 'number':
      case 'counter':
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
          add('out_of_range', `${path}/min`, `Field "${field.key}" has min above max.`);
        }
        if (
          field.default !== undefined &&
          ((field.min !== undefined && field.default < field.min) ||
            (field.max !== undefined && field.default > field.max))
        ) {
          add('out_of_range', `${path}/default`, `Field "${field.key}" defaults out of range.`);
        }
        if (field.ladder !== undefined && !ladderKeys.has(field.ladder)) {
          add('unknown_reference', `${path}/ladder`, `Unknown ladder "${field.ladder}".`);
        }
        break;
      case 'text':
        if (
          field.default !== undefined &&
          field.maxLength !== undefined &&
          field.default.length > field.maxLength
        ) {
          add('out_of_range', `${path}/default`, `Field "${field.key}" defaults over its length.`);
        }
        break;
      case 'select':
        if (field.default !== undefined && !field.values.includes(field.default)) {
          add('out_of_range', `${path}/default`, `Field "${field.key}" defaults outside values.`);
        }
        break;
      case 'multi_select':
        if (field.default?.some((value) => !field.values.includes(value))) {
          add('out_of_range', `${path}/default`, `Field "${field.key}" defaults outside values.`);
        }
        break;
      case 'resource':
        if (!resourceKeys.has(field.resourceKey)) {
          add(
            'unknown_reference',
            `${path}/resourceKey`,
            `Field "${field.key}" names unknown resource "${field.resourceKey}".`,
          );
        }
        break;
      case 'inventory':
        if (system.mechanics.inventory?.key !== field.inventoryKey) {
          add(
            'unknown_reference',
            `${path}/inventoryKey`,
            `Field "${field.key}" names unknown inventory "${field.inventoryKey}".`,
          );
        }
        break;
      case 'repeater':
        unique(
          field.of.map((nested) => nested.key),
          (index) => `${path}/of/${index}/key`,
          'nested field',
        );
        unique(
          (field.entryTypes ?? []).map((entry) => entry.id),
          (index) => `${path}/entryTypes/${index}/id`,
          'entry type',
        );
        unique(
          (field.slots ?? []).map((slot) => slot.id),
          (index) => `${path}/slots/${index}/id`,
          'slot',
        );
        field.of.forEach((nested, index) => {
          checkField(nested, `${path}/of/${index}`);
        });
        break;
      default:
        break;
    }
  };
  fields.forEach((field, index) => {
    checkField(field, `/characterSchema/fields/${index}`);
  });

  system.characterSchema.summaryFields.forEach((key, index) => {
    if (!fieldKeys.has(key)) {
      add(
        'unknown_reference',
        `/characterSchema/summaryFields/${index}`,
        `Summary names unknown field "${key}".`,
      );
    }
  });

  system.resources.forEach((resource, index) => {
    const path = `/resources/${index}`;
    if (resource.shape === 'pool') {
      if (typeof resource.max === 'number' && resource.min > resource.max) {
        add('out_of_range', `${path}/min`, `Resource "${resource.key}" has min above max.`);
      }
      if (
        typeof resource.default === 'number' &&
        (resource.default < resource.min ||
          (typeof resource.max === 'number' && resource.default > resource.max))
      ) {
        add('out_of_range', `${path}/default`, `Resource "${resource.key}" defaults out of range.`);
      }
    } else {
      unique(
        resource.boxes.map((box) => box.id),
        (box) => `${path}/boxes/${box}/id`,
        'box',
      );
    }
  });

  system.actions.forEach((action, index) => {
    action.inputs.forEach((input, inputIndex) => {
      if (!fieldKeys.has(input)) {
        add(
          'unknown_reference',
          `/actions/${index}/inputs/${inputIndex}`,
          `Action "${action.key}" reads unknown field "${input}".`,
        );
      }
    });
    unique(
      action.outcomes.map((outcome) => outcome.id),
      (outcome) => `/actions/${index}/outcomes/${outcome}/id`,
      'outcome',
    );
    (action.picks ?? []).forEach((pick, pickIndex) => {
      pick.fields.forEach((field, fieldIndex) => {
        if (!fieldKeys.has(field)) {
          add(
            'unknown_reference',
            `/actions/${index}/picks/${pickIndex}/fields/${fieldIndex}`,
            `Action "${action.key}" picks from unknown field "${field}".`,
          );
        }
      });
    });
    // Feature 11 adds `roll`, `natural`, `successes`, and `success` to what a formula reads.
    const named = [
      ...(action.picks ?? []).map((pick) => pick.name),
      ...(action.prompts ?? []).map((prompt) => prompt.name),
      ...(action.derived ?? []).map((derived) => derived.name),
    ];
    unique(
      [...named, 'roll', 'natural', 'successes', 'success'],
      (name) => `/actions/${index}/${name}`,
      'named value',
    );
  });

  system.mechanics.ladders.forEach((ladder, index) => {
    ladder.steps.forEach((step, stepIndex) => {
      const previous = ladder.steps[stepIndex - 1];
      if (previous !== undefined && step.value <= previous.value) {
        add(
          'out_of_range',
          `/mechanics/ladders/${index}/steps/${stepIndex}/value`,
          `Ladder "${ladder.key}" must strictly increase.`,
        );
      }
    });
  });

  system.rules.sections.forEach((section, index) => {
    section.references.forEach((reference, referenceIndex) => {
      if (!sectionIds.has(reference)) {
        add(
          'unknown_reference',
          `/rules/sections/${index}/references/${referenceIndex}`,
          `Section "${section.id}" references unknown section "${reference}".`,
        );
      }
    });
  });

  system.options.forEach((option, index) => {
    if (option.type === 'select' && !option.values.includes(option.default)) {
      add(
        'out_of_range',
        `/options/${index}/default`,
        `Option "${option.key}" defaults outside values.`,
      );
    }
    if (
      option.type === 'string' &&
      ((option.minLength !== undefined && option.default.length < option.minLength) ||
        (option.maxLength !== undefined && option.default.length > option.maxLength))
    ) {
      add(
        'out_of_range',
        `/options/${index}/default`,
        `Option "${option.key}" defaults out of range.`,
      );
    }
  });

  // A capability is an honest claim, both ways (D-06).
  const evidence = capabilityEvidence(system);
  const claimed = new Set<CapabilityKey>(system.capabilities);
  for (const [key, declared] of Object.entries(evidence) as [CapabilityKey, boolean | null][]) {
    if (declared === null) continue;
    if (claimed.has(key) && !declared) {
      add('capability_mismatch', '/capabilities', `"${key}" is claimed but nothing declares it.`);
    }
    if (!claimed.has(key) && declared) {
      add('capability_mismatch', '/capabilities', `"${key}" is declared but not claimed.`);
    }
  }

  const { integration, license } = system.manifest;
  const shipsText = evidence.integrated_rules === true;
  // Only an exact `allowed` permits shipping; `review-required` has not been reviewed (D-08).
  if (license.assets.rulesText !== 'allowed') {
    if (integration.rulesTextIntegrated) {
      add(
        'license_contradiction',
        '/manifest/integration/rulesTextIntegrated',
        `Rules text is claimed as integrated, but the licence says "${license.assets.rulesText}".`,
      );
    }
    if (shipsText) {
      add(
        'license_contradiction',
        '/rules/sections',
        `Rules text ships, but the licence says "${license.assets.rulesText}".`,
      );
    }
  }
  if (integration.rulesTextIntegrated !== shipsText) {
    add(
      'integration_mismatch',
      '/manifest/integration/rulesTextIntegrated',
      'Rules integration must match whether any section ships text.',
    );
  }
  if (integration.characterSheetSupported !== evidence.character_sheet) {
    add(
      'integration_mismatch',
      '/manifest/integration/characterSheetSupported',
      'Character sheet support must match whether fields are declared.',
    );
  }
  if (integration.compendiumIntegrated !== evidence.compendium) {
    add(
      'integration_mismatch',
      '/manifest/integration/compendiumIntegrated',
      'Compendium integration must match whether compendiums are declared.',
    );
  }
  return found;
}
