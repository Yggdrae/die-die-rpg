# Task 05: Conformance kit and two-paradigm proof

Status: completed (2026-10-30)

## Scope

- `@rpg/systems/testing`: `runConformance(candidate)`, named checks with offending paths.
- Two contract fixtures in the tests, named for neither real system, carrying every mechanic `PRD.md` s.10 lists:
  - slot-based rules-light: three attributes, protection pool, armour, slot inventory, fatigue occupying slots,
    scars, target-under save, spillover damage effects;
  - aspect-based narrative: typed free-text entries, skills on a ladder, spendable points, stress box tracks,
    consequence slots with severity holding free text, 4dF-plus-skill actions with margin branches and table
    choices.

## Acceptance Criteria

- Both fixtures pass with no field or capability used only because of its name.
- Every kit check has a failing fixture proving it fires.
- A test asserts the kit source holds no system identifier.
- Any shape these fixtures need beyond the techspec is a recorded contract decision, not a local patch.

## Verification

```bash
bun test packages/systems
```
