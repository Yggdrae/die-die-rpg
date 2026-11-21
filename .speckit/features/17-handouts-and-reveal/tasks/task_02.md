# Task 02: Queued reveal at the authority

Status: completed (2026-11-03)

## Scope

- `EntityVisibilityChange` schema. `EntitySyncMutationApplier` hands an update carrying it (and no envelope) to
  feature 04 `VisibilityService.change`, with the mutation ID as the audit origin.
- `EntityService.readable` for the conflict response. Runtime passes the visibility service to the applier.

## Acceptance Criteria

- A reveal applies once and records one `visibility.revealed`, also when retried.
- A stale version is a conflict and reveals nothing. A player, an envelope, a malformed intent, and a non-member
  target are refused.
- Un-reveal returns the handout to `gm_only`, audited.

## Verification

```bash
bun test apps/api/src/modules/content
```
