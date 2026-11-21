# Task 01: Quick rules contract and fixture rules tree

Status: completed (2026-11-06)

## Scope

- Feature 08 `RulesDeclaration`: optional section `summary` (at most 500 characters); `integrated_rules` evidence and
  licence gating count it (D-05). Contract-change note in `00-platform-foundation/`.
- `@rpg/fixtures`: `FIXTURE_RULES` becomes a `rules` declaration of invented text, shipped by
  `FIXTURE_SYSTEM_PACKAGE` with `rulesText: allowed`, `integrated_rules`, `rulesTextIntegrated: true` (D-17).

## Acceptance Criteria

- A summary under a licence that is not `allowed` is refused at load; a summary alone makes the package integrated.
- The fixture package passes the conformance kit and declares quick rules and cross-references.

## Verification

```bash
bun test packages/systems packages/fixtures systems
```

## Evidence (2026-11-06)

- `packages/systems/src/schema.ts` (`summary`), `semantics.ts` (evidence counts it); note
  `00-platform-foundation/2026-11-06-rules-quick-summary-contract-change.md`.
- `packages/fixtures/src/rules.ts` (7 invented sections, 2 quick rules, cross-references), shipped by the fixture package.
- `packages/systems/src/systems.test.ts`: a quick rule alone integrates, is licence-gated, and is bounded; fixture
  conformance and summary tests pass.
