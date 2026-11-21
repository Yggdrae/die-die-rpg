# Task 01: Verify S3 adapter, MinIO, and browser isolation

Status: completed (2026-10-27).

## Scope

- Evaluate the smallest maintained S3-compatible client/presigner under pinned Bun.
- Verify MinIO startup, private bucket bootstrap, bound upload/read grants, expiry, checksum support, and CORS.
- Verify image/PDF delivery preserves feature 03 COOP/COEP requirements and separate-origin safety.
- Record evidence and exact supported configuration; do not retain throwaway spike code.

## Acceptance Criteria

- [x] One adapter choice is evidenced under Bun/MinIO with no provider type in domain contracts.
- [x] Uploaded active content cannot execute in the application origin.
- [x] Any unsupported grant condition is documented and compensated at finalization.

## Verification

```bash
bun test packages/attachments
bun run build
```

## Evidence

### Adapter choice

`Bun.S3Client` (built into Bun 1.3.14, the pinned runtime; the API builds with `--target=bun`). No
SDK dependency was added. Adapter: `packages/attachments/src/infra/s3/bun-s3-storage.ts`
(`BunS3ObjectStorage`, exported from `@rpg/attachments/s3`). Domain and consumers depend only on
the `ObjectStorage` port (`packages/attachments/src/storage.ts`); guard rule
`no-direct-object-storage-provider` fails any `S3Client`, `Bun.s3`, `@aws-sdk/*` or `minio`
reference outside `packages/attachments/src/infra/s3/`.

Provider verified: MinIO `RELEASE.2025-09-07T16-13-09Z` (local `minio/minio:latest` image; the tag
is not pinned in `compose.yaml` because only `latest` is present locally).

### Supported configuration

| Item | Value |
| --- | --- |
| Bucket | `S3_BUCKET` (default `rpg-attachments`), private, anonymous access `none` |
| Signing user | `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (default `rpg-attachments` / dev secret); policy `rpg-attachments`: `GetObject`, `PutObject`, `DeleteObject` on `bucket/*`, `ListBucket` on the bucket (for task 06 reconciliation). Root credentials never reach the API. |
| Endpoint / region | `S3_ENDPOINT` (`http://localhost:9000`), `S3_REGION` (`us-east-1`) |
| CORS | MinIO has no per-bucket CORS; server-wide `MINIO_API_CORS_ALLOW_ORIGIN=${S3_CORS_ALLOW_ORIGIN:-http://localhost:5173,http://127.0.0.1:4173}`. Methods cannot be narrowed (MinIO limitation). |
| Bootstrap | compose one-shot `minio-bucket` (same MinIO image, `mc`); idempotent (run twice, exit 0 both times). |
| Keys | `campaigns/<campaign>/<attachment>/<random uuid>`; never a filename (DB check + `objectKeyFor`). |
| Grant lifetimes | upload 600 s, read 300 s; the adapter refuses lifetimes outside 1–3600 s (Bun itself accepts more than 7 days). |

Commands run: `wsl -e docker compose up -d --no-deps minio` (recreated with the CORS variable) and
`wsl -e docker compose up --no-deps minio-bucket` (twice).

### What a presigned grant binds (MinIO + `Bun.S3Client`)

`Bun.S3Client.presign` produces SigV4 query presigns with `X-Amz-SignedHeaders=host`.

| Condition | Upload (PUT) | Compensation |
| --- | --- | --- |
| Bucket, exact key, method, expiry | bound | — |
| Content type | not bound (`type` only adds `response-content-type`) | read grants force the declared type; finalization verifies the file signature |
| Content length | not bound (a 1 MiB body on a 12-byte grant is accepted) | finalization HEAD size check before streaming; 24 h abandoned cleanup; pending-upload cap per actor |
| Checksum | not bound, but MinIO rejects a body that does not match a sent `x-amz-checksum-sha256` (`XAmzContentChecksumMismatch`); the grant tells the client to send it | finalization streams SHA-256 and compares with the declaration |

Read grants: `response-content-type` and `response-content-disposition` are signed query
parameters (tampering gives 403). A stored `text/html` object read with a forced `image/png` grant
is served as `image/png` with `X-Content-Type-Options: nosniff`. A grant fails with
`AccessDenied: Request has expired` after its expiry. Anonymous GET and bucket listing give 403.

### Browser isolation

The app is cross-origin isolated (`COOP: same-origin`, `COEP: require-corp`). MinIO sends no CORP
or COEP headers, so:

- images use `<img crossorigin="anonymous">`; the storage CORS allowlist answers the app origin and
  COEP is satisfied. Proved: `crossOriginIsolated === true` with the image loaded; the same URL
  without `crossorigin` is blocked (mutation check: removing the attribute fails the e2e test);
- PDFs are never framed (a cross-origin frame would need COEP/CORP from the provider). They open as
  a top-level `noopener,noreferrer` navigation on the storage origin (or download with
  `attachment` disposition). Proved: the popup's origin is the storage origin, `window.opener` is
  `null`, it cannot read the app's `localStorage`, and the embedded PDF JavaScript raised no dialog;
- HTML/script bytes stored under an image grant render as a failed image and never execute.

Evidence: `packages/attachments/src/infra/s3/bun-s3-storage.integration.test.ts` (9 tests) and
`apps/web/e2e/attachments.e2e.ts` (5 tests, real MinIO URLs; the Bun helper
`apps/web/e2e/fixtures/attachment-objects.ts` signs them because Playwright runs under Node).

Throwaway spike scripts lived only in the session scratchpad; the spike bucket `rpg-spike` was
removed (`mc rb --force`).

### Results (with `.env`)

- `bun test packages/attachments`: 84 pass, 0 fail (4 files).
- `bun run test:e2e -- apps/web/e2e/attachments.e2e.ts`: 5 pass.
- `bun run build`: api and web exit 0.

## Open

- Production must serve storage from a separate **site** (registrable domain). In local dev the
  storage origin `localhost:9000` differs from the app origin but shares the `localhost` cookie jar;
  the session cookie is HttpOnly, so storage content cannot read it, but a separate site is the
  intended production boundary.
- Firefox/WebKit/mobile behavior of the PDF top-level open is not verified (only Edge headless, the
  configured Playwright channel).
