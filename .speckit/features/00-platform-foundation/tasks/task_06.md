# Task 06: Fixtures Package

## Goal

A complete sandbox campaign that any feature can build and demonstrate against with no other
feature implemented and no API running.

## Dependencies

- Task 03

## Context

- PRD: `../_prd.md` (FR-005)
- Source content: `PRD.md` s.82 to s.85, the sandbox campaign "The Missing Caravan".
- `../_index.md`, rule 7: until a dependency ships, build against fixtures. Never against a branch
  owned by another developer. This task is what makes that rule possible.

## Scope

### Change

- `packages/fixtures/`, depending on `packages/contracts` only.
- Sandbox campaign from `PRD.md` s.82: 5 locations, 6 NPCs, 5 items, a party of 2, one GM,
  two players.
- A fixture character schema, deliberately **not** Cairn and **not** Fate.
- A fixture rules tree, same constraint.
- A mix of visibility values across the content, including GM-only records, so features can test
  filtering rather than assuming everything is public.
- Tests asserting every fixture validates against the contracts it claims to satisfy.

### Do Not Change

- Do not model the fixture schema on either MVP system. A fixture that resembles Cairn lets
  Track C build hidden system assumptions that pass every test until wave 3.
- Do not include Cairn or Fate rules text. Licensing is unresolved (features 12, 13).
- Do not add a seed command. That is FR-102, P1, and explicitly outside the freeze gate.

## Acceptance Criteria

- [ ] Every fixture record validates against its contract; CI fails if one does not.
- [ ] The fixture character schema exercises enough of the `PRD.md` s.18 component vocabulary for
      feature 15 to build a real sheet against it.
- [ ] Fixture content includes GM-only, everyone, and specific-player visibility values.
- [ ] Fixture actors cover all five roles from `Role`.
- [ ] Content is recognizably disposable and matches `PRD.md` s.81: no resemblance to a real
      campaign, no spoilers, nothing anyone would mind being public.
- [ ] A feature can import fixtures and render against them with the API stack stopped.

## Verification

```bash
bun test packages/fixtures && bun run typecheck
```

## Notes

- A fixture that does not validate is worse than no fixture, because features build against it and
  inherit the error. That is why validation is a CI gate and not a convention.
- The "not Cairn, not Fate" constraint is the whole point of this task. It is the cheapest
  available test of the `PRD.md` s.89 architectural criterion, three waves before the real one.
