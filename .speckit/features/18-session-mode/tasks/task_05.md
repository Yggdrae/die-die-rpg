# Task 05: Live sync and real-stack end-to-end

Status: completed (2026-11-04)

## Scope

- Live PowerSync: a player receives the session and the public entry, never the GM notes or the `gm_only` entry.
- `apps/web/e2e/sessions.e2e.ts` over PostgreSQL, PowerSync, and the real API.

## Acceptance Criteria

- `PRD.md` s.78 from Session Mode: an NPC added well under 30 seconds, a reveal on the player's screen within 5 seconds.
- `PRD.md` s.76: a whole session offline, accepted once on reconnect.
- `PRD.md` s.79: ten cold offline opens, p95 under 2,000 ms.

## Verification

```bash
bun test apps/api/src/modules/sync/sync-config.powersync.integration.test.ts
bun x playwright test apps/web/e2e/sessions.e2e.ts
```

## Evidence (2026-11-04)

- Live PowerSync: owner and assistant GM hold the session, the notes, and both entries; player A holds the session
  and the public entry only, and nothing in the payload names the notes or the hidden entry; GM-only churn and a notes
  edit send player A nothing.
- `sessions.e2e.ts` (4 tests, real stack, dev server): Add NPC from Session Mode stored locally in 100 ms; reveal from
  Session Mode on the player's screen in 846 ms; a whole offline session accepted on reconnect; ten cold offline opens
  588 to 616 ms, p95 616 ms (budget 2,000 ms). The cold open is a page reload with the API and PowerSync unreachable,
  measured to the visible party panel, on the Vite dev server with a warm HTTP cache.
