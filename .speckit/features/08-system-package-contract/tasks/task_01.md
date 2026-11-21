# Task 01: Closed capability registry

Status: completed (2026-10-30)

## Scope

- `packages/contracts/src/system.ts`: `CAPABILITY_KEYS` with a documented meaning per key (techspec table),
  `CapabilityKey` as the union of those keys, `CapabilityKeySchema` as a closed union, `isCapabilityKey`.
- Remove or narrow `capabilityKey(string)`: no unchecked cast to the brand remains.
- Dated contract note in feature 00 and a row in the post-freeze log.

## Acceptance Criteria

- A key outside the set fails `CapabilityKeySchema`, and fails to compile where typed.
- No key contains a system name (a test reads the guard's `SYSTEM_IDS` list).
- `SessionQuickAction.capability` still compiles.

## Verification

```bash
bun test packages/contracts
bun run typecheck
```
