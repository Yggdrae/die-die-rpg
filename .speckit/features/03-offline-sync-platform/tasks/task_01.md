# Task 01: Ratify revocation and replica-purge contract

Status: implemented; awaiting human track review (one approval per track, feature 00 FR-008).

## Scope

- Write the dated contract-change note naming affected features and migration.
- Add the smallest provider-neutral membership-revocation/replica-purge boundary.
- Define acknowledgment/watermark types without exposing PowerSync.
- Obtain one review per track and add contract tests.

## Acceptance Criteria

- Feature 01 can revoke access without importing feature 03.
- Feature 03 can prove when a tombstone is safe to purge.
- Existing frozen repository consumers remain source-compatible.

## Verification

```bash
bun test packages/contracts
bun run typecheck
bun run guard
```

## Progress (2026-10-24)

- Contract-change note: `../00-platform-foundation/2026-10-24-replica-watermark-contract-change.md`
  (extends `2026-08-30-revocation-purge-contract-change.md`). Review recorded as open: Track A/B/C
  pending. The implementing agent cannot obtain it.
- `packages/contracts/src/revocation.ts`, additive: `CampaignAccessRevocationReason`,
  `ReplicaPurgeReason`, `ReplicaPurged`, `ReplicaPurgeListener`, `AuthoritySequence`,
  `ReplicaScope`, `ReplicaWatermark`, `TombstoneRef`, `TombstonePurgeBlocker`,
  `TombstonePurgeDecision`, `TombstonePurgeEvidence`. `CampaignAccessRevoked`,
  `CampaignAccessRevocationPublisher`, `ReplicaPurgeWatermark`, and `ReplicaPurgeEvidence` keep
  their shapes; feature 01 and API consumers compile unchanged.
- `packages/sync/src/watermarks.ts` `decideTombstonePurge` maps the `_db.md` rule to
  `TombstonePurgeDecision`.
- Evidence: `bun test packages/contracts` 79 pass; `bun run typecheck` every workspace exit 0;
  `bun run guard` no violations.

## Open

- [ ] One approval per track recorded in the contract-change note.
- Production `TombstonePurgeEvidence`/`ReplicaPurgeEvidence` and the revocation publisher adapter
  belong to task 07.
