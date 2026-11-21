import { visibilityAdmits } from '@rpg/authorization';
import type { ActorRef, SearchDoc, SearchIndexer } from '@rpg/contracts';
import { type Admits, SearchIndex } from '@rpg/search';

/**
 * Feature 20 device search (D-02, D-05, D-07, D-08, D-11): one in-memory `SearchIndex` per open campaign, fed by the
 * contributions the app shell lists. Each contribution's documents come from the device replica only; a change the
 * owning source announces re-runs that module alone. Visibility is decided at query time with feature 04's
 * predicate and the device's cached membership, so a reveal admits a document at the next query.
 */

/** What an owning feature contributes, through the shell (D-09). This feature never imports one. */
export interface SearchContribution {
  readonly indexer: SearchIndexer;
  /** The owning source's changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The owning feature's label for one of its document types (D-16). */
  typeLabel(type: string): string;
  /** The owning view's route for a document (D-10). */
  route(doc: SearchDoc): string | undefined;
}

export type SearchActor = Pick<ActorRef, 'userId' | 'role'>;

export interface SearchStatus {
  /** Every contributor has run once (D-08). */
  readonly ready: boolean;
  /** Modules whose last run failed: their earlier documents stay, and the screen names them. */
  readonly failed: readonly string[];
  /** Documents dropped on ingest (invalid, or of another campaign), across modules (D-06). */
  readonly rejected: number;
}

export interface SearchResult {
  readonly key: string;
  readonly id: string;
  readonly moduleId: string;
  readonly title: string;
  readonly typeLabel: string;
  readonly snippet?: string;
  readonly href?: string;
}

export interface SearchAnswer {
  readonly results: readonly SearchResult[];
  readonly total: number;
}

export interface SearchService {
  readonly campaignId: string;
  /** Changes on every index, status, or actor change; drives `useSyncExternalStore`. */
  readonly version: number;
  status(): SearchStatus;
  query(text: string, options?: { readonly limit?: number }): SearchAnswer;
  subscribe(listener: () => void): () => void;
  /** FR-009: clears the index and runs every contributor again. */
  rebuild(): Promise<void>;
  /** Schedules the first build off the interaction path, then follows changes. */
  start(): void;
  dispose(): void;
  /** Resolves when no module run is in flight or pending (tests and the harness). */
  settled(): Promise<void>;
}

export type Schedule = (task: () => void) => void;

/** D-08: an idle callback where the browser has one, else a short timeout. */
export const idleSchedule: Schedule = (task) => {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  if (idle !== undefined) idle(task, { timeout: 1_000 });
  else setTimeout(task, 50);
};

export function createSearchService(input: {
  readonly campaignId: string;
  readonly contributions: readonly SearchContribution[];
  /** The device's current actor (cached membership); `undefined` admits nothing. */
  readonly actor: () => Promise<SearchActor | undefined>;
  readonly schedule?: Schedule;
}): SearchService {
  const { campaignId, contributions } = input;
  const byModule = new Map<string, SearchContribution>();
  for (const contribution of contributions) {
    if (byModule.has(contribution.indexer.moduleId)) {
      throw new Error(`duplicate search module ${contribution.indexer.moduleId}`);
    }
    byModule.set(contribution.indexer.moduleId, contribution);
  }
  const index = new SearchIndex(campaignId);
  const listeners = new Set<() => void>();
  const running = new Map<string, Promise<void>>();
  const pending = new Set<string>();
  const attempted = new Set<string>();
  const failed = new Set<string>();
  const rejected = new Map<string, number>();
  const unsubscribes: (() => void)[] = [];
  /** Every operation in flight (actor reads, builds), so `settled` sees work that has not reached a module yet. */
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise)).catch(() => undefined);
    return promise;
  };
  let actor: SearchActor | undefined;
  let disposed = false;
  let started = false;
  let version = 0;

  const notify = () => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };

  const refreshActor = async () => {
    const next = await input.actor().catch(() => undefined);
    if (next?.userId === actor?.userId && next?.role === actor?.role) return;
    actor = next;
    notify();
  };

  const run = (moduleId: string): Promise<void> => {
    const current = running.get(moduleId);
    if (current !== undefined) {
      pending.add(moduleId);
      return current;
    }
    const contribution = byModule.get(moduleId);
    if (contribution === undefined || disposed) return Promise.resolve();
    const task = (async () => {
      try {
        const docs = await contribution.indexer.index(campaignId);
        if (disposed) return;
        rejected.set(moduleId, index.replaceModule(moduleId, docs).rejected);
        failed.delete(moduleId);
      } catch {
        failed.add(moduleId);
      } finally {
        attempted.add(moduleId);
        running.delete(moduleId);
      }
      notify();
      if (pending.delete(moduleId)) await run(moduleId);
    })();
    running.set(moduleId, task);
    return task;
  };

  const runAll = async () => {
    await refreshActor();
    await Promise.all([...byModule.keys()].map(run));
  };

  const admits: Admits = (visibility) => actor !== undefined && visibilityAdmits(actor, visibility);

  return {
    campaignId,
    get version() {
      return version;
    },
    status() {
      return {
        ready: attempted.size === byModule.size,
        failed: [...failed].sort(),
        rejected: [...rejected.values()].reduce((sum, count) => sum + count, 0),
      };
    },
    query(text, options = {}) {
      const answer = index.query(text, {
        admits,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return {
        total: answer.total,
        results: answer.hits.map((hit) => {
          const contribution = byModule.get(hit.moduleId);
          const href = contribution?.route(hit.doc);
          return {
            key: `${hit.moduleId}:${hit.doc.id}`,
            id: hit.doc.id,
            moduleId: hit.moduleId,
            title: hit.doc.title,
            typeLabel: contribution?.typeLabel(hit.doc.type) ?? hit.doc.type,
            ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
            ...(href === undefined ? {} : { href }),
          };
        }),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async rebuild() {
      index.clear();
      rejected.clear();
      notify();
      await track(runAll());
    },
    start() {
      if (started) return;
      started = true;
      (input.schedule ?? idleSchedule)(() => {
        if (disposed) return;
        for (const [moduleId, contribution] of byModule) {
          unsubscribes.push(
            contribution.subscribe(() => {
              void track(refreshActor());
              void track(run(moduleId));
            }),
          );
        }
        void track(runAll());
      });
    },
    dispose() {
      disposed = true;
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      listeners.clear();
    },
    async settled() {
      while (inflight.size > 0 || running.size > 0) {
        await Promise.all([...inflight, ...running.values()]);
      }
    },
  };
}
