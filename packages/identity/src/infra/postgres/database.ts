import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { identitySchema } from './schema.ts';

export type IdentityDatabase = PostgresJsDatabase<typeof identitySchema>;
export type IdentityTransaction = Parameters<Parameters<IdentityDatabase['transaction']>[0]>[0];
export type IdentityExecutor = IdentityDatabase | IdentityTransaction;

export interface IdentityDatabaseConnection {
  readonly db: IdentityDatabase;
  close(): Promise<void>;
}

export function connectIdentityDatabase(connectionString: string): IdentityDatabaseConnection {
  const client = postgres(connectionString, {
    max: 10,
    prepare: false,
    onnotice: () => undefined,
  });

  return {
    db: drizzle(client, { schema: identitySchema, logger: false }),
    close: async () => client.end(),
  };
}

export async function inIdentityTransaction<T>(
  db: IdentityDatabase,
  operation: (transaction: IdentityTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(operation);
}

export async function readDatabaseTime(executor: IdentityExecutor): Promise<Date> {
  const rows = await executor.execute<{ databaseNow: Date }>(
    sql`select transaction_timestamp() as "databaseNow"`,
  );
  const databaseNow = rows[0]?.databaseNow;
  if (databaseNow === undefined) {
    throw new Error('identity database did not return its current time');
  }
  return databaseNow;
}
