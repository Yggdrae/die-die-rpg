# Task 04: Content sync streams, hold filters, drift gate

Status: completed (2026-10-28)

## Goal

Replicate entities and personal notes to exactly the devices allowed to read them, and replicate
long-text holds for these classes without disclosing hidden records (B-3).

## Dependencies

- Task 03.

## Context

- TechSpec: `../_techspec.md` "Offline and Synchronization", "Cross-Feature Blocker Resolutions"
  B-3.
- Data: `../_db.md` "Offline and Sync".
- Feature 03 task 07 Open: "the first content owner with long text must add a per-class hold
  stream"; B-3 resolves it without a join (holds go to roles that read every row, or to the
  holder only).
- Dialect constraints: `docs/OFFLINE_SYNC_RUNTIME.md` "PowerSync 1.25.0 dialect"; joined-row
  equality is not enforced, so no content query may depend on a join beyond the requester's own
  membership row.

## Scope

### Change

- `apps/api/src/modules/sync/sync-rules.ts`: `SYNC_RULE_BINDINGS` entries for `campaign_entity`
  and `personal_note` (stream `authorized_content`, approved columns incl. visibility, ownership,
  `deleted_at`).
- `infra/powersync/sync-config.yaml`: stream `authorized_content` with the compiled queries
  (rendered by `compileProviderQueries`, pasted, drift-gated).
- Hold filter (B-3): the holds query replaces `sync_long_text_holds.resource_class = 'campaign'`
  with `resource_class = 'campaign'` OR (`resource_class = 'campaign_entity'` AND
  `m.role IN '["owner","gm","assistant_gm"]'`) OR (`resource_class = 'personal_note'` AND
  `holder_user_id = auth.user_id()`), rendered from a derivation over the registered declarations:
  a class's holds go to a role only if that role reads every row regardless of Visibility and the
  class has no Ownership Rule, else to the holder only. The derivation lives with the existing
  holds derivation (`packages/sync/src/sync-rules.ts` or the drift test helper, whichever already
  owns it).
- `apps/api/src/modules/sync/sync-config.integration.test.ts`: drift for the new stream; hold
  filter derived from declarations + `decide`; tamper variants; PostgreSQL simulated replicas for
  owner, gm, assistant_gm, player A, player B, observer, removed gm, non-member, other campaign.
- Browser `Schema` additions for the two tables through the `schema` option of
  `packages/sync/src/browser.ts`, composed by the web app.

### Do Not Change

- `packages/sync/src/sync-rules.ts` compiler beyond the B-3 hold filter derivation.
- Membership and campaign streams.

## Acceptance Criteria

- [x] `findSyncDivergences` is `[]` for both classes in-process and as PostgreSQL SQL, tombstones
  included.
- [x] Simulated replicas: no `gm_only` entity on player replicas; personal notes only on the
  author's replica (no GM role); unseen tombstones absent; 25 hidden inserts/deletes leave the
  player payload byte-identical.
- [x] Holds: a hold on a `gm_only` entity reaches `owner`, `gm`, `assistant_gm` only; a hold on a
  personal note reaches only its holder; `campaign` holds unchanged; mutation of any filter branch
  fails the drift test.
- [x] No content stream query joins a table other than the requester's membership row.
- [x] `sync-config.yaml` compiles in the PowerSync engine check with zero diagnostics when
  `POWERSYNC_ENGINE_EXEC` is available (otherwise recorded as skipped, not passed).

## Verification

```bash
set -a; . ./.env; set +a
bun test apps/api/src/modules/sync packages/sync packages/authorization --timeout 120000
bun run typecheck
```

## Notes

- DNF limit: the 1.25.0 compiler caps OR expansion at 100 terms per AND; use JSON-array value sets
  as the adapter already does.
- Restart `rpg-powersync` after the YAML changes when running the live provider tests.

## Evidence (2026-10-28)

- `SYNC_RULE_BINDINGS`: `campaign_entity` and `personal_note` in stream `authorized_content`,
  projections from `CONTENT_REPLICA_TABLES` (`packages/content/src/replica.ts`).
- `infra/powersync/sync-config.yaml`: stream `authorized_content` (compiled queries) and the B-3
  holds filter (`campaign` | `campaign_entity` for GM roles | `personal_note` for the holder).
- B-3 derivation `holdAudiences()` lives with the existing holds derivation in
  `apps/api/src/modules/sync/sync-config.integration.test.ts` (declarations + `decide`): 7 hold
  tamper variants and 6 content tamper variants all reported.
- `sync-config.integration.test.ts`: 12 pass: in-process `findSyncDivergences` `[]` for both
  classes; PostgreSQL rendering on shadow tables agrees with `decide` for every truth-table case
  (both classes, tombstones, observers); join check (only `identity_campaign_memberships m`);
  simulated replicas for owner, gm, assistant_gm, player A, player B, observer, removed gm,
  non-member, other-campaign owner incl. holds; 25 hidden entity/note/hold inserts and deletes leave
  player A's payload byte-identical.
- Browser schema: `replicaSchema({ privateAudit, tables })` and `BrowserSyncSessionOptions.tables`
  (`packages/sync/src/browser.ts`, additive); web composes `CONTENT_REPLICA_TABLES` in
  `useBrowserSync`. Tests: `packages/sync/src/browser-schema.test.ts` (2),
  `apps/web/src/features/sync/replica-schema.test.ts` (1).
- Live provider (rpg-powersync restarted after the YAML change; healthy, new slot
  `powersync_10_*`): `sync-config.powersync.integration.test.ts` 6/6 with a new content test (exact
  entities/notes/holds per requester, payload absence, live reveal PUT and un-reveal REMOVE, 25
  hidden inserts/deletes with no op or checkpoint change). Mutation: player added to the GM branch of
  the entity query, service restarted -> the content test fails (5 pass, 1 fail); restored -> 6/6.
- Engine check (`POWERSYNC_ENGINE_EXEC="wsl -e docker exec -i rpg-powersync"`):
  `packages/sync/src/infra/powersync` 7/7 incl. zero diagnostics for the real `sync-config.yaml`.
- Audit sync: `campaign_entity` excluded `campaign_scope_unprovable`, `personal_note`
  `ownership_on_read` (online-only audit, as specified).
- `bun test apps/api/src/modules/sync packages/sync packages/authorization --timeout 120000`: 304
  pass, 8 skip (engine opt-in), 0 fail; with the engine env: 12/12 in the provider files.
- Docs: `docs/OFFLINE_SYNC_RUNTIME.md`, F03 `_db.md` and `tasks/task_07.md` (B-3 closed).
- Gates (2026-10-28, with `.env`): `bun run check` clean (421 files); `bun run typecheck` 13/13
  workspaces exit 0; `bun run guard` 372 files, no violations; `bun run build` api and web exit 0;
  `bun test --timeout 30000` (with `POWERSYNC_ENGINE_EXEC`) 1316 pass, 0 fail (131 files); `bun run test:e2e` 64 passed.
