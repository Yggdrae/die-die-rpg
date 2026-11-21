# Task 02: Non-blocking recorder and mutation envelope

Status: completed (2026-10-26). Recorder, retry, dead-letter, the sync mutation envelope, and
same-transaction authority audit (`_db.md` Write Path) are done and wired for the campaign and
campaign-setting appliers. See "Same-transaction atomicity (2026-10-26)".

## Scope

- Implement `AuditRecorder` adapter with stable event/origin mutation IDs.
- Atomically attach validated audit payload to local/authority mutation envelopes.
- Add repair/dead-letter diagnostics for catastrophic audit insertion failures.
- Test retry, rejection, lost acknowledgement, and unavailable audit adapter.

## Acceptance Criteria

- [x] Audit outage never rejects an otherwise valid user mutation.
- [x] Retry creates one accepted event; rejected mutation creates no accepted history.
- [x] Every gap/dead letter is observable without logging payload content.
- [x] Uploaded mutation envelope carries the validated audit payload; the authority records it under
  the client mutation ID (origin ID).
- [x] Authority records the envelope inside the domain transaction (applier hook
  `AuthorityMutationContext.recordAudit` -> `recordWithin`); after-commit recording is only the
  fallback and the replay repair.

## Verification

```bash
bun test packages/audit packages/sync apps/api --timeout 30000
bun run typecheck
```

## Progress

- `DurableAuditRecorder` (`packages/audit/src/recorder.ts`) implements the frozen
  `AuditRecorder`; `record`, `recordCampaign`, `recordAccount`, `recordMutationOutcome`, and
  `recordWithin` resolve and never throw. Event ID is derived from the origin mutation ID before
  the first attempt (`deriveAuditEventId`); stores are idempotent by origin ID.
- Failure path: bounded append (3 s) -> restricted `audit_repair_outbox` (pending, exponential
  backoff) -> bounded in-memory queue if the outbox is unreachable. `retryPending()` /
  `startRetryLoop()` replay; after 8 attempts the entry is dead-lettered. Validation failures are
  dead-lettered immediately. `AuditDiagnostics` signals carry only event/origin IDs, store, code,
  attempt, and where the event is parked; `backlog()` exposes memory/outbox counts.
- `recordWithin(tx, ...)` appends inside the caller's PostgreSQL transaction under a savepoint; an
  insert failure parks in the outbox inside the same transaction and never aborts it; if that also
  fails it is a signalled gap (no memory replay that could fabricate rolled-back history).
- `recordMutationOutcome` records only `accepted` outcomes, keyed by the feature 03 mutation ID.
- Runtime (`apps/api/src/runtime.ts`) and operator CLI use `createPostgresAuditRuntime`; identity
  membership/invitation, campaign events, and recovery issuance now reach durable stores.
  `integrations.audit` / `integrations.recoveryAudit` stay injectable for tests.
- Tests: `recorder.test.ts` (outage, lost ack, outbox+store down, timeout, exhaustion, invalid,
  rejection, no-payload signals), PostgreSQL in-transaction commit/rollback/failure isolation and
  outbox repair, `apps/api/src/audit-runtime.integration.test.ts`.

## Mutation envelope (2026-10-25)

- Wire: `PendingMutation.audit?` (`MutationAuditSchema`, TypeBox, `additionalProperties: false`) is the
  frozen `AuditEvent` without `id`; `actor` is optional and advisory. Optional, so older clients stay
  valid. `SqliteReplicaStore.write/softDelete/resolveConflict` validate it (schema plus the 16 KiB
  before/after bound, `isValidMutationAudit`) and fail the local write atomically when invalid.
  `pending()` joins `sync_audit_envelopes`, so retries and restarts re-upload the same payload.
- Port (`@rpg/sync`, provider-neutral): `MutationAuditParticipant.recordMutationOutcome({ mutationId,
  outcome, audit })`. `AuthorityMutationService` takes it as an optional 4th constructor argument.
- Authority binding: campaign, target type/ID, and actor are replaced by the mutation's
  `campaignId`/`tableName`/`recordId` and the actor resolved from the session. `action`, `before`,
  `after`, `at`, `private`, and `sessionId` remain client-asserted.
- Call timing: after `receipts.save`, inside the per-mutation lock, for every outcome of an item that
  has an envelope and a resolved actor; again on every receipt replay (lost acknowledgement) so an
  interrupted attempt is repaired. Participant faults are swallowed. A retryable error saves no
  receipt, so a later accepted attempt is the only one that records.
- Composition (`apps/api/src/modules/audit/composition.ts`): `mutationAuditParticipantFor(recorder)`
  adapts `DurableAuditRecorder.recordMutationOutcome`; `recordOnlyMutationAuditParticipant` serves
  the `integrations.audit` test override.
- No double record: `CampaignSyncMutationApplier`/`CampaignSettingSyncMutationApplier` take a second
  `CampaignService` built with `DISCARD_AUDIT` and use it whenever `mutation.audit` is present. A
  mutation without an envelope (older client) keeps the service-level `campaign.*` event. HTTP
  paths are unchanged.
- Tests: `packages/sync/src/authority.test.ts` (participant timing, binding, replay, retry, conflict,
  throwing adapter, denial, creation), `sync.test.ts` (local validation, restart, wire schema),
  `apps/api/src/modules/sync/campaign-applier.test.ts` (no double record, legacy fallback, forged
  envelope), `apps/api/src/modules/audit/composition.test.ts` (durable recorder: store down, outbox
  down, lost ack, conflict/rejection, invalid, no payload in signals), and
  `audit-runtime.integration.test.ts` (PostgreSQL through `POST /sync/mutations`).

## Same-transaction atomicity (2026-10-26)

- Port (`@rpg/sync` `model.ts`, provider-neutral, opaque handle):
  - `AuthorityMutationContext.recordAudit?` and `CreationMutationContext.recordAudit?`
    (`MutationAuditHook = (transaction: unknown) => Promise<void>`);
  - optional `MutationAuditParticipant.recordAcceptedWithin(transaction, { mutationId, audit })`
    resolving `true` when the transaction holds the event.
- `AuthorityMutationService` offers the hook only when the item has an envelope, the batch campaign
  matches, an actor is known, and the participant supports it. For creation the actor is the
  creator as `owner` (the applier commits that membership in the same transaction). The payload is
  bound exactly as before. One call per attempt; participant faults are swallowed.
- Decision (outage vs atomicity): the hook never aborts the domain transaction.
  - Held (inserted, duplicate, or parked in `audit_repair_outbox` in the same transaction): commits
    or rolls back with the write; no after-commit call.
  - Not held (the applier never called the hook, the participant returned `false`, or it threw):
    `recordMutationOutcome` after commit, where the outcome is known, so a rolled-back write can
    never fabricate history. Replays keep calling it (idempotent repair).
  - `recordWithin` returning `dead_lettered` maps to not held. In a transaction that means the store
    and the in-transaction outbox both failed, or the event is invalid; the after-commit path then
    reaches the outbox or memory queue on the audit pool.
- Campaigns: `CampaignTransactionParticipant`; `CampaignRepository.create/updateDetails/
  updateSetting/softDelete` and `CampaignService.create/updateDetails/updateSetting/delete` take an
  optional `withinTransaction`. The PostgreSQL repository calls it inside its transaction after the
  write matched (`updateDetails` and `softDelete` now run in a transaction). A throw rolls the write
  back as `persistence_unavailable` (retryable `authority_unavailable` at the applier). The in-memory
  repository never calls it (fallback). HTTP paths pass nothing and are unchanged.
- Appliers: `CampaignSyncMutationApplier` (create, creation scope, details, tombstone) and
  `CampaignSettingSyncMutationApplier` pass `recordAudit` through.
- Composition: `mutationAuditParticipantFor` adds `recordAcceptedWithin` over
  `DurableAuditRecorder.recordWithin`; a handle that is not a SQL executor is refused (`false`).
  `runtime.ts` unchanged.
- Receipt: stays outside the domain transaction (F03 `_db.md` does not require it; separate pool and
  advisory-lock transaction). A crash after the domain commit and before the receipt now leaves the
  event committed with the write; the retry then conflicts and records nothing new.
- Tests:
  - `packages/sync/src/authority.test.ts`: 7 new unit tests (staging-map transaction).
  - `apps/api/src/modules/audit/composition.test.ts`: 1 new test (adapter outcome mapping).
  - `apps/api/src/modules/sync/campaign-applier.integration.test.ts`: 5 new PostgreSQL tests, real
    campaign, audit, outbox, and receipt stores. They cover:
    - create, edit, setting, and delete each committing one event in-transaction; replay adds none;
    - a domain failure after the audit insert rolling back both, with no receipt; the retry records
      one event;
    - an audit insert failure parking a pending outbox row with the write; the mutation is accepted;
      `retryPending` repairs it once;
    - store and outbox failing, which records once after commit;
    - conflict, invalid, and foreign mutations recording no event and no outbox row.
    Mutation check: disabling the repository hook call fails 4 of the 5.
- Evidence (with `.env`): `bun test packages/audit packages/sync apps/api --timeout 30000` 309 pass,
  0 fail; `bun test packages/campaigns` 29 pass; `bun run guard` 209 files, no violations; my files
  clean under `biome check` and `@rpg/api`/`@rpg/campaigns`/`@rpg/audit` typecheck. Workspace
  `bun run typecheck`/`bun run check` fail only on `packages/sync/src/sync-rules.test.ts`, which a
  parallel PowerSync task is editing.

## Remaining gaps

- No `lock_timeout` bounds the in-transaction audit insert; a blocked sequence-allocator row lock
  delays the domain write (the after-commit path keeps its 3 s bound).
- No operator signal when an applier skips the hook (the fallback is silent but correct).
- Offline action names are generic (`<featureId>.created|updated|deleted`, e.g. `campaigns.updated`),
  not the online `campaign.*` vocabulary, until `SqliteSyncedRepository` accepts a per-feature
  audit describer.
- Client-asserted `action`/`before`/`after`/`private` need feature 04/06 contributor declarations to be
  checked server-side.

## Former blockers (feature 03, `packages/sync`), all resolved above

- Uploaded `PendingMutation` does not carry the local `sync_audit_envelopes` payload, and
  `AuthorityMutationService` / `MutationApplier` expose no transaction or audit participant. Need:
  (a) include `audit` in the uploaded mutation, validated with `@rpg/audit` `isValidCampaignEvent`
  when written locally; (b) call `DurableAuditRecorder.recordWithin(tx, { event, originMutationId:
  mutationId })` inside the applier's domain transaction, or `recordMutationOutcome` after the
  receipt is saved. Until then authority audit is post-commit through the domain service with a
  generated origin ID; lost-ack resubmissions do not duplicate because receipts short-circuit.
