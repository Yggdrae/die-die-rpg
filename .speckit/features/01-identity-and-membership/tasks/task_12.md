# Task 12: Audit and Sync Revocation Boundaries

Status: completed (2026-10-25). Provider round trip and contract-note reviews remain open items
(see Open items); no acceptance criterion requires them.

## Goal

Connect committed identity changes to audit and synchronization without making either integration
the source of authorization truth.

## Dependencies

- Task 09
- Feature 03 revocation/cache contract
- Feature 06 `AuditRecorder` integration contract

## Scope

### Change

- Adapt recovery issuance and membership create/remove/role/ownership changes to `AuditRecorder`.
- Adapt membership role/removal commits to feature 03's provider-neutral connected-access and
  local-cleanup signal.
- Expose only current-user membership cache fields approved by `_db.md`.
- Test degraded delivery, retry observability, server denial after revocation, reconnect
  replacement, tombstone handling, and credential-table publication exclusion.

### Do Not Change

- No PowerSync/SQLite ownership inside feature 01, no rollback of committed membership because a
  notification fails, and no finite tombstone purge before feature 03 defines acknowledgment.
- No credential, session, invitation, recovery, or unrelated-user data in sync publication.

## Acceptance Criteria

- [x] Server authorization rejects removed membership regardless of notification state.
- [x] Connected access is revoked and cached campaign cleanup is requested after commit.
- [x] Higher server membership version replaces cached role; tombstone removes cached access.
- [x] Audit/sync failures are observable and retryable without restoring membership.
- [x] Publication/export checks exclude every credential-bearing table and field.

## Verification

```bash
bun test packages/identity --timeout 30000
bun run guard
bun run typecheck
```

## Progress

- Invitation acceptance records `membership.created`; removal, role change, and ownership transfer
  already record through `AuditRecorder`. All post-commit; failure logs
  `integrationDegraded(integration, campaignId, userId, { event, membershipVersion })` (replay key)
  and never restores membership.
- `MembershipCacheRow` schema, `toMembershipCacheRow`, and `reconcileMembershipCache`
  (`replace`/`remove`/`keep`) define the `_db.md` cache fields and version/tombstone rules.
- `infra/powersync/sync-config.yaml` checked: no credential-bearing identity table or field; only
  approved membership fields may be selected.
- Runtime acceptance (`apps/api/src/membership-revocation.integration.test.ts`): with throwing
  audit and revocation adapters, removal commits and the member is denied on campaign reads,
  listing, member list, sync bootstrap, and sync upload; role change is authoritative immediately.

### Closure (2026-10-25)

Criteria are provider-neutral (the task forbids PowerSync/SQLite ownership in feature 01), so
completion needs the feature 03 revocation/cache contract and feature 06 recorder, not a running
PowerSync service. All five have test evidence:

1. Denial regardless of notification: `membership-revocation.integration.test.ts` "failed audit and
   revocation delivery never restore access" (throwing adapters; campaign read, list, members,
   bootstrap, upload all denied).
2. Connected access revoked + cleanup requested after commit: same file, "default durable publisher
   records delivery and revokes the removed member subscriptions" (runtime default
   `DurableRevocationPublisher`; outbox `delivered`, subscription `revoked_at` set, bootstrap 404);
   `packages/sync/src/revocation.test.ts` "tombstone on reconnect drops campaign data and pending
   work and emits ReplicaPurged"; `campaign-applier.test.ts` "revoked replica loses campaign data
   and pending work on reconnect".
3. Higher version replaces role; tombstone removes access: new
   `apps/api/src/modules/sync/membership-reconciler.test.ts` drives the real
   `ReplicaAccessReconciler` with identity's `reconcileMembershipCache` and
   `toMembershipCacheRow` (replace, keep equal/lower, tombstone purge, stale version cannot
   restore, rejoin, only approved fields); `membership-cache.test.ts` for the pure rule;
   `publication.integration.test.ts` "current-user membership stream ...".
4. Observable and retryable, membership never restored: audit — `DurableAuditRecorder` outbox;
   new `composition.test.ts` "audit store outage after commit: outbox retry produces exactly one
   event" (real `MembershipService`), plus `membership-service.test.ts` "audit or revocation
   failure never undoes a committed change"; revocation — `revocation.test.ts` "degraded delivery
   is recorded, observable, retried, and never thrown", "exhausted retries end in an observable
   failed state", "an outbox write failure propagates so feature 01 logs integrationDegraded", and
   `revocation.integration.test.ts` "outbox is idempotent; degraded delivery is observable,
   retried, then delivered". Recovery issuance: durable account store (`audit-runtime.integration.test.ts`).
5. Publication/export exclusion: migration 0003 least-privilege publication +
   `publication.integration.test.ts` (sync config == publication, pgoutput decode shows no
   credential rows); `sync-publication.test.ts` (no stream references a credential table or
   field); new guard rule `no-credential-surface-in-export` (`tools/guard/src/rules.ts`, tested in
   `rules.test.ts`) fails the build if any non-test code under `packages/sync/` or an
   export/publication/replication path references `identity_password_credentials`,
   `identity_sessions`, `identity_recovery_tokens`, `identity_invitations` (incl. `token_digest`),
   `identity_bindings`, `identity_users`, or the digest/hash fields. Export itself is N/A until
   feature 07 exists; the rule enforces the criterion for it.

Replay idempotency: post-commit audit calls (removal, role change, ownership transfer, invitation
acceptance) now use an origin ID derived from (campaignId, userId, membershipVersion, action)
(`membershipAuditOriginId`, `apps/api/src/modules/audit/composition.ts`). The frozen
`AuditRecorder` port is unchanged: `membershipAuditRecorderFor` derives the ID from the event and
calls `DurableAuditRecorder.recordCampaign({ event, originMutationId })`; `runtime.ts` wires it
for identity unless `integrations.audit` overrides. Tests: `composition.test.ts` (stable ID,
replay stores one event, new version stores another, invitation acceptance) and
`audit-runtime.integration.test.ts` (PostgreSQL origin IDs match the derivation).

Evidence: `bun test packages/identity packages/audit packages/sync apps/api tools/guard --timeout
30000` 458 pass; `bun run typecheck` all workspaces exit 0; `bun run guard` no violations.
`bun run check` fails only on import ordering in `apps/api/src/modules/sync/campaign-applier.test.ts`
(feature 02 task 06 work in progress, not touched here).

## Open items

- PowerSync provider round trip is unverified: the service image is not running locally, so
  membership tombstones reaching browser SQLite and the browser read adapter calling
  `ReplicaAccessReconciler` are covered only through the provider-neutral reconciler, the stream
  query shape, and PostgreSQL logical decoding (feature 03 task 07 Open).
- Human review of the feature 03 contract-change notes (revocation purge, replica watermark) is
  still pending; identity tombstones stay indefinite until ratified.
- Offline replay of an undelivered audit event after a process crash between commit and the
  recorder call is not recorded anywhere (post-commit by contract); the `integrationDegraded` key
  now replays idempotently if an operator re-drives it.
- Feature 07 export does not exist; the guard rule is the only enforcement until it does.
