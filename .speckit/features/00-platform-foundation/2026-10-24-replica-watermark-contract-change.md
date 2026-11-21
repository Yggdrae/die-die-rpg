# Contract Change: Replica Purge Signal and Tombstone Watermarks

- Date: 2026-10-24
- Requested by: feature 03 task 01 (unblocks features 01 task 12, 02 task 06, 03 tasks 04/07)
- Extends: `2026-08-30-revocation-purge-contract-change.md`
- Affected features: 01 (publishes revocation, purges membership tombstones), 02 (campaign
  tombstones, local context removal), 03 (implements every interface), 05 (deletes local
  attachment bytes on purge), 06 (private audit rows follow the same tombstone rule)
- Review status: **open human review**. One approval per track is required (FR-008):
  Track A pending; Track B pending; Track C pending. The implementing agent cannot supply these;
  this note is not ratified until the three approvals are recorded here.

## Reason

The 2026-08-30 change let feature 01 publish revocation without importing feature 03, but left
two gaps: the device had no provider-neutral signal that a replica was destroyed (feature 05 and
feature 01's cached role need it), and tombstone purge had no shared acknowledgement or decision
shape, so `_db.md`'s watermark rule could not be proved by anyone but feature 03 internals.

## Change

Additive, in `packages/contracts/src/revocation.ts`:

- `CampaignAccessRevocationReason`: the existing reason union, now named. `CampaignAccessRevoked`
  is structurally unchanged.
- `ReplicaPurgeReason` (`access_revoked`, `signed_out`, `campaign_deleted`), `ReplicaPurged`
  (`campaignId`, `replicaId`, `reason`, `purgedAt`), and `ReplicaPurgeListener.replicaPurged(event)`
  for device-local state outside the replica.
- `AuthoritySequence` (integer >= 0, authority-assigned per campaign and scope), `ReplicaScope`
  (table/resource name), and `ReplicaWatermark` (`campaignId`, `userId`, `replicaId`, `scope`,
  `sequence`, `acknowledgedAt`).
- `TombstoneRef` (`campaignId`, `scope`, `recordId`, `sequence`, `deletedAt`),
  `TombstonePurgeBlocker` (`minimum_age`, `unacknowledged_replica`, `pending_mutation_reference`),
  `TombstonePurgeDecision` (`{ safe: true }` or `{ safe: false, blockers }`), and
  `TombstonePurgeEvidence` (`acknowledge(watermark)`, `decide(tombstone, now)`).

No shape names a provider bucket, provider cursor, local database path, or transport. Contract
tests reject provider fields (`packages/contracts/src/revocation.test.ts`).

## Compatibility and Migration

- Source-compatible. `CampaignAccessRevoked`, `CampaignAccessRevocationPublisher`,
  `ReplicaPurgeWatermark`, and `ReplicaPurgeEvidence` keep their shapes; existing feature 01 and
  API consumers compile unchanged.
- No data migration. Feature 03 maps its internal rule to the contract with
  `decideTombstonePurge` (`packages/sync/src/watermarks.ts`).
- Membership and campaign tombstones stay indefinite until a production `TombstonePurgeEvidence`
  / `ReplicaPurgeEvidence` implementation exists (feature 03 task 07) and this note is approved.

## Related, not a contract change

Feature 03 task 04 also added migration `0003_least_privilege_sync_publication`, replacing the
local `FOR ALL TABLES` `powersync` publication with the four streamed tables. An existing provider
replication slot created before that migration must be recreated (see
`docs/OFFLINE_SYNC_RUNTIME.md`).
