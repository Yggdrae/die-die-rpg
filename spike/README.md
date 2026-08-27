# Spike — task 10

Throwaway. **Deleted at the freeze tag (task 11).**

Its only product is
[`../.speckit/features/00-platform-foundation/spike-findings.md`](../.speckit/features/00-platform-foundation/spike-findings.md).
Read that; this directory is the evidence behind it, not something to build on. If any of this
starts looking like reusable infrastructure, it has become feature 03 and belongs there.

## What it answers

1. **Search** — does SQLite/WASM give usable full-text search, and does OPFS persist it?
   Gates features 14 and 20.
2. **Sync** — does a write made offline in local SQLite reach PostgreSQL and come back?
   Gates feature 03 and the `SyncedRepository` contract.

Both answered **GO**. The sync leg also produced a contract change, applied before the freeze:
conflict detection on an offline write is asynchronous, so `SyncedRepository` grew a
`conflicts` channel.

## Re-running it

```bash
docker compose -f compose.yaml -f spike/compose.powersync.yaml up -d
```

Vendored sqlite-wasm distribution (gitignored, regenerable):

```bash
mkdir -p spike/public/sqlite && cp spike/node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/* spike/public/sqlite/
```

```bash
cd spike && bun install && SPIKE_WSL_HOST=<docker-host> bun run dev
```

```bash
cd spike && node run-headless.mjs
```

## Things that will waste your time

All five are recorded in the findings note; the short version:

- OPFS is worker-only. A main-thread capability check reports a false negative.
- sqlite-wasm must be served as static assets. Bundled, it cannot find its async proxy worker.
- The page must be cross-origin isolated (COOP/COEP) or OPFS is unavailable.
- Run the headless Chromium runner, not an embedded browser. The embedded one could not spawn
  the nested worker OPFS needs and reported NO-GO on everything.
- `node run-headless.mjs`, not `bun`. Playwright's pipe transport does not work under Bun on
  Windows.
