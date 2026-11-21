# Task 04: Live sync and real-stack end-to-end

Status: completed (2026-11-03)

## Scope

- Live PowerSync: a handout revealed through `/sync/mutations` reaches player A only, then leaves on un-reveal.
- `apps/web/e2e/handouts.e2e.ts` over PostgreSQL, PowerSync, and the real API (`fixtures/content-api-server.ts`).

## Acceptance Criteria

- `PRD.md` s.87 Test 3: player B never holds the handout, in the sync payload or in the local database.
- `PRD.md` s.78: GM confirm to the player's screen in under 5 seconds.
- An offline GM reveal waits, then reaches the table on reconnect. A recipient reads it offline.

## Verification

```bash
bun test apps/api/src/modules/sync/sync-config.powersync.integration.test.ts
bun x playwright test apps/web/e2e/handouts.e2e.ts
```
