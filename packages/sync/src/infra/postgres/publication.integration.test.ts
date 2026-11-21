import { afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

/**
 * Feature 03 task 04: the sync provider replicates only the `powersync` publication. It must list
 * exactly the tables `infra/powersync/sync-config.yaml` streams, and never a credential-bearing
 * identity table. Migration `0003_least_privilege_sync_publication` owns it.
 */

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);
const PUBLICATION = 'powersync';
const ALLOWED = [
  // Feature 07 task 05: `campaign_export_metadata` (0013_offline_export_replica).
  'attachments',
  // Feature 06 task 04: the two audit stores, each in its own stream (0007_audit_sync_publication).
  'audit_campaign_events',
  'audit_private_events',
  // Feature 07 task 05: exact pins in `authorized_campaigns` (0013_offline_export_replica).
  'campaign_module_pins',
  // Feature 18: stream `authorized_sessions` (0017_sessions).
  'campaign_sessions',
  'campaign_settings',
  'campaign_system_pins',
  'campaigns',
  // Feature 15: stream `authorized_characters` (0016_characters).
  'character_secrets',
  'characters',
  // Feature 16 task 04: stream `authorized_content` (0011_content_entities).
  'content_entities',
  // Feature 16 task 08: relationships, same stream (0012_content_relationships).
  'content_entity_relationships',
  'content_personal_notes',
  // Feature 09: stream `authorized_rolls` (0014_dice_rolls).
  'dice_rolls',
  // Feature 11: stream `authorized_effects` (0015_effect_applications).
  'effect_applications',
  // Feature 19: stream `authorized_encounters` (0018_encounters).
  'encounter_gm_notes',
  'encounter_participant_states',
  'encounter_participants',
  'encounters',
  'identity_campaign_memberships',
  'import_preserved_chunks',
  // Feature 14: stream `authorized_rules_marks` (0019_rules_section_marks).
  'rules_section_marks',
  'session_gm_notes',
  'session_log_entries',
  'sync_long_text_holds',
];
const NEVER_PUBLISHED = [
  'audit_account_events',
  'audit_campaign_sequences',
  'audit_private_sequences',
  'audit_repair_outbox',
  'identity_bindings',
  'identity_invitations',
  'identity_password_credentials',
  'identity_recovery_tokens',
  'identity_sessions',
  'identity_users',
  'sync_access_revocations',
  'sync_mutation_receipts',
  'sync_replica_subscriptions',
  'sync_replica_watermarks',
];

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate =
  databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2, onnotice: () => {} });
const sql = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate`select 1`;
    return candidate;
  } catch {
    await candidate.end();
    return undefined;
  }
})();

afterAll(async () => sql?.end());

async function streamedTables(): Promise<string[]> {
  const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
    readonly streams?: Record<string, { readonly query?: string; readonly queries?: string[] }>;
  };
  const queries = Object.values(parsed.streams ?? {}).flatMap((stream) => [
    ...(stream.query === undefined ? [] : [stream.query]),
    ...(stream.queries ?? []),
  ]);
  const tables = new Set<string>();
  for (const query of queries) {
    for (const match of query.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)) {
      tables.add((match[1] as string).toLowerCase());
    }
  }
  return [...tables].sort();
}

describe('sync config allow-list', () => {
  test('streams exactly the allow-listed tables', async () => {
    expect(await streamedTables()).toEqual(ALLOWED);
  });

  test('current-user membership stream is scoped to the requester and keeps tombstones', async () => {
    const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
      readonly streams: Record<string, { readonly query?: string }>;
    };
    const query = parsed.streams.current_user_memberships?.query ?? '';
    // Unaliased: PowerSync 1.25.0 names the synced table after a source alias.
    expect(query).toMatch(
      /FROM identity_campaign_memberships\s+WHERE user_id = auth\.user_id\(\)\s*$/,
    );
    // Removal tombstones must reach the device, so the stream never filters them out.
    expect(query).not.toMatch(/removed_at IS NULL/i);
    const selected = /^SELECT\s+([\s\S]*?)\s+FROM/i.exec(query)?.[1] ?? '';
    expect(selected.split(',').map((column) => column.trim())).toEqual([
      'campaign_id AS id',
      'campaign_id',
      'user_id',
      'role',
      'version',
      'updated_at',
      'removed_at',
    ]);
  });
});

describe.skipIf(sql === undefined)('PostgreSQL least-privilege sync publication', () => {
  test('publication lists exactly the streamed tables and is not FOR ALL TABLES', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [publication] = await sql<{ puballtables: boolean }[]>`
      select puballtables from pg_publication where pubname = ${PUBLICATION}`;
    expect(publication?.puballtables).toBe(false);
    const rows = await sql<{ schemaname: string; tablename: string }[]>`
      select schemaname, tablename from pg_publication_tables where pubname = ${PUBLICATION}
      order by tablename`;
    expect(rows.map((row) => `${row.schemaname}.${row.tablename}`)).toEqual(
      (await streamedTables()).map((table) => `public.${table}`),
    );
    for (const table of NEVER_PUBLISHED) {
      expect(rows.map((row) => row.tablename)).not.toContain(table);
    }
  });

  test('logical decoding through the publication emits campaigns but no credential table', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const reserved = await sql.reserve();
    const slot = `rpg_publication_probe_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const userId = crypto.randomUUID();
    const campaignId = crypto.randomUUID();
    try {
      await reserved`select pg_create_logical_replication_slot(${slot}, 'pgoutput', true)`;
      await sql.begin(async (tx) => {
        await tx`insert into identity_users (id, username_display, username_normalized)
          values (${userId}, ${`Probe_${userId.slice(0, 8)}`}, ${`probe_${userId.slice(0, 8)}`})`;
        await tx`insert into identity_password_credentials (user_id, password_hash)
          values (${userId}, 'probe-hash-never-replicated')`;
        await tx`insert into identity_sessions (id, user_id, credential_digest, created_at, expires_at)
          values (${crypto.randomUUID()}, ${userId}, ${Buffer.from(crypto.getRandomValues(new Uint8Array(32)))}, now(), now() + interval '30 days')`;
        await tx`insert into campaigns (id, name, game_mode, created_by)
          values (${campaignId}, 'Publication probe', 'standard', ${userId})`;
        await tx`insert into identity_campaign_memberships (campaign_id, user_id, role)
          values (${campaignId}, ${userId}, 'owner')`;
      });
      const changes = await reserved<{ data: Uint8Array }[]>`
        select data from pg_logical_slot_get_binary_changes(${slot}, null, null,
          'proto_version', '1', 'publication_names', ${PUBLICATION})`;
      const stream = Buffer.concat(changes.map((change) => Buffer.from(change.data)));
      expect(stream.includes(Buffer.from('campaigns\0'))).toBe(true);
      expect(stream.includes(Buffer.from('identity_campaign_memberships\0'))).toBe(true);
      for (const table of NEVER_PUBLISHED) {
        expect(stream.includes(Buffer.from(`${table}\0`))).toBe(false);
      }
      expect(stream.includes(Buffer.from('probe-hash-never-replicated'))).toBe(false);
    } finally {
      await sql.begin(async (tx) => {
        await tx`delete from identity_campaign_memberships where campaign_id = ${campaignId}`;
        await tx`delete from campaigns where id = ${campaignId}`;
      });
      await reserved`delete from identity_sessions where user_id = ${userId}`;
      await reserved`delete from identity_password_credentials where user_id = ${userId}`;
      await reserved`delete from identity_users where id = ${userId}`;
      await reserved`select pg_drop_replication_slot(slot_name) from pg_replication_slots
        where slot_name = ${slot}`;
      reserved.release();
    }
  });
});
