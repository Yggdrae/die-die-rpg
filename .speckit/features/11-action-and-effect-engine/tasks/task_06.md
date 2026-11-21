# Task 06: Browser composition, guard, gates

Status: completed (2026-11-01)

## Scope

- `browserEffectRepository`, replica table, e2e with a probe target; guard rules; docs; statuses.

## Acceptance Criteria

- An offline application displays through the overlay and drains once in a real browser.
- All completion gates pass with fresh evidence.

## Verification

```bash
bun run check
bun run typecheck
bun test --timeout 30000
bun run guard
bun run build
bun run test:e2e
```
