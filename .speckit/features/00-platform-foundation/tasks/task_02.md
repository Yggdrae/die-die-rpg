# Task 02: CI Pipeline

## Goal

Every pull request runs lint, typecheck, tests, and build, and a failure blocks the merge.

## Dependencies

- Task 01 (scripts must exist)

## Context

- PRD: `../_prd.md` (FR-006)
- TechSpec: `../_techspec.md` (Testing Strategy)
- `docs/SPEC_GUIDELINE.md`, Tests and Gates: full gates before merge are lint, typecheck, tests,
  build, and critical E2E when applicable. There is no E2E yet.

## Scope

### Change

- CI workflow running the four verification scripts on pull requests and on the default branch.
- Branch protection requiring the workflow to pass.
- Dependency caching so the pipeline stays fast enough that developers do not route around it.

### Do Not Change

- No deployment, release, or publish steps. Nothing is deployed in the MVP wave plan.
- No coverage threshold gate. `docs/SPEC_GUIDELINE.md` explicitly rejects a global coverage
  percentage as a quality substitute.
- No E2E job. Playwright arrives with the first user-facing flow.

## Acceptance Criteria

- [ ] Workflow triggers on pull request and on push to the default branch.
- [ ] All four scripts run and a failure in any one fails the pipeline.
- [ ] A deliberately broken commit (a type error) is demonstrated to fail CI.
- [ ] Pipeline completes fast enough to be usable per pull request; if it does not, cache first
      rather than dropping a gate.

## Verification

```bash
git push origin HEAD --set-upstream
```

Then confirm in the pipeline run that all four steps executed, and that the deliberate-failure
branch is red.

## Notes

- The architecture guard (task 09) is added to this pipeline when it exists. Leave the workflow
  easy to extend with one more step.

## Outcome

Verified on PR #1 (2026-08-27). `bun run check` failed on a deliberate `any`, the job exited 1,
the merge was blocked. Install 1.3 s, lint 81 ms.

Two changes came out of that first run:

- The pipeline was fail-fast, so only the first broken gate was reported. Every gate now runs
  independently (`if: always()`), gated on install succeeding. Fixing a broken branch no longer
  costs one push per gate.
- `actions/checkout` bumped v4 to v5, clearing the Node 20 deprecation warning.

Branch protection was enabled on 2026-08-27. `main` requires the strict `gates` status check,
including for administrators.
