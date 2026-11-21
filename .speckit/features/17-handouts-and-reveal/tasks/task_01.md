# Task 01: Handout type and attachments that follow it

Status: completed (2026-11-03)

## Scope

- `handout` in feature 16 `ENTITY_TYPES`, with `attachmentsFollowEntity`, and `HANDOUT_ENTITY_TYPE`.
- `attachmentVisibilityFor`: an upload on a handout carries `everyone`, so feature 05's intersection follows the
  handout. The generic entity screen and the handout screen both use it.

## Acceptance Criteria

- Feature 16's lists, search, export, and import take handouts with no other change.
- An image on a hidden handout is readable by its recipient only after the reveal.

## Verification

```bash
bun test packages/content
bun test apps/api/src/modules/content/handouts.integration.test.ts
```
