import { err, ok, type RepositoryError, type Result, type SyncedRepository } from '@rpg/contracts';
import {
  isValidRulesMark,
  markVisibility,
  mergeMarks,
  RULES_MARK_RECORD_TYPE,
  type RulesMarkRecord,
  rulesMarkId,
} from './records.ts';

/**
 * Feature 14 device API (`_techspec.md` "Device", D-08 to D-11): bookmarks and recently viewed sections, local first
 * through a feature 03 repository, queued offline. Writes are serialized per repository, so a view and a bookmark of
 * one section never race on the local version. The authority merges, so a queued write never conflicts.
 */

export type LocalRulesMarkError =
  | { readonly code: 'invalid_section' }
  | { readonly code: 'storage'; readonly failure: RepositoryError };

export const RECENT_LIMIT = 10;
/** D-11: a section re-opened within this interval records no new view. */
export const VIEW_INTERVAL_MS = 60_000;

interface Actor {
  readonly userId: string;
  readonly campaignId: string;
}

export class RulesMarkLocalRepository {
  readonly #clock: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly records: SyncedRepository<RulesMarkRecord>,
    private readonly actor: Actor,
    options: { readonly clock?: () => Date } = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
  }

  /** This user's live marks in the campaign (the replica holds no one else's). */
  async list(): Promise<RulesMarkRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return listed.value.filter(
      (record) => record.deletedAt === undefined && record.userId === this.actor.userId,
    );
  }

  /** Bookmarked sections, latest bookmark first. */
  async bookmarks(): Promise<RulesMarkRecord[]> {
    return (await this.list())
      .filter((record) => record.bookmarked)
      .sort((left, right) =>
        (right.bookmarkChangedAt ?? '').localeCompare(left.bookmarkChangedAt ?? ''),
      );
  }

  /** The latest viewed sections, newest first (FR-006). */
  async recent(limit = RECENT_LIMIT): Promise<RulesMarkRecord[]> {
    return (await this.list())
      .filter((record) => record.viewedAt !== undefined)
      .sort((left, right) => (right.viewedAt ?? '').localeCompare(left.viewedAt ?? ''))
      .slice(0, limit);
  }

  /** Sets or clears the bookmark; a change is always later than the one it replaces, so it wins (D-09). */
  bookmark(
    sectionId: string,
    on: boolean,
  ): Promise<Result<RulesMarkRecord | undefined, LocalRulesMarkError>> {
    return this.#serial(async () => {
      const now = this.#clock().getTime();
      return this.#write(sectionId, (current) => {
        if ((current?.bookmarked ?? false) === on) return undefined;
        const previous =
          current?.bookmarkChangedAt === undefined ? 0 : Date.parse(current.bookmarkChangedAt) + 1;
        return {
          bookmarked: on,
          bookmarkChangedAt: new Date(Math.max(now, previous)).toISOString(),
        };
      });
    });
  }

  /** Records a view, at most once per section per `VIEW_INTERVAL_MS` (D-11). */
  viewed(sectionId: string): Promise<Result<RulesMarkRecord | undefined, LocalRulesMarkError>> {
    return this.#serial(async () => {
      const now = this.#clock();
      return this.#write(sectionId, (current) =>
        current?.viewedAt !== undefined &&
        now.getTime() - Date.parse(current.viewedAt) < VIEW_INTERVAL_MS
          ? undefined
          : { viewedAt: now.toISOString() },
      );
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** `change` returns the facts to set, or `undefined` for no write (the current row is returned). */
  async #write(
    sectionId: string,
    change: (
      current: RulesMarkRecord | undefined,
    ) =>
      | { readonly bookmarked: boolean; readonly bookmarkChangedAt: string }
      | { readonly viewedAt: string }
      | undefined,
  ): Promise<Result<RulesMarkRecord | undefined, LocalRulesMarkError>> {
    const { campaignId, userId } = this.actor;
    const id = await rulesMarkId(campaignId, userId, sectionId);
    const found = await this.records.get(id);
    const current = found.ok && found.value.deletedAt === undefined ? found.value : undefined;
    const facts = change(current);
    if (facts === undefined) return ok(current);
    const now = this.#clock().toISOString();
    const merged = mergeMarks(current ?? { bookmarked: false }, {
      bookmarked: current?.bookmarked ?? false,
      ...facts,
    });
    const record: RulesMarkRecord = {
      id,
      campaignId,
      type: RULES_MARK_RECORD_TYPE,
      name: sectionId,
      tags: [],
      metadata: {},
      visibility: markVisibility(userId),
      version: current?.version ?? 1,
      createdAt: current?.createdAt ?? now,
      createdBy: current?.createdBy ?? userId,
      updatedAt: now,
      updatedBy: userId,
      userId,
      sectionId,
      ...merged,
    };
    if (!isValidRulesMark(record)) return err({ code: 'invalid_section' });
    const written = await this.records.upsert(record, current?.version ?? null);
    return written.ok ? ok(written.value) : err({ code: 'storage', failure: written.error });
  }
}
