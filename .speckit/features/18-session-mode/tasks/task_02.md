# Task 02: Authority service, appliers, sync stream, and audit

Status: completed (2026-11-04)

## Scope

- `SessionService` and the three appliers (`apps/api/src/modules/sessions`), registered in the runtime.
- Policies and stream `authorized_sessions` registered and compiled (`sync-config.yaml`, drift-gated).
- Audit declarations registered with feature 06.

## Acceptance Criteria

- Numbering, one open session, transitions, version conflicts, and entry rules hold at the authority.
- Players and observers are refused every write with `not_found_or_forbidden`.
- A retried start records one `session.started`.

## Verification

```bash
bun test apps/api/src/modules/sessions apps/api/src/modules/sync/sync-config.integration.test.ts
```
