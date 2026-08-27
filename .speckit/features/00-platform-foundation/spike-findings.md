# Spike Findings — Task 10

Date: 2026-08-27. Source: `tasks/task_10.md`.
Environment: Chromium 151.0.7922.34 (headless, Playwright), Bun 1.3.14, PostgreSQL 17.11,
PowerSync Service 1.25.0 (Open Edition), SQLite 3.51.0 via `@sqlite.org/sqlite-wasm`.

The spike code is deleted at the freeze tag. This note is what survives it.

## Verdicts

| Question | Verdict | Gates |
| --- | --- | --- |
| Search — does SQLite/WASM give usable full-text search? | **GO** | features 14, 20 |
| Sync — does an offline write reach PostgreSQL and come back? | **GO** | feature 03, `SyncedRepository` |

## Measurements

Campaign-sized corpus, 5000 documents.

| Operation | Result |
| --- | --- |
| Index 5000 documents (FTS5) | 101 ms |
| Word query | 2.4 ms |
| Phrase query | 0.5 ms |
| Prefix query (`ware*`) | 0.5 ms |
| Ranked boolean query | 3.5 ms |
| 5000 durable writes in OPFS | 23 ms |
| **Cold open + read 5000 rows from warm OPFS** | **8 ms** |
| Local write while disconnected | 8.7 ms |

The cold-open number matters for `PRD.md` s.79 (p95 under 2 s to usable Session Mode). At 8 ms
the local database is not the constraint; the budget will be spent on bundle, hydration, and
first render. Feature 18 owns that measurement, and it should not blame storage.

## Finding 1 — conflict detection is asynchronous, and the contract must say so

**This is the finding that affects the freeze.**

PowerSync is asymmetric. Reads flow PostgreSQL → sync service → local SQLite. Writes do not come
back the same way: the client queues a write locally and uploads it to a backend the application
owns, and that backend is the only thing that touches PostgreSQL.

Observed, end to end:

```text
client offline   -> insert succeeds locally in 8.7 ms, interface reports success
                 -> 1 entry in the upload queue
client reconnects-> queued write reaches PostgreSQL
                    applied: [{"id":"npc-offline-...","op":"INSERT","version":1,"ok":true}]

stale write      -> rejected server-side on upload, not at write time
                    [{"id":"npc-1","op":"CONFLICT","expectedVersion":1,"actualVersion":4}]
```

Consequence for `SyncedRepository.upsert(value, expectedVersion)` as frozen in task 04: it returns
`Result<T, RepositoryError>`, which reads as though a conflict is known at call time. For an
offline write it is not. The local write succeeds, the interface has already told the user the
change was applied, and the conflict arrives seconds or hours later.

`PRD.md` s.80 requires zero silent overwrites and explicit presentation of unresolvable conflicts.
That is achievable, but not through the return value of `upsert` alone.

**Recommended contract change, before the freeze tag:**

- Keep `upsert(value, expectedVersion)` returning a synchronous `Result` — it stays correct for
  the online path and for the in-memory double.
- Add a deferred-conflict channel to the contract: a subscription a feature can observe for
  conflicts detected at upload time, carrying the same `VersionConflict` payload.
- Feature 03 owns the shared conflict surface (its FR-009); features render conflicts from that
  channel rather than from an `upsert` return value.

Without this, every feature will assume `upsert` tells it the truth, and the offline case will
silently do the thing `PRD.md` s.80 targets at zero.

## Finding 2 — OPFS is worker-only, and a main-thread check lies

`FileSystemFileHandle.createSyncAccessHandle` is not exposed on the main thread in Chromium, and
sqlite-wasm refuses to install the OPFS VFS there:

```text
Ignoring inability to install OPFS sqlite3_vfs:
The OPFS sqlite3_vfs cannot run in the main thread because it requires Atomics.wait().
```

The first version of this spike checked OPFS on the main thread and reported a false NO-GO.
Feature 03 must run its local database in a worker. This is not a preference.

## Finding 3 — sqlite-wasm must be served as static assets, not bundled

The library loads a sibling helper, `sqlite3-opfs-async-proxy.js`, by relative URL at runtime.
Bundled through Vite that resolution fails with `Loading OPFS async Worker failed for unknown
reasons`. A dynamic import inside a bundled worker is still rewritten even with `@vite-ignore`.

What worked: copy the `jswasm/` distribution to a static path and load the **classic** worker
`sqlite3-worker1.js`, driving it with the worker1 message protocol. Feature 03 inherits this
build constraint, and it should be settled in its techspec rather than discovered during
implementation.

## Finding 4 — the app must be cross-origin isolated

OPFS SyncAccessHandle requires `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. This constrains how the PWA is served and how any
cross-origin subresource is loaded, which touches feature 05 (attachments) as much as feature 03.

## Finding 5 — verify browser capability in a real browser

The embedded browser used for development could not spawn the nested worker the OPFS VFS depends
on, from either a module worker or a classic worker, with correct COOP/COEP headers and no proxy
configured. In headless Chromium 151 every one of those steps passed.

Had the spike stopped at the embedded browser, it would have reported NO-GO on search **and**
sync, and features 03, 14 and 20 would have been redesigned around a limitation that does not
exist in any target browser.

## Environment findings (feature 00 FR-010, task 08)

Not product findings, but they cost hours and the next person should not repeat them.

- Docker runs inside WSL on this machine. Published ports are **not** reliably reachable from
  Windows `localhost`; the WSL VM address works when the VM is up. Consider enabling WSL mirrored
  networking, or document the address.
- The WSL VM shuts down when idle, taking Docker with it. Containers with `restart: unless-stopped`
  come back, which looks like a crash loop from the outside. Long-running tests need the VM pinned.
- Chromium could not reach the WSL VM address at all (`ERR_CONNECTION_TIMED_OUT`) while `curl`
  could, with no proxy configured — a firewall profile on the WSL adapter. Proxying through the
  dev server to same-origin sidesteps it, and also removes CORS and COEP-on-subresource problems.
- Neither `node-postgres` nor Bun's SQL client connected reliably from Windows to the WSL-hosted
  PostgreSQL. Running the backend inside the Docker network removed the problem entirely.
- PostgreSQL needs `wal_level=logical` for the sync provider. Already set in `compose.yaml`.
- PowerSync requires a `powersync` publication and its own storage database. Feature 03 decides
  what of that becomes permanent.

## What was not tested

- The IndexedDB-backed VFS fallback path (`PRD.md` s.53). OPFS was available throughout, so the
  fallback never engaged. Feature 03 must exercise it deliberately, on a browser or context where
  OPFS is unavailable.
- Sync rules enforcing membership and visibility. The spike used one global bucket. Features 04
  and 03 own the real rules, and `PRD.md` s.34 makes them a correctness requirement, not a filter.
- Multi-client convergence. One client only.
- Anything at real campaign scale over a slow network.
