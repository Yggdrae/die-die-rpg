import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import { check, Id } from '@rpg/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { RollResult } from '../../engine/model.ts';
import {
  ROLL_RECORD_TYPE,
  type RollRecord,
  type RollVisibility,
  rollDisplayName,
} from '../../records.ts';
import { diceRolls, diceSchema } from './schema.ts';

/**
 * Feature 09 persistence (`_db.md`). Reads are campaign-scoped and carry no authorization: the caller
 * decides through feature 04. Insert only, since rolls are immutable (D-09). Callers pass validated
 * records (`checkRollRecord`); the CHECKs are the last line, not the rule.
 */

export type DiceDatabase = PostgresJsDatabase<typeof diceSchema>;
export type DiceTransaction = Parameters<Parameters<DiceDatabase['transaction']>[0]>[0];

export function connectDiceDatabase(connectionString: string, options: { max?: number } = {}) {
  const client = postgres(connectionString, {
    max: options.max ?? 5,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: diceSchema, logger: false }),
    close: async () => client.end(),
  };
}

type Row = typeof diceRolls.$inferSelect;

function fromRow(row: Row): RollRecord {
  const visibility = visibilityFromColumns(row.visibilityMode, row.visibilityTargets);
  if (visibility === undefined) throw new Error('a stored roll has an invalid Visibility');
  const createdAt = row.createdAt.toISOString();
  return {
    id: row.id,
    campaignId: row.campaignId,
    type: ROLL_RECORD_TYPE,
    name: rollDisplayName(row.action ?? undefined, row.expression),
    tags: [],
    metadata: {},
    visibility,
    version: row.version,
    createdAt,
    createdBy: row.actorUserId,
    updatedAt: createdAt,
    updatedBy: row.actorUserId,
    actorUserId: row.actorUserId,
    ...(row.actorRef === null ? {} : { actorRef: row.actorRef }),
    ...(row.targetRef === null ? {} : { targetRef: row.targetRef }),
    ...(row.action === null ? {} : { action: row.action }),
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
    expression: row.expression,
    inputs: row.inputs,
    result: row.result as RollResult,
    rollVisibility: row.rollVisibility as RollVisibility,
    rolledAt: row.rolledAt.toISOString(),
  };
}

export type RollInsertResult =
  | { readonly ok: true; readonly record: RollRecord }
  | { readonly ok: false; readonly reason: 'exists' };

export class PostgresRollRepository {
  constructor(private readonly db: DiceDatabase) {}

  transaction<T>(work: (transaction: DiceTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /** A malformed id is simply absent; no cast error reaches the caller. */
  async get(
    campaignId: string,
    id: string,
    options: { readonly executor?: DiceTransaction } = {},
  ): Promise<RollRecord | undefined> {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const [row] = await (options.executor ?? this.db)
      .select()
      .from(diceRolls)
      .where(and(eq(diceRolls.campaignId, campaignId), eq(diceRolls.id, id)));
    return row === undefined ? undefined : fromRow(row);
  }

  async list(
    campaignId: string,
    options: { readonly sessionId?: string } = {},
  ): Promise<RollRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(diceRolls)
      .where(
        and(
          eq(diceRolls.campaignId, campaignId),
          options.sessionId === undefined ? undefined : eq(diceRolls.sessionId, options.sessionId),
        ),
      )
      .orderBy(asc(diceRolls.rolledAt), asc(diceRolls.id));
    return rows.map(fromRow);
  }

  /** A client-generated id that already exists is never overwritten. */
  async insert(executor: DiceTransaction, record: RollRecord): Promise<RollInsertResult> {
    const visibility = visibilityToColumns(record.visibility);
    const [row] = await executor
      .insert(diceRolls)
      .values({
        id: record.id,
        campaignId: record.campaignId,
        actorUserId: record.actorUserId,
        actorRef: record.actorRef ?? null,
        targetRef: record.targetRef ?? null,
        action: record.action ?? null,
        sessionId: record.sessionId ?? null,
        expression: record.expression,
        inputs: { ...record.inputs },
        result: record.result,
        naturalResult: record.result.natural,
        modifiedResult: record.result.modified,
        rollVisibility: record.rollVisibility,
        visibilityMode: visibility.mode,
        visibilityTargets: [...visibility.targets],
        rolledAt: new Date(record.rolledAt),
      })
      .onConflictDoNothing({ target: diceRolls.id })
      .returning();
    return row === undefined ? { ok: false, reason: 'exists' } : { ok: true, record: fromRow(row) };
  }
}
