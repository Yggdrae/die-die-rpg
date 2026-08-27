# Task 04: Contracts — Repository and Registries

## Goal

The four contracts that make features independent of each other: one repository interface, and
three registries that let a feature contribute to export, search, and the session screen without
those features knowing it exists.

## Dependencies

- Task 03

## Context

- PRD: `../_prd.md` (FR-003 `SyncedRepository`, FR-004 registries)
- TechSpec: `../_techspec.md` (Repository contract, Registry contracts)
- `../_index.md`, rule 5: cross-cutting concerns use a registry so each owner contributes
  independently. Features 07, 20, and 18 would otherwise each depend on five features.

## Scope

### Change

- `SyncedRepository<T>`: `get`, `list`, `upsert(value, expectedVersion)`,
  `softDelete(id, expectedVersion)`. A stale version returns a typed conflict through `Result`.
- `ExportableModule`: `moduleId`, `export(campaignId)`, `import(chunk)`.
- `SearchIndexer`: `moduleId`, `index(campaignId): SearchDoc[]`, plus `SearchDoc`.
- `SessionQuickAction`: `id`, `label`, optional `capability`, `invoke()`.
- Unit tests covering the contract shapes and the conflict result type.

### Do Not Change

- No implementation of any of the four. Task 05 ships the repository double; features 07, 20,
  and 18 host their own registries.
- Do not reference PowerSync. The repository contract is provider-neutral by design
  (`PRD.md` s.55), and feature 03 is free to replace the provider behind it.

## Acceptance Criteria

- [ ] `upsert` and `softDelete` require `expectedVersion`. It is not optional, so no caller can
      accidentally get last-write-wins.
- [ ] A stale-version outcome is representable as a typed `Result` failure carrying both versions,
      which is what feature 03 needs to render an explicit conflict (`PRD.md` s.80).
- [ ] `SearchDoc` carries `visibility`, so feature 20 can filter at query time rather than trusting
      a stale index.
- [ ] `SessionQuickAction` carries an optional capability key, so an action for a system that does
      not declare the capability simply does not appear.
- [ ] Registry contracts are shaped so a contributor imports only `packages/contracts` — never the
      host feature.

## Verification

```bash
bun test packages/contracts && bun run typecheck
```

## Notes

- This is the task the whole split depends on. If `expectedVersion` is optional here, twenty
  features will omit it, and feature 03 will discover in wave 3 that conflict detection is
  impossible without a data migration.
- Task 10 can invalidate `SyncedRepository`. Do not treat this task as final until the spike
  reports.
- **It did.** The spike found that conflict detection on an offline write is asynchronous: the
  local write succeeds, the interface reports success, and the server rejects it on upload
  (`../spike-findings.md`, Finding 1). `SyncedRepository` therefore also carries a `conflicts`
  channel of `DeferredConflict`. `upsert` returning ok is not proof the server accepted the
  write. This is exactly the class of error the spike exists to catch before the freeze.
