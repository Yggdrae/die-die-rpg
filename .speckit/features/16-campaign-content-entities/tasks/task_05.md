# Task 05: Content services and audit declarations

Status: completed (2026-10-29)

## Goal

One application service per class that validates, decides through feature 04, and writes through
the repository inside a caller-supplied transaction, plus registered audit renderers that pass the
feature 06 CI conformance.

## Dependencies

- Task 03.

## Context

- TechSpec: `../_techspec.md` "Mutation Appliers" steps 1–3, 6–7 and audit actions.
- Feature 06: `AuditRendererRegistry.register`, `recordWithin` semantics
  (`packages/audit/src/{renderers,recorder}.ts`); conformance inventory
  `apps/api/src/modules/audit/contributors.ts` (row `16`, prefix `entity`, `not_built`) and
  `contributors.test.ts`.
- BDD: "Creating", "Editing", "Deletion", "Accepted changes are audited".

## Scope

### Change

- `packages/content/src/application.ts`: `EntityService.create/update/tombstone`,
  `PersonalNoteService.create/update/tombstone`; inputs carry the resolved `ActorRef`, never a role
  from input; default Visibility from the policy; explicit non-default Visibility on create
  requires the `reveal` decision; updates cannot change Visibility; type enabled check on create;
  D-11 limits, D-18 tags, D-01 fields through the task 01 rules.
- `packages/content/src/audit-declarations.ts` (exported as `CONTENT_AUDIT_DECLARATIONS`):
  `entity.created`, `entity.updated`, `entity.deleted`, `entity.personal_note_created`,
  `entity.personal_note_updated`, `entity.personal_note_deleted` with payload schemas; renderer
  text has no user content beyond already-authorized display values; long-text and custom-field
  changes recorded as `{ changed: [...] }` only; personal-note events pass snapshot
  `players:[author]`. Relationship actions are added in task 09.
- `apps/api/src/modules/audit/contributors.ts`: row `16` becomes `built` with the actions above;
  `createAuditRendererRegistry()` registers `CONTENT_AUDIT_DECLARATIONS`.
- Unit tests with the in-memory/fixture decision; PostgreSQL tests for transaction + audit.

### Do Not Change

- Feature 06 store/query code.

## Acceptance Criteria

- [x] Every enabled type created without Visibility is stored `gm_only` (test enumerates the
  configuration).
- [x] Player and observer creates/updates of `campaign_entity` are denied; GM-role creates of
  `personal_note` are denied.
- [x] A domain failure after `recordAudit` rolls back both write and event.
- [x] Exactly one event per accepted change, none for rejected; no description/body text, field
  label, or field value in any stored `before`/`after`.
- [x] Update of a tombstone is rejected.
- [x] `apps/api/src/modules/audit/contributors.test.ts` passes with row `16` built; no quoted
  `entity.<word>` literal in `packages/content` production source other than registered actions.

## Verification

```bash
set -a; . ./.env; set +a
bun test packages/content packages/audit apps/api/src/modules/audit --timeout 30000
bun run typecheck
```

## Notes

- Long-text hold enforcement is in the applier (task 06), because it needs the session (B-2).

## Evidence (2026-10-29)

- `packages/content/src/application.ts`: `EntityService`, `PersonalNoteService` (resolved
  `ActorRef`, `ContentDecider` = `AuthorizationService`, policy default Visibility, explicit
  non-default Visibility needs `reveal` + current-member targets, party refused, updates never change
  Visibility, enabled-type rule on create/type change, D-01/D-11/D-18 via `domain.ts`, CAS + audit
  hook on the same transaction, `record_deleted` for an edited tombstone, `hold_required` guard).
- `audit-actions.ts` (`CONTENT_AUDIT_ACTIONS`, 8 actions incl. task 09's relationship actions),
  `audit-declarations.ts` (`CONTENT_AUDIT_DECLARATIONS`, payload schemas with
  `additionalProperties: false`; long text/fields/metadata only as `changed: [...]`).
- `apps/api/src/modules/audit/contributors.ts`: row `16` built (`Object.values(CONTENT_AUDIT_ACTIONS)`),
  declarations registered; `contributors.test.ts` samples + expected texts added: 4/4 pass.
- `application.integration.test.ts` (PostgreSQL, real `AuthorizationService`): 11 pass (every
  enabled type -> gm_only, player/observer/foreign denied, GM-role notes denied, conflict returns
  current, no secret text/label/value in any payload and every payload passes its schema, hold guard,
  tombstone edit rejected, removed type, rollback on audit-hook throw). Real-recorder rollback
  (write + event) in `apps/api/src/modules/content/appliers.integration.test.ts`.
- Focused: `bun test packages/content packages/audit apps/api/src/modules/audit`: 162 pass, 0 fail.

Gates (with `.env`, 2026-10-29): `bun run check` clean (434 files); `bun run typecheck` 13/13;
`bun run guard` 384 files, no violations; `bun run build` api + web exit 0; `bun run test:e2e` 64
passed; `bun test --timeout 30000` with `POWERSYNC_ENGINE_EXEC`: 1362 pass, 1 fail, 1363 tests, two runs;
the single failure differed per run (`identity-p0` operator recovery, then the MinIO read-URL
expiry) and each passes alone (13/13, 10/10): timing flakes outside feature 16.
