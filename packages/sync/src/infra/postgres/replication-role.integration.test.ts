import { afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

/**
 * Feature 03 task 04: the sync provider connects as a dedicated least-privilege role, not the
 * database owner. Migration `0006_powersync_replication_role` owns it. The role may replicate and
 * SELECT exactly the tables of the `powersync` publication (feature 06 task 04 added the two audit
 * stores in `0007_audit_sync_publication`), and nothing else.
 */

const ROLE = 'powersync_replicator';
const PUBLICATION = 'powersync';
const DEV_PASSWORD = 'powersync_replication_dev_password';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate =
  databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2, onnotice: () => {} });
const sql = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    const [row] = await candidate`select 1 as one from pg_roles where rolname = ${ROLE}`;
    if (row === undefined) {
      await candidate.end();
      return undefined;
    }
    return candidate;
  } catch {
    await candidate.end();
    return undefined;
  }
})();

/** A real login as the role, when its password is set (compose sets the dev default). */
const login = await (async () => {
  if (databaseUrl === undefined || sql === undefined) return undefined;
  const url = new URL(databaseUrl);
  url.username = ROLE;
  url.password = process.env.POWERSYNC_REPLICATION_PASSWORD ?? DEV_PASSWORD;
  const connection = postgres(url.toString(), { max: 1, onnotice: () => {}, connect_timeout: 3 });
  try {
    await connection`select 1`;
    return connection;
  } catch {
    await connection.end();
    return undefined;
  }
})();

afterAll(async () => {
  await login?.end();
  await sql?.end();
});

async function publishedTables(db: postgres.Sql): Promise<string[]> {
  const rows = await db<{ name: string }[]>`
    select tablename as name from pg_publication_tables
    where pubname = ${PUBLICATION} and schemaname = 'public' order by 1`;
  return rows.map((row) => row.name);
}

async function denied(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

describe.skipIf(sql === undefined)('dedicated PowerSync replication role (PostgreSQL)', () => {
  const db = () => {
    if (sql === undefined) throw new Error('database unavailable');
    return sql;
  };

  test('can log in and replicate, and holds no elevated attribute', async () => {
    const [role] = await db()<
      {
        login: boolean;
        replication: boolean;
        superuser: boolean;
        createdb: boolean;
        createrole: boolean;
        bypassrls: boolean;
        inherits_members: boolean;
      }[]
    >`
      select rolcanlogin as login, rolreplication as replication, rolsuper as superuser,
        rolcreatedb as createdb, rolcreaterole as createrole, rolbypassrls as bypassrls,
        exists (select 1 from pg_auth_members where member = pg_roles.oid) as inherits_members
      from pg_roles where rolname = ${ROLE}`;
    expect(role).toEqual({
      login: true,
      replication: true,
      superuser: false,
      createdb: false,
      createrole: false,
      bypassrls: false,
      inherits_members: false,
    });
  });

  test('SELECT is granted on exactly the published tables and no write privilege anywhere', async () => {
    const published = await publishedTables(db());
    expect(published.length).toBeGreaterThan(0);
    const tables = await db()<{ name: string; schema: string; select: boolean; write: boolean }[]>`
      select c.relname as name, n.nspname as schema,
        has_table_privilege(${ROLE}, c.oid, 'SELECT') as "select",
        (has_table_privilege(${ROLE}, c.oid, 'INSERT')
          or has_table_privilege(${ROLE}, c.oid, 'UPDATE')
          or has_table_privilege(${ROLE}, c.oid, 'DELETE')
          or has_table_privilege(${ROLE}, c.oid, 'TRUNCATE')
          or has_table_privilege(${ROLE}, c.oid, 'REFERENCES')
          or has_table_privilege(${ROLE}, c.oid, 'TRIGGER')) as write
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm') and n.nspname = 'public'
      order by 1`;
    expect(tables.length).toBeGreaterThan(published.length);
    expect(tables.filter((table) => table.select).map((table) => table.name)).toEqual(published);
    expect(tables.filter((table) => table.write)).toEqual([]);
    // Credential-bearing tables are never readable.
    for (const name of ['identity_users', 'identity_sessions', 'identity_password_credentials']) {
      expect(tables.find((table) => table.name === name)?.select).toBe(false);
    }
  });

  test('as the role, published tables read and everything else is denied', async () => {
    const published = await publishedTables(db());
    const attempt = (statement: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      denied(() =>
        db().begin(async (tx) => {
          await tx.unsafe(`set local role ${ROLE}`);
          await statement(tx);
          // Never keep anything a permitted statement did.
          throw new Error('rollback');
        }),
      );
    // A permitted read reaches the rollback sentinel, not a privilege error.
    for (const name of published) {
      expect(await attempt((tx) => tx.unsafe(`select * from public.${name} limit 1`))).toBe(
        'unknown',
      );
    }
    for (const statement of [
      'select * from public.identity_users limit 1',
      'select * from public.identity_sessions limit 1',
      'select * from public.audit_account_events limit 1',
      'select * from public.audit_repair_outbox limit 1',
      'select * from public.audit_campaign_sequences limit 1',
      'insert into public.audit_campaign_events (id) values (gen_random_uuid())',
      'select * from public.sync_mutation_receipts limit 1',
      'select * from drizzle.__drizzle_migrations limit 1',
      'insert into public.campaigns (id) values (gen_random_uuid())',
      'update public.campaigns set name = name',
      'delete from public.identity_campaign_memberships',
      'truncate public.campaign_settings',
      'update public.sync_long_text_holds set resource_class = resource_class',
      'create table public.replication_role_probe (id int)',
      'drop publication powersync',
    ]) {
      expect({ statement, code: await attempt((tx) => tx.unsafe(statement)) }).toEqual({
        statement,
        code: '42501',
      });
    }
  });

  test.skipIf(login === undefined)('a real login as the role is equally confined', async () => {
    if (login === undefined) return;
    const [who] = await login<{ user: string }[]>`select current_user as "user"`;
    expect(who?.user).toBe(ROLE);
    await login`select count(*) from public.campaigns`;
    expect(await denied(() => login`select * from public.identity_users limit 1`)).toBe('42501');
    expect(await denied(() => login`delete from public.campaigns`)).toBe('42501');
  });
});
