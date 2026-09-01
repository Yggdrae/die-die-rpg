# Offline Sync Runtime

Verified 2026-08-31 on Windows 11 Pro build 26200, Microsoft Edge 152.0.4191.53
(headless), AMD Ryzen 7 3700X, and 31.9 GB RAM.

## Browser requirements

- JavaScript, WebAssembly, Web Workers, and persistent browser storage.
- `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` for the OPFS worker path.
- IndexedDB is the fallback when OPFS is unavailable.
- Pinned PowerSync 1.39.1 and WA-SQLite 1.7.0 worker/WASM assets are copied by
  `bun run --cwd apps/web sync:assets` before development and production builds.

## Measured local database open

The Playwright acceptance opens a persisted fixture, closes it, and measures 20 cold database
reopens for each backend. The p95 results from the verified matrix were:

| Backend | p95 |
| --- | ---: |
| OPFS | 198.4 ms |
| IndexedDB | 79.9 ms |

Run with:

```bash
bun run test:e2e -- apps/web/e2e/offline-sync.e2e.ts
```

This proves browser-worker asset loading, persistence across database restart, and the local
database portion of the two-second startup budget. It does not yet prove installed-PWA Session
Mode time-to-usable or the complete promised offline-flow matrix; those gates require the
dependent feature screens and fixtures.

## Local service stack

The repository defines PostgreSQL 17 with logical replication, MongoDB 7, and PowerSync Service
1.25.0 in `compose.yaml`. Docker was not installed on the verification machine, so service startup,
PostgreSQL replication, and end-to-end multi-client convergence remain unverified here.
