# Contract Change: Campaign Access Revocation and Replica Purge Evidence

- Date: 2026-08-30
- Requested by: features 01, 02, and 03 implementation
- Review status: Track A pending; Track B pending; Track C pending

## Reason

The frozen contracts had no provider-neutral way for authoritative membership changes to revoke a
connected replica or prove that every eligible replica observed a tombstone. Feature 01 otherwise
had to import feature 03 or name a synchronization provider.

## Change

Add `CampaignAccessRevoked`, `CampaignAccessRevocationPublisher`, `ReplicaPurgeWatermark`, and
`ReplicaPurgeEvidence` to `@rpg/contracts`. The shapes carry campaign/user/version/time facts only.
They expose no PowerSync bucket, SQLite path, transport, or provider cursor.

## Compatibility and Migration

This is additive and source-compatible. Feature 01 publishes committed membership changes. Feature
03 consumes them and owns replica cleanup plus watermark persistence. Membership tombstones remain
indefinite until `ReplicaPurgeEvidence.safeToPurge` has a production implementation and all three
track reviews approve this note.
