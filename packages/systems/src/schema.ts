import { CapabilityKeySchema, SystemRef } from '@rpg/contracts';
import { type Static, type TProperties, Type } from '@sinclair/typebox';

/**
 * The system package contract (`PRD.md` s.15): what a system declares, never how it plays. A generic
 * page reads these declarations and never asks which system it has (`PRD.md` s.89). Dice, formula,
 * and effect content is inert text here; features 09, 10, and 11 own what it means.
 *
 * Every object refuses unknown properties, so a typo fails at load instead of silently doing nothing.
 */

function strict<T extends TProperties>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

const Identifier = Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9._-]*$' });
const Key = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_]*$' });
const Label = Type.String({ minLength: 1, maxLength: 120 });
const Description = Type.String({ minLength: 1, maxLength: 2000 });
const Version = Type.String({ minLength: 1, pattern: '^\\d+\\.\\d+\\.\\d+$' });

/** A dice expression, parsed only by feature 09. */
export const DiceExpression = strict({ dice: Type.String({ minLength: 1, maxLength: 200 }) });
export type DiceExpression = Static<typeof DiceExpression>;

/** A formula, parsed only by feature 10. Never JavaScript (`PRD.md` s.24). */
export const FormulaExpression = strict({ formula: Type.String({ minLength: 1, maxLength: 500 }) });
export type FormulaExpression = Static<typeof FormulaExpression>;

const NumberOrFormula = Type.Union([Type.Number(), FormulaExpression]);

/** An effect by kind, with its arguments. Feature 11 owns the kinds and applies them. */
export const EffectDeclaration = strict({
  effect: Key,
  params: Type.Record(
    Key,
    Type.Union([Type.String({ maxLength: 500 }), Type.Number(), Type.Boolean(), FormulaExpression]),
  ),
});
export type EffectDeclaration = Static<typeof EffectDeclaration>;

/** The feature 04 vocabulary a package may declare. Enforcement stays with feature 04. */
export const DeclaredVisibility = Type.Union([Type.Literal('everyone'), Type.Literal('gm_only')]);
export type DeclaredVisibility = Static<typeof DeclaredVisibility>;

/* -------------------------------------------------------------------------- */
/* Licence and integration (`PRD.md` s.9, s.14)                               */
/* -------------------------------------------------------------------------- */

export const IntegrationStatus = strict({
  mechanicsSupported: Type.Boolean(),
  characterSheetSupported: Type.Boolean(),
  rulesTextIntegrated: Type.Boolean(),
  compendiumIntegrated: Type.Boolean(),
  externalDocumentation: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
});

const AssetPermission = Type.Union([
  Type.Literal('allowed'),
  Type.Literal('forbidden'),
  Type.Literal('review-required'),
]);

/** A technical guardrail. It does not replace legal review and must not imply it happened. */
export const LicenseManifest = strict({
  license: Label,
  source: Type.String({ minLength: 1, maxLength: 2048 }),
  version: Type.String({ minLength: 1, maxLength: 60 }),
  attribution: Description,
  redistributionStatus: AssetPermission,
  translationStatus: AssetPermission,
  brandUsageStatus: AssetPermission,
  assets: strict({
    rulesText: AssetPermission,
    mechanics: AssetPermission,
    officialArtwork: AssetPermission,
    officialLogo: AssetPermission,
  }),
});
export type LicenseManifest = Static<typeof LicenseManifest>;

export const Complexity = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
]);

export const ModuleDeclaration = strict({ id: Identifier, version: Version, name: Label });
export type ModuleDeclaration = Static<typeof ModuleDeclaration>;

export const SystemManifest = strict({
  ref: SystemRef,
  name: Label,
  shortDescription: Type.String({ minLength: 1, maxLength: 500 }),
  complexity: Complexity,
  languages: Type.Array(Type.String({ minLength: 2, maxLength: 16 }), {
    minItems: 1,
    uniqueItems: true,
  }),
  integration: IntegrationStatus,
  license: LicenseManifest,
  rulesEntryPoint: Type.String({ minLength: 1, maxLength: 2048 }),
  compatibleModules: Type.Array(ModuleDeclaration),
});
export type SystemManifest = Static<typeof SystemManifest>;

/* -------------------------------------------------------------------------- */
/* Character schema (`PRD.md` s.17, s.18), early-published for feature 15     */
/* -------------------------------------------------------------------------- */

const fieldBase = {
  key: Key,
  label: Label,
  group: Key,
  gmOnly: Type.Optional(Type.Boolean()),
};

const LeafField = Type.Union([
  strict({
    ...fieldBase,
    type: Type.Literal('text'),
    maxLength: Type.Optional(Type.Integer({ minimum: 1 })),
    default: Type.Optional(Type.String()),
  }),
  strict({ ...fieldBase, type: Type.Literal('rich_text') }),
  strict({
    ...fieldBase,
    type: Type.Union([Type.Literal('number'), Type.Literal('counter')]),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    default: Type.Optional(Type.Number()),
    /** A declared rating ladder that names this field's values. */
    ladder: Type.Optional(Key),
  }),
  strict({
    ...fieldBase,
    type: Type.Literal('boolean'),
    default: Type.Optional(Type.Boolean()),
  }),
  strict({
    ...fieldBase,
    type: Type.Literal('select'),
    values: Type.Array(Label, { minItems: 1, uniqueItems: true }),
    default: Type.Optional(Label),
  }),
  strict({
    ...fieldBase,
    type: Type.Literal('multi_select'),
    values: Type.Array(Label, { minItems: 1, uniqueItems: true }),
    default: Type.Optional(Type.Array(Label, { uniqueItems: true })),
  }),
  strict({ ...fieldBase, type: Type.Literal('list') }),
  strict({ ...fieldBase, type: Type.Literal('resource'), resourceKey: Key }),
  strict({ ...fieldBase, type: Type.Literal('inventory'), inventoryKey: Key }),
  strict({ ...fieldBase, type: Type.Literal('condition') }),
  strict({ ...fieldBase, type: Type.Literal('reference'), targetType: Key }),
  strict({ ...fieldBase, type: Type.Literal('computed'), value: FormulaExpression }),
  strict({ ...fieldBase, type: Type.Literal('dice'), roll: DiceExpression }),
]);

const RepeaterField = strict({
  ...fieldBase,
  type: Type.Literal('repeater'),
  of: Type.Array(LeafField, { minItems: 1 }),
  /** The kind of an entry whose content stays free, so kinds differ without an enumeration of text. */
  entryTypes: Type.Optional(Type.Array(strict({ id: Key, label: Label }), { minItems: 1 })),
  /** Fixed labelled entries, each with a severity, instead of an open-ended list. */
  slots: Type.Optional(
    Type.Array(strict({ id: Key, label: Label, severity: Type.Number() }), { minItems: 1 }),
  ),
  maxEntries: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const CharacterField = Type.Union([LeafField, RepeaterField]);
export type CharacterField = Static<typeof CharacterField>;

export const CharacterSchema = strict({
  fields: Type.Array(CharacterField),
  /** What party panels and encounter participants show (features 18 and 19), by field key. */
  summaryFields: Type.Array(Key, { uniqueItems: true }),
});
export type CharacterSchema = Static<typeof CharacterSchema>;

/* -------------------------------------------------------------------------- */
/* Resources (`PRD.md` s.19). Mutation semantics belong to feature 11         */
/* -------------------------------------------------------------------------- */

const RecoveryRule = strict({
  trigger: Key,
  label: Label,
  amount: Type.Optional(NumberOrFormula),
});

const resourceBase = {
  key: Key,
  label: Label,
  visibility: DeclaredVisibility,
  /** Spent as a currency rather than lost as harm. */
  spendable: Type.Boolean(),
  recovery: Type.Array(RecoveryRule),
};

export const ResourceDeclaration = Type.Union([
  strict({
    ...resourceBase,
    shape: Type.Literal('pool'),
    min: Type.Number(),
    max: NumberOrFormula,
    default: Type.Optional(NumberOrFormula),
    temporary: Type.Boolean(),
  }),
  strict({
    ...resourceBase,
    shape: Type.Literal('track'),
    /** Separately marked boxes. Collapsing them to a number would change the system. */
    boxes: Type.Array(strict({ id: Key, label: Label, value: Type.Optional(Type.Number()) }), {
      minItems: 1,
    }),
  }),
]);
export type ResourceDeclaration = Static<typeof ResourceDeclaration>;

/* -------------------------------------------------------------------------- */
/* Actions (`PRD.md` s.22, s.27). Nothing here is rolled or evaluated         */
/* -------------------------------------------------------------------------- */

const OutcomeResolution = Type.Union([
  strict({ mode: Type.Literal('apply'), effects: Type.Array(EffectDeclaration) }),
  /** The table decides: nothing is applied automatically (`PRD.md` s.27). */
  strict({
    mode: Type.Literal('choice'),
    options: Type.Array(strict({ id: Key, label: Label, effects: Type.Array(EffectDeclaration) }), {
      minItems: 1,
    }),
  }),
]);

export const ActionDeclaration = strict({
  key: Key,
  label: Label,
  /** Absent for an action the table simply takes, such as spending a point (feature 11). */
  roll: Type.Optional(DiceExpression),
  /** Field keys the action's expressions read. */
  inputs: Type.Array(Key, { uniqueItems: true }),
  /** A named value the actor picks when rolling: one of these fields, or a repeater entry's field. */
  picks: Type.Optional(
    Type.Array(
      strict({
        name: Key,
        label: Label,
        fields: Type.Array(Key, { minItems: 1, uniqueItems: true }),
        entryField: Type.Optional(Key),
      }),
    ),
  ),
  /** A named whole number the table enters when rolling, such as a difficulty. */
  prompts: Type.Optional(
    Type.Array(strict({ name: Key, label: Label, default: Type.Optional(Type.Integer()) })),
  ),
  /** A named value computed in order after the roll, such as a margin. */
  derived: Type.Optional(Type.Array(strict({ name: Key, value: FormulaExpression }))),
  success: Type.Optional(FormulaExpression),
  outcomes: Type.Array(
    strict({
      id: Key,
      label: Label,
      when: Type.Optional(FormulaExpression),
      resolution: OutcomeResolution,
    }),
  ),
});
export type ActionDeclaration = Static<typeof ActionDeclaration>;

/* -------------------------------------------------------------------------- */
/* Mechanics: queried by generic features, not a field, resource, or action   */
/* -------------------------------------------------------------------------- */

/** Early-published shape for features 11, 15, and 19. */
export const ConditionDeclaration = strict({
  key: Key,
  label: Label,
  description: Type.Optional(Description),
  stacking: Type.Union([Type.Literal('single'), Type.Literal('count')]),
  occupiesSlots: Type.Optional(Type.Integer({ minimum: 1 })),
  visibility: DeclaredVisibility,
});
export type ConditionDeclaration = Static<typeof ConditionDeclaration>;

export const InventoryDeclaration = strict({
  key: Key,
  label: Label,
  capacity: NumberOrFormula,
  unit: Type.Literal('slots'),
});
export type InventoryDeclaration = Static<typeof InventoryDeclaration>;

export const RatingLadder = strict({
  key: Key,
  label: Label,
  steps: Type.Array(strict({ value: Type.Number(), label: Label }), { minItems: 2 }),
});
export type RatingLadder = Static<typeof RatingLadder>;

export const Mechanics = strict({
  conditions: Type.Array(ConditionDeclaration),
  inventory: Type.Optional(InventoryDeclaration),
  ladders: Type.Array(RatingLadder),
});

/* -------------------------------------------------------------------------- */
/* Rules and compendiums (`PRD.md` s.26). Feature 14 owns presentation        */
/* -------------------------------------------------------------------------- */

export const RulesDeclaration = strict({
  sections: Type.Array(
    strict({
      id: Key,
      title: Label,
      category: Key,
      /** Shipped text; only where the licence permits it. Absent means a reference only. */
      body: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })),
      /** A quick rule (feature 14 FR-007): rules text too, licence-gated like `body`. */
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      references: Type.Array(Key, { uniqueItems: true }),
    }),
  ),
});

export const CompendiumDeclaration = strict({ key: Key, label: Label });

/* -------------------------------------------------------------------------- */
/* Options and game modes, consumed by the feature 02 wizard                  */
/* -------------------------------------------------------------------------- */

export const GameModeDeclaration = strict({ id: Identifier, label: Label });
export type GameModeDeclaration = Static<typeof GameModeDeclaration>;

export const SystemOptionDeclaration = Type.Union([
  strict({
    key: Identifier,
    label: Label,
    type: Type.Literal('string'),
    default: Type.String(),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  strict({
    key: Identifier,
    label: Label,
    type: Type.Literal('boolean'),
    default: Type.Boolean(),
  }),
  strict({
    key: Identifier,
    label: Label,
    type: Type.Literal('select'),
    default: Type.String(),
    values: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
  }),
]);
export type SystemOptionDeclaration = Static<typeof SystemOptionDeclaration>;

/* -------------------------------------------------------------------------- */
/* The package                                                                */
/* -------------------------------------------------------------------------- */

export const SystemPackage = Type.Object(
  {
    contractVersion: Type.Literal(1),
    manifest: SystemManifest,
    capabilities: Type.Array(CapabilityKeySchema, { uniqueItems: true }),
    characterSchema: CharacterSchema,
    resources: Type.Array(ResourceDeclaration),
    actions: Type.Array(ActionDeclaration),
    mechanics: Mechanics,
    rules: RulesDeclaration,
    compendiums: Type.Array(CompendiumDeclaration),
    options: Type.Array(SystemOptionDeclaration),
    gameModes: Type.Array(GameModeDeclaration, { minItems: 1 }),
  },
  { additionalProperties: false, $id: 'SystemPackage' },
);
export type SystemPackage = Static<typeof SystemPackage>;

/* -------------------------------------------------------------------------- */
/* Projections feature 02 consumes                                            */
/* -------------------------------------------------------------------------- */

export const SystemSummary = Type.Object(
  {
    ref: SystemRef,
    name: Label,
    shortDescription: Type.String({ minLength: 1, maxLength: 500 }),
    complexity: Complexity,
    documentationStatus: Type.Union([
      Type.Literal('integrated'),
      Type.Literal('external'),
      Type.Literal('unavailable'),
    ]),
    rulesEntryPoint: Type.String({ minLength: 1, maxLength: 2048 }),
    integration: IntegrationStatus,
  },
  { additionalProperties: false, $id: 'CampaignSystemSummary' },
);
export type SystemSummary = Static<typeof SystemSummary>;

export const SystemDefinition = Type.Object(
  {
    summary: SystemSummary,
    gameModes: Type.Array(GameModeDeclaration, { minItems: 1 }),
    options: Type.Array(SystemOptionDeclaration),
    compatibleModules: Type.Array(ModuleDeclaration),
  },
  { additionalProperties: false, $id: 'CampaignSystemDefinition' },
);
export type SystemDefinition = Static<typeof SystemDefinition>;
