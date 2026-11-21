import { check, Id } from '@rpg/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  type MarkFacts,
  markVisibility,
  RULES_MARK_RECORD_TYPE,
  type RulesMarkRecord,
} from '../../records.ts';
import { rulesSchema, rulesSectionMarks } from './schema.ts';

/**
 * Feature 14 persistence (`_db.md`). Reads carry no authorization: the service decides through feature 04. Every
 * write takes the executor, so the access fence and the write share one transaction.
 */

export type RulesDatabase = PostgresJsDatabase<typeof rulesSchema>;
export type RulesTransaction = Parameters<Parameters<RulesDatabase['transaction']>[0]>[0];

export function connectRulesDatabase(connectionString: string, options: { max?: number } = {}) {
  const client = postgres(connectionString, {
    max: options.max ?? 3,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: rulesSchema, logger: false }),
    close: async () => client.end(),
  };
}

const iso = (value: Date) => value.toISOString();
const date = (value: string | undefined) => (value === undefined ? null : new Date(value));

function markFrom(row: typeof rulesSectionMarks.$inferSelect): RulesMarkRecord {
  return {
    id: row.id,
    campaignId: row.campaignId,
    type: RULES_MARK_RECORD_TYPE,
    name: row.sectionId,
    tags: [],
    metadata: {},
    visibility: markVisibility(row.userId),
    version: row.version,
    createdAt: iso(row.createdAt),
    createdBy: row.createdBy,
    updatedAt: iso(row.updatedAt),
    updatedBy: row.updatedBy,
    ...(row.deletedAt === null ? {} : { deletedAt: iso(row.deletedAt) }),
    userId: row.userId,
    sectionId: row.sectionId,
    bookmarked: row.bookmarked,
    ...(row.bookmarkChangedAt === null ? {} : { bookmarkChangedAt: iso(row.bookmarkChangedAt) }),
    ...(row.viewedAt === null ? {} : { viewedAt: iso(row.viewedAt) }),
  };
}

export class PostgresRulesMarkRepository {
  constructor(private readonly db: RulesDatabase) {}

  transaction<T>(work: (transaction: RulesTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async getMark(
    campaignId: string,
    id: string,
    options: { readonly executor?: RulesTransaction; readonly lock?: boolean } = {},
  ): Promise<RulesMarkRecord | undefined> {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const query = (options.executor ?? this.db)
      .select()
      .from(rulesSectionMarks)
      .where(and(eq(rulesSectionMarks.campaignId, campaignId), eq(rulesSectionMarks.id, id)));
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? undefined : markFrom(row);
  }

  /** `undefined` when the row exists already (the caller merges into it). */
  async insertMark(
    executor: RulesTransaction,
    input: {
      readonly id: string;
      readonly campaignId: string;
      readonly userId: string;
      readonly sectionId: string;
      readonly facts: MarkFacts;
    },
  ): Promise<RulesMarkRecord | undefined> {
    const [row] = await executor
      .insert(rulesSectionMarks)
      .values({
        id: input.id,
        campaignId: input.campaignId,
        userId: input.userId,
        sectionId: input.sectionId,
        bookmarked: input.facts.bookmarked,
        bookmarkChangedAt: date(input.facts.bookmarkChangedAt),
        viewedAt: date(input.facts.viewedAt),
        visibilityMode: 'players',
        visibilityTargets: [input.userId],
        createdBy: input.userId,
        updatedBy: input.userId,
      })
      .onConflictDoNothing()
      .returning();
    return row === undefined ? undefined : markFrom(row);
  }

  /** Writes merged facts to a locked row; the version moves by one. */
  async updateMark(
    executor: RulesTransaction,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly facts: MarkFacts;
      readonly actorUserId: string;
    },
  ): Promise<RulesMarkRecord | undefined> {
    const [row] = await executor
      .update(rulesSectionMarks)
      .set({
        bookmarked: input.facts.bookmarked,
        bookmarkChangedAt: date(input.facts.bookmarkChangedAt),
        viewedAt: date(input.facts.viewedAt),
        version: sql`${rulesSectionMarks.version} + 1`,
        updatedAt: new Date(),
        updatedBy: input.actorUserId,
      })
      .where(
        and(eq(rulesSectionMarks.campaignId, input.campaignId), eq(rulesSectionMarks.id, input.id)),
      )
      .returning();
    return row === undefined ? undefined : markFrom(row);
  }
}
