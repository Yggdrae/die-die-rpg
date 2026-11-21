# Contract change: closed capability registry

Date: 2026-10-30. Feature 08 task 01.

## Reason

`packages/contracts/src/system.ts` froze a branded `CapabilityKey` with no values, deferring the closed set to
feature 08 (FR-004). The set now exists, so a key outside it fails at compile time and at package load.

## Surface

- Added `CAPABILITY_KEYS`, a key-to-meaning record, and `isCapabilityKey`.
- `CapabilityKey` is the union of those keys. `CapabilityKeySchema` is a closed union.
- Removed `capabilityKey(string)`, the unchecked cast. It had no callers outside its own module.

## Affected features

Feature 18 (`SessionQuickAction.capability`, which registers no action yet), features 12, 13, 15, 19 (future
consumers). No stored data holds capability keys.

## Migration

None. Nothing outside `system.ts` called the removed helper.

## Review

Ratified 2026-10-30 (A/B/C, repository owner delegation).
