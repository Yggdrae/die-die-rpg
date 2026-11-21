import { visibilityFromColumns, visibilityToColumns } from '@rpg/authorization';
import { check, Id, type Visibility } from '@rpg/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { PlannedOperation, StateChange } from '../../engine/state.ts';
import { EFFECT_RECORD_TYPE, type EffectRecord, effectDisplayName } from '../../records.ts';
import { actionsSchema, effectApplications } from './schema.ts';

/**
 * Feature 11 persistence (`_db.md`). Reads carry no authorization: the caller decides through feature 04.
 * `claim` inserts the row before the target is touched, so a concurrent resend under another mutation
 * waits on the primary key inside its own transaction.
 */

export type ActionsDatabase = PostgresJsDatabase<typeof actionsSchema>;
export type ActionsTransaction = Parameters<Parameters<ActionsDatabase['transaction']>[0]>[0];

export function connectActionsDatabase(connectionString: string, options: { max?: number } = {}) {
  const client = postgres(connectionString, {
    max: options.max ?? 5,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: actionsSchema, logger: false }),
    close: async () => client.end(),
  };
}

type Row = typeof effectApplications.$inferSelect;

function fromRow(row: Row): EffectRecord {
  const visibility = visibilityFromColumns(row.visibilityMode, row.visibilityTargets);
  if (visibility === undefined) throw new Error('a stored application has an invalid Visibility');
  const acceptedAt = row.acceptedAt.toISOString();
  return {
    id: row.id,
    campaignId: row.campaignId,
    type: EFFECT_RECORD_TYPE,
    name: effectDisplayName(row.action ?? undefined),
    tags: [],
    metadata: {},
    visibility,
    version: row.version,
    createdAt: acceptedAt,
    createdBy: row.actorUserId,
    updatedAt: acceptedAt,
    updatedBy: row.actorUserId,
    actorUserId: row.actorUserId,
    targetClass: row.targetClass,
    targetId: row.targetId,
    ...(row.action === null ? {} : { action: row.action }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.rollId === null ? {} : { rollId: row.rollId }),
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
    operations: row.operations as readonly PlannedOperation[],
    changes: row.changes as readonly StateChange[],
    edited: row.edited,
    appliedAt: row.appliedAt.toISOString(),
    acceptedAt,
  };
}

export class PostgresEffectRepository {
  constructor(private readonly db: ActionsDatabase) {}

  transaction<T>(work: (transaction: ActionsTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async get(
    campaignId: string,
    id: string,
    options: { readonly executor?: ActionsTransaction } = {},
  ): Promise<EffectRecord | undefined> {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const [row] = await (options.executor ?? this.db)
      .select()
      .from(effectApplications)
      .where(and(eq(effectApplications.campaignId, campaignId), eq(effectApplications.id, id)));
    return row === undefined ? undefined : fromRow(row);
  }

  async list(
    campaignId: string,
    options: { readonly sessionId?: string } = {},
  ): Promise<EffectRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(effectApplications)
      .where(
        and(
          eq(effectApplications.campaignId, campaignId),
          options.sessionId === undefined
            ? undefined
            : eq(effectApplications.sessionId, options.sessionId),
        ),
      )
      .orderBy(asc(effectApplications.appliedAt), asc(effectApplications.id));
    return rows.map(fromRow);
  }

  /** `false` when the identity is already taken. Nothing is overwritten. */
  async claim(executor: ActionsTransaction, record: EffectRecord): Promise<boolean> {
    const visibility = visibilityToColumns({ mode: 'gm_only' });
    const rows = await executor
      .insert(effectApplications)
      .values({
        id: record.id,
        campaignId: record.campaignId,
        actorUserId: record.actorUserId,
        targetClass: record.targetClass,
        targetId: record.targetId,
        action: record.action ?? null,
        outcome: record.outcome ?? null,
        rollId: record.rollId ?? null,
        sessionId: record.sessionId ?? null,
        operations: [...record.operations],
        edited: record.edited,
        // Hidden until the same transaction fills in the target's Visibility.
        visibilityMode: visibility.mode,
        visibilityTargets: [...visibility.targets],
        appliedAt: new Date(record.appliedAt),
      })
      .onConflictDoNothing({ target: effectApplications.id })
      .returning({ id: effectApplications.id });
    return rows.length > 0;
  }

  /** The authority's half of the row, inside the claiming transaction. */
  async complete(
    executor: ActionsTransaction,
    id: string,
    input: { readonly changes: readonly StateChange[]; readonly visibility: Visibility },
  ): Promise<void> {
    const visibility = visibilityToColumns(input.visibility);
    await executor
      .update(effectApplications)
      .set({
        changes: [...input.changes],
        visibilityMode: visibility.mode,
        visibilityTargets: [...visibility.targets],
      })
      .where(eq(effectApplications.id, id));
  }
}
