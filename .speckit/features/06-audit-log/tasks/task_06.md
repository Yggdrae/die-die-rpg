# Task 06: Contributor conformance, retention, and acceptance

Status: completed (2026-10-27); retention follow-up completed 2026-10-28. The 365-day policy is
Approved (2026-10-28, delegated by owner). Replicas acknowledge synced audit rows, and a deletion
executor exists; it deletes nothing unless an operator sets `AUDIT_RETENTION_DELETE=true`.

## Scope

- Add conformance inventory for every PRD-required P0 mutating contributor and renderer.
- Implement 365-day retention report-only job and watermark checks; enable deletion only after approval.
- Run offline atomicity, private-store, ordering, failure-isolation, and local-budget acceptance flows.
- Verify repository gates and no accidental audit export.

## Acceptance Criteria

- [x] Missing required contributor registration fails CI.
- [x] No user operation fails because audit storage/retention/rendering fails.
- [x] Report-only retention names eligible rows without deleting before approval.
- [x] Active replicas acknowledge what they hold, so they stop blocking as `unacknowledged_replica`.
- [x] Deletion is off by default; enabled, it deletes only unblocked rows past 365 days, in batches.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

## Implementation

- Declarations owned by contributors (payload schema where the shape is fixed, renderer):
  `packages/campaigns/src/audit-declarations.ts` (5 actions), `packages/identity/src/audit-declarations.ts`
  (4), `packages/authorization/src/audit-declarations.ts` (2), `packages/sync/src/conflict-audit.ts`
  (`sync.conflict_resolved`). New events are stored with renderer version 1; older rows keep the
  generic text (version 0).
- `apps/api/src/modules/audit/contributors.ts`: `AUDIT_CONTRIBUTORS` mirrors FR-005 (01, 02, 04/17
  built; 05, 15, 16, 18, 19, 09 not built with reserved prefixes) and `createAuditRendererRegistry()`,
  composed in `runtime.ts`.
- `contributors.test.ts` (CI): FR-005 features parsed from `_prd.md` must equal the inventory; every
  built action registered, payload-valid and rendered as `registered`; renderers never echo raw or
  hostile values; a source scan fails on any recorded action under a contributor prefix that is not
  registered (a not-built feature recording `attachment.*` fails until registered) and on stale rows.
- `packages/audit/src/retention.ts` `PostgresAuditRetentionReporter` (SELECT only): per store and
  campaign, rows accepted before now − 365 days, oldest/newest, and blockers: always
  `approval_pending`, plus feature 03 `TombstonePurgeEvidence.decide` (newest eligible event and
  sequence) or `no_watermark_evidence`. `deleted: 0`. CLI:
  `bun run apps/api/src/modules/audit/retention-cli.ts` (JSON; exit 1 with a safe message on failure).
  (2026-10-28: `approval_pending` is gone; see "Retention follow-up".)

## Retention follow-up (2026-10-28)

Approvals recorded (delegated by owner): 365-day retention, GM-only membership readership (task
03), and the account-store note as written (account rows follow 365 days; no watermark).

Acknowledgement (reuses feature 03's ack route, `PostgresWatermarkStore`, `decideTombstonePurge`):

- `packages/sync/src/schemas.ts`: `AuditWatermarkAcknowledgement` `{ replicaId, tableName:
  audit_campaign_events | audit_private_events, throughEventId }`. The generic shape now rejects
  `audit_*` tables, so a device can never post a raw audit sequence (400).
- `packages/sync/src/audit-replica.ts`: `AuditWindowManager.acknowledgements(campaignId)` claims,
  per store, the newest accepted event held, only when every window month is subscribed here and
  its stream reports `hasSynced` (port `AuditStreams.synced`). A player never claims the private
  store; nothing held or an unsynced window claims nothing.
- `packages/sync/src/browser.ts`: `BrowserSyncSession` posts changed claims after each
  consistent checkpoint and when the set of synced audit subscriptions changes; failures retry on
  the next checkpoint. A sign-out flag stops a queued membership pass from refilling the cleared
  cache.
- `packages/audit/src/acknowledgement.ts` `AuditAcknowledgementResolver` and repository
  `locate()`: event ID to sequence only within the campaign and store, and only if the reader may
  read it now. `apps/api/src/modules/audit/replica-acknowledgement.ts` binds it to
  `AuditTargetAccess` (same decision as the audit API; GM-only narrowing for the private store).
  `POST /sync/replicas/:campaignId/ack` answers 204 whether or not the event resolved.
- Eligibility: `ReplicaScopeEligibility` (`packages/sync/src/watermarks.ts`), optional in
  `PostgresTombstonePurgeEvidence`. `auditReplicaEligibility` keeps, per audit scope, the
  subscribers whose user may receive that store now (campaign readers; GM roles for private),
  decided by feature 04 on the campaign record through the feature 01 `ActorResolver`.

Deletion executor:

- `packages/audit/src/retention-executor.ts` `PostgresAuditRetentionExecutor.run({ delete,
  batchSize (max 5000, default 500), maxBatches (default 100) })`. Without `delete: true` it is
  the report. Enabled, it deletes only groups with no blocker, only rows past the plan boundary and
  the database's own 365-day check, never past the sequence the watermark decision covered, one
  short transaction per batch under `SET LOCAL ROLE rpg_audit_maintenance` with
  `rpg.audit_retention = on` (migration 0004 triggers, unchanged). The report module
  (`retention.ts`) stays SELECT-only.
- Switch: runtime option `auditRetention: { delete, intervalMs (default 24 h), batchSize,
  maxBatches }`; no loop starts unless `delete === true`. `main.ts` and the CLI read
  `AUDIT_RETENTION_DELETE` (only the exact `true`). `.env.example` documents `false`; compose
  is unchanged. For deletion the connecting role must be a member of `rpg_audit_maintenance`.
- No migration.

## Evidence (with `.env`, 2026-10-27)

- `contributors.test.ts`: 4 pass. Mutation checks: an unregistered `attachment.uploaded` literal in
  production source fails 1 test; removing the campaign declarations fails 1.
- `packages/audit/src/infra/postgres/retention.integration.test.ts`: 2 pass — eligible counts and
  blockers per store, watermark question, account store, nothing deleted, an application DELETE is
  rejected (42501), no delete statement in the job.
- `apps/api/src/audit-acceptance.integration.test.ts` (runtime composition): 4 pass — GM reads actor,
  time and 'Renamed the campaign from "Draft" to "Ashen Road".'; authority order despite client
  clocks 2031/2001; player sees only permitted events with matching total and gets 404 on the private
  route; a throwing audit recorder does not fail create/rename; retention CLI deletes nothing and its
  failure is contained; no `ExportableModule` names audit.
- Other acceptance flows already proven: offline atomicity (`campaign-applier.integration.test.ts`,
  task 02), private store and replica privacy (task 04 live/provider/browser tests), local budget
  (`audit-replica.test.ts`).
- Gates: `bun run check` clean (285 files); `bun run typecheck` 10/10; `bun test --timeout 30000`
  931 pass, 8 skip, 0 fail (939 pass with `POWERSYNC_ENGINE_EXEC`); `bun run guard` 246 files, no
  violations; `bun run build` api+web exit 0; `bun run test:e2e` 41 pass.

### Evidence (with `.env`, 2026-10-28)

- `packages/audit/src/infra/postgres/retention.integration.test.ts`: 5 pass. Report; default run
  deletes nothing; enabled run deletes only unblocked rows in batches of 2 (first run truncated),
  keeps 364-day and recent rows and every `unacknowledged_replica`, `pending_mutation_reference`
  and `no_watermark_evidence` group; the maintenance role is still refused inside the window or
  without the setting (42501); never past the covered sequence; the report module has no delete.
- `apps/api/src/audit-retention.integration.test.ts`: 1 pass through `buildRuntimeApp`. Two
  replicas subscribed 500 days ago block both stores; a player's acks of a GM-private event, a
  GM-only membership event, and an unknown ID move nothing; a raw audit sequence is 400; the
  owner's acks clear the private store although the player never acknowledges it; the player's ack
  clears the campaign store; the default run deletes nothing; the enabled run deletes the 4 old
  rows only.
- `packages/sync/src/audit-replica.test.ts` +3, `revocation.integration.test.ts` +1 (eligibility),
  `apps/api/src/modules/sync/routes.test.ts` +1, `packages/audit/src/acknowledgement.test.ts` 2,
  `apps/api/src/modules/audit/retention.test.ts` 3; `audit-acceptance.integration.test.ts` updated.
- Live provider and browser: the `apps/web/e2e/live-sync.e2e.ts` audit test now also requires the
  owner device to acknowledge `audit_campaign_events` (newest held event) and
  `audit_private_events`, and the player device only `audit_campaign_events`, each body exactly
  `{ replicaId, tableName, throughEventId }` (the stand-in API records them).
- Mutation checks (each reverted): no eligibility filter fails the runtime test; skipping the read
  decision in the resolver fails 2; ignoring blockers fails 1; ignoring the switch fails 1;
  dropping the covered-sequence bound fails 1; no subscriber filter in the evidence fails 1;
  claiming without stream status fails 2. Without the status-change trigger the player device
  never acknowledged in the live test.
- Gates: `bun run check` clean (400 files); `bun run typecheck` 12/12; `bun test --timeout 30000`
  1241 pass, 8 skip, 0 fail (an earlier run had 1 failure in `identity-p0.integration.test.ts`
  operator recovery, green in isolation and on the rerun); `bun run guard` 354 files, no
  violations; `bun run build` api and web exit 0; `bun run test:e2e` 64 pass.

## Open

- Abandoned devices: a subscription is eligible until revoked, so a device that never returns
  holds rows newer than its last acknowledgement back indefinitely (feature 03 has no subscription
  expiry).
- Only the campaign used for bootstrap gets a subscription row; other campaigns' acknowledgements
  create unregistered watermark rows, which feature 03 treats as eligible (conservative).
- A replica that holds no event of a store, or whose window never synced, never acknowledges it;
  such a replica keeps blocking (retention runs longer, never early).
- Enabling deletion in a deployment needs `GRANT rpg_audit_maintenance TO <api role>` (the local
  superuser passes implicitly) and an operator decision to set `AUDIT_RETENTION_DELETE=true`.
- Pre-existing live e2e flake, not from this change (reproduced with the new hooks disabled):
  "queued writes of a revoked member ..." failed 1 of 8 at baseline.
