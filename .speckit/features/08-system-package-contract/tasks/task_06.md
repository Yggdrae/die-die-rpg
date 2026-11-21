# Task 06: Campaign and fixture migration

Status: completed (2026-10-30)

## Scope

- `@rpg/campaigns` re-exports the moved schemas and depends on `@rpg/systems`.
- `packages/fixtures`: `FIXTURE_SYSTEM_PACKAGE` passing the kit; `FIXTURE_SYSTEM_DEFINITION` derived from it;
  `FIXTURE_CHARACTER_SCHEMA` becomes the real shape, still neither MVP system.

## Acceptance Criteria

- BDD "Campaign Integration": existing feature 02 and 07 suites pass unchanged.
- `FIXTURE_SYSTEM_DEFINITION` deep equals the literal it replaces.
- The character schema's `measure-fixture-size` consumer still runs.
- Browser build holds no Node API from `@rpg/systems`.

## Verification

```bash
bun test packages/campaigns packages/fixtures apps/api/src/campaign-lifecycle.integration.test.ts
bun run build
```
