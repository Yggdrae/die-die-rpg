# TechSpec: Cairn 2e System Package

Source: `_prd.md`, `PRD.md` s.9, s.10, s.14, s.15, s.22, s.89; feature 08 contract; feature 11 kinds. P0 only.

Mechanics were read from the official second edition core rules and character creation pages on 2026-11-01. The site
states its text is CC BY-SA 4.0. Nothing in the package reproduces that text.

## Decisions (open PRD questions closed; delegated by the owner, 2026-11-01)

- **D-01 One JSON file: `systems/cairn-2e/system.json`.** A format that cannot hold code, so "declarations only" holds by
  construction, asserted by test. `systems/index.ts` lists installed packages as untrusted data, and the validated
  registry is the only way in (`apps/api/src/modules/systems/registry.ts`).
- **D-02 No rules text ships in version 1.** The licence permits it (FR-011), but no body is included:
  `rulesTextIntegrated: false`, `externalDocumentation` and `rulesEntryPoint` point at the official pages, and sections
  are titled references. That is the honest fallback the PRD names. Importing the official text is a later version of the
  package, under CC BY-SA, once feature 14 can show it with its attribution. The success signal "looks up a rule in under
  10 seconds" therefore depends on feature 14 opening the external page.
- **D-03 Condition model (open question).** Critical damage, scars, fatigue, deprived, paralyzed, delirious, and dead are
  feature 11 counters. None needs a duration in P0, since all are cleared by a table decision.
- **D-04 Spellbooks are a repeater of spell and notes (open question).** No compendium. A spellbook's slot is the
  inventory's concern, as with any item.
- **D-05 Game modes (open question): GM + Players, Theatre of the Mind.** The PRD's solo and companion modes are not
  claimed until something supports them.
- **D-06 Brand use stays `review-required`.** The package uses the system's name to describe compatibility, and no logo or
  artwork. `PRD.md` s.14: the manifest is a guardrail, not legal review. Owner action at the final audit.

## Mechanics As Declared

| Mechanic | Declaration |
| --- | --- |
| Attributes | `STR`, `DEX`, `WIL`, numbers, minimum 0 |
| Save | `1d20`, picked attribute. Ordered outcomes: natural 1, natural 20, `roll <= attribute`, otherwise failure |
| Armor | Number capped at 3, and formulas read `min(armor, 3)`, so a sheet holding more still counts as 3 |
| HP | Pool `hp`, maximum `hp_max`, restored by trigger `brief_rest` |
| Damage | `take_damage_d4` to `d12`. Ordered: deflected, fatal, spills, scar (exactly 0), absorbed |
| Spill | HP to 0, Strength reduced by the rest, then `execute_roll` of `critical_damage_save` |
| Critical damage | Failing that save adds the condition; `stabilize` clears it |
| Fatigue | Counting condition with `occupiesSlots: 1`; added by casting, cleared by `clear_fatigue` |
| Inventory | `pack`, capacity 10, slots |
| Scars | Counting condition. The table's result stays with the table, since the table text does not ship |

## Findings Escalated To Feature 08

- **Actions with no roll.** Casting, fatigue, and stabilizing roll nothing. `roll` became optional. Fate needs it too, so it
  generalizes (feature 08 techspec, feature 11 pipeline).
- **A fixed die per action.** Damage dice vary by weapon, so the package declares one action per die. Attack modifiers and
  several attackers are table decisions (roll elsewhere, or edit the plan). Not a gap worth a contract change yet.

## Test Strategy

`systems/packages.test.ts`: conformance with every engine, honest integration status, each row above played through the real
planner, boundary values for saves and each damage branch. Generic code stays free of the system name, by the existing guard.

## Out of Scope

Compendium, guided creation, localization (P1). Applying these effects to a saved character needs feature 15's target.
