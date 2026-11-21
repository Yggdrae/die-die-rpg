# Task 03: Table and authority service

Status: completed (2026-10-31)

## Scope

- Migration `0014_dice_rolls` (table, function, CHECKs, publication, grant); drizzle schema; `@rpg/dice/postgres`.
- `PostgresRollRepository`, `RollService` (D-10, D-12, D-14).

## Acceptance Criteria

- "Required Data Tests" CHECK rows pass on PostgreSQL.
- A resend with identical content is accepted without a second row; a different one is refused.

## Verification

```bash
bun run db:migrate
bun test packages/dice
```
