# Task 11: Freeze — Decisions, ADR, Tag

## Goal

The contract surface is frozen, the two open decisions are recorded, ADR-001 is written, and the
tag that starts the three tracks is announced.

## Dependencies

- Tasks 02, 04, 05, 06, 09, 10

## Context

- PRD: `../_prd.md` (FR-008, FR-012, FR-013)
- TechSpec: `../_techspec.md` (ADRs, Decisions recorded at freeze)
- `../_index.md`, Definition of Ready. This task closes that gate.
- After this tag, a contract change costs a written note and one reviewer per track, same working
  day (PRD FR-008).

## Scope

### Change

- Reconcile the task 10 findings against the contracts. A sync no-go redrafts `SyncedRepository`
  before the tag, not after.
- Record the long-text concurrency decision (FR-012): single-writer, or optimistic concurrency
  with the shared conflict surface.
- Record the local database size budget (FR-013), measured against the fixture campaign.
- Write `adrs/ADR-001-optimistic-concurrency.md` using
  `.agents/skills/create-prd/references/adr-template.md`.
- Write the contract-change process note in this directory: what requires one, who reviews, and
  the one-working-day expectation.
- Delete `spike/`.
- Tag the commit and announce it.

### Do Not Change

- Do not start any wave 1 feature work in this task.
- Do not write FR-101 or FR-102. They are P1 and land after the tracks are running.
- Do not fill the `CapabilityKey` union. Feature 08 owns it in wave 1.

## Acceptance Criteria

- [x] Every line of the Definition of Ready in `../_index.md` is satisfied or explicitly waived
      with a reason.
- [x] Task 10 findings are reconciled; if sync was no-go, the redraft is committed before the tag.
- [x] FR-012 and FR-013 decisions are recorded where a wave 1 developer will find them without
      asking.
- [x] ADR-001 states the decision, the last-write-wins alternative, and why it was rejected
      (`PRD.md` s.57, s.80).
- [x] `spike/` no longer exists in the tree.
- [x] Tag exists and is announced with a pointer to `../_index.md`.
- [x] The five product decisions in `../_index.md` are answered, or the features they block are
      explicitly flagged as starting with an open dependency. The licence question is the one most
      likely to still be open; if so, features 12, 13, and 14 start knowing it.

## Verification

```bash
bun install && bun run check && bun run typecheck && bun test && bun run build
```

from a clean clone at the tag. Then confirm a feature can be scaffolded importing
`packages/contracts` and `packages/fixtures` with the API stack stopped.

## Notes

- This is a decision-recording task, not a build task. Its output is that three developers can
  work for four waves without asking each other a question.
- If something on the gate is not met, say so and waive it deliberately with a written reason.
  A silently unmet gate is discovered in wave 3, by which time it is expensive.

## Outcome

Completed on 2026-08-27. Freeze tag: `platform-foundation-freeze-2026-08-27`.

- Sync and search spikes are both GO; the deferred conflict channel was added before freeze.
- FR-012 uses single-writer long text with explicit takeover. FR-013 budgets 60 MB per campaign.
- Product decisions are recorded in `../freeze-decisions.md` and `../../_index.md`.
- `main` branch protection requires the strict `gates` status check, including for administrators.
- Full local gates pass: Biome checked 51 files, five workspaces typechecked, 106 tests passed,
  and both application builds passed.
- A temporary workspace scaffold imported `@rpg/contracts` and `@rpg/fixtures` while the API was
  stopped, then was removed.
