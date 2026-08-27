# PRD: System Package Contract and Registry

Source: `PRD.md` s.3, s.4, s.9, s.14, s.15, s.16, s.17, s.19, s.25, s.66, s.75, s.89.
Track: B. Depends on: contracts from feature 00 only. Owns `SystemRef`, `SystemSummary`,
`CapabilityKey`, and the full manifest shape that features 02, 12, 13, 14, 15, 19 consume.

## Problem

The product hypothesis is stated in `PRD.md` s.3: a role-playing system can be represented as
schema, resources, actions, rules, effects, compendiums, and capabilities, and if that is true,
mechanically unlike systems share one platform. The architectural rule that follows is s.4:
the core does not know how to play; systems do.

Nothing enforces that today. Without a contract, the first time Cairn needs inventory slots and
Fate needs Fate points, both leak into generic code as conditionals, and s.89 fails permanently.
This feature defines the contract that makes the hypothesis testable and the rule enforceable.

## Goals

- A system is a declarative package validated strictly at load, never executable code
  (`PRD.md` s.15, s.75).
- Generic pages read `capabilities`, `characterSchema`, and `actions`, and never a system identity
  (`PRD.md` s.89).
- Cairn and Fate can both be expressed in this contract with no contract change specific to either.
- Licence and provenance are declared per package, so redistribution status is explicit
  (`PRD.md` s.14).
- Campaigns pin a system version and the registry can serve more than one version at once
  (`PRD.md` s.66).

## Non-Goals

- The Cairn and Fate packages themselves. Features 12 and 13 own their content.
- Executable plugins and sandboxed runtimes (`PRD.md` s.25, deferred).
- A custom system builder or a public SDK (`PRD.md` s.73, s.74).
- Community package distribution, signing, or a marketplace.
- Rules text presentation. Feature 14 owns the library; this feature only carries the declaration.
- Formula evaluation and dice resolution. Features 09 and 10 own them; the manifest only references
  expressions by their contract type.

## Users and Context

### Primary user

The three developers, immediately. The manifest is the contract that keeps twenty features from
learning what a Fate point is.

### Secondary users

A GM, indirectly, through honest support levels at system selection (`PRD.md` s.9). A future
system author (`PRD.md` s.6), who is explicitly not a user in MVP but whose eventual existence is
the reason packages must be declarative rather than code.

## User Stories

- As a developer, I want a validated manifest describing a system, so that my generic page renders
  it without knowing which system it is.
- As a developer, I want capability flags, so that I can hide a feature a system does not have,
  without naming the system.
- As a GM, I want to see honestly what a system supports before selecting it, so that I do not
  find a gap in session three.
- As a maintainer, I want licence and redistribution status declared per package, so that shipping
  rules text is a checked decision rather than an assumption.
- As a maintainer, I want a bad package rejected at load, so that invalid data never reaches the domain.

## Functional Requirements

### P0 — MVP

- FR-001: `GameSystem` manifest per `PRD.md` s.15, expressed in TypeBox: `manifest`, `capabilities`,
  `characterSchema`, `resources`, `actions`, `mechanics`, `rules`, `compendiums`, `options`, `gameModes`.
- FR-002: `manifest` identity block: system id, version, display name, short description,
  complexity, supported languages, and the integration status fields in `PRD.md` s.9
  (mechanics supported, character sheet supported, rules text integrated, compendium integrated,
  external documentation).
- FR-003: Licence manifest per `PRD.md` s.14: licence, source, version, attribution, redistribution
  status, translation status, brand usage status, with per-asset-class permissions
  (rules text, mechanics, official artwork, official logo).
- FR-004: `CapabilityKey` registry: the closed set of capability keys generic features may query,
  with a documented meaning per key. Adding a key is a contract change under the feature 00 freeze
  process, which is exactly the friction that stops capability keys from becoming system names.
- FR-005: `characterSchema` declaration per `PRD.md` s.17: named fields with type, constraints,
  defaults, grouping, and display metadata, consumed by feature 15.
- FR-006: Resource declaration per `PRD.md` s.19: `current`, `min`, `max`, `temporary`,
  recovery rules, visibility. Mutation semantics belong to feature 11; this is the declaration.
- FR-007: Action declaration per `PRD.md` s.22: roll specification, success condition, outcome
  branches, referencing dice expressions (feature 09) and formulas (feature 10) by contract type
  only. This feature does not evaluate them.
- FR-008: Options and game mode declarations, consumed generically by the creation wizard in feature 02.
- FR-009: Strict validation of every package at load with TypeBox (`PRD.md` s.16, s.75). Invalid
  packages are rejected with a precise error and never partially loaded.
- FR-010: No executable code in a package. Declarations only. Loading a package must not evaluate
  anything (`PRD.md` s.15, s.75).
- FR-011: System registry: list installed systems, resolve `system-id@version`, and hold more than
  one version of the same system simultaneously so pinned campaigns keep working (`PRD.md` s.66).
- FR-012: Early-publish set, frozen in the first days of wave 1 so Track A and Track C stop
  building against fixtures as soon as possible: `SystemSummary` (consumed by feature 02),
  the `characterSchema` field shape (feature 15), and the `Condition` contract (features 11, 15, 19).
  These three are the only cross-track shapes this feature owns; publishing them early is what
  keeps the other two tracks from negotiating with Track B.
- FR-013: A conformance test kit that any system package runs against, so features 12 and 13 prove
  compliance without this feature knowing about them.

### P1 — Important

- FR-101: Compendium declaration and loading (`PRD.md` s.15), once a system needs one.
- FR-102: Manifest changelog per version, to support the review-changes step in feature 02 FR-011.
- FR-103: Package translation metadata beyond the licence status flag.

### P2 — Later

- FR-201: Package signing and trust (`PRD.md` s.73).
- FR-202: Executable plugin runtime with permission manifest and resource limits (`PRD.md` s.25).
- FR-203: Public system SDK (`PRD.md` s.73).

## Behavioral Constraints

- Packages are untrusted input, including first-party ones (`PRD.md` s.75). They are validated the
  same way regardless of origin.
- No `eval`, no dynamic import, no arbitrary execution at load (`PRD.md` s.24, s.75).
- Capability keys describe mechanics, not systems. A key named for a system, or a key with exactly
  one system using it and no plausible second, fails review, because that is a system conditional
  wearing a different name.
- Mechanical support never implies documentation redistribution rights (`PRD.md` s.9). The two are
  separate fields and the interface must present them separately.
- A system version is immutable once published. Changes ship as a new version (`PRD.md` s.66).
- The registry does not decide which system a campaign uses; feature 02 pins it.

## Data and Privacy Considerations

- Packages contain licensed third-party content. The licence manifest is a technical guardrail and
  does not replace legal review (`PRD.md` s.14), and the interface must not imply otherwise.
- No personal data. Packages are static assets shipped with the application in MVP.
- Rules text redistribution is governed per package by FR-003, and features 12, 13, and 14 must
  honour those flags rather than assuming.

## Success Signals

- `PRD.md` s.89, the central architectural acceptance criterion: character, session, encounter and
  rules pages work with both Cairn and Fate with no branch on system identity. Enforced by the
  architecture guard in feature 00 FR-009.
- Features 12 and 13 are expressed entirely in this contract with no contract change made
  specifically for either of them. A change made for one system is the hypothesis failing.
- An invalid package is rejected at load with an actionable message, in every test case.
- Feature 02 renders the selection screen from `SystemSummary` alone.

## Rollout

Wave 1, Track B, and the first thing Track B ships because features 02, 12, 13, 15, and 19 read it.
`SystemSummary` and `CapabilityKey` are published in the first days of wave 1 so consumers stop
using fixtures early; the full manifest can settle afterwards.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Contract shaped around Cairn, then bent for Fate | The core hypothesis in `PRD.md` s.3 fails and the platform becomes single-system | Build the contract against both MVP systems at once; a contract change motivated by exactly one system triggers a design review, not a merge |
| Capability keys degenerate into system aliases | s.89 satisfied on paper, violated in practice | Closed registry with documented meanings (FR-004); freeze process makes adding one deliberate |
| Manifest becomes a dumping ground for anything a system needs | Untestable, unimplementable contract | Every field must be consumed by a named feature; unconsumed fields are removed |
| Licence flags declared but not enforced by consumers | Redistribution of material without rights | Features 12, 13, 14 assert against the flags; conformance kit (FR-013) covers it |
| Declarative-only proves insufficient for a real system | Pressure to allow executable packages in MVP | Cairn and Fate are the MVP proof; if a required mechanic cannot be declared, that is a finding for the tech spec, not an unplanned runtime |

## ADR Candidates

- Declarative-only system packages with no arbitrary execution, versus an executable plugin runtime
  (`PRD.md` s.15, s.25). Registered in s.91 context; the alternative is live for V3, so the boundary
  and its reasoning deserve a record.
- Capability flags as the mechanism for generic feature gating, versus system identity checks
  (`PRD.md` s.89).

## Open Questions

- TODO: The seed set of `CapabilityKey` values. Derivable only from features 12 and 13 in draft;
  expected to settle during wave 1 with both systems drafted in parallel.
- TODO: Whether `mechanics` in `PRD.md` s.15 is distinct from `actions` and `resources`, or a
  grouping of them. The source PRD lists it separately without defining it.
- TODO: How multiple versions of one system are stored and addressed in the registry.
- TODO: Whether compendiums are in MVP at all. `PRD.md` s.68 does not list them; s.15 includes the field.
