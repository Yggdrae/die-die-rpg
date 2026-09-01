# Task 08: Sync status, browser acceptance, and performance

Status: pending. Browser storage is measured; installed-PWA Session Mode, promised offline flows,
and multi-client provider convergence remain unverified.

## Scope

- Complete synchronized/pending/offline/error status UI and initial-sync progress.
- Automate promised offline flows, restart, multi-client convergence, and failure injection.
- Measure cold-open p95 on the documented browser/device matrix and both storage backends.
- Document only verified runtime/startup requirements.

## Acceptance Criteria

- Status never says synchronized while pending/error work exists.
- All P0 offline flows remain usable and converge after reconnect.
- Warm-replica Session Mode reaches usable state under two seconds p95 on the accepted matrix.

## Verification

```bash
bun run check
bun run typecheck
bun test
bun run guard
bun run build
```
