# Task 06: Reveal and un-reveal interface

Status: pending. Depends on tasks 03–04.

## Scope

- Build generic Visibility controls and current-member target picker.
- Display conflicts and the prior-knowledge limitation of un-reveal.
- Keep unsupported party controls absent/fail-closed.
- Add component/Playwright tests for targeted reveal, additive repeat, and un-reveal.

## Acceptance Criteria

- Player A receives a reveal and player B receives no row/payload.
- Removing the last target stores `gm_only` and removes future/local access after sync.
- Unauthorized users cannot produce a visibility mutation by direct request.

## Verification

```bash
bun test apps/web/src/features/visibility apps/api/src/modules/authorization
bun run build
```

