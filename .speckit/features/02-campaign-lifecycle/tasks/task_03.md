# Task 03: Campaign application services and context resolver

Status: pending. Depends on tasks 01–02.

## Scope

- Implement atomic create, list/get, detail update, soft delete, settings, and context use cases.
- Enforce expected versions and immutable P0 system/module pins outside dedicated update flow.
- Integrate owner participant and non-blocking `AuditRecorder`.
- Test idempotent create and business failure mapping.

## Acceptance Criteria

- Detail/setting writes cannot alter pins or other namespaces.
- Tombstoned campaigns resolve no context and disappear from default lists.
- Duplicate create retry matches/returns one campaign; conflicting payload rejects.

## Verification

```bash
bun test packages/campaigns
bun run typecheck
```

