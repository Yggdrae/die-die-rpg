import { type Static, Type } from '@sinclair/typebox';
import type { ActorRef } from './actor.ts';
import { Id } from './primitives.ts';
import type { Result } from './result.ts';
import type { CapabilityKey } from './system.ts';
import { Visibility } from './visibility.ts';

/**
 * The three registries exist for one reason: features 07, 20, and 18 would otherwise each
 * depend on five other features, and would block on all of them.
 *
 * A contributor imports this module only. It never imports the host feature, and the host
 * feature never imports the contributor (`.speckit/features/_index.md`, rules 2 and 5).
 */

/* -------------------------------------------------------------------------- */
/* Export — hosted by feature 07                                              */
/* -------------------------------------------------------------------------- */

export interface ExportChunk {
  readonly moduleId: string;
  readonly chunkVersion: string;
  readonly payload: unknown;
}

/**
 * One feature contributing its own data to `.rpgpack` (`PRD.md` s.65).
 *
 * An unknown chunk on import is preserved and reported, never dropped, so a round trip
 * through a newer version does not destroy data (feature 07 FR-008).
 */
export interface ExportableModule {
  readonly moduleId: string;
  export(campaignId: Id): Promise<ExportChunk>;
  import(campaignId: Id, chunk: ExportChunk): Promise<Result<void, string>>;
}

/*
 * Transaction-aware import, version 2 of the contributor surface. Added by the ratified note
 * `00-platform-foundation/2026-10-27-transaction-aware-import-contract-change.md`. Additive:
 * `ExportableModule` and `ExportChunk` above keep their frozen shapes. A contributor that only
 * implements the frozen `import` is never restored; feature 07 preserves its chunk opaquely and
 * reports it as `contributor_not_transactional`.
 */

/**
 * Opaque capability for one import transaction. A contributor passes it back to its own
 * persistence adapter only; no PostgreSQL, Drizzle or SQL type ever appears here.
 */
export interface ImportTransaction {
  readonly brand: 'ImportTransaction';
}

/** Safe codes only: `^[a-z][a-z0-9_]*$`. Never shown together with package content. */
export const ImportCode = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$', $id: 'ImportCode' });
export type ImportCode = Static<typeof ImportCode>;

/**
 * One explicit import warning, e.g. `visibility_narrowed_to_gm_only` or a binary not restored.
 * `sourceId` is a record id from the package, never content.
 */
export const ImportWarning = Type.Object(
  {
    code: ImportCode,
    sourceId: Type.Optional(Id),
    count: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false, $id: 'ImportWarning' },
);
export type ImportWarning = Static<typeof ImportWarning>;

/** What one recognized chunk defines, found by the write-free `validate` phase. */
export interface ImportPlanContribution {
  /** Source ids this chunk defines, by record kind (e.g. `attachment`, `entity`). */
  readonly defines: readonly { readonly kind: string; readonly sourceId: Id }[];
  readonly warnings: readonly ImportWarning[];
}

export interface ImportContext {
  /** The new campaign, created by feature 02 inside `transaction`. */
  readonly campaignId: Id;
  /** The importing user, sole owner of the new campaign. */
  readonly importerUserId: Id;
  /**
   * Deterministic for one import job and total over every `defines` entry of every recognized
   * chunk. `undefined` for an id no chunk defines and no approved mapping covers, e.g. a member
   * of the source campaign: memberships are never imported.
   *
   * Visibility rule: when `mapId('member', id)` (players) or `mapId('party', id)` (party) is
   * `undefined` for a target, the contributor stores `gm_only` and emits
   * `ImportWarning{ code: 'visibility_narrowed_to_gm_only', sourceId }`. It never widens.
   */
  mapId(kind: string, sourceId: Id): Id | undefined;
  readonly transaction: ImportTransaction;
}

export interface ImportResult {
  readonly restoredCount: number;
  readonly warnings: readonly ImportWarning[];
}

/**
 * Transaction-aware import of one module's chunk. `export` stays on `ExportableModule`.
 *
 * - `validate` must not write.
 * - `restore` writes only through `context.transaction` and never calls object storage; the
 *   host commits or rolls back every contributor together.
 * - Error strings are safe codes (`ImportCode`).
 */
export interface ImportableModule {
  readonly moduleId: string;
  /** Chunk versions this module can restore. Another version is preserved and reported. */
  readonly importChunkVersions: readonly string[];
  validate(chunk: ExportChunk): Promise<Result<ImportPlanContribution, string>>;
  restore(chunk: ExportChunk, context: ImportContext): Promise<Result<ImportResult, string>>;
}

/* -------------------------------------------------------------------------- */
/* Search — hosted by feature 20                                              */
/* -------------------------------------------------------------------------- */

/**
 * `visibility` travels with the document so feature 20 filters at query time against
 * current permissions. Baking a decision into the index goes stale the moment a handout
 * is revealed (feature 20 FR-004).
 */
export const SearchDoc = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    title: Type.String(),
    body: Type.String(),
    campaignId: Type.String({ minLength: 1 }),
    visibility: Visibility,
  },
  { $id: 'SearchDoc' },
);
export type SearchDoc = Static<typeof SearchDoc>;

export interface SearchIndexer {
  readonly moduleId: string;
  index(campaignId: Id): Promise<SearchDoc[]>;
}

/* -------------------------------------------------------------------------- */
/* Session quick actions — hosted by feature 18                               */
/* -------------------------------------------------------------------------- */

/**
 * An operation offered on the session screen without feature 18 knowing what it does
 * (`PRD.md` s.44, s.45).
 *
 * `capability` gates the action on what the pinned system declares, so a quick action for
 * a mechanic a system does not have simply does not appear — with no branch on system
 * identity (`PRD.md` s.89). A deferred feature such as clocks registers later with no
 * change to feature 18.
 */
export interface SessionQuickAction {
  readonly id: string;
  readonly label: string;
  readonly capability?: CapabilityKey;
  invoke(context: { actor: ActorRef; sessionId: Id }): Promise<void>;
}
