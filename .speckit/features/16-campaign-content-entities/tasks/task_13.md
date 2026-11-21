# Task 13: Web relationships and attachment panel

Status: completed (2026-10-30)

## Goal

Link entities from the detail screen, navigate links both ways, show broken links, and offer
feature 05 attachments on entities (not on personal notes, D-15).

## Dependencies

- Tasks 09, 12. Feature 05 is complete.

## Context

- TechSpec: `../_techspec.md` "Web", "Blob Storage"; D-15.
- BDD: "A GM links an NPC to a faction and a location", "Relationships survive as broken links",
  "A GM attaches a portrait to an NPC", "A hidden entity's attachment is unreachable",
  "A personal note takes no attachments or links".
- Feature 05: owner classes opt in through `buildRuntimeApp({ attachments: { ownerClasses } })`
  (default `[]`); web `AttachmentList({ campaignId, owner })` in
  `apps/web/src/features/attachments/Attachments.tsx`, `uploadAttachment` in `attachments-api.ts`;
  attachment metadata is not replicated (online list, pinned offline set only).

## Scope

### Change

- `RelationshipPanel`: create (endpoint picker over local visible entities, kind from
  configuration), delete, inverse labels, deleted-endpoint rendering; `VisibilityControls` mounted
  per relationship (`entity_relationship`); bound violation shown from the 400 reason.
- `apps/api/src/main.ts` and the API test runtime: `attachments.ownerClasses: ['campaign_entity']`.
- Attachment section on entity detail: `AttachmentList` with `owner = { resourceClass:
  'campaign_entity', resourceId }` and an upload control over `uploadAttachment` whose attachment
  Visibility is the entity's current Visibility. Nothing on personal notes.
- Playwright for linking, broken links, and attaching a PNG to an NPC.

### Do Not Change

- Feature 05 components, routes, or exporter.

## Acceptance Criteria

- [x] Linking Smuggler to a faction and a location shows the link on all three details.
- [x] Deleted endpoint renders as deleted, link remains.
- [x] Reveal wider than an endpoint shows the validation message and changes nothing.
- [x] A PNG attached to an NPC is listed on that NPC; an attachment on a `gm_only` NPC is never
  listed for a player and a direct read gets the safe 404.
- [x] An upload naming a `personal_note` owner gets the safe 404 (class not registered).

## Verification

```bash
set -a; . ./.env; set +a
bun test apps/web/src/features/content apps/api/src/modules/attachments --timeout 30000
bun x playwright test apps/web/e2e/content.e2e.ts
bun run build
```

## Evidence (2026-10-30)

- `RelationshipPanel`: links in both directions with configured/inverse labels, a deleted endpoint
  rendered as "Deleted entity", create (kind from configuration, endpoint picker over local visible
  entities) and remove through `RelationshipLocalRepository`, `VisibilityControls` per link
  (`entity_relationship`; reload refetches the relationships route).
- `EntityAttachments`: feature 05 `AttachmentList` (owner `campaign_entity`) plus an upload over
  `uploadAttachment` with the entity's current Visibility; nothing on personal notes.
- `CONTENT_ATTACHMENT_OWNER_CLASSES` (`policies.ts`) passed by `apps/api/src/main.ts`, the attachments
  runtime-composition test, and the e2e helper.
- Tests: `apps/api/src/modules/content/attachments.integration.test.ts` 1 (runtime, PostgreSQL +
  MinIO: PNG listed on the NPC for GM and player; a gm_only NPC's attachment never listed for a player
  and a direct read equals a missing one; an `everyone` attachment on a gm_only NPC still unreadable;
  `personal_note` / `entity_relationship` / `campaign` owners -> safe 404, nothing stored);
  the `attachments.integration.test.ts` runtime test now uses the production owner list.
- Playwright (`content.e2e.ts`): Smuggler member of River Guild (type changed note -> faction) and
  lives at Abandoned Warehouse, shown on all three with inverse labels; a link reveal wider than its
  endpoints shows the validation message and stays GM only; deleting Smuggler leaves the link as
  "Deleted entity" (route: `other.deleted = true`); a PNG attached to an NPC is listed, a player's
  list/read equals a missing one.
- Focused: `bun test apps/web/src/features/content apps/api/src/modules/attachments
  apps/api/src/modules/content/attachments.integration.test.ts --timeout 30000` 67 pass, 0 fail.

Gates (with `.env`, 2026-10-30): `bun run check` clean (462 files); `bun run typecheck` 13/13
exit 0; `bun run guard` 412 files, no violations; `bun run build` api + web exit 0;
`bun test --timeout 30000` 1406 pass, 8 skip, 1 fail (MinIO read-URL expiry, a known timing flake;
`packages/attachments/src/infra/s3` alone 10/10); the 8 engine-gated sync tests pass with
`POWERSYNC_ENGINE_EXEC` (`apps/api/src/modules/sync` 79/79); `bun run test:e2e` 72 passed, 1 failed
(live-sync "queued writes of a revoked member", the known flake; `live-sync.e2e.ts` alone 9/9).
