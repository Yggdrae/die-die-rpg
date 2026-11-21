# Task 03: Marks authority, migration, and stream

Status: completed (2026-11-06)

## Scope

- Schema and migration `0019_rules_section_marks` (publication, grant), `PostgresRulesMarkRepository`,
  `RulesMarkService`, `RulesMarkSyncMutationApplier` in `apps/api/src/modules/rules`, runtime registration.
- Policy registered; stream `authorized_rules_marks` compiled into `infra/powersync/sync-config.yaml`; sync, audit-sync,
  and publication tests updated.

## Acceptance Criteria

- Only the owner reads or writes a mark; observer none; another user's ID or a derived-ID mismatch is refused.
- An undeclared section is refused; a stale update or a duplicate insert merges and is accepted.
- The compiled stream holds only the requester's own rows.

## Verification

```bash
bun test apps/api/src/modules/rules apps/api/src/modules/sync packages/sync
```

## Evidence (2026-11-06)

- Migration `0019_rules_section_marks` (publication, grant), `packages/rules/src/infra/postgres`, `application.ts`,
  `apps/api/src/modules/rules/appliers.ts`, runtime registration, stream `authorized_rules_marks` (compiled).
- `apps/api/src/modules/rules/rules.integration.test.ts`: 4 tests (owner only, GM refused on a player's mark, stream
  returns own rows, not audited; derived-ID, undeclared section, delete, envelope refused; two devices merge, resend
  idempotent, never a conflict; CHECKs).
- `sync-config`, `audit-sync`, and publication tests updated and passing.
