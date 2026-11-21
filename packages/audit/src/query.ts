import { check, Metadata } from '@rpg/contracts';
import type { StoredCampaignAuditEvent } from './infra/postgres/repositories.ts';
import type { AuditRendererRegistry, AuditRendering } from './renderers.ts';

/**
 * Feature 06 task 03: authorized reads of one physical store.
 *
 * Each `AuditQueryService` is bound to exactly one store reader at composition, so no request
 * input chooses the table and no code path unions the campaign and GM-private stores. The
 * caller supplies an `AuditReadAuthorizer` for the requesting Actor; it decides every distinct
 * (target, stored snapshot) group with the target's current feature 04 facts before any row,
 * total, cursor, or renderer value is produced.
 */

export const AUDIT_PAGE_DEFAULT_LIMIT = 50;
export const AUDIT_PAGE_MAX_LIMIT = 100;

/** Narrowing filters only. None of them can widen what the authorizer permits. */
export interface AuditReadScope {
  readonly campaignId: string;
  readonly sessionId?: string;
  readonly actorUserId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
}

/** One distinct target plus the snapshot stored with its events. */
export interface AuditTargetOccurrence {
  readonly targetType: string;
  readonly targetId: string;
  /** Stored `target_visibility`, unvalidated; an authorizer must reject what it cannot parse. */
  readonly snapshot: unknown;
}

/** A target group as the store sees it: `snapshotText` is the stored JSON, compared verbatim. */
export interface AuditTargetGroup extends AuditTargetOccurrence {
  readonly snapshotText: string;
}

/**
 * Decides one group for one reader. Implementations must answer `false` for anything they cannot
 * prove readable now: an undeclared class, a missing record, an invalid snapshot.
 */
export interface AuditReadAuthorizer {
  permits(occurrence: AuditTargetOccurrence): Promise<boolean>;
}

/** Read surface of one physical store. Every method is restricted to the permitted groups. */
export interface AuditEventReader {
  targetGroups(scope: AuditReadScope): Promise<readonly AuditTargetGroup[]>;
  countWithin(scope: AuditReadScope, groups: readonly AuditTargetGroup[]): Promise<number>;
  /**
   * Newest first by authority sequence, at most `limit` rows. `cursor` is the event ID of the last
   * row already returned; `undefined` means that event is not among the permitted rows in scope.
   */
  pageWithin(
    scope: AuditReadScope,
    groups: readonly AuditTargetGroup[],
    page: { readonly limit: number; readonly cursor?: string },
  ): Promise<readonly StoredCampaignAuditEvent[] | undefined>;
}

export interface AuditQueryInput {
  readonly scope: AuditReadScope;
  readonly limit?: number;
  /** Event ID of the last entry of the previous page. */
  readonly cursor?: string;
}

/**
 * Public entry. No before/after values and no raw sequence: values reach the reader only through
 * the renderer, and sequence gaps would disclose hidden events.
 */
export interface AuditEntryView {
  readonly id: string;
  readonly sessionId: string | null;
  readonly actor: { readonly userId: string; readonly role: string };
  readonly action: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly acceptedAt: string;
  readonly description: AuditRendering;
}

export interface AuditPageView {
  readonly items: readonly AuditEntryView[];
  /** Counted over the permitted events in scope only. */
  readonly total: number;
  readonly nextCursor?: string;
}

export type AuditQueryResult =
  | { readonly ok: true; readonly page: AuditPageView }
  | { readonly ok: false; readonly reason: 'invalid_cursor' };

export class AuditQueryService {
  constructor(
    private readonly reader: AuditEventReader,
    private readonly registry: Pick<AuditRendererRegistry, 'render'>,
  ) {}

  async query(input: AuditQueryInput, authorizer: AuditReadAuthorizer): Promise<AuditQueryResult> {
    const limit = clampLimit(input.limit);
    const groups = await this.reader.targetGroups(input.scope);
    const decisions = await Promise.all(
      groups.map((group) =>
        authorizer.permits({
          targetType: group.targetType,
          targetId: group.targetId,
          snapshot: group.snapshot,
        }),
      ),
    );
    const permitted = groups.filter((_, index) => decisions[index] === true);
    if (permitted.length === 0) {
      return input.cursor === undefined
        ? { ok: true, page: { items: [], total: 0 } }
        : { ok: false, reason: 'invalid_cursor' };
    }
    const [total, rows] = await Promise.all([
      this.reader.countWithin(input.scope, permitted),
      this.reader.pageWithin(input.scope, permitted, {
        limit: limit + 1,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
    ]);
    if (rows === undefined) return { ok: false, reason: 'invalid_cursor' };
    const items = rows.slice(0, limit).map((row) => this.#view(row));
    const last = items.at(-1);
    return {
      ok: true,
      page: {
        items,
        total,
        ...(rows.length > limit && last !== undefined ? { nextCursor: last.id } : {}),
      },
    };
  }

  #view(row: StoredCampaignAuditEvent): AuditEntryView {
    return {
      id: row.id,
      sessionId: row.sessionId,
      actor: { userId: row.actorUserId, role: row.actorRole },
      action: row.action,
      target: { type: row.targetType, id: row.targetId },
      acceptedAt: row.acceptedAt.toISOString(),
      // Only rows already permitted reach a renderer; `render` never throws or echoes values.
      description: this.registry.render({
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        before: metadataOrUndefined(row.beforeValue),
        after: metadataOrUndefined(row.afterValue),
        at: row.clientRecordedAt.toISOString(),
        rendererVersion: row.rendererVersion,
      }),
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit)) return AUDIT_PAGE_DEFAULT_LIMIT;
  return Math.min(AUDIT_PAGE_MAX_LIMIT, Math.max(1, limit));
}

function metadataOrUndefined(value: unknown): Metadata | undefined {
  return check(Metadata, value) ? value : undefined;
}
