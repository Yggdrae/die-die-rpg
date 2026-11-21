# Task 05: Complete-replica offline export

Status: completed (2026-10-31). A fully synchronized campaign exports offline with the same chunks as online. See
"Closed", including two scope items replaced by recorded decisions (restart-safe store, dedicated worker).

## Scope

- Implement browser worker export against one proven-complete replica cursor.
- Reuse format/contributor schemas without importing server persistence.
- Refuse incomplete replicas explicitly and produce manifest-only attachment entries.
- Test offline generation, restart-safe download, and parity with online logical counts/checksums.

## Acceptance Criteria

- Fully synchronized campaign exports with no network.
- Incomplete local data never becomes a silent partial backup.
- Offline package obeys the same secret/visibility/format rules as online export.

## Verification

```bash
bun test packages/campaign-portability apps/web/src/features/portability
bun run build
```

## Evidence

### Package (`packages/campaign-portability/src/offline.ts`)

- `ReplicaCoverage`: the replica cursor plus per-module completeness.
- `replicaConsistency(registry, replica)`: the orchestrator's cursor mode. Every registered module
  must be complete at one cursor, before and after the reads.
- `unreplicatedContributor(moduleId, placement)`.
- The offline path reuses the same orchestrator, scanner, format and inspector as the online path.
  The web imports only `@rpg/campaign-portability`, which has no persistence; guard rule 11 and
  the package's import scan hold.

### Web (`apps/web/src/features/portability/`)

- `export-client.ts`:
  - `exportOnline`: job, then file download.
  - `exportOffline`.
  - `exportCampaign`: online first; offline when `navigator.onLine` is false or the network fails.
- `CampaignExport.tsx`:
  - A GM-secret warning that must be acknowledged before export.
  - A status line, then a Blob download.
  - Explicit messages for denial, incomplete replica and failure. No local role check.
- `e2e-harness.tsx`.
- Mounted in `CampaignDashboard.tsx` under "Export".

### Tests

- **`packages/campaign-portability/src/offline.test.ts`** (6 tests):
  - Complete replica at one cursor: the package is byte-identical to the online export, so logical
    checksums and counts match.
  - An incomplete module is refused before any read.
  - No cursor, or an uncovered module, counts as incomplete.
  - A cursor that moves is re-read, never mixed.
  - An unreplicated contributor is named and never read.
  - The forbidden-data rules apply offline too.
- **`apps/web/src/features/portability/export-client.test.ts`** (4 tests): online job and
  download, denial, failed job and expired file, browser replica refusal, and a network failure
  falling back to the replica refusal.
- **`apps/web/e2e/portability.e2e.ts`** (4 Playwright tests, Edge headless):
  - *Warning first.* The online download is inspected with the production inspector.
  - *Player denial.* No file is produced.
  - *Offline before the replica opened.* An explicit refusal with
    `data-incomplete-modules="attachments,campaign,content"`, no download, and no `/exports` request.
  - *Offline with a complete local source.* The download is produced with the network down and
    zero network requests, and it is a valid manifest-only package.
- **Gates:** `bun run build` exits 0 (api and web).

## Closed (2026-10-31)

A real campaign now exports offline. Migration `0013_offline_export_replica` publishes four tables, and the device
holds what it needs to prove completeness.

### What changed

- Exact pins replicate to every reader of the campaign (`authorized_campaigns`).
- New stream `campaign_export_metadata`, owner and gm only (the roles of the `export` capability):
  - Attachment metadata, `ready` and not deleted, checksums as hex. Never `object_key`.
  - The identity of each preserved import chunk. Never its payload.
- `apps/web/src/features/portability/replica-export.ts` registers the same contributors as the API, over local rows.
  `CampaignExporter` and `AttachmentManifestExporter` now take narrow source ports instead of the repositories. Feature 02
  keeps its own queries and tables on the device (`campaignReplicaSource`, `CAMPAIGN_EXPORT_REPLICA_TABLES`), as the guard
  requires.
- `CAMPAIGN_RESOURCE_POLICY` moved to `@rpg/campaigns/policy`, so the device applies the same `export` decision.

### Decisions (delegated by the owner, 2026-10-31)

- **D-1 A member who may not export is refused before anything is read.** A player's replica is partial by design, so
  without this it would produce a backup that looks complete. `assistant_gm` reads everything but does not hold `export`.
- **D-2 Unsynchronized changes make the copy incomplete.** The acceptance criterion is a fully synchronized campaign. A
  file holding writes the authority may still refuse is not that, and the refusal says to export when online. So an
  offline edit blocks offline export until it syncs. Revisit if tables ask for a backup of unaccepted work.
- **D-3 A campaign with preserved import chunks refuses offline.** Their payloads stay on the authority (feature 07
  `_db.md`), and the online export re-emits them, so an offline file would silently lose them. Only their identity
  replicates, enough to refuse.
- **D-4 Attachment metadata replicates after all, for export holders only.** This changes the feature 05 decision, which
  kept it out because per-attachment Visibility needs joins PowerSync 1.25 cannot enforce. Those roles read every owner
  class (feature 16 D-15: no attachments on personal notes), so no per-attachment rule is needed. **A future owner class
  private from a GM must revisit this stream.**
- **D-5 No restart-safe store of the package.** Regenerating is the restart safety: a test restarts offline and gets the
  same chunks. Keeping a GM-secret file on the device longer would add exposure for no gain.
- **D-6 No dedicated worker.** SHA-256 and compression already run off the main thread and the replica's SQLite runs in
  the PowerSync worker. A worker would need a replica-read bridge for the small remainder. Not measured on a large
  campaign.

### Evidence

- `apps/web/e2e/pwa.e2e.ts`, production bundle, real API, real PowerSync, real attachment:
  - Offline export has exactly the online package's chunks and system lock, compared with the production inspector.
  - The same after an offline restart.
  - A local unsynchronized write refuses, naming the modules, with no download.
  - A player offline is refused, with no download.
  - 18 of 18 with `--repeat-each=3`.
- `apps/web/src/features/portability/replica-export.test.ts`: each refusal reason and every role.
- `apps/api/src/modules/sync/sync-config.integration.test.ts`: the new queries on real tables, against the `read` and
  `export` decisions, for all requesters (removed GM and observer included). Pending and deleted attachments never
  stream.
- Publication allow-list test updated; PowerSync engine validation of the configuration passes.
- The two tests that asserted these tables stay unpublished now assert the narrower truth: no `object_key`, no chunk
  `payload`, only live `ready` attachments, and `owner`/`gm` only.

### Limits

- Verified on Chromium engines, like the offline restart it depends on.
- Provider storage now holds `attachments` and `import_preserved_chunks` rows for evaluation, including columns not
  projected to devices. The replication role could already read comparable GM content; noted for the security review.
