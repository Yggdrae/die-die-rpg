# Task 07: Attachment security and acceptance suite

Status: completed (2026-10-27), against feature 04 fixture owner classes (no production owner class
exists). Depends on tasks 03–06.

## Scope

- Automate upload-to-preview, offline pinned campaign, estimate accuracy, and unavailable fallback BDD flows.
- Add security tests for MIME spoofing, oversized uploads, URL leakage, CORS, XSS, and authorization bypass.
- Exercise provider failure, lost finalization acknowledgement, cleanup backlog, and missing objects.
- Verify full repository gates and document only evidenced configuration.

## Acceptance Criteria

- [x] Fixture upload reaches preview under 30 seconds on the accepted network profile.
- [x] Zero attachment paths serve without authorization or execute in application origin.
- [x] All P0 BDD scenarios have automated or explicitly profiled evidence.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```

## Normal-connection reference profile

Chromium network emulation (CDP `Network.emulateNetworkConditions`): 10 Mbit/s down, 5 Mbit/s up,
40 ms latency, applied to the browser's direct storage traffic. Map: a 1024 × 1024 PNG of noise
(3.6 MB). Measured from the start of `uploadAttachment()` (hash, permission, direct upload,
finalize) to a decoded preview (`naturalWidth === 1024`): 6,767 ms and 7,767 ms on two runs
(Edge headless, Windows 11, local Fastify + PostgreSQL + MinIO). Target: < 30 s.

## Evidence

- `apps/web/e2e/attachments-acceptance.e2e.ts` (2, real stack): the production upload client and
  viewer in the browser; the real attachment routes over PostgreSQL and MinIO run in a Bun helper
  (`e2e/fixtures/attachment-api-server.ts`, fixture owner classes) and the page's `/campaigns/**`
  requests are forwarded to it; bytes travel only browser ↔ MinIO (PUT and GET observed). (1)
  upload-to-preview within the profile above, still cross-origin isolated; (2) SVG refused
  (`unsupported_file_type`), HTML disguised as PNG refused at finalization (`signature_mismatch`),
  never listed, never executed, no dialog.
- `apps/api/src/modules/attachments/security.test.ts` (11): the module registers exactly six routes
  (collected with `onRoute`) and every one answers 401 anonymous, 404 to an outsider and to a
  foreign campaign, with no filename/checksum/URL and no grant issued; a revoked member gets the
  missing-attachment shape on every route; a player reaches no GM-only attachment on any route;
  `text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/javascript` refused before a grant;
  HTML labelled PNG/JPEG/WebP and a PDF header after leading junk fail finalization (422) and their
  bytes are deleted; read grants name the verified type, `no-store`; upload grants live 10 min,
  read grants 5 min, no other response carries a URL or key; lost finalize acknowledgement returns
  the identical attachment with one event; provider outage during finalize is 503 and retryable
  and never exposes the upload; log hygiene across every route, user and provider failure (no
  URL, key, filename, checksum, `X-Amz`, session cookie).
- Cleanup backlog: `reconciliation.test.ts` drains 250 abandoned uploads over several 100-row
  passes without touching the ready row. Missing objects: `diagnose()` reports them (task 06); the
  viewer and the offline store degrade to unavailable (task 04 expired-URL e2e, task 05 failed
  download e2e).
- Earlier tasks' evidence still green: oversized uploads (413, 25 MB boundary), URL expiry, anonymous
  object/bucket access 403, CORS allowlist (no `access-control-allow-origin` for a foreign origin),
  forced response type, image inertness and PDF isolation (tasks 01–04).

### P0 BDD scenario coverage

| Scenario group | Evidence |
| --- | --- |
| Attaching files (outline, direct bytes, invisible before finalize, finalize, retry, mismatch, abandoned) | `application.test.ts`, `routes.test.ts`, `attachments.integration.test.ts`, acceptance e2e (direct bytes) |
| Upload authorization and file policy (fail closed, denials, MIME accept/reject, 25 MB boundary, client bypass) | `application.test.ts`, `policy.test.ts`, `routes.test.ts`, `security.test.ts` |
| Authorized reading and safe rendering (temporary URL, fresh decision, hidden no leak, URL ages out, no execution) | `application.test.ts`, `routes.test.ts`, `bun-s3-storage.integration.test.ts`, `attachments.e2e.ts`, acceptance e2e |
| Offline availability (all 9 scenarios + state outline) | `offline.test.ts`, `attachments-offline.e2e.ts`, `live-sync.e2e.ts` (revocation) |
| Deletion and retention (tombstone, no inline removal, eventual removal, idempotent) | `deletion.test.ts`, `reconciliation.test.ts`, `retention.integration.test.ts`, `offline-deletion.routes.test.ts`, offline narrowing e2e |
| Published module and export | `application.test.ts` (provider-free contracts), `deletion.test.ts` export block |
| Success signals (preview < 30 s, pinned campaign offline, estimate tolerance) | acceptance e2e (profiled), offline e2e |

## Verification run (2026-10-27, with `.env`)

| Command | Result |
| --- | --- |
| `bun run check` | clean (336 files) |
| `bun run typecheck` | 11/11 workspaces exit 0 |
| `bun test --timeout 30000` | 1113 pass, 8 skip, 0 fail (103 files) |
| `bun run guard` | 294 files, no violations |
| `bun run build` | api and web exit 0 |
| `bun run test:e2e` | 55 pass |

## Open

- No production owner class (feature 16); every flow is proven on the feature 04 fixture classes.
  Production stays fail-closed (`ownerClasses: []`).
- JPEG and WebP are not rendered in a browser test; they share the PNG `<img>` path and their
  signature checks are covered server-side.
- "Deleting an attachment publishes a tombstone" is proven per device through the offline-set
  reconcile, not with two live devices (metadata does not replicate, task 05).
- Browser matrix: Edge headless only. Firefox, WebKit and mobile are not installed.
- Local dev shares `localhost` cookies between the app and MinIO (task 04 gap 3); production must
  place storage on a separate site.
