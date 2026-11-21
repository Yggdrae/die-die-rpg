import type { TargetState } from '@rpg/actions/engine';
import { check, Id } from '@rpg/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  CHARACTER_RECORD_TYPE,
  type CharacterRecord,
  type CharacterSecretRecord,
  characterVisibility,
} from '../../records.ts';
import { characterSecrets, characters, charactersSchema } from './schema.ts';

/**
 * Feature 15 persistence (`_db.md`). Reads carry no authorization: callers decide through feature 04. Every
 * write takes the executor, so the service and the effect adapter write inside their own transaction.
 */

export type CharactersDatabase = PostgresJsDatabase<typeof charactersSchema>;
export type CharactersTransaction = Parameters<Parameters<CharactersDatabase['transaction']>[0]>[0];

export function connectCharactersDatabase(
  connectionString: string,
  options: { max?: number } = {},
) {
  const client = postgres(connectionString, {
    max: options.max ?? 5,
    prepare: false,
    onnotice: () => undefined,
  });
  return {
    db: drizzle(client, { schema: charactersSchema, logger: false }),
    close: async () => client.end(),
  };
}

type Row = typeof characters.$inferSelect;

function fromRow(row: Row): CharacterRecord {
  return {
    id: row.id,
    campaignId: row.campaignId,
    type: CHARACTER_RECORD_TYPE,
    name: 'Character',
    tags: [],
    metadata: {},
    visibility: characterVisibility(row.ownerUserId),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    ...(row.deletedAt === null ? {} : { deletedAt: row.deletedAt.toISOString() }),
    ownerUserId: row.ownerUserId,
    system: { systemId: row.systemId, version: row.systemVersion },
    state: row.state as TargetState,
  };
}

function secretFrom(row: typeof characterSecrets.$inferSelect): CharacterSecretRecord {
  return {
    id: row.id,
    campaignId: row.campaignId,
    state: row.state as TargetState,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    ...(row.deletedAt === null ? {} : { deletedAt: row.deletedAt.toISOString() }),
  };
}

export class PostgresCharacterRepository {
  constructor(private readonly db: CharactersDatabase) {}

  transaction<T>(work: (transaction: CharactersTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async get(
    campaignId: string,
    id: string,
    options: { readonly executor?: CharactersTransaction; readonly lock?: boolean } = {},
  ): Promise<CharacterRecord | undefined> {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const query = (options.executor ?? this.db)
      .select()
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), eq(characters.id, id)));
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? undefined : fromRow(row);
  }

  async getSecret(
    campaignId: string,
    id: string,
    options: { readonly executor?: CharactersTransaction; readonly lock?: boolean } = {},
  ): Promise<CharacterSecretRecord | undefined> {
    if (!check(Id, id) || !check(Id, campaignId)) return undefined;
    const query = (options.executor ?? this.db)
      .select()
      .from(characterSecrets)
      .where(and(eq(characterSecrets.campaignId, campaignId), eq(characterSecrets.id, id)));
    const [row] = options.lock === true ? await query.for('update') : await query;
    return row === undefined ? undefined : secretFrom(row);
  }

  async list(campaignId: string): Promise<CharacterRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.campaignId, campaignId), isNull(characters.deletedAt)))
      .orderBy(asc(characters.id));
    return rows.map(fromRow);
  }

  async listSecrets(campaignId: string): Promise<CharacterSecretRecord[]> {
    if (!check(Id, campaignId)) return [];
    const rows = await this.db
      .select()
      .from(characterSecrets)
      .where(and(eq(characterSecrets.campaignId, campaignId), isNull(characterSecrets.deletedAt)))
      .orderBy(asc(characterSecrets.id));
    return rows.map(secretFrom);
  }

  /** Both rows, or neither: a client-generated id that already exists is never overwritten. */
  async insert(
    executor: CharactersTransaction,
    input: {
      readonly id: string;
      readonly campaignId: string;
      readonly ownerUserId: string;
      readonly system: CharacterRecord['system'];
      readonly state: TargetState;
      readonly secretState: TargetState;
      readonly actorUserId: string;
    },
  ): Promise<CharacterRecord | undefined> {
    const [row] = await executor
      .insert(characters)
      .values({
        id: input.id,
        campaignId: input.campaignId,
        ownerUserId: input.ownerUserId,
        systemId: input.system.systemId,
        systemVersion: input.system.version,
        state: input.state,
        visibilityMode: 'players',
        visibilityTargets: [input.ownerUserId],
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      })
      .onConflictDoNothing({ target: characters.id })
      .returning();
    if (row === undefined) return undefined;
    await executor.insert(characterSecrets).values({
      id: input.id,
      campaignId: input.campaignId,
      state: input.secretState,
    });
    return fromRow(row);
  }

  /** Writes both halves and bumps both versions (the effect adapter's save). */
  async writeState(
    executor: CharactersTransaction,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly state: TargetState;
      readonly secretState: TargetState;
      readonly actorUserId: string;
    },
  ): Promise<void> {
    await executor
      .update(characters)
      .set({
        state: input.state,
        version: sql`${characters.version} + 1`,
        updatedAt: new Date(),
        updatedBy: input.actorUserId,
      })
      .where(and(eq(characters.campaignId, input.campaignId), eq(characters.id, input.id)));
    await executor
      .update(characterSecrets)
      .set({
        state: input.secretState,
        version: sql`${characterSecrets.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(characterSecrets.campaignId, input.campaignId), eq(characterSecrets.id, input.id)),
      );
  }

  /** Compare-and-set tombstone of both rows; `false` when the version moved or the row is gone. */
  async tombstone(
    executor: CharactersTransaction,
    input: {
      readonly campaignId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly actorUserId: string;
    },
  ): Promise<CharacterRecord | undefined> {
    const now = new Date();
    const [row] = await executor
      .update(characters)
      .set({
        deletedAt: now,
        updatedAt: now,
        updatedBy: input.actorUserId,
        version: sql`${characters.version} + 1`,
      })
      .where(
        and(
          eq(characters.campaignId, input.campaignId),
          eq(characters.id, input.id),
          eq(characters.version, input.expectedVersion),
          isNull(characters.deletedAt),
        ),
      )
      .returning();
    if (row === undefined) return undefined;
    await executor
      .update(characterSecrets)
      .set({ deletedAt: now, updatedAt: now, version: sql`${characterSecrets.version} + 1` })
      .where(
        and(eq(characterSecrets.campaignId, input.campaignId), eq(characterSecrets.id, input.id)),
      );
    return fromRow(row);
  }
}
