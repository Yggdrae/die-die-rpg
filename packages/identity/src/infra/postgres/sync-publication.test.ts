import { describe, expect, test } from 'bun:test';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema.ts';

/**
 * Feature 01 publication boundary (`_db.md`): sync configuration may reference only the
 * membership table, and may read from it only the approved current-user cache fields.
 * Credential, session, recovery, invitation, binding, and user tables never reach a client.
 */

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);
const MEMBERSHIPS = 'identity_campaign_memberships';
const CACHE_FIELDS = new Set([
  'campaign_id',
  'user_id',
  'role',
  'version',
  'updated_at',
  'removed_at',
]);

const identityTables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));
const excludedTables = identityTables.filter((table) => table.name !== MEMBERSHIPS);

async function streamQueries(): Promise<readonly string[]> {
  const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
    readonly streams?: Record<string, { readonly query?: string; readonly queries?: string[] }>;
  };
  return Object.values(parsed.streams ?? {}).flatMap((stream) => [
    ...(stream.query === undefined ? [] : [stream.query]),
    ...(stream.queries ?? []),
  ]);
}

describe('sync publication boundary', () => {
  test('schema exposes every identity table to the check', () => {
    expect(identityTables.map((table) => table.name).sort()).toEqual([
      'identity_bindings',
      'identity_campaign_memberships',
      'identity_invitations',
      'identity_password_credentials',
      'identity_recovery_tokens',
      'identity_sessions',
      'identity_users',
    ]);
  });

  test('no stream references a credential-bearing identity table', async () => {
    const queries = await streamQueries();
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      for (const table of excludedTables) {
        expect(query).not.toMatch(new RegExp(`\\b${table.name}\\b`, 'i'));
      }
    }
  });

  test('no stream selects a credential field or a non-cache membership field', async () => {
    const credentialColumns = excludedTables
      .flatMap((table) => table.columns.map((column) => column.name))
      .filter((name) => /hash|digest|subject|username|operator_reference/.test(name));
    expect(credentialColumns).toEqual(
      expect.arrayContaining(['password_hash', 'credential_digest', 'token_digest']),
    );
    for (const query of await streamQueries()) {
      for (const column of credentialColumns) {
        expect(query).not.toMatch(new RegExp(`\\b${column}\\b`, 'i'));
      }
      const alias = new RegExp(`\\b${MEMBERSHIPS}\\s+(?:AS\\s+)?(\\w+)`, 'i').exec(query)?.[1];
      const head = /^\s*SELECT\s+([\s\S]*?)\s+FROM\s+(\w+)/i.exec(query);
      const selectList = head?.[1] ?? '';
      if (head?.[2] === MEMBERSHIPS) expect(selectList).not.toMatch(/\*/);
      if (alias === undefined) continue;
      for (const match of selectList.matchAll(new RegExp(`\\b${alias}\\.(\\w+|\\*)`, 'g'))) {
        expect(CACHE_FIELDS.has(match[1] ?? '')).toBe(true);
      }
    }
  });
});
