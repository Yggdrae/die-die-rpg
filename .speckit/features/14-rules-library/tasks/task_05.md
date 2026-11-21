# Task 05: Real-stack end-to-end

Status: completed (2026-11-06)

## Scope

- `apps/web/e2e/rules.e2e.ts` with a Bun API helper and a test-only harness: a GM and a player in a campaign pinned to
  the first installed package that claims `integrated_rules`.

## Acceptance Criteria

- A rule found in under 10 seconds from focusing the search, online and offline (D-16).
- Cross-reference, bookmark, recently viewed; global search and the Session Mode palette reach the section.
- The player's device never holds the GM's marks and the reverse; an offline bookmark reaches the authority.

## Verification

```bash
bun run test:e2e -- rules
```

## Evidence (2026-11-06)

- `apps/web/e2e/rules.e2e.ts`, `fixtures/rules-api-server.ts`, `features/rules/e2e-harness.tsx`: 2 tests pass.
- Measured: "chec" -> Checks in 79 ms online, "intr" -> Introduction in 55 ms offline (budget 10,000 ms, dev server).
