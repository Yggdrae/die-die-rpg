# Task 14: Custom fields editor

Status: completed (2026-10-30)

## Goal

Let a GM add, edit, and remove free-form custom fields (D-01) on any entity, stored in
`content_entities.fields` and validated identically on device and authority.

## Dependencies

- Tasks 06, 12. The rule (task 01) and authority validation (task 06) already exist.

## Context

- PRD: FR-001 (custom fields, `PRD.md` s.30).
- TechSpec: D-01 (≤ 32 label → string pairs, label trimmed 1..64 and unique case-insensitively,
  value 0..1,000).
- Data: `../_db.md` `fields jsonb` column (present since task 02; no migration).
- BDD: "A GM adds a free-form custom field".

## Scope

### Change

- `apps/web/src/features/content/`: field rows in `EntityEditor` (add, rename, edit value,
  remove) validated with the task 01 rule before queuing; detail lists fields sorted by label.
- Tests: device rule and authority reject the same invalid inputs; audit stores
  `{ changed: ['fields'] }` only.

### Do Not Change

- Table shape; type configuration (no per-type field declarations in P0).

## Acceptance Criteria

- [x] Adding a field needs no screen or configuration change for any type.
- [x] Duplicate label (case-insensitive), 33rd field, over-long label or value rejected on device
  and at the authority identically.
- [x] Field edits are versioned and conflict like other structured fields.
- [x] No field label or value appears in logs or audit payloads.

## Verification

```bash
bun test packages/content apps/api/src/modules/content apps/web/src/features/content
bun run typecheck
```

## Evidence (2026-10-30)

- `apps/web/src/features/content/EntityEditor.tsx`: "Custom fields" fieldset (rows sorted by label;
  add, rename, edit value, remove); rows -> `fieldsFromRows` (same D-01 rule, `normalizeCustomFields`)
  before `EntityLocalRepository.update(id, { fields }, version)`; nothing is queued on a rule error.
  No type configuration is read (the same rows for every type, a removed type included).
- `content-model.ts`: `CustomFieldRow`, `sortedFields`, `customFieldRows`, `fieldsFromRows` (an exact
  duplicate label is refused before an object would collapse it; a fully blank row is ignored);
  `field_*` / `too_many_fields` / `invalid_fields` messages in `RULE_MESSAGES`.
- `EntityViews.tsx`: detail lists fields sorted by label (case-insensitive).
- Defect found and fixed (`packages/content/src/domain.ts`): `normalizeCustomFields` assigned
  `fields[label] = value`, so a free-form label `__proto__` was silently dropped (device and
  authority alike); now defined as an own property. Test: `domain.test.ts` "a free-form label that
  names an object property is kept as a field".
- Logs: the appliers log nothing about payloads (unchanged); audit payload of a field edit is
  `before {}`, `after { type, changed: ['fields'] }` (the type is kept by design so the event names the
  record kind; no label or value).
- Tests:
  - `apps/api/src/modules/content/appliers.integration.test.ts` +1 (PostgreSQL, real authority):
    7 invalid field sets rejected identically by `EntityLocalRepository.update` (code), by
    `EntityService.update` (`invalid_payload` + same reason) and by the applier (`invalid_payload`),
    nothing queued, no audit row; accepted edit -> version 2, audit `changed: ['fields']` without any
    label/value; concurrent edit from the same base -> `conflict` with both values; a name-only edit
    with fields in another key order records no field change.
  - `apps/web/src/features/content/content-model.test.ts` +2 (editor rows vs device repository on
    the same invalid inputs; sorting, round trip, safe copy for every code).
  - `apps/web/src/features/content/content-views.test.tsx` +2 (detail sorted by label; the editor
    renders identical field rows for every configured type and an unconfigured one).
  - `apps/web/e2e/content.e2e.ts` +1 Playwright: GM adds "Price" = "one silver" (detail + authority
    `fields`, version 2), "price" refused with the duplicate message, remove + add "Allegiance",
    detail sorted, authority holds both.
  - `packages/content/src/domain.test.ts` +1.
- Focused: `bun test packages/content apps/api/src/modules/content apps/web/src/features/content
  --timeout 30000` 129 pass, 0 fail when task 14 finished, 137 pass, 0 fail with tasks 15-17; `bun x playwright test apps/web/e2e/content.e2e.ts -g "custom
  field"` 1 passed; `bun run typecheck` exit 0.
