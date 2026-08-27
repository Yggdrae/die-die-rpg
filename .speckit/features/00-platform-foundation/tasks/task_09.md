# Task 09: Architecture Guard and Code Ownership

## Goal

CI fails when someone branches on a system identity or imports another feature internals, so the
two rules the whole plan depends on are enforced by the build rather than by review vigilance.

## Dependencies

- Task 01, Task 07

## Context

- PRD: `../_prd.md` (FR-007, FR-009)
- `PRD.md` s.89: the central architectural acceptance criterion. Generic pages must work with both
  MVP systems with no branch on system identifier.
- `../_index.md`, rules 1 to 4.

## Scope

### Change

- `tools/guard/`: a repository-wide check with three rules.
  - A file outside `systems/` and `packages/fixtures/` must not reference a concrete system
    identifier.
  - A feature module must not import internals of another feature module. Contracts only.
  - A package must not import an application.
- Guard test fixtures that are *expected to fail*, one per rule.
- Guard wired into the CI workflow from task 02.
- `CODEOWNERS` mapping each feature directory to its track, so a cross-feature change requires
  cross-track review.

### Do Not Change

- Do not enforce style, naming, or file layout. Biome owns style; this guard owns architecture.
- Do not add rules speculatively. Three rules, each traceable to a stated requirement.
- Do not exempt directories to make the guard pass. An exemption is a finding, not a fix.

## Acceptance Criteria

- [ ] Each of the three rules is demonstrated failing against a deliberately violating fixture.
      A guard that has never failed has not been tested.
- [ ] The guard runs in CI and a violation blocks the merge.
- [ ] The guard passes on the repository as it stands at the end of wave 0.
- [ ] Violation output names the offending file, the rule, and what to do instead.
- [ ] `CODEOWNERS` covers every `.speckit/features/*` directory and every source directory that
      exists at the freeze.

## Verification

```bash
bun test tools/guard && bun run check
```

## Notes

- The system-identity rule is the one that matters most and the one most likely to be worked
  around under deadline pressure in features 15, 18, and 19. Make its failure message explain the
  alternative — read `system.capabilities` — rather than only reporting a violation.
- The guard cannot detect every violation. It raises the cost of the obvious ones, which is enough
  to keep the pattern visible in review.
