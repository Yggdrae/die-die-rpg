# Contract Change: Transaction-Aware Campaign Import

- Date: 2026-10-27
- Requested by: feature 07 task 01 (blocks feature 07 tasks 06 and 07)
- Extends: `registries.ts` `ExportableModule` / `ExportChunk` (frozen at the wave 0 tag)
- Affected features:
  - 07: hosts the import coordinator.
  - 02: creates the campaign inside the import transaction.
  - 01: creates only the importer's owner membership.
  - 05: `AttachmentManifestExporter` restores metadata or reports binaries unresolved.
  - Every future content contributor (15–19): restores its own chunk through the new interface.
  - 04: Visibility narrowing rule on remap.
- Review status: **RATIFIED and APPLIED, 2026-10-28.**
  - Track A: approved 2026-10-28 by repository owner delegation.
  - Track B: approved 2026-10-28 by repository owner delegation.
  - Track C: approved 2026-10-28 by repository owner delegation.
  - Delegation: on 2026-10-28 the repository owner authorized the agents to do everything except
    commits ("Com exceção de commits, pode fazer tudo"), which includes ratifying this note. The
    approvals were recorded within one working day of the 2026-10-27 request (FR-008).
  - Applied as proposed, additively, in `packages/contracts/src/registries.ts`; see
    "Ratification record" at the end of this note.

## Reason

The frozen import surface is `import(campaignId: Id, chunk: ExportChunk): Promise<Result<void, string>>`.
It cannot honestly implement feature 07 P0 (`07/_db.md` Atomic Import, `07/_techspec.md` Required
Contract Revision). Four things are missing:

1. **No shared transaction.** Each contributor commits on its own connection. "A failure leaves no
   partial campaign" (`07/_prd.md` Behavioral Constraints) cannot be guaranteed. The same goes for
   "Contributor failure rolls back every PostgreSQL row including owner and preserved chunks"
   (`07/_db.md` Required Data Tests).
2. **No identifier map.** Import must assign new identifiers (FR-007). A contributor that renames
   its own records has no shared, deterministic way to:
   - resolve a reference to another contributor's record, such as an attachment owner, a handout
     on an entity, or a targeted player;
   - publish its own old-to-new mapping.
3. **No report.** FR-007 and FR-008 require per-module restored counts and explicit warnings, for
   example "targeted visibility narrowed to `gm_only`" or "binary not restored". `Result<void, string>`
   carries one opaque string.
4. **No validation phase.** "Import validates ... before any write" (FR-006, BDD "Invalid package
   input changes nothing") needs a write-free check of each recognized chunk. Only then can a
   transaction start. The frozen surface offers only the writing call.

The export half needs no change. Feature 07 tasks 02–05 ship on the frozen
`export(campaignId)`. Online consistency is proved by a double read with equal canonical checksums,
and offline consistency by a replica cursor (`packages/campaign-portability/src/orchestrator.ts`).

## Proposed change (additive, in `packages/contracts/src/registries.ts`)

```ts
/** Opaque capability: a contributor passes it back to its own persistence adapter only. */
export interface ImportTransaction {
  readonly brand: 'ImportTransaction';
}

export const ImportWarning = Type.Object(
  {
    code: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
    /** Source record id from the package, never content. */
    sourceId: Type.Optional(Id),
    count: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false, $id: 'ImportWarning' },
);
export type ImportWarning = Static<typeof ImportWarning>;

export interface ImportPlanContribution {
  /** Source ids this chunk defines, by record kind (e.g. 'attachment', 'entity'). */
  readonly defines: readonly { readonly kind: string; readonly sourceId: Id }[];
  readonly warnings: readonly ImportWarning[];
}

export interface ImportContext {
  /** The new campaign created by feature 02 inside `transaction`. */
  readonly campaignId: Id;
  /** The importing user, sole owner of the new campaign. */
  readonly importerUserId: Id;
  /**
   * Deterministic, total over every `defines` entry of every recognized chunk.
   * `undefined` for an id no chunk defines, e.g. a member of the source campaign: memberships are
   * never imported.
   */
  mapId(kind: string, sourceId: Id): Id | undefined;
  readonly transaction: ImportTransaction;
}

export interface ImportResult {
  readonly restoredCount: number;
  readonly warnings: readonly ImportWarning[];
}

/**
 * Version 2 of the contributor surface. `export` is unchanged.
 * `validate` must not write; `restore` must write only through `context.transaction`.
 */
export interface ImportableModule {
  readonly moduleId: string;
  /** Chunk versions this module can restore. A chunk outside this list is reported, not restored. */
  readonly importChunkVersions: readonly string[];
  validate(chunk: ExportChunk): Promise<Result<ImportPlanContribution, string>>;
  restore(chunk: ExportChunk, context: ImportContext): Promise<Result<ImportResult, string>>;
}
```

### Rules carried by the contract text

- **Visibility narrowing.** If `mapId('member', id)` is `undefined` for a `players` or `party`
  target, the contributor stores `gm_only` and emits `ImportWarning{ code:
  'visibility_narrowed_to_gm_only', sourceId }`. It never widens to `everyone`
  (`04/_db.md`, `07/_techspec.md` Import Flow).
- **No side effects outside the transaction.** A contributor never writes outside
  `context.transaction` and never calls object storage before commit (`07/_db.md`).
- **Safe errors.** Error strings are safe codes (`^[a-z][a-z0-9_]*$`). The host never shows them
  together with package content.

## Compatibility and migration

- **Source-compatible and additive.**
  - `ExportableModule`, `ExportChunk` and the existing `import` keep their exact shapes.
  - Every current implementer compiles unchanged: `AttachmentManifestExporter` (feature 05) and
    `CampaignExporter` (feature 02, added by feature 07 task 04).
- **Adapter.** Feature 07 treats a contributor that implements only the frozen `import` as *not
  restorable*. Its chunk is preserved opaquely (`import_preserved_chunks`) and reported with
  `contributor_not_transactional`. It is never restored outside the transaction.
  - The legacy `import` is therefore never called by the coordinator.
  - It is marked `@deprecated` once every P0 contributor implements `ImportableModule`, and removed
    in a later dated note.
- **Transaction capability.** The API composition root owns the concrete adapter: one PostgreSQL
  transaction opened by feature 07. Each contributor's package exports a function such as
  `restoreAttachmentsWithin(executor)`. That function unwraps the opaque capability only inside the
  owning package's persistence adapter. This follows the same pattern as
  `CampaignTransactionParticipant` (feature 02) and `VisibilityWrite.recordAudit` (feature 04).
  No Drizzle, postgres.js or SQL type appears in `@rpg/contracts`.
- **Feature 02 and feature 01 participants.**
  - Feature 02 needs a campaign-create entry point that joins a caller-supplied transaction.
  - Feature 01 needs `CampaignMembershipWriter.createOwner` inside that same transaction.
  - Both are package-internal changes, not contract changes.
- **No data migration** for existing rows. Feature 07 task 06 adds `import_jobs` and
  `import_preserved_chunks` in its own forward migration.

## Tests required when ratified

- **`packages/contracts`.** Compile-time conformance:
  - an object literal implementing `ImportableModule`;
  - the frozen `ExportableModule` still assignable;
  - `ImportWarning` TypeBox validation (valid and hostile codes).
- **Feature 07 coordinator.**
  - Rollback when any contributor `restore` returns `err` or throws: no campaign, owner,
    contributor row or preserved chunk remains.
  - `validate` is never followed by a write when any chunk is invalid.
  - The same package always yields the same `mapId` result for the same job id.
- **Visibility narrowing** test for an unmapped `players` target.

## Decision requested

Approve or reject the additive `ImportableModule`, `ImportContext`, `ImportResult`,
`ImportWarning` and `ImportTransaction` surface above. One approval per track (A, B, C) within one
working day (FR-008).

On approval, the next agent:

1. Adds the shapes to `packages/contracts/src/registries.ts` with the tests above.
2. Records the approvals in this note.
3. Unblocks feature 07 task 06.

On rejection, feature 07 import stays disabled. Export continues to ship unchanged.

## Ratification record (2026-10-28)

- **Decision:** approved, one approval per track (A, B, C), by repository owner delegation.
- **Applied shapes** (`packages/contracts/src/registries.ts`, additive): `ImportTransaction`,
  `ImportWarning`, `ImportPlanContribution`, `ImportContext`, `ImportResult`,
  `ImportableModule` exactly as proposed, plus `ImportCode`, the named TypeBox schema for the
  safe-code pattern that `ImportWarning.code` already used (`^[a-z][a-z0-9_]{0,63}$`).
  The Visibility narrowing rule is written into the `ImportContext.mapId` doc comment; for a
  `party` target the lookup kind is `party`.
- **Unchanged:** `ExportableModule`, `ExportChunk`, the frozen `import`, `SearchDoc`,
  `SearchIndexer` and `SessionQuickAction`. Every existing implementer compiled unchanged.
- **Contract tests:** `packages/contracts/src/registries.test.ts` (object-literal
  `ImportableModule`, frozen `ExportableModule` still assignable and combinable, `ImportWarning`
  and `ImportCode` valid and hostile values).
- **Implementation (feature 07 task 06):** see `07-campaign-import-export/tasks/task_06.md`.
  - The transaction is opened by feature 07 (`PostgresImportTransactions` in
    `@rpg/campaign-portability/postgres`). The composition root hands each contributor an
    `unwrap` function; only its own persistence adapter casts the handle.
  - Feature 02 joins it through `PostgresCampaignRepository.createWithin`, which also runs
    feature 01's `CampaignMembershipWriter.createOwner` on the same handle.
  - The legacy `import` is never called by the coordinator. Both P0 contributors (`campaign`,
    `attachments`) now implement `ImportableModule`. Marking the legacy `import` `@deprecated`
    and removing it is left to a later dated note, as planned; this note does not touch it.
