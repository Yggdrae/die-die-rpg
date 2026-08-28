# PRD: Cairn 2e System Package

Source: `PRD.md` s.10 (P0), s.9, s.14, s.15, s.22, s.68, s.88, s.89.
Track: B. Depends on: the manifest contract from feature 08. Declarative content only, no application code.

## Problem

The platform hypothesis in `PRD.md` s.3 is unproven until two mechanically unlike systems run on
one core. Cairn 2e is the rules-light half of that proof: three attributes, hit protection that
is not hit points, damage that spills into attributes, slot-based inventory, fatigue and scars
(`PRD.md` s.10).

It is also the honest test of the declarative constraint. Cairn is simple enough that any
shortcut taken here would be invisible, and every shortcut taken here becomes a system conditional
in generic code, which is exactly what `PRD.md` s.89 forbids.

## Goals

- Cairn 2e is playable end to end using only declarations from the feature 08 contract.
- The generic character, session, encounter, and rules surfaces render Cairn with no code that
  names Cairn (`PRD.md` s.89).
- Any contract gap discovered here is reported to feature 08 as a contract change, never patched
  locally with application code.
- Licence and redistribution status for every asset class is declared and honoured (`PRD.md` s.14).

## Non-Goals

- Application logic of any kind. This package is data.
- Mausritter or other Cairn-family systems (`PRD.md` s.11, V1).
- Compendium content beyond what the MVP acceptance flow needs (`PRD.md` s.68 does not list compendiums).
- Redistributing any asset whose licence does not permit it, including artwork and logos
  (`PRD.md` s.14).
- Adventure or setting content. The validation campaign in `PRD.md` s.82 is deliberately generic
  and ships in feature 00 fixtures.

## Users and Context

### Primary user

A GM running Cairn 2e, and the players at that table. Cairn is chosen by GMs who want to prepare
lightly and run fast, so anything that adds ceremony to play defeats the reason they chose it.

### Secondary users

The development team, which uses this package as one half of the architectural proof in `PRD.md` s.89.

## User Stories

- As a GM, I want to select Cairn 2e and get a working character sheet, so that setup is not a project.
- As a player, I want to make a save against an attribute and see the result, so that the core
  mechanic works without me explaining it to the tool.
- As a player, I want damage to reduce hit protection and then my attributes, so that the system
  lethality is real rather than approximated.
- As a player, I want inventory slots enforced, so that encumbrance stays a decision.
- As a GM, I want the rules text available in the application, so that a lookup does not become
  a phone search.

## Functional Requirements

### P0 — MVP

- FR-001: Manifest identity and integration status per `PRD.md` s.9: mechanics supported,
  character sheet supported, rules text integrated, compendium integrated, external documentation.
  Each flag reflects what actually ships, not what is planned.
- FR-002: Licence manifest per `PRD.md` s.14: licence, source, version, attribution, redistribution
  status, translation status, brand usage status, with per-asset-class permissions.
- FR-003: Character schema per `PRD.md` s.10: STR, DEX, WIL, HP, Armor, inventory slots, Fatigue,
  Scars, and the identity fields a character needs.
- FR-004: Resource declarations for the consumable values in that list, using the feature 08
  resource shape (`current`, `min`, `max`, `temporary`, recovery, visibility).
- FR-005: Save action per `PRD.md` s.22: roll 1d20, succeed when the result is at or under the
  named attribute. Declared, not coded.
- FR-006: Damage flow: damage reduces HP first, then applies to an attribute, with the attendant
  consequences declared as effects from the feature 11 kinds.
- FR-007: Critical damage and scars declared as effects and conditions (`PRD.md` s.4, s.10).
- FR-008: Fatigue declared as an inventory-occupying condition, since that is how it interacts
  with slots.
- FR-009: Slot-based inventory declaration, consumed by the sheet in feature 15 and the
  move-inventory-item effect in feature 11.
- FR-010: Spellbook representation per `PRD.md` s.10, using existing contract primitives.
- FR-011: Rules text structured per `PRD.md` s.26 for feature 14, shipped only where FR-002
  permits redistribution. Where it does not, the manifest declares external documentation and the
  package ships references rather than text.
- FR-012: Game mode declarations the package supports, consumed by feature 02 (`PRD.md` s.49).
- FR-013: Passes the feature 08 conformance kit with no exception.
- FR-014: Capability declarations naming only mechanics from the feature 08 registry, never
  Cairn-specific keys.

### P1 — Important

- FR-101: Compendium content: equipment, creatures, and tables, once feature 08 FR-101 ships.
- FR-102: Character creation procedure declared as a guided flow.
- FR-103: Localization of package strings.

### P2 — Later

- FR-201: Mausritter as a separate package reusing the same primitives (`PRD.md` s.11).

## Behavioral Constraints

- Declarations only. Any executable code in this package is a defect (`PRD.md` s.15, s.75).
- No application code may reference this package by name outside `systems/` (`PRD.md` s.89),
  enforced by the guard in feature 00 FR-009.
- A mechanic that cannot be declared is a feature 08 contract gap and is escalated, not worked
  around. This rule is the entire value of building Cairn and Fate in the same wave.
- Rules text ships only where the licence manifest permits it. When redistribution is not
  permitted, the integration status must say so honestly (`PRD.md` s.9).
- The package version is immutable once published; corrections ship as a new version
  (`PRD.md` s.66).
- Mechanical support does not imply documentation rights and must not be presented as if it does.

## Data and Privacy Considerations

- The package is a static asset with no personal data.
- Third-party licensed content is involved. The licence manifest is a technical guardrail and does
  not replace legal review (`PRD.md` s.14). Shipping rules text without confirming rights is the
  one failure in this feature that cannot be fixed by a patch.
- Attribution required by the licence must be visible in the application, not only in a file.

## Success Signals

- `PRD.md` s.88 acceptance: a GM creates a Cairn campaign, creates a character, runs a session,
  rolls, manages an encounter, and looks up a rule.
- `PRD.md` s.89: the same generic pages render Cairn and Fate with no system branch.
- Zero contract changes made specifically for Cairn that Fate does not also exercise or that do
  not generalize.
- Rules lookup for a common Cairn rule completes in under 10 seconds (`PRD.md` s.78).

## Rollout

Wave 3, Track B, drafted in parallel with feature 13 during waves 1 and 2 so that contract gaps
surface while feature 08 can still absorb them cheaply. A draft manifest that does not yet validate
is more useful in wave 1 than a finished package in wave 3.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Rules text shipped without redistribution rights | Legal exposure and a forced removal after release | Licence verification before FR-011; manifest flags gate what ships; external documentation is a supported and honest fallback |
| A Cairn mechanic cannot be declared | Pressure to add application code and break `PRD.md` s.89 | Escalate as a feature 08 contract gap; both MVP packages drafted early to find gaps in wave 1 |
| Contract bent to fit Cairn first | Fate then needs a second bend, and the hypothesis fails quietly | Both packages drafted against the same contract simultaneously; a change motivated by one system triggers review |
| Damage-to-attribute flow modelled as a special case | The most distinctive Cairn mechanic becomes the first system conditional | Expressed with feature 11 effect kinds; if the kinds are insufficient, that is a feature 11 finding |
| Package used as the validation campaign | Test content mixed into a rules package | Validation content lives in feature 00 fixtures (`PRD.md` s.82) |

## ADR Candidates

None specific to this package. Contract-level decisions belong to feature 08. A licence decision
that constrains the product, such as choosing not to ship rules text at all, would be worth recording.

## Open Questions

- Ship only official SRD-derived text/data under the applicable Creative Commons terms, preserving
  attribution and share-alike obligations. Book artwork, layout, logos, and trademarks require
  separate permission and are excluded.
- TODO: Whether attribute damage and scars need condition duration, which depends on feature 11
  FR-101 and its open question about the condition model.
- TODO: Whether spellbooks need a compendium (feature 08 FR-101) or fit in inventory declarations.
- TODO: Which game modes from `PRD.md` s.49 Cairn declares.
