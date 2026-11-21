# Task 04: Real-stack end-to-end

Status: completed (2026-11-06)

## Scope

- `apps/web/e2e/search.e2e.ts` and `features/search/e2e-harness.tsx` over PostgreSQL, PowerSync, and the real API.

## Acceptance Criteria

- `PRD.md` s.88: a GM finds a known NPC in under 5 seconds and opens it in the content view.
- A player never finds GM-only content (count 0) and finds what is visible to everyone.
- A location synchronized from the GM appears on the player's open search; an offline-created NPC is findable.
- The palette shows search results.

## Verification

```bash
bun x playwright test apps/web/e2e/search.e2e.ts
```

## Evidence (2026-11-06)

- `search.e2e.ts` (2 tests, real stack, dev server): "mir" -> GM-only NPC first in 29 ms (budget 5,000 ms), opens the
  content detail; the player finds the everyone location, 0 results for the NPC name and its summary word; a location
  created by the GM appears on the player's open search; the player's character opens its sheet; the palette shows
  search results and opens the lookup panel; offline creation is found at once and accepted on reconnect.
