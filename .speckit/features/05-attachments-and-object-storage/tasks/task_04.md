# Task 04: Authorized reads and safe rendering

Status: completed (2026-10-27), against feature 04 fixture owner classes. Depends on tasks 02–03 and feature 04.

## Scope

- Implement list/resolve routes and five-minute signed read grants after fresh Decisions.
- Build inert image and sandboxed/separate-origin PDF viewer behavior.
- Make hidden/missing resolution indistinguishable and redact URL/key/log data.
- Test expiry, direct identifier probes, deletion/visibility changes, and active malformed content.

## Acceptance Criteria

- [x] No URL is issued without current authorization.
- [x] Leaked URLs expire and cannot be renewed after access loss.
- [x] Uploaded content cannot access application data/session credentials.

## Verification

```bash
bun test packages/attachments apps/api/src/modules/attachments apps/web/src/features/attachments
bun run build
```

## Evidence

- Service: `list`, `resolve`, `issueRead` (`packages/attachments/src/application.ts`). Effective
  decision = the owner's `read` decision (fresh `ContentAccess.authorizeResource`) AND the same
  owner declaration evaluated with the attachment's own Visibility (an attachment narrows, never
  widens, its owner). Only `ready` and non-deleted rows resolve. Every grant asks again; nothing is
  cached. Read grants last 300 s and force the declared `Content-Type` and the disposition.
- Routes: `GET /campaigns/:campaignId/resources/:class/:resourceId/attachments` (sanctioned
  `requireResource({capability: 'read'})` pre-handler, then the service repeats and filters; in the
  content-route inventory) and `GET /campaigns/:campaignId/attachments/:attachmentId/read
  [?disposition=inline|attachment]` (200 `no-store`; 404 safe denial; 503 only for an allowed
  actor). Hidden, missing, pending, tombstoned, foreign-campaign and hidden-owner attachments give
  byte-identical responses (status, body, all headers but `date`), with no filename.
- Redaction: routes and service never log URLs, keys or filenames; provider faults log the
  operation name only. Test captures every log line through several reads and a provider fault and
  finds no URL, key, filename or `X-Amz` parameter.
- Web (`apps/web/src/features/attachments/`): `attachment-model.ts` (a grant is usable only when it
  is a 200 with an HTTP(S) URL on an origin other than the app's; everything else is
  `unavailable`), `attachments-api.ts` (list, read, upload client: bytes go to the storage URL with
  `credentials: 'omit'` and `no-referrer`), `Attachments.tsx` (`<img crossorigin="anonymous"
  referrerpolicy="no-referrer">`; PDFs only via a `noopener,noreferrer` top-level window or download,
  never `iframe`/`embed`/`object`; failures show "Preview unavailable."), `e2e-harness.tsx`.

Tests (with `.env`):

- `packages/attachments/src/application.test.ts` read block: allowed grant (5 min, declared type),
  hidden == missing for 4 probes and 2 outsiders and a wrong campaign, list filtering, no widening,
  attachment and owner narrowing deny the next grant, membership revocation denies renewal,
  tombstone denies, decision unavailable fails closed, download disposition only when allowed.
- `apps/api/src/modules/attachments/routes.test.ts`: list/read byte-identity, renewal after access
  loss, author-private owners (GM role denied), 503 only when allowed, log redaction, inventory has
  no violations and `ready()` passes.
- `packages/attachments/src/infra/s3/bun-s3-storage.integration.test.ts`: expiry (`Request has
  expired`), forced type/disposition, signed-parameter tampering 403, `nosniff`, CORS allowlist.
- `apps/web/src/features/attachments/attachments.test.tsx`: 8 (unsafe URL schemes and same-origin
  URLs refused, no executable markup, upload client sends metadata only to the API).
- `apps/web/e2e/attachments.e2e.ts`: 5 against real MinIO grants (inert image with the app still
  cross-origin isolated; HTML stored under an image grant does not execute; PDF opens on the storage
  origin with no opener and no access to app storage; expired URL degrades; denied read never
  contacts storage). Mutation: removing `crossOrigin` fails the image test.
- `bun test packages/attachments apps/api/src/modules/attachments apps/web/src/features/attachments`:
  113 pass, 0 fail. `bun run build`: exit 0.

## Open

- Deletion itself (versioned tombstone route, `attachment.deleted` audit) is task 06; this task
  proves a tombstoned row is denied using the repository's test helper and a direct SQL update.
- An issued URL stays usable until its 5-minute expiry after access loss (no proxying in P0, as
  `_db.md` states); renewal is denied immediately.
- No production owner class (see task 03).
