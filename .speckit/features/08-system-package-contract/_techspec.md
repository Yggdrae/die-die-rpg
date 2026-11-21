# TechSpec: System Package Contract and Registry

Source: `_prd.md`, `_bdd.md`, `PRD.md` s.9, s.14–19, s.22, s.26, s.66, s.75, s.89. P0 only.

## Current Facts

- `packages/contracts/src/system.ts`: `SystemRef`, and a branded `CapabilityKey` with no values.
- `packages/campaigns/src/contracts.ts`: `SystemSummary`, `GameModeDeclaration`,
  `SystemOptionDeclaration`, `ModuleDeclaration`, `SystemDefinition`, and the `SystemCatalog` port.
  `StaticSystemCatalog` serves `SystemDefinition`s; the wizard and `validateCampaignCreate` consume them.
- `packages/fixtures`: `FIXTURE_SYSTEM_DEFINITION` (a campaign-shaped stand-in) and
  `FIXTURE_CHARACTER_SCHEMA` (a placeholder this feature replaces, FR-012).
- `apps/api/src/runtime.ts` builds the catalog from `input.systems ?? [FIXTURE_SYSTEM_DEFINITION]`;
  `CampaignDashboard` lists the same fixture as `INSTALLED_MANIFESTS`.
- Guard: `no-system-identity` and `no-system-id-branch` already refuse system identifiers in generic
  code, with `systems/` exempt.
- Nothing has a manifest; no package is validated at load.

## Decisions (open PRD questions closed; delegated by the owner, 2026-10-30)

- **D-01 New pure package `@rpg/systems`.** TypeBox schemas, validation, registry, conformance kit.
  No persistence, Fastify, React, or Node API, so API and browser load the same code. It depends on
  `@rpg/contracts` and TypeBox only. `@rpg/campaigns` depends on it, never the reverse.
- **D-02 `mechanics` is a grouping, not a peer of `actions` and `resources`.** It holds the declarations
  generic features query that are neither a field, a resource, nor an action: `conditions`,
  `inventory`, `ladders`.
- **D-03 Closed capability keys live in `@rpg/contracts`** (`CAPABILITY_KEYS`), because feature 18's
  `SessionQuickAction.capability` already types against it there. Additive, recorded as a post-freeze
  contract note. Seed set in "Capabilities".
- **D-04 Versions are addressed by the exact string `system-id@version`** in one in-memory map. `list()`
  shows each system once at its highest version; `resolve()` is exact and never falls back.
- **D-05 Compendiums are a declared, empty-capable array in MVP.** `PRD.md` s.68 does not list them; the
  block exists so feature 08 FR-101 adds content, not a shape. Declaring one requires the
  `compendium` capability and `integration.compendiumIntegrated`.
- **D-06 A capability is an honest claim.** Each key that names a declared block requires that block to be
  non-empty, and the block requires the key. A consumer gating on the key never meets an empty block.
- **D-07 Dice, formula, and effect content stays inert text** with typed wrappers (`{ dice }`,
  `{ formula }`, `{ effect, params }`). `SystemRegistry` takes optional `expressionValidators`, which
  features 09, 10, and 11 plug in so a bad expression is refused at load (their FR-005 equivalents)
  without this feature depending on them.
- **D-08 `review-required` does not permit shipping.** A licence asset must be exactly `allowed` for
  rules text to ship; the licence is a guardrail and never implies legal review happened (`PRD.md` s.14).
- **D-09 The summary is derived, never authored twice.** `documentationStatus` comes from integration:
  rules integrated → `integrated`, external documentation present → `external`, else `unavailable`.
- **D-10 Party and participant summaries are declared** by `characterSchema.summaryFields`, the mechanism
  features 18 (FR-005) and 19 (FR-004) both name.
- **D-11 Migration keeps `SystemDefinition`** as the campaign-facing projection, now derived by
  `systemDefinitionOf(package)`, so feature 02 and its tests keep their shape. Pinned campaigns resolve
  exactly as before.

## Package Shape

```text
SystemPackage
  contractVersion: 1
  manifest      ref, name, shortDescription, complexity, languages, integration, license,
                rulesEntryPoint, compatibleModules
  capabilities  CapabilityKey[] (unique)
  characterSchema  fields: CharacterField[], summaryFields: key[]
  resources     ResourceDeclaration[]  (shape: pool | track)
  actions       ActionDeclaration[]
  mechanics     conditions, inventory?, ladders
  rules         sections, externalDocumentation?
  compendiums   CompendiumDeclaration[]
  options       SystemOptionDeclaration[]
  gameModes     GameModeDeclaration[] (at least one)
```

Every object is `additionalProperties: false`. Labels are bounded strings; keys match `^[A-Za-z][A-Za-z0-9_]*# TechSpec: System Package Contract and Registry

Source: `_prd.md`, `_bdd.md`, `PRD.md` s.9, s.14–19, s.22, s.26, s.66, s.75, s.89. P0 only.

## Current Facts

- `packages/contracts/src/system.ts`: `SystemRef`, and a branded `CapabilityKey` with no values.
- `packages/campaigns/src/contracts.ts`: `SystemSummary`, `GameModeDeclaration`,
  `SystemOptionDeclaration`, `ModuleDeclaration`, `SystemDefinition`, and the `SystemCatalog` port.
  `StaticSystemCatalog` serves `SystemDefinition`s; the wizard and `validateCampaignCreate` consume them.
- `packages/fixtures`: `FIXTURE_SYSTEM_DEFINITION` (a campaign-shaped stand-in) and
  `FIXTURE_CHARACTER_SCHEMA` (a placeholder this feature replaces, FR-012).
- `apps/api/src/runtime.ts` builds the catalog from `input.systems ?? [FIXTURE_SYSTEM_DEFINITION]`;
  `CampaignDashboard` lists the same fixture as `INSTALLED_MANIFESTS`.
- Guard: `no-system-identity` and `no-system-id-branch` already refuse system identifiers in generic
  code, with `systems/` exempt.
- Nothing has a manifest; no package is validated at load.

## Decisions (open PRD questions closed; delegated by the owner, 2026-10-30)

- **D-01 New pure package `@rpg/systems`.** TypeBox schemas, validation, registry, conformance kit.
  No persistence, Fastify, React, or Node API, so API and browser load the same code. It depends on
  `@rpg/contracts` and TypeBox only. `@rpg/campaigns` depends on it, never the reverse.
- **D-02 `mechanics` is a grouping, not a peer of `actions` and `resources`.** It holds the declarations
  generic features query that are neither a field, a resource, nor an action: `conditions`,
  `inventory`, `ladders`.
- **D-03 Closed capability keys live in `@rpg/contracts`** (`CAPABILITY_KEYS`), because feature 18's
  `SessionQuickAction.capability` already types against it there. Additive, recorded as a post-freeze
  contract note. Seed set in "Capabilities".
- **D-04 Versions are addressed by the exact string `system-id@version`** in one in-memory map. `list()`
  shows each system once at its highest version; `resolve()` is exact and never falls back.
- **D-05 Compendiums are a declared, empty-capable array in MVP.** `PRD.md` s.68 does not list them; the
  block exists so feature 08 FR-101 adds content, not a shape. Declaring one requires the
  `compendium` capability and `integration.compendiumIntegrated`.
- **D-06 A capability is an honest claim.** Each key that names a declared block requires that block to be
  non-empty, and the block requires the key. A consumer gating on the key never meets an empty block.
- **D-07 Dice, formula, and effect content stays inert text** with typed wrappers (`{ dice }`,
  `{ formula }`, `{ effect, params }`). `SystemRegistry` takes optional `expressionValidators`, which
  features 09, 10, and 11 plug in so a bad expression is refused at load (their FR-005 equivalents)
  without this feature depending on them.
- **D-08 `review-required` does not permit shipping.** A licence asset must be exactly `allowed` for
  rules text to ship; the licence is a guardrail and never implies legal review happened (`PRD.md` s.14).
- **D-09 The summary is derived, never authored twice.** `documentationStatus` comes from integration:
  rules integrated → `integrated`, external documentation present → `external`, else `unavailable`.
- **D-10 Party and participant summaries are declared** by `characterSchema.summaryFields`, the mechanism
  features 18 (FR-005) and 19 (FR-004) both name.
- **D-11 Migration keeps `SystemDefinition`** as the campaign-facing projection, now derived by
  `systemDefinitionOf(package)`, so feature 02 and its tests keep their shape. Pinned campaigns resolve
  exactly as before.

## Package Shape

```text
SystemPackage
  contractVersion: 1
  manifest      ref, name, shortDescription, complexity, languages, integration, license,
                rulesEntryPoint, compatibleModules
  capabilities  CapabilityKey[] (unique)
  characterSchema  fields: CharacterField[], summaryFields: key[]
  resources     ResourceDeclaration[]  (shape: pool | track)
  actions       ActionDeclaration[]
  mechanics     conditions, inventory?, ladders
  rules         sections, externalDocumentation?
  compendiums   CompendiumDeclaration[]
  options       SystemOptionDeclaration[]
  gameModes     GameModeDeclaration[] (at least one)
```

,
since a system may name attributes in capitals.

### Character fields (`PRD.md` s.17, s.18)

A discriminated union on `type`: `text`, `rich_text`, `number`, `boolean`, `counter`, `select`,
`multi_select`, `list`, `repeater`, `resource`, `inventory`, `condition`, `reference`, `computed`, `dice`.
Common: `key`, `label`, `group`, optional `gmOnly`.

- `number`/`counter`: `min`, `max`, `default`, optional `ladder` (a declared rating ladder).
- `select`/`multi_select`: `values`, `default`.
- `repeater`: `of` (non-repeater fields; both invented systems needed no deeper nesting), optional `entryTypes` (the type of a
  free-text entry, such as how long it lasts), optional `slots` (fixed labelled entries with a
  `severity`), optional `maxEntries`.
- `resource`: `resourceKey`. `inventory`: `inventoryKey`. `condition`: a condition list. `reference`:
  `targetType`. `computed`: `value: { formula }`. `dice`: `roll: { dice }`.

### Resources (`PRD.md` s.19)

- `shape: 'pool'`: `min`, `max` (number or `{ formula }`), `default`, `temporary`, `recovery`.
- `shape: 'track'`: `boxes` (each `{ id, label, value? }`), `recovery`. Marked boxes are never a number.
- Both: `key`, `label`, `visibility` (`everyone` | `gm_only`, the feature 04 vocabulary), `spendable`.

### Actions (`PRD.md` s.22, s.27)

`key`, `label`, optional `roll: { dice }` (absent for an action the table simply takes, from features 12 and 13), `inputs` (field keys the expressions read), optional
`picks`, `prompts`, `derived` (feature 11 D-07, additive: a named value picked from fields, entered by the table, or
computed after the roll), optional `success: { formula }`, `outcomes`. An outcome is `{ id, label, when?: { formula }, resolution }`, where
`resolution` is `{ mode: 'apply', effects }` or `{ mode: 'choice', options: [{ id, label, effects }] }`.
`choice` is how the table keeps narrative control: nothing is applied automatically.

### Mechanics

- `conditions`: `key`, `label`, optional `description`, `stacking` (`single` | `count`), optional
  `occupiesSlots`, `visibility`. This is the early-published `Condition` shape (FR-012).
- `inventory`: `key`, `label`, `capacity` (number or `{ formula }`), `unit: 'slots'`.
- `ladders`: `key`, `label`, `steps: [{ value, label }]`, strictly increasing.

### Rules and licence

- `rules.sections`: `id`, `title`, optional `body`, `category` (`PRD.md` s.26), `references` (section ids).
- `license`: `license`, `source`, `version`, `attribution`, `redistributionStatus`, `translationStatus`,
  `brandUsageStatus`, `assets: { rulesText, mechanics, officialArtwork, officialLogo }`, each `allowed` |
  `forbidden` | `review-required`.

## Capabilities

Closed set; every key describes a mechanic or a generic surface, with a documented meaning in code.

| Key | Meaning | Requires |
| --- | --- | --- |
| `character_sheet` | Characters render from `characterSchema` | at least one field |
| `dice_rolls` | Actions roll dice | at least one action |
| `resource_pools` | Numeric pools | a `pool` resource |
| `resource_tracks` | Marked-box tracks | a `track` resource |
| `spendable_points` | A resource spent as currency | a `spendable` resource |
| `conditions` | Named conditions | at least one condition |
| `inventory_slots` | Slot-based inventory | `mechanics.inventory` |
| `rating_ladders` | Named rating scales | at least one ladder |
| `freeform_entries` | Free-text entries with a type | a repeater with `entryTypes` |
| `outcome_choices` | Outcomes the table chooses | a `choice` resolution |
| `integrated_rules` | Rules text in the application | a section with a `body` |
| `compendium` | Declared compendiums | at least one compendium |
| `turn_order` | Encounters track turns | no block; a pure claim, feature 19 FR-101 |

`turn_order` is the one key with no block, because it declares how a generic tracker should behave.

## Loading

`loadSystemPackage(candidate: unknown, validators?)` returns `Result<SystemPackage, PackageLoadError[]>`:

1. `assertPlainData`: only plain objects, arrays, strings, finite numbers, booleans, null. Refuses
   functions, symbols, class instances, accessors, cycles, the keys `__proto__`/`constructor`/
   `prototype`, and anything past depth 16 or 1 MiB of canonical JSON. Runs first, on the raw value, and
   evaluates nothing (no getter is invoked: descriptors are read).
2. `Value.Errors` against `SystemPackage`, every error with its JSON pointer. No coercion, no defaults.
3. Semantic checks (`semantics.ts`): unique keys per block, references (field to resource, inventory,
   ladder; summary field; action input; section reference), defaults inside their constraints,
   `min <= max`, capability honesty (D-06), licence contradictions (D-08), compatible module uniqueness.
4. `expressionValidators`, when given (D-07), including `formulaCycles` (feature 10 D-10, code
   `formula_cycle`), over computed fields, resource maximums, and inventory capacity, and `effects` (feature 11, code
   `invalid_effect`), for what a package's effects imply across its declarations.

Each error is `{ code, path, message }`. The result is deep-frozen. A rejected package exposes nothing.

### Registry

```ts
class SystemRegistry {
  constructor(validators?: ExpressionValidators);
  load(candidate: unknown): Result<SystemPackage, PackageLoadError[]>;
  loadAll(candidates: readonly unknown[]): { loaded: readonly SystemRef[]; rejected: readonly RejectedPackage[] };
  resolve(ref: SystemRef): SystemPackage | undefined;
  list(): readonly SystemPackage[];
}
export function hasCapability(system: SystemPackage, key: CapabilityKey): boolean;
export function systemSummaryOf(system: SystemPackage): SystemSummary;
export function systemDefinitionOf(system: SystemPackage): SystemDefinition;
```

Reloading the same `system-id@version` compares canonical JSON (recursively sorted keys): equal is a no-op,
different is `version_conflict` and the original stays. One bad package never blocks the others.

## Campaign Integration

- `SystemSummary` and the declaration schemas move to `@rpg/systems`; `@rpg/campaigns` re-exports them, so
  its consumers do not change.
- `packages/fixtures` gains `FIXTURE_SYSTEM_PACKAGE`, which passes the kit.
  `FIXTURE_SYSTEM_DEFINITION = systemDefinitionOf(...)` stays byte-equivalent to today's value.
- `FIXTURE_CHARACTER_SCHEMA` becomes the package's real `characterSchema`, still deliberately neither MVP
  system.
- Runtime and wizard keep receiving `SystemDefinition`s; a later feature adds real packages to the list.

## Conformance Kit

`@rpg/systems/testing` exports `runConformance(candidate): ConformanceReport`, a list of named checks with
offending paths, and is what features 12 and 13 run. It checks: loads clean; JSON round trip is identical
(pure data); capability honesty both ways; licence and integration agree; summary derives; at least one game
mode and a resolvable default for each option; `summaryFields` resolve; hidden fields and resources use the
vocabulary. The kit contains no system identifier, which a test asserts.

## Authorization, Offline, Sync

- **Authorization:** none here. `gmOnly` and `visibility` are declarations consumers enforce through
  feature 04.
- **Offline:** packages are bundled static data, available wherever the code is. No persistence, no sync,
  no migration, no `_db.md`.
- **Conflicts, realtime, blobs:** N/A.

## Test Strategy

- Unit: schema and semantics per BDD outline, one failing fixture per defect.
- Two contract fixtures in the package's tests, one slot-based rules-light and one aspect-based narrative,
  named for neither real system, carrying every mechanic `PRD.md` s.10 lists. Both must pass the kit: this is
  the early proof that neither MVP system needs a contract change.
- Adversarial: accessors are never invoked, prototype keys refused, `Object.prototype` unchanged.
- Source scan: no `eval`, `new Function`, or dynamic `import(` in `packages/systems/src`.
- Campaign: existing feature 02 suites unchanged, plus `FIXTURE_SYSTEM_DEFINITION` deep equal to the literal it
  replaces.

## Affected Modules

- New: `packages/systems`.
- `packages/contracts/src/system.ts`: `CAPABILITY_KEYS`; dated note in feature 00.
- `packages/campaigns/src/contracts.ts`: re-exports; `package.json` dependency.
- `packages/fixtures/src/`: package fixture, real character schema.
- `tools/guard/src/rules.ts`: `@rpg/systems` import boundary (no persistence or UI inside it).

## Out of Scope

Cairn and Fate packages (12, 13). Evaluating dice, formulas, and effects (09, 10, 11). Rendering (15), rules
presentation (14). Everything P1 and P2 in the PRD.
