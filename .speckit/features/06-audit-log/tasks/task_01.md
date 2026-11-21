# Task 01: Audit stores and renderer registry

Status: completed (2026-10-24; feature 04 declaration boundary wired 2026-10-26). Undescribed
targets take their snapshot from the feature 04 Resource Policy when the declaration fixes every
record's visibility; otherwise they stay fail-closed GM-only (see Notes).

## Scope

- Create `packages/audit`, two independent schemas/migrations, sequence allocator, privileges, and guard triggers.
- Implement campaign/private repositories with no shared broad read method.
- Add payload/renderer registry keyed by action/version and safe generic fallback.
- Test routing, immutability, idempotency, sequence concurrency, and renderer safety.

## Acceptance Criteria

- [x] `private` routes one event to exactly one physical table.
- [x] Application roles cannot update/delete history.
- [x] Client clocks cannot alter stable campaign order.

## Verification

```bash
bun test packages/audit
bun run typecheck
```

## Progress

- `packages/audit/src/infra/postgres/schema.ts`: `audit_campaign_events`, `audit_private_events`
  (same columns, no shared parent/view), one campaign-scoped allocator table per store
  (`audit_campaign_sequences`, `audit_private_sequences`) so private events never consume or
  reveal campaign sequence values, `audit_repair_outbox`, and `audit_account_events` (see
  `../2026-10-24-account-audit-store.md`).
- Migration `packages/identity/drizzle/0004_audit_stores.sql` (generated, plus a hand-written
  tail): roles `rpg_audit_writer` (SELECT/INSERT on history) and `rpg_audit_maintenance`
  (SELECT/DELETE), `REVOKE ALL ... FROM PUBLIC`, row triggers rejecting UPDATE and any DELETE
  except maintenance + `rpg.audit_retention = on` + older than 365 days, TRUNCATE triggers, and a
  monotonic allocator guard. Not added to the `powersync` publication.
- `CampaignAuditRepository` / `PrivateAuditRepository`: each bound to its table; only
  campaign-scoped `listForCampaign` reads; append is advisory-locked by origin mutation ID,
  allocates the sequence under the allocator row lock, and is idempotent by origin/event ID.
- `AuditRendererRegistry`: `(action, version)` declarations with payload schema and default
  target visibility; missing/throwing/invalid renderers fall back to a generic description that
  never echoes values.
- Tests: `renderers.test.ts`, `recorder.test.ts` (routing), `sync-boundary.test.ts`,
  `infra/postgres/repositories.integration.test.ts` (routing, idempotency under concurrency,
  contiguous order with skewed client clocks, owner/writer/maintenance UPDATE/DELETE/TRUNCATE
  rejection, writer can append).

## Notes

- `target_visibility` stores a `ResourceFacts`-shaped snapshot (`visibility`, optional
  `authorUserId`/`partyIds`). It is resolved in this order, and the first answer wins:
  1. the caller's snapshot (for example `VisibilityService` passes `gm_only` plus the author);
  2. the action declaration's `targetVisibility`;
  3. the feature 04 declaration of `targetType`;
  4. `{ visibility: gm_only }`.
- Step 3 (2026-10-26) uses an audit-owned port, `AuditTargetDeclarations.snapshotFor(targetType)`
  (`packages/audit/src/model.ts`), passed to `DurableAuditRecorder` and
  `createPostgresAuditRuntime` as `targets`.
  - Audit does not import authorization; authorization already depends on audit types.
  - Composition implements the port: `auditTargetDeclarationsFor(policies)`
    (`apps/api/src/modules/audit/composition.ts`) reads the runtime `ResourcePolicyRegistry`
    through the public `@rpg/authorization` entry. `runtime.ts` builds the registry before the
    audit runtime.
  - A class answers only with a static `defaultVisibility`, no `reveal` capability, and no
    Ownership Rule on `read`. Today that is `campaign` → `everyone`.
  - An undeclared class, an `explicit` default, a reveal-capable class (a record may differ from
    its default) or an author-scoped class needs facts and gets `gm_only` unless the caller
    passes them. `campaign_membership` is not a Resource Class and stays `gm_only`.
  - A throwing or invalid lookup also yields `gm_only`; the event is still recorded.
- This step changes stored snapshots. Campaign events (`targetType: 'campaign'`) recorded
  without a caller snapshot are now stored with `everyone`, where they were `gm_only` before.
  Events stored earlier keep `gm_only`.
- Reading with the target's current visibility and its Ownership Rule, rather than only the
  stored snapshot, stays in task 03. Sync filtering stays in task 04.
- Tests:
  - `packages/audit/src/recorder.test.ts`: precedence, and fail-closed for undeclared, throwing
    and malformed lookups.
  - `apps/api/src/modules/audit/composition.test.ts` (2 new tests): which declarations answer,
    and runtime-registry snapshots for campaign, membership and visibility events.
- `bun test packages/sync packages/audit packages/authorization apps/api --timeout 30000`:
  384 pass, 0 fail. `bun run typecheck` 10/10; `bun run check` clean; `bun run guard`: no
  violations.
- The API still connects as the database owner; triggers enforce immutability for it. Running the
  application as `rpg_audit_writer` is a deployment step not wired here.
