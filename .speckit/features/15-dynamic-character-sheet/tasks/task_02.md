# Task 02: Persistence, policies, and sync streams

Status: completed (2026-11-03)

## Scope

- Migration `0016_characters` (`characters`, `character_secrets`), publication, and grants.
- `CHARACTER_POLICY` (owner or GM role edits and deletes) and `CHARACTER_SECRET_POLICY` (GM roles only).
- `authorized_characters` stream and the long-text hold branch for class `character`.

## Acceptance Criteria

- The compiled streams match `infra/powersync/sync-config.yaml` (drift gate).
- A player's stream never carries a secret row.

## Verification

```bash
bun run db:migrate
bun test apps/api/src/modules/sync
```
