# Task 02: Record, policy, and device repository

Status: completed (2026-10-31)

## Scope

- Record schema, visibility mapping (D-11), `DICE_ROLL_POLICY`, replica definition and codec.
- `RollLocalRepository`; browser repository `audited: false` option.

## Acceptance Criteria

- A roll is readable at once on the double and queues no audit envelope.
- A hidden roll by an actor who could not read it is refused on the device, failing closed.
- A typical record stays inside the local budget (D-15).

## Verification

```bash
bun test packages/dice packages/sync/src/browser-repository.test.ts
```
