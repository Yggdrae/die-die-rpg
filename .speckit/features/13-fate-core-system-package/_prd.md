# PRD: Fate Core System Package

Source: `PRD.md` s.10 (P0), s.9, s.14, s.15, s.22, s.27, s.47, s.68, s.88, s.89.
Track: B. Depends on: the manifest contract from feature 08. Declarative content only, no application code.

## Problem

Fate Core is the second half of the architectural proof (`PRD.md` s.3, s.10). It is chosen
precisely because it shares almost nothing with Cairn: aspects are free text that matter
mechanically, skills replace attributes, stress is a set of boxes rather than a pool,
consequences are named conditions with a cost, and Fate points are a currency players spend.

A platform that runs both without knowing which one it is running has demonstrated the hypothesis.
A platform that needs one conditional has disproved it (`PRD.md` s.89). Fate is where that breaks
first, because narrative mechanics do not fit the numeric assumptions a rules-light system invites.

## Goals

- Fate Core is playable end to end using only declarations from the feature 08 contract.
- The generic surfaces render Fate with no code that names Fate (`PRD.md` s.89).
- Narrative mechanics, specifically aspects and consequences, are expressible without a special case.
- Any contract gap is escalated to feature 08 rather than patched locally.

## Non-Goals

- Application logic. This package is data.
- Fate Accelerated and Fate Condensed (`PRD.md` s.11, V1), though the contract should not make
  them harder later.
- The four-action outcome automation beyond declaring the actions. `PRD.md` s.27 keeps narrative
  control with the table.
- Redistributing any asset the licence does not permit (`PRD.md` s.14).
- Setting or adventure content.

## Users and Context

### Primary user

A GM running Fate Core and their players. Fate tables spend more time talking than calculating,
so the tool must stay out of the way and must not push the table toward a tactical rhythm
(`PRD.md` s.5.5).

### Secondary users

The development team, which uses this package to falsify or confirm the architecture.

## User Stories

- As a player, I want my aspects visible and invocable, so that the central mechanic of the system
  is present rather than a note field.
- As a player, I want to spend and gain Fate points, so that the economy is tracked without a bowl
  of tokens.
- As a player, I want to mark stress boxes and take consequences, so that harm works the way the
  system describes.
- As a player, I want to roll four Fudge dice plus a skill and read the margin, so that the core
  roll is native (`PRD.md` s.22).
- As a GM, I want the four actions available, so that resolution follows the system rather than my memory.

## Functional Requirements

### P0 — MVP

- FR-001: Manifest identity and integration status per `PRD.md` s.9.
- FR-002: Licence manifest per `PRD.md` s.14, with per-asset-class permissions.
- FR-003: Character schema per `PRD.md` s.10: aspects, skills, Fate points, stress, consequences,
  plus identity fields.
- FR-004: Aspects declared as structured repeatable text entries with a type, since a high concept
  and a situation aspect differ in lifetime, not in shape.
- FR-005: Skills declared with the system rating ladder, consumed generically by the sheet.
- FR-006: Fate points declared as a resource using the feature 08 resource shape.
- FR-007: Stress declared as marked boxes rather than a numeric pool, because collapsing it to a
  number would change the system. If the feature 08 resource shape cannot express boxes, that is
  a contract gap to escalate, not a modelling compromise.
- FR-008: Consequences declared as slots with severity, each holding an aspect, linking the
  consequence model to the aspect model rather than duplicating it.
- FR-009: The four actions per `PRD.md` s.10 and s.22: overcome, create advantage, attack, defend,
  each declared with a 4dF plus skill roll and outcome branches read from the margin.
- FR-010: Outcome branches expressing the system degrees of result, including the shift margin
  shown in `PRD.md` s.27, offered as options to the table rather than applied automatically.
- FR-011: Effects for marking stress, taking a consequence, and spending or gaining a Fate point,
  using the feature 11 effect kinds.
- FR-012: Rules text structured per `PRD.md` s.26 for feature 14, shipped only where FR-002 permits.
- FR-013: Game mode declarations, consumed by feature 02 (`PRD.md` s.49).
- FR-014: Passes the feature 08 conformance kit with no exception.
- FR-015: Capability declarations naming only mechanics from the feature 08 registry, never
  Fate-specific keys.

### P1 — Important

- FR-101: Compendium content such as stunt examples, once feature 08 FR-101 ships.
- FR-102: Character creation procedure including the phase trio, declared as a guided flow.
- FR-103: Fate Accelerated and Fate Condensed as separate packages reusing these primitives
  (`PRD.md` s.11).

### P2 — Later

- FR-201: Aspect invocation tracking across a scene, if the table demonstrates a need.

## Behavioral Constraints

- Declarations only. Executable code in this package is a defect (`PRD.md` s.15, s.75).
- No application code may reference this package by name outside `systems/` (`PRD.md` s.89).
- A mechanic that cannot be declared is escalated to feature 08 as a contract gap. Fate is the
  system most likely to find one, which is why it is drafted in wave 1 rather than built in wave 3.
- The application must not resolve fiction. A successful attack offers stress, consequence, or
  concede as choices; it does not pick one (`PRD.md` s.27).
- Aspects are mechanically meaningful free text. Treating them as decorative notes fails the system,
  and treating them as an enumeration fails it differently.
- Rules text ships only where the licence permits, with honest integration status (`PRD.md` s.9).
- The package version is immutable once published (`PRD.md` s.66).

## Data and Privacy Considerations

- Static asset, no personal data.
- Third-party licensed content. The licence manifest does not replace legal review (`PRD.md` s.14).
- Required attribution must be visible in the application.

## Success Signals

- `PRD.md` s.88 acceptance passes for a Fate campaign end to end.
- `PRD.md` s.89: the same generic pages render Cairn and Fate with no system branch. This package
  is the harder half of that test.
- The combat tracker in `PRD.md` s.47 shows stress and consequences for Fate and hit protection
  for Cairn from capability declarations alone.
- Zero contract changes made specifically for Fate that do not generalize.

## Rollout

Wave 3, Track B, drafted in parallel with feature 12 during waves 1 and 2. Fate is the more likely
source of contract gaps, so its draft should lead rather than follow: a gap found in wave 1 is a
contract edit, the same gap found in wave 3 is a redesign across features 08, 11, and 15.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Stress boxes and consequences do not fit the resource contract | The clean modelling choice is a numeric pool, which changes the system, or a special case, which breaks `PRD.md` s.89 | Draft this in wave 1 while feature 08 is still open; escalate as a contract gap (FR-007) |
| Aspects modelled as plain notes | The defining mechanic of the system is decorative and the validation is worthless | Structured repeatable entries with type (FR-004); validated by playing the sandbox campaign |
| Rules text shipped without redistribution rights | Legal exposure and forced removal | Licence verification before FR-012; manifest flags gate what ships |
| Outcome branches automate narrative decisions | Contradicts `PRD.md` s.27 and alienates the audience the system serves | Outcomes are offered as options; application is a table decision (FR-010) |
| Fate drafted after Cairn | The contract is shaped by the simpler system and Fate becomes a series of exceptions | Both drafted simultaneously in wave 1; this is the reason the wave plan pairs them |

## ADR Candidates

None specific to this package. If stress boxes force a contract change, that decision belongs in
feature 08 and is worth an ADR there, since it shapes every future system with non-pool harm tracks.

## Open Questions

- Ship only official CC-BY SRD-derived text/data with required attribution. Book artwork, layout,
  logos, and trademarks require separate permission and are excluded.
- TODO: Whether the feature 08 resource shape can express stress boxes, or whether a track
  primitive is needed. Answer this in wave 1; it is the single highest-value contract question
  in the MVP.
- TODO: Whether consequences need their own contract primitive or compose from aspect plus resource.
- TODO: Which game modes from `PRD.md` s.49 Fate Core declares.
