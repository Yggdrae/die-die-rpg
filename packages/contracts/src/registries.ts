import { type Static, Type } from '@sinclair/typebox';
import type { ActorRef } from './actor.ts';
import type { Id } from './primitives.ts';
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
