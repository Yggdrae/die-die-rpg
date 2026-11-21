# Task 03: Authorized upload and verified finalization

Status: completed (2026-10-27), against feature 04 fixture owner classes. Depends on task 02 and feature 04.

## Scope

- Add upload-request/finalize application services and Fastify routes with TypeBox.
- Require fresh target authorization before pending row/grant.
- Verify HEAD size, streamed SHA-256, and actual file signature before ready.
- Implement 24-hour abandoned upload cleanup and retry/idempotency tests.

## Acceptance Criteria

- [x] No unauthorized/invalid request receives an upload destination.
- [x] Pending/mismatched files never list or receive read URLs.
- [x] Identical finalize retry returns one attachment; mismatched retry changes nothing.

## Verification

```bash
bun test packages/attachments apps/api/src/modules/attachments
bun run typecheck
```

## Evidence

- `AttachmentService.requestUpload` / `finalize` (`packages/attachments/src/application.ts`).
  Owner decision: `ContentAccess.authorizeResource(userId, {campaignId, class, id, 'update'})`
  through `apps/api/src/modules/attachments/authorizer.ts`; facts always reload from the class's
  own source. The owner class must also be in the service's `ownerClasses` opt-in list. The
  decision runs first; file policy, Visibility targets (current members; `party` rejected) and the
  pending cap (20 unexpired per actor and campaign) only answer an allowed actor. Then one pending
  row, then one 10-minute grant. A thrown/unavailable decision propagates: no row, no grant.
- Finalize: only the uploader, still allowed `update` on the owner; submitted size/checksum must
  equal the declaration (else 422, nothing changes); HEAD size first (an oversized object is never
  streamed), then streamed SHA-256 and the signature of the declared type. A stored mismatch marks
  the row failed and deletes the bytes; a missing object is `409 upload_incomplete` (row stays
  pending); a provider fault is `503` (retryable). The pending → ready update is conditional, so a
  concurrent or repeated finalize yields exactly one ready row and one audit event
  (`attachment.uploaded`, origin ID = attachment ID, snapshot = the attachment's Visibility on its
  owner, payload type and size only, never the filename).
- `AttachmentCleanup` (24 h pending → bytes deleted, row failed; 7 days → bytes deleted again and
  metadata hard-deleted; never ready rows; provider faults retried next pass). The runtime runs it
  hourly (`startLoop`, unref'd, stopped on close).
- Routes (`apps/api/src/modules/attachments/routes.ts`):
  `POST /campaigns/:campaignId/attachments/uploads` (201 `no-store`; 404 safe denial; 415/413/400
  policy; 429 cap; 503 provider) and `POST /campaigns/:campaignId/attachments/:attachmentId/finalize`
  (200; 404; 422 `size_mismatch`/`checksum_mismatch`/`signature_mismatch`; 409
  `upload_incomplete`/`upload_expired`/`upload_failed`; 503). Both require a session and the
  same-origin check; bodies are `additionalProperties: false` (a role, actor, bucket or key field is
  a 400).
- Feature 06: `ATTACHMENT_AUDIT_DECLARATIONS` registered in `apps/api/src/modules/audit/contributors.ts`;
  contributor `05` is now `built` with `attachment.uploaded` (conformance test sample + expected
  text "Attached a PDF (2.4 MB).").

Tests (with `.env`):

- `packages/attachments/src/application.test.ts`: 44 (BDD outlines: attach to NPC/location/note;
  9 unauthorized conditions incl. author-private and an opted-out class; fail-closed decision;
  policy after decision; client bypass; Visibility targets; cap; pending invisible; valid finalize;
  idempotent retry; stored size/checksum mismatch; HTML-as-PNG signature; submitted mismatch;
  incomplete; uploader-only; 24 h exclusive expiry; provider faults; abandoned collection).
- `apps/api/src/modules/attachments/routes.test.ts`: 16 (real `ContentAccess`; every denial
  byte-identical to an unmatched route, headers included; status codes; spoofed role headers).
- `apps/api/src/modules/attachments/attachments.integration.test.ts`: 5 (PostgreSQL + MinIO over
  HTTP: direct upload to the signed URL, not listed before finalize, idempotent retry, HTML under
  an image type fails `signature_mismatch` and its bytes are removed, swapped bytes without the
  checksum header fail `checksum_mismatch`; runtime composition denies every owner class).
- `bun test packages/attachments apps/api/src/modules/attachments`: 105 pass, 0 fail.
- Mutation check: removing the attachment-Visibility narrowing fails 4 tests.

## Open

- No production content class exists (feature 16 is a draft spec). The runtime's `ownerClasses` is
  empty and every owner class (including `campaign`, which the spec does not name as an attachment
  owner) is denied with the safe 404; behavior is proven with the feature 04 fixture classes
  `fixture_note` and author-private `fixture_secret`. Feature 16 must add its classes to
  `buildRuntimeApp({ attachments: { ownerClasses } })`.
- The upload grant cannot bind length/type/checksum with `Bun.S3Client` presigns (task 01);
  finalization compensates.
- No upload UI yet: `uploadAttachment()` (web client) is tested; the screen arrives with the first
  owner page (feature 16) or task 07's acceptance flow.
