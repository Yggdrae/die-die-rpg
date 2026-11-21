# Task 02: Attachment schema, storage port, and lifecycle

Status: completed (2026-10-27). Depends on task 01.

## Scope

- Create `packages/attachments`, public module contracts, ObjectStorage port/adapter, and TypeBox schemas.
- Add metadata migration/indexes/checks and lifecycle repositories from `_db.md`.
- Implement file policy, safe filename/key generation, status transitions, and idempotency primitives.
- Add unit/PostgreSQL tests.

## Acceptance Criteria

- [x] Binary bytes cannot enter PostgreSQL or public metadata payloads.
- [x] Only ready/nondeleted rows resolve as attachments.
- [x] Database and boundary reject unsupported MIME, unsafe filename, invalid checksum, and >25 MB.

## Verification

```bash
bun test packages/attachments
bun run typecheck
```

## Evidence

Package `@rpg/attachments` (entry points `.`, `./policy` (pure, browser-safe), `./postgres`, `./s3`):

- `policy.ts`: allowlist (`application/pdf`, `image/jpeg`, `image/png`, `image/webp`),
  `MAX_ATTACHMENT_BYTES = 26_214_400` inclusive, filename rule (1–255 code points; no C0/C1
  control, DEL, `/` or `\`; not blank, `.` or `..`), lowercase-hex SHA-256, lifetimes.
- `content.ts`: file-signature check (PDF at byte 0, JPEG, PNG, RIFF/WEBP), opaque object keys,
  streamed SHA-256 digest.
- `storage.ts`: `ObjectStorage` port, `ObjectStorageUnavailable`, `UnconfiguredObjectStorage`,
  RFC 5987 `Content-Disposition`.
- `model.ts`: TypeBox contracts (`AttachmentUploadRequest`, `AttachmentFinalizeRequest`,
  `AttachmentMetadata` ⊇ frozen `AttachmentRef`, `AttachmentUploadPermission`,
  `AttachmentReadGrant`); `additionalProperties: false`; no key, URL or byte field in metadata.
- `application.ts`: repository port, lifecycle record, service (tasks 03–04).
- `memory.ts`: in-memory repository and storage test kit.
- `infra/postgres`: Drizzle schema and `PostgresAttachmentRepository` (conditional transitions:
  `markReady` only from an unexpired pending row with equal declared values, `markFailed` only from
  pending, `hardDeleteUnready` never touches ready rows; expiry by database time, exclusive).

Migration `packages/identity/drizzle/0008_attachment_metadata.sql` (generated with
`bun run db:generate`, renamed from the random tag before applying; applied with
`bun run db:migrate`). Table `attachments` with every `_db.md` column, the five indexes, and checks:
owner class token, filename, MIME allowlist, declared size 1–26,214,400, 32-byte checksum digests,
verified = declared, object-key shape, status, lifecycle (ready ⇔ verified + finalized; failed ⇔
`failed_at`), deletion only for ready rows with `purge_after` exactly when deleted, feature 04
Visibility shape (`gm_only`/`everyone` ⇒ `[]`; `party`/`players` ⇒ non-empty array), version ≥ 1.
The only `bytea` columns are the two digests. No FK to `campaigns` (feature 02 persistence
boundary). The table is not published to PowerSync (metadata sync is task 05).

Tests (with `.env`):

- `src/policy.test.ts`: 25 (MIME outlines incl. every BDD-rejected type, exact 25 MB and +1 byte,
  filenames, checksum shape, signatures vs HTML/SVG/RIFF-WAVE/leading junk, keys, streamed digest,
  disposition header injection, metadata contract has no key/bytes).
- `src/infra/postgres/repository.integration.test.ts`: 6 (only digests are binary; 23 database
  check violations, each naming its constraint; ready/non-deleted listing; concurrent `markReady`
  transitions once; exclusive 24 h boundary by database time; cleanup by database time never
  touches ready rows; concurrent HTTP-less finalize leaves one ready row).
- `bun test packages/attachments`: 84 pass, 0 fail.
- `bun run typecheck`: 11/11 workspaces exit 0.

## Open

- Party Visibility is stored (feature 04 representation) but rejected at upload while party
  targeting is inactive (`target_mode_not_allowed`).
