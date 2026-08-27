# PRD: Dice Engine

Source: `PRD.md` s.20, s.21, s.68, s.69, s.76, s.88.
Track: B. Depends on: contracts from feature 00 only. Deliberately independent of feature 10
(`PRD.md` s.20: the dice parser must be independent of the Formula Engine).

## Problem

Rolling dice is the single most frequent operation in the product and the one users judge it by.
It must be correct, fast, offline, and honest. It must also express notation that differs
sharply between systems: Cairn rolls a d20 under an attribute, Fate rolls four Fudge dice, a
dice-pool system counts successes (`PRD.md` s.20).

The trap is coupling. If the dice engine resolves attribute references itself, it needs a
character, which needs a system, which needs a campaign, and the most reusable component in the
product becomes the least testable. `PRD.md` s.20 draws the line: the parser is independent.

## Goals

- Any MVP system expresses its rolls in one notation, with no system-specific dice code.
- A roll is a pure function of expression, inputs, and randomness, so it is fully unit testable
  and reproducible under a seed.
- Rolling works offline with no server participation (`PRD.md` s.76).
- A roll result carries enough context to be displayed, audited, and hidden correctly
  (`PRD.md` s.21).

## Non-Goals

- Formula evaluation. Feature 10 owns it. The dice engine receives already-resolved numeric inputs.
- Deciding whether a roll succeeded. Feature 11 owns success conditions and outcomes.
- Dice animation, 3D dice, or physics. Ephemeral realtime is V1 (`PRD.md` s.56).
- Server-authoritative or verifiable-fairness rolling.
- A macro language or user-authored roll scripts.

## Users and Context

### Primary user

Everyone at the table. A GM rolling hidden, a player rolling in the open, both mid-conversation,
both expecting an instant answer.

### Secondary users

Features 11, 15, 18, and 19, which trigger rolls, and the two system packages, which declare them.

## User Stories

- As a player, I want to roll from my sheet and see the result immediately, so that the flow of
  play is not interrupted.
- As a GM, I want to roll privately, so that the table does not learn from my face or my screen
  (`PRD.md` s.21).
- As a player, I want to see the individual dice, not only the total, so that I can check the maths.
- As a GM, I want a roll to record what it was for, so that the session log means something later.
- As a developer, I want deterministic rolls under a seed, so that tests are not flaky.

## Functional Requirements

### P0 — MVP

- FR-001: Die types per `PRD.md` s.20: d4, d6, d8, d10, d12, d20, d100, dF.
- FR-002: Expression notation covering the examples in `PRD.md` s.20: `1d20`, `2d6+3`, `4d6kh3`,
  `1d20+ATTRIBUTE_A`, `4dF`, `6d6 success>=6`.
- FR-003: Operations required by those examples: multiple dice, flat modifiers, keep highest and
  keep lowest, and success counting against a threshold.
- FR-004: Named references in an expression (`ATTRIBUTE_A`) are resolved by the caller and passed
  in as a value map. The engine does not read a character, a system, or a formula
  (`PRD.md` s.20 independence rule).
- FR-005: Parse and evaluate as separate steps, so an invalid expression is rejected at package
  validation time (feature 08) rather than at the table.
- FR-006: Result detail: every die face rolled, which dice were kept or dropped, modifiers applied,
  natural result, and modified result (`PRD.md` s.21).
- FR-007: Roll context per `PRD.md` s.21: actor, target, action, expression, visibility, natural
  result, modified result, timestamp, session.
- FR-008: Roll visibility per `PRD.md` s.21: public, GM only, player only, blind, whisper.
  Enforcement is by feature 04 and feature 03; this feature carries the value and never resolves it.
- FR-009: Roll records persist through `SyncedRepository` and are available offline
  (`PRD.md` s.76).
- FR-010: Injectable randomness source, seeded and deterministic in tests, cryptographically
  adequate in production.
- FR-011: Bounds on dice count and expression size, so a pasted or malformed expression cannot
  hang a client. Rejected at parse, not at evaluation.
- FR-012: A published module API for evaluating an expression and recording a roll, consumed by
  features 11, 15, 18, 19.

### P1 — Important

- FR-101: Exploding dice, rerolls, and drop-lowest variants, when a P1 system needs them
  (`PRD.md` s.11, s.12).
- FR-102: Dice pool result grouping for Year Zero style systems (`PRD.md` s.12).
- FR-103: Advantage and disadvantage style paired rolls for a d20 system (`PRD.md` s.11).

### P2 — Later

- FR-201: Server-verified rolls, if a trust problem is ever demonstrated.
- FR-202: User-authored roll macros.

## Behavioral Constraints

- The engine is pure apart from its injected randomness source. No input from network, storage,
  clock, or global state.
- No branch on system identity. Notation is the only interface (`PRD.md` s.89).
- The engine does not evaluate formulas, read character state, or decide success. Those crossings
  are the specific coupling `PRD.md` s.20 forbids.
- A roll must be recorded exactly once. A retried synchronization must not produce a second roll,
  because a duplicated roll changes the fiction.
- Blind and GM-only rolls must never reach an unauthorized client, which means the visibility value
  must be set at creation and honoured by the sync rules, not applied when rendering.
- Expression parsing must reject rather than guess. A silently reinterpreted expression is worse
  than an error.

## Data and Privacy Considerations

- A hidden roll is genuinely hidden: the record must not synchronize to player devices at all
  (`PRD.md` s.34), because a filtered-out row in a local database is not hidden.
- Roll history is campaign content and follows campaign retention.
- Roll volume is high; roll records are the most likely source of local database growth and must
  be considered against the cold-start budget in `PRD.md` s.79.

## Success Signals

- Both MVP systems express every one of their MVP rolls in this notation with no engine change
  specific to either (`PRD.md` s.89).
- A player rolls from the sheet and sees a result with no perceptible delay, offline.
- Zero blind or GM-only rolls present in a player local database, asserted by test.
- Deterministic seeded runs reproduce identical results across platforms.

## Rollout

Wave 1, Track B, alongside the system package contract, because features 11, 15, and 18 all
consume it and it has no dependency of its own beyond feature 00. Publishing `RollRequest` and
`RollResult` early is more valuable than completing the notation surface.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Notation grows to cover every system in `PRD.md` s.11 to s.13 speculatively | A parser nobody can maintain, for systems not being built | MVP notation covers only what Cairn and Fate declare, plus the s.20 examples; extensions arrive with the system that needs them |
| Attribute resolution creeps into the engine | The independence rule in s.20 is lost and the engine becomes untestable | Caller supplies a value map (FR-004); architecture guard from feature 00 FR-009 |
| Hidden rolls leak through sync | The GM screen becomes transparent, which is a product failure | Visibility set at creation (FR-008), enforced in sync rules by feature 04; explicit test |
| Duplicate roll records on sync retry | The fiction changes retroactively | Idempotent roll identity generated client-side before queueing |
| Roll volume degrades local database performance | s.79 cold start regression | Measure roll growth in the validation campaign; retention decided with feature 06 |

## ADR Candidates

- Client-side rolling with no server verification, versus server-authoritative rolls. The product
  is a trust-based tabletop tool, so client-side is right, and recording why prevents a later
  reflexive change.

## Open Questions

- TODO: Exact notation grammar beyond the `PRD.md` s.20 examples, settled with features 12 and 13
  in draft.
- TODO: Whether roll records live in the audit log (feature 06), the session log (feature 18), or
  their own store read by both. Affects volume and retention.
- TODO: Rounding and ordering rules for combined modifiers, needed for determinism across clients.
