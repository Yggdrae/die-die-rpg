import { afterAll, describe, expect, test } from 'bun:test';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import {
  CONTENT_SYNC_FEATURE_ID,
  ENTITY_REPLICA_TABLE,
  type EntityRecord,
  RELATIONSHIP_REPLICA_TABLE,
  type RelationshipRecord,
} from '@rpg/content';
import type { Role, Visibility } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';
import { registerResourcePolicies } from './sync-rules.ts';
import { HmacSyncTokenIssuer } from './token.ts';

/**
 * Provider round trip (feature 03 tasks 01/04/07, feature 04 task 05): the running PowerSync
 * Service (compose `powersync`, 1.25.0) replicates committed PostgreSQL rows through the stream
 * queries in `infra/powersync/sync-config.yaml`, and each requester's token receives exactly the
 * rows the API read decision allows. A small replica model applies the real sync protocol
 * (`/sync/stream` checkpoints, PUT/REMOVE ops, buckets dropped from a checkpoint are deleted
 * locally, as the PowerSync client does). A write checkpoint (`/write-checkpoint2.json`) is the
 * barrier: a sync completes only once every earlier commit is replicated, so absence is real.
 *
 * Skipped unless both PostgreSQL and the PowerSync service are reachable. Seeds committed rows
 * with random ids in the real tables and deletes them afterwards; the feature 16 task 16 test
 * writes through the runtime composition root instead (mutations and the feature 04 route). Observer memberships are not
 * representable here (feature 01 role CHECK); `sync-config.integration.test.ts` covers them on
 * shadow tables.
 */

const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SECRET = process.env.POWERSYNC_JWT_SECRET ?? 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ';
const issuer = new HmacSyncTokenIssuer(SECRET);

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate =
  databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2, onnotice: () => {} });
const sql = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate`select 1 from campaigns limit 1`;
    return candidate;
  } catch {
    await candidate.end();
    return undefined;
  }
})();
const serviceUp = await fetch(`${ENDPOINT}/probes/liveness`, { signal: AbortSignal.timeout(1500) })
  .then((response) => response.ok)
  .catch(() => false);
const live = sql !== undefined && serviceUp;

type Row = Record<string, unknown>;

interface BucketState {
  after: string;
  readonly rows: Map<string, Row>;
}

interface Checkpoint {
  readonly bucket: string;
  readonly count: number;
  readonly checksum: number;
}

/** One device's local state as the PowerSync client keeps it. */
interface Replica {
  readonly userId: string;
  readonly clientId: string;
  readonly buckets: Map<string, BucketState>;
  checkpoint: Checkpoint[];
  /** Raw protocol lines received by the last sync (no line may name a hidden row). */
  received: string;
  /** Ops received by the last sync. */
  ops: { op: string; table: string; id: string; row?: Row }[];
}

function replicaFor(userId: string): Replica {
  return {
    userId,
    clientId: crypto.randomUUID(),
    buckets: new Map(),
    checkpoint: [],
    received: '',
    ops: [],
  };
}

async function tokenFor(userId: string): Promise<string> {
  return issuer.issue({
    userId,
    campaignId: crypto.randomUUID(),
    replicaId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
}

interface StreamLine {
  readonly checkpoint?: {
    readonly last_op_id: string;
    readonly write_checkpoint?: string;
    readonly buckets: Checkpoint[];
  };
  readonly checkpoint_diff?: {
    readonly last_op_id: string;
    readonly write_checkpoint?: string;
    readonly updated_buckets: Checkpoint[];
    readonly removed_buckets: string[];
  };
  readonly checkpoint_complete?: { readonly last_op_id: string };
  readonly data?: {
    readonly bucket: string;
    readonly next_after: string;
    readonly data: {
      readonly op: 'PUT' | 'REMOVE' | 'MOVE' | 'CLEAR';
      readonly object_type?: string;
      readonly object_id?: string;
      readonly data?: string | null;
    }[];
  };
}

/**
 * Reconnects `replica` and applies the stream until a complete checkpoint that includes every
 * commit made before this call.
 */
/** An explicit stream subscription (the audit streams are not subscribed by default). */
interface Subscription {
  readonly stream: string;
  readonly parameters: Record<string, string>;
}

async function sync(
  replica: Replica,
  subscriptions: readonly Subscription[] = [],
): Promise<Replica> {
  const authorization = `Token ${await tokenFor(replica.userId)}`;
  const barrier = await fetch(`${ENDPOINT}/write-checkpoint2.json?client_id=${replica.clientId}`, {
    headers: { authorization },
  });
  if (!barrier.ok) throw new Error(`write checkpoint failed: ${barrier.status}`);
  const target = BigInt(
    ((await barrier.json()) as { data: { write_checkpoint: string } }).data.write_checkpoint,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const response = await fetch(`${ENDPOINT}/sync/stream`, {
    method: 'POST',
    signal: controller.signal,
    // Uncompressed: a compressed NDJSON stream may hold lines back until the frame ends.
    headers: {
      authorization,
      'content-type': 'application/json',
      'accept-encoding': 'identity',
    },
    body: JSON.stringify({
      buckets: [...replica.buckets].map(([name, state]) => ({ name, after: state.after })),
      include_checksum: true,
      raw_data: true,
      client_id: replica.clientId,
      streams: {
        include_defaults: true,
        subscriptions: subscriptions.map((item) => ({
          stream: item.stream,
          parameters: item.parameters,
          override_priority: null,
        })),
      },
    }),
  });
  if (!response.ok || response.body === null) throw new Error(`sync failed: ${response.status}`);
  replica.received = '';
  replica.ops = [];
  let reached = false;
  let checkpoint = new Map(replica.checkpoint.map((item) => [item.bucket, item]));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('sync stream ended before a complete checkpoint');
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (text.trim() === '') continue;
        replica.received += `${text}\n`;
        const line = JSON.parse(text) as StreamLine;
        if (line.checkpoint !== undefined) {
          checkpoint = new Map(line.checkpoint.buckets.map((item) => [item.bucket, item]));
          reached = BigInt(line.checkpoint.write_checkpoint ?? '0') >= target;
          // A bucket the requester no longer has is deleted locally, rows and all.
          for (const name of [...replica.buckets.keys()]) {
            if (!checkpoint.has(name)) replica.buckets.delete(name);
          }
        } else if (line.checkpoint_diff !== undefined) {
          for (const item of line.checkpoint_diff.updated_buckets)
            checkpoint.set(item.bucket, item);
          for (const name of line.checkpoint_diff.removed_buckets) {
            checkpoint.delete(name);
            replica.buckets.delete(name);
          }
          reached = BigInt(line.checkpoint_diff.write_checkpoint ?? '0') >= target || reached;
        } else if (line.data !== undefined) {
          const state = replica.buckets.get(line.data.bucket) ?? { after: '0', rows: new Map() };
          replica.buckets.set(line.data.bucket, state);
          for (const op of line.data.data) {
            if (op.op === 'CLEAR') state.rows.clear();
            if (op.object_type === undefined || op.object_id === undefined) continue;
            const key = `${op.object_type}/${op.object_id}`;
            const row = op.data == null ? undefined : (JSON.parse(op.data) as Row);
            replica.ops.push({ op: op.op, table: op.object_type, id: op.object_id, row });
            if (op.op === 'PUT' && row !== undefined) state.rows.set(key, row);
            if (op.op === 'REMOVE') state.rows.delete(key);
          }
          state.after = line.data.next_after;
        } else if (line.checkpoint_complete !== undefined && reached) {
          replica.checkpoint = [...checkpoint.values()].sort((a, b) =>
            a.bucket.localeCompare(b.bucket),
          );
          return replica;
        }
      }
    }
  } catch (error) {
    throw new Error(
      `sync incomplete for ${replica.userId} (write checkpoint ${target}): ${String(error)}\n${replica.received.slice(0, 3000)}`,
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Rows of `table` on the replica, keyed by id (union over buckets, as the client stores them). */
function view(replica: Replica, table: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const state of replica.buckets.values()) {
    for (const [key, row] of state.rows) {
      if (key.startsWith(`${table}/`)) rows.set(key.slice(table.length + 1), row);
    }
  }
  return rows;
}

const ids = (replica: Replica, table: string) => [...view(replica, table).keys()].sort();

const id = () => crypto.randomUUID();
const authorization = new AuthorizationService(
  registerResourcePolicies(new ResourcePolicyRegistry()),
);

interface Membership {
  readonly campaign: string;
  readonly user: string;
  readonly role: Role;
  readonly removed: boolean;
}

function reads(
  memberships: readonly Membership[],
  userId: string,
  campaignId: string,
  resourceClass: string,
  visibility: Visibility,
): boolean {
  const membership = memberships.find(
    (item) => item.user === userId && item.campaign === campaignId && !item.removed,
  );
  return (
    membership !== undefined &&
    authorization.decide({ userId, campaignId, role: membership.role }, 'read', {
      campaignId,
      resourceClass,
      resourceId: campaignId,
      visibility,
      version: 1,
    }).allowed
  );
}

/** Committed fixture rows, removed in `cleanup`. */
const seeded = { users: [] as string[], campaigns: [] as string[] };
/** Campaigns created through the runtime: only their content rows are removed. */
const runtimeCampaigns: string[] = [];

async function seedUsers(count: number): Promise<string[]> {
  if (sql === undefined) throw new Error('database unavailable');
  const users = Array.from({ length: count }, id);
  for (const userId of users) {
    const suffix = userId.replaceAll('-', '').slice(0, 12);
    await sql`insert into identity_users (id, username_display, username_normalized)
      values (${userId}, ${`Ps_${suffix}`}, ${`ps_${suffix}`})`;
  }
  seeded.users.push(...users);
  return users;
}

async function seedCampaign(
  owner: string,
  members: readonly Omit<Membership, 'campaign'>[],
  deleted = false,
): Promise<string> {
  if (sql === undefined) throw new Error('database unavailable');
  const campaign = id();
  seeded.campaigns.push(campaign);
  // One transaction: the deferred one-active-owner constraint checks at commit.
  await sql.begin(async (tx) => {
    await tx`insert into campaigns (id, name, game_mode, created_by, deleted_at)
      values (${campaign}, 'PowerSync probe', 'standard', ${owner},
        ${deleted ? new Date('2026-10-01T00:00:00Z') : null})`;
    for (const item of members) {
      await tx`insert into identity_campaign_memberships (campaign_id, user_id, role, removed_at)
        values (${campaign}, ${item.user}, ${item.role},
          ${item.removed ? new Date('2026-09-01T00:00:00Z') : null})`;
    }
  });
  return campaign;
}

async function setting(
  campaign: string,
  namespace: string,
  memberVisible: boolean,
  by: string,
  deleted = false,
): Promise<void> {
  if (sql === undefined) throw new Error('database unavailable');
  await sql`insert into campaign_settings
      (campaign_id, namespace, value, member_visible, updated_by, deleted_at)
    values (${campaign}, ${namespace}, ${sql.json({ probe: namespace })}, ${memberVisible},
      ${by}, ${deleted ? new Date('2026-10-02T00:00:00Z') : null})`;
}

afterAll(async () => {
  if (sql === undefined) return;
  try {
    if (seeded.campaigns.length > 0) {
      await sql`delete from dice_rolls where campaign_id = any(${seeded.campaigns}::uuid[])`;
      await sql`delete from effect_applications
        where campaign_id = any(${seeded.campaigns}::uuid[])`;
    }
    if (runtimeCampaigns.length > 0) {
      await sql`delete from content_entity_relationships
        where campaign_id = any(${runtimeCampaigns}::uuid[])`;
      await sql`delete from content_entities where campaign_id = any(${runtimeCampaigns}::uuid[])`;
      await sql`delete from sync_mutation_receipts
        where campaign_id = any(${runtimeCampaigns}::uuid[])`;
    }
    await sql.begin(async (tx) => {
      const campaigns = seeded.campaigns;
      await tx`delete from sync_long_text_holds where campaign_id = any(${campaigns}::uuid[])`;
      await tx`delete from content_entity_relationships
        where campaign_id = any(${campaigns}::uuid[])`;
      await tx`delete from content_entities where campaign_id = any(${campaigns}::uuid[])`;
      await tx`delete from content_personal_notes where campaign_id = any(${campaigns}::uuid[])`;
      await tx`delete from campaign_settings where campaign_id = any(${campaigns}::uuid[])`;
      await tx`delete from identity_campaign_memberships
        where campaign_id = any(${campaigns}::uuid[])`;
      await tx`delete from campaigns where id = any(${campaigns}::uuid[])`;
      await tx`delete from identity_users where id = any(${seeded.users}::uuid[])`;
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
});

describe.skipIf(!live)('PowerSync provider round trip (live service)', () => {
  test('a token signed with another key is rejected', async () => {
    const forged = `${await tokenFor(id())}x`;
    const response = await fetch(`${ENDPOINT}/sync/stream`, {
      method: 'POST',
      headers: { authorization: `Token ${forged}`, 'content-type': 'application/json' },
      body: JSON.stringify({ buckets: [], raw_data: true }),
    });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  test('each requester receives exactly the rows the read decision allows, tombstones included', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [owner, gm, assistantGm, player, removedGm, nonMember, otherOwner] = (await seedUsers(
      7,
    )) as [string, string, string, string, string, string, string];
    const members = (rows: [string, Role, boolean?][]) =>
      rows.map(([user, role, removed]) => ({ user, role, removed: removed === true }));
    const live = await seedCampaign(
      owner,
      members([
        [owner, 'owner'],
        [gm, 'gm'],
        [assistantGm, 'assistant_gm'],
        [player, 'player'],
        [removedGm, 'gm', true],
      ]),
    );
    const other = await seedCampaign(otherOwner, members([[otherOwner, 'owner']]));
    const deleted = await seedCampaign(
      owner,
      members([
        [owner, 'owner'],
        [player, 'player'],
      ]),
      true,
    );
    const memberships: Membership[] = [
      ...members([
        [owner, 'owner'],
        [gm, 'gm'],
        [assistantGm, 'assistant_gm'],
        [player, 'player'],
        [removedGm, 'gm', true],
      ]).map((item) => ({ ...item, campaign: live })),
      { campaign: other, user: otherOwner, role: 'owner', removed: false },
      { campaign: deleted, user: owner, role: 'owner', removed: false },
      { campaign: deleted, user: player, role: 'player', removed: false },
    ];
    const settings = [
      { campaign: live, namespace: 'probe.shared', memberVisible: true, deleted: false },
      { campaign: live, namespace: 'probe.gm', memberVisible: false, deleted: false },
      { campaign: live, namespace: 'probe.gm_deleted', memberVisible: false, deleted: true },
      { campaign: live, namespace: 'probe.shared_deleted', memberVisible: true, deleted: true },
      { campaign: other, namespace: 'probe.shared', memberVisible: true, deleted: false },
    ];
    for (const row of settings) {
      await setting(row.campaign, row.namespace, row.memberVisible, owner, row.deleted);
    }
    const secretRecord = id();
    const holds = [
      { campaign: live, resourceClass: 'campaign', recordId: live },
      // A hold names its record: on a class that is not campaign-wide it reaches no replica.
      { campaign: live, resourceClass: 'fixture.gm_secret', recordId: secretRecord },
      { campaign: other, resourceClass: 'campaign', recordId: other },
    ];
    const at = new Date('2026-10-26T00:00:00Z');
    for (const row of holds) {
      await sql`insert into sync_long_text_holds (campaign_id, resource_class, record_id,
            field_path, holder_user_id, holder_session_id, acquired_at, renewed_at, expires_at,
            version)
          values (${row.campaign}, ${row.resourceClass}, ${row.recordId}, 'body', ${gm}, ${id()},
            ${at}, ${at}, ${at}, 1)`;
    }

    const everyone: Visibility = { mode: 'everyone' };
    const expected = (userId: string) => ({
      campaigns: [live, other, deleted]
        .filter((campaign) => reads(memberships, userId, campaign, 'campaign', everyone))
        .sort(),
      campaign_settings: settings
        .filter((row) =>
          reads(
            memberships,
            userId,
            row.campaign,
            'campaign',
            row.memberVisible ? everyone : { mode: 'gm_only' },
          ),
        )
        .map((row) => `${row.campaign}:${row.namespace}`)
        .sort(),
      sync_long_text_holds: holds
        .filter((row) => reads(memberships, userId, row.campaign, row.resourceClass, everyone))
        .map((row) => `${row.campaign}:${row.resourceClass}:${row.recordId}:body`)
        .sort(),
      identity_campaign_memberships: memberships
        .filter((row) => row.user === userId)
        .map((row) => row.campaign)
        .sort(),
    });

    const requesters = { owner, gm, assistantGm, player, removedGm, nonMember, otherOwner };
    for (const [name, userId] of Object.entries(requesters)) {
      const replica = await sync(replicaFor(userId));
      expect({
        name,
        campaigns: ids(replica, 'campaigns'),
        campaign_settings: ids(replica, 'campaign_settings'),
        sync_long_text_holds: ids(replica, 'sync_long_text_holds'),
        identity_campaign_memberships: ids(replica, 'identity_campaign_memberships'),
      }).toEqual({ name, ...expected(userId) });
      // The hidden hold's record id never appears in any requester's payload.
      expect(replica.received).not.toContain(secretRecord);
      // Synced tables keep their client names (an aliased source would rename them).
      const clientTables = [
        'campaigns',
        'campaign_settings',
        'sync_long_text_holds',
        'identity_campaign_memberships',
      ];
      expect(replica.ops.filter((op) => !clientTables.includes(op.table))).toEqual([]);
      if (name === 'player') {
        expect(replica.received).not.toContain('probe.gm');
        // A deleted campaign the player could read arrives as a tombstone.
        expect(view(replica, 'campaigns').get(deleted)?.deleted_at).not.toBeNull();
        expect(
          view(replica, 'campaign_settings').get(`${live}:probe.shared_deleted`)?.deleted_at,
        ).not.toBeNull();
      }
      if (name === 'removedGm') {
        // The removal tombstone reaches the removed member; nothing else does.
        expect(view(replica, 'identity_campaign_memberships').get(live)?.removed_at).not.toBe(null);
      }
    }
  }, 120_000);

  test('role change and revocation add and remove rows on an existing replica', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [owner, member] = (await seedUsers(2)) as [string, string];
    const campaign = await seedCampaign(owner, [
      { user: owner, role: 'owner', removed: false },
      { user: member, role: 'player', removed: false },
    ]);
    await setting(campaign, 'probe.shared', true, owner);
    await setting(campaign, 'probe.gm', false, owner);
    const shared = `${campaign}:probe.shared`;
    const secret = `${campaign}:probe.gm`;
    const changeRole = async (role: Role) => {
      await sql`update identity_campaign_memberships
          set role = ${role}, version = version + 1, updated_at = now()
          where campaign_id = ${campaign} and user_id = ${member}`;
    };

    const replica = await sync(replicaFor(member));
    expect(ids(replica, 'campaigns')).toEqual([campaign]);
    expect(ids(replica, 'campaign_settings')).toEqual([shared]);

    await changeRole('gm');
    await sync(replica);
    expect(ids(replica, 'campaign_settings')).toEqual([shared, secret].sort());
    expect(view(replica, 'identity_campaign_memberships').get(campaign)?.role).toBe('gm');

    // Demotion: the GM-only setting leaves the device (its bucket is dropped).
    await changeRole('player');
    await sync(replica);
    expect(ids(replica, 'campaign_settings')).toEqual([shared]);
    expect(replica.received).not.toContain('probe.gm"');

    // Revocation: every campaign row leaves; the membership tombstone arrives.
    await sql`update identity_campaign_memberships
        set removed_at = now(), version = version + 1, updated_at = now()
        where campaign_id = ${campaign} and user_id = ${member}`;
    await sync(replica);
    expect(ids(replica, 'campaigns')).toEqual([]);
    expect(ids(replica, 'campaign_settings')).toEqual([]);
    expect(view(replica, 'identity_campaign_memberships').get(campaign)?.removed_at).not.toBe(null);
  }, 120_000);

  test('unseen tombstones and hidden-row churn change nothing on a player replica; un-reveal is a REMOVE', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [owner, player] = (await seedUsers(2)) as [string, string];
    const campaign = await seedCampaign(owner, [
      { user: owner, role: 'owner', removed: false },
      { user: player, role: 'player', removed: false },
    ]);
    await setting(campaign, 'probe.shared', true, owner);
    await setting(campaign, 'probe.later_hidden', true, owner);
    await setting(campaign, 'probe.seen_then_deleted', true, owner);
    const playerReplica = await sync(replicaFor(player));
    const ownerReplica = await sync(replicaFor(owner));
    const before = playerReplica.checkpoint;

    // Hidden rows created and deleted: no op, no count or checksum change for the player.
    for (let index = 0; index < 5; index += 1) {
      await setting(campaign, `probe.hidden_${index}`, false, owner);
    }
    await sql`update campaign_settings set deleted_at = now(), version = version + 1
        where campaign_id = ${campaign} and namespace like 'probe.hidden_%'`;
    await sync(playerReplica);
    expect(playerReplica.ops).toEqual([]);
    expect(playerReplica.checkpoint).toEqual(before);
    expect(playerReplica.received).not.toContain('probe.hidden_');
    await sync(ownerReplica);
    const hidden = [...view(ownerReplica, 'campaign_settings')].filter(([key]) =>
      key.includes('probe.hidden_'),
    );
    expect(hidden.length).toBe(5);
    expect(hidden.every(([, row]) => row.deleted_at !== null)).toBe(true);

    // Un-reveal: a setting that stops being member-visible is removed from the player replica.
    await sql`update campaign_settings set member_visible = false, version = version + 1
        where campaign_id = ${campaign} and namespace = 'probe.later_hidden'`;
    // Seen then deleted: the player receives the tombstone.
    await sql`update campaign_settings set deleted_at = now(), version = version + 1
        where campaign_id = ${campaign} and namespace = 'probe.seen_then_deleted'`;
    await sync(playerReplica);
    expect(playerReplica.ops).toContainEqual(
      expect.objectContaining({
        op: 'REMOVE',
        table: 'campaign_settings',
        id: `${campaign}:probe.later_hidden`,
      }),
    );
    expect(ids(playerReplica, 'campaign_settings')).toEqual(
      [`${campaign}:probe.shared`, `${campaign}:probe.seen_then_deleted`].sort(),
    );
    expect(
      view(playerReplica, 'campaign_settings').get(`${campaign}:probe.seen_then_deleted`)
        ?.deleted_at,
    ).not.toBeNull();
  }, 120_000);

  /**
   * Feature 06 task 04: the audit streams on the live service. Audit rows are append-only, so the
   * committed fixture events stay (their campaign and members are removed in cleanup and no
   * stream delivers them afterwards).
   */
  test('audit stores reach exactly the permitted replicas, windowed by campaign and month', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const db = sql;
    const [owner, gm, player, removedGm] = (await seedUsers(4)) as [string, string, string, string];
    const campaign = await seedCampaign(owner, [
      { user: owner, role: 'owner', removed: false },
      { user: gm, role: 'gm', removed: false },
      { user: player, role: 'player', removed: false },
      { user: removedGm, role: 'gm', removed: true },
    ]);
    const sequence = { campaign: 0, private: 0 };
    const event = async (
      store: 'campaign' | 'private',
      snapshot: Record<string, unknown>,
      acceptedAt: string,
      targetType = 'campaign',
      targetId = campaign,
    ): Promise<string> => {
      const eventId = id();
      sequence[store] += 1;
      const table = store === 'campaign' ? 'audit_campaign_events' : 'audit_private_events';
      await db.unsafe(
        `insert into ${table} (id, campaign_id, campaign_sequence, actor_user_id, actor_role,
           action, target_type, target_id, target_visibility, before_value, after_value,
           client_recorded_at, accepted_at, origin_mutation_id, renderer_version)
         values ($1, $2, $3, $4, 'owner', 'campaign.details_updated', $5, $6, $7::text::jsonb,
           $8::text::jsonb, $9::text::jsonb, $10, $10, $11, 1)`,
        [
          eventId,
          campaign,
          sequence[store],
          owner,
          targetType,
          targetId,
          JSON.stringify(snapshot),
          JSON.stringify({ name: 'Before' }),
          JSON.stringify({ name: 'After' }),
          acceptedAt,
          id(),
        ],
      );
      return eventId;
    };
    const everyone = { visibility: { mode: 'everyone' } };
    const gmOnly = { visibility: { mode: 'gm_only' } };
    const october = '2026-10-15T10:00:00Z';
    const september = '2026-09-15T10:00:00Z';
    const ev = {
      everyone: await event('campaign', everyone, october),
      gmOnly: await event('campaign', gmOnly, october),
      toPlayer: await event(
        'campaign',
        { visibility: { mode: 'players', playerIds: [player] } },
        october,
      ),
      september: await event('campaign', everyone, september),
      membership: await event('campaign', gmOnly, october, 'campaign_membership', player),
      privateEveryone: await event('private', everyone, october),
      privateGm: await event('private', gmOnly, october),
    };
    const window = (stream: string, months: readonly string[]) =>
      months.map((month) => ({ stream, parameters: { campaign_id: campaign, month } }));
    const both = (months: readonly string[]) => [
      ...window('campaign_audit', months),
      ...window('gm_private_audit', months),
    ];

    // GM roles: the campaign store (snapshot permitting) and the private store.
    const ownerReplica = await sync(replicaFor(owner), both(['2026-10', '2026-09']));
    expect(ids(ownerReplica, 'audit_campaign_events')).toEqual(
      [ev.everyone, ev.gmOnly, ev.toPlayer, ev.september].sort(),
    );
    expect(ids(ownerReplica, 'audit_private_events')).toEqual(
      [ev.privateEveryone, ev.privateGm].sort(),
    );
    const row = view(ownerReplica, 'audit_campaign_events').get(ev.everyone) ?? {};
    // Approved projection only: no sequence (gaps count hidden events), snapshot, or origin.
    expect(Object.keys(row).sort()).toEqual(
      [
        'accepted_at',
        'action',
        'actor_role',
        'actor_user_id',
        'after_value',
        'before_value',
        'campaign_id',
        'client_recorded_at',
        'id',
        'renderer_version',
        'session_id',
        'target_id',
        'target_type',
      ].sort(),
    );
    expect(String(row.accepted_at).slice(0, 7)).toBe('2026-10');
    const gmReplica = await sync(replicaFor(gm), both(['2026-10']));
    expect(ids(gmReplica, 'audit_private_events')).toEqual(
      [ev.privateEveryone, ev.privateGm].sort(),
    );

    // A player, as the real client subscribes (campaign store only): no private stream, table,
    // id, or count in anything received.
    const playerWindow = window('campaign_audit', ['2026-10', '2026-09']);
    const playerReplica = await sync(replicaFor(player), playerWindow);
    expect(ids(playerReplica, 'audit_campaign_events')).toEqual(
      [ev.everyone, ev.toPlayer, ev.september].sort(),
    );
    for (const hidden of [ev.gmOnly, ev.membership, ev.privateEveryone, ev.privateGm]) {
      expect(playerReplica.received).not.toContain(hidden);
    }
    expect(playerReplica.received).not.toContain('audit_private_events');
    expect(playerReplica.received).not.toContain('gm_private_audit');
    // Even a forged subscription to the private stream yields nothing: the query decides.
    const forged = await sync(replicaFor(player), both(['2026-10']));
    expect(ids(forged, 'audit_private_events')).toEqual([]);
    expect(forged.received).not.toContain(ev.privateEveryone);
    expect(forged.received).not.toContain(ev.privateGm);
    // Membership events are server-only: no replica receives them, GM roles included.
    expect(ownerReplica.received).not.toContain(ev.membership);
    // A removed member receives nothing.
    const removed = await sync(replicaFor(removedGm), both(['2026-10', '2026-09']));
    expect([...view(removed, 'audit_campaign_events').keys()]).toEqual([]);
    expect([...view(removed, 'audit_private_events').keys()]).toEqual([]);

    // Hidden events change nothing a player receives: no ops, same bucket counts and checksums.
    const before = playerReplica.checkpoint;
    for (let index = 0; index < 4; index += 1) await event('campaign', gmOnly, october);
    for (let index = 0; index < 3; index += 1) await event('private', everyone, october);
    await sync(playerReplica, playerWindow);
    expect(playerReplica.ops).toEqual([]);
    expect(playerReplica.checkpoint).toEqual(before);

    // Eviction: dropping a month from the subscription drops its rows (the 10 MB window).
    await sync(ownerReplica, both(['2026-10']));
    expect(ids(ownerReplica, 'audit_campaign_events')).not.toContain(ev.september);
    expect(ids(ownerReplica, 'audit_campaign_events')).toContain(ev.everyone);

    // Revocation removes the player's audit rows.
    await db`update identity_campaign_memberships set removed_at = now()
      where campaign_id = ${campaign} and user_id = ${player}`;
    await sync(playerReplica, playerWindow);
    expect(ids(playerReplica, 'audit_campaign_events')).toEqual([]);

    // A deleted target (here the campaign itself) hides its history from every replica.
    await db`update campaigns set deleted_at = now() where id = ${campaign}`;
    await sync(ownerReplica, both(['2026-10']));
    expect(ids(ownerReplica, 'audit_campaign_events')).toEqual([]);
    expect(ids(ownerReplica, 'audit_private_events')).toEqual([]);
  }, 120_000);

  // Feature 16 task 04: content entities and personal notes through the live provider.
  test('content: each requester receives exactly the permitted entities, notes, and holds; reveal and un-reveal of an entity', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [owner, gm, assistantGm, playerA, playerB, removedGm, nonMember] = (await seedUsers(
      7,
    )) as [string, string, string, string, string, string, string];
    const campaign = await seedCampaign(owner, [
      { user: owner, role: 'owner', removed: false },
      { user: gm, role: 'gm', removed: false },
      { user: assistantGm, role: 'assistant_gm', removed: false },
      { user: playerA, role: 'player', removed: false },
      { user: playerB, role: 'player', removed: false },
      { user: removedGm, role: 'gm', removed: true },
    ]);
    const entity = async (visibility: Visibility, deleted = false) => {
      const entityId = id();
      await sql`insert into content_entities (id, campaign_id, type, name, visibility_mode,
          visibility_targets, created_by, updated_by, deleted_at)
        values (${entityId}, ${campaign}, 'npc', 'Live probe', ${visibility.mode},
          ${sql.json(visibility.mode === 'players' ? visibility.playerIds : [])}, ${gm}, ${gm},
          ${deleted ? new Date('2026-10-03T00:00:00Z') : null})`;
      return entityId;
    };
    const note = async (author: string) => {
      const noteId = id();
      await sql`insert into content_personal_notes (id, campaign_id, author_user_id, name,
          visibility_mode, visibility_targets, created_by, updated_by)
        values (${noteId}, ${campaign}, ${author}, 'Private probe', 'players',
          ${sql.json([author])}, ${author}, ${author})`;
      return noteId;
    };
    const gmOnly = await entity({ mode: 'gm_only' });
    const shared = await entity({ mode: 'everyone' });
    const forA = await entity({ mode: 'players', playerIds: [playerA] });
    const unseenTombstone = await entity({ mode: 'gm_only' }, true);
    const noteA = await note(playerA);
    const noteB = await note(playerB);
    const at = new Date(Date.now() + 60_000);
    for (const [resourceClass, recordId, holder] of [
      ['campaign_entity', gmOnly, gm],
      ['personal_note', noteA, playerA],
    ] as const) {
      await sql`insert into sync_long_text_holds (campaign_id, resource_class, record_id,
          field_path, holder_user_id, holder_session_id, acquired_at, renewed_at, expires_at,
          version)
        values (${campaign}, ${resourceClass}, ${recordId}, 'description', ${holder}, ${id()},
          now(), now(), ${at}, 1)`;
    }
    const entityHold = `${campaign}:campaign_entity:${gmOnly}:description`;
    const noteHold = `${campaign}:personal_note:${noteA}:description`;
    const gmView: Record<'content_entities' | 'content_personal_notes' | 'holds', string[]> = {
      content_entities: [gmOnly, shared, forA, unseenTombstone].sort(),
      content_personal_notes: [],
      holds: [entityHold],
    };
    const expected: Record<string, typeof gmView> = {
      owner: gmView,
      gm: gmView,
      assistantGm: gmView,
      playerA: {
        content_entities: [shared, forA].sort(),
        content_personal_notes: [noteA],
        holds: [noteHold],
      },
      playerB: { content_entities: [shared], content_personal_notes: [noteB], holds: [] },
      removedGm: { content_entities: [], content_personal_notes: [], holds: [] },
      nonMember: { content_entities: [], content_personal_notes: [], holds: [] },
    };
    const requesters = { owner, gm, assistantGm, playerA, playerB, removedGm, nonMember };
    const replicas = new Map<string, Replica>();
    for (const [name, userId] of Object.entries(requesters)) {
      const replica = await sync(replicaFor(userId));
      replicas.set(name, replica);
      expect({
        name,
        content_entities: ids(replica, 'content_entities'),
        content_personal_notes: ids(replica, 'content_personal_notes'),
        holds: ids(replica, 'sync_long_text_holds').filter((key) => key.startsWith(campaign)),
      }).toEqual({ name, ...(expected[name] ?? gmView) });
    }
    // Absence is asserted on the payload, not only on the applied rows.
    const playerA_ = replicas.get('playerA');
    const playerB_ = replicas.get('playerB');
    if (playerA_ === undefined || playerB_ === undefined) throw new Error('replica missing');
    for (const hidden of [gmOnly, unseenTombstone, noteB]) {
      expect(playerA_.received).not.toContain(hidden);
    }
    for (const hidden of [gmOnly, forA, noteA]) expect(playerB_.received).not.toContain(hidden);
    for (const name of ['owner', 'gm', 'assistantGm']) {
      expect(replicas.get(name)?.received).not.toContain(noteA);
      expect(replicas.get(name)?.received).not.toContain(noteB);
    }
    expect(view(playerA_, 'content_personal_notes').get(noteA)?.author_user_id).toBe(playerA);
    // JSON columns arrive as text.
    expect(typeof view(playerA_, 'content_entities').get(forA)?.visibility_targets).toBe('string');

    // Reveal to player B (feature 04 write shape), then un-reveal: a PUT, then a REMOVE.
    await sql`update content_entities set visibility_mode = 'players',
        visibility_targets = ${sql.json([playerA, playerB].sort())}, version = version + 1
      where id = ${forA}`;
    await sync(playerB_);
    expect(ids(playerB_, 'content_entities')).toEqual([shared, forA].sort());
    await sql`update content_entities set visibility_mode = 'gm_only',
        visibility_targets = '[]'::jsonb, version = version + 1
      where id = ${forA}`;
    await sync(playerB_);
    expect(ids(playerB_, 'content_entities')).toEqual([shared]);
    expect(playerB_.ops.some((op) => op.op === 'REMOVE' && op.id === forA)).toBe(true);

    // 25 hidden entity inserts and deletes: no op, no checkpoint change for player B.
    const before = playerB_.checkpoint;
    for (let index = 0; index < 25; index += 1) await entity({ mode: 'gm_only' });
    await sql`update content_entities set deleted_at = now(), version = version + 1
      where campaign_id = ${campaign} and visibility_mode = 'gm_only' and id <> ${gmOnly}
        and id <> ${forA} and deleted_at is null`;
    await sync(playerB_);
    expect(playerB_.ops).toEqual([]);
    expect(playerB_.checkpoint).toEqual(before);
  }, 120_000);

  test('content through the real write path: a reveal reaches player A only; un-reveal and a hidden endpoint are REMOVEs (feature 16 task 16)', async () => {
    if (sql === undefined || databaseUrl === undefined) throw new Error('database unavailable');
    const origin = 'https://table.invalid';
    const app = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: ENDPOINT,
      powerSyncJwtSecret: SECRET,
      systems: [FIXTURE_SYSTEM_DEFINITION],
      logger: false,
    });
    try {
      await app.ready();
      const suffix = crypto.randomUUID().slice(0, 8);
      let counter = 0;
      const signUp = async () => {
        counter += 1;
        const account = await app.inject({
          method: 'POST',
          url: '/auth/accounts',
          payload: {
            username: `live_${suffix}_${counter}`,
            password: 'correct horse battery staple',
          },
        });
        expect(account.statusCode).toBe(200);
        const raw = account.headers['set-cookie'];
        return {
          id: (account.json() as { user: { id: string } }).user.id,
          headers: {
            cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '',
            origin,
          },
        };
      };
      type Who = Awaited<ReturnType<typeof signUp>>;
      const owner = await signUp();
      const playerA = await signUp();
      const playerB = await signUp();
      const campaign = crypto.randomUUID();
      runtimeCampaigns.push(campaign);
      const created = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: owner.headers,
        payload: {
          id: campaign,
          system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
          gameMode: 'standard',
          options: {},
          moduleIds: [],
          name: 'Live reveal',
          description: '',
        },
      });
      expect(created.statusCode).toBe(201);
      for (const player of [playerA, playerB]) {
        const invited = await app.inject({
          method: 'POST',
          url: `/campaigns/${campaign}/invitations`,
          headers: owner.headers,
          payload: { targetRole: 'player' },
        });
        const token = (invited.json() as { token: string }).token;
        const accepted = await app.inject({
          method: 'POST',
          url: `/invitations/${token}/accept`,
          headers: player.headers,
        });
        expect(accepted.statusCode).toBe(200);
      }
      let causal = 0;
      const upload = async (table: string, record: EntityRecord | RelationshipRecord) => {
        causal += 1;
        const at = new Date().toISOString();
        const response = await app.inject({
          method: 'POST',
          url: '/sync/mutations',
          headers: owner.headers,
          payload: {
            campaignId: campaign,
            replicaId: crypto.randomUUID(),
            mutations: [
              {
                mutationId: id(),
                campaignId: campaign,
                featureId: CONTENT_SYNC_FEATURE_ID,
                tableName: table,
                recordId: record.id,
                operation: 'insert',
                expectedVersion: null,
                payload: record,
                audit: {
                  campaignId: campaign,
                  action: 'content.changed',
                  targetType: table,
                  targetId: record.id,
                  at,
                  private: false,
                },
                causalSequence: causal,
                state: 'pending',
                attemptCount: 0,
                recordedAt: at,
              },
            ],
          },
        });
        expect((response.json() as { outcomes: { status: string }[] }).outcomes[0]?.status).toBe(
          'accepted',
        );
      };
      const now = new Date().toISOString();
      const envelope = (recordId: string) => ({
        id: recordId,
        campaignId: campaign,
        tags: [],
        metadata: {},
        visibility: { mode: 'gm_only' } as Visibility,
        version: 1,
        createdAt: now,
        createdBy: owner.id,
        updatedAt: now,
        updatedBy: owner.id,
      });
      const entity = async (name: string) => {
        const entityId = id();
        await upload(ENTITY_REPLICA_TABLE, {
          ...envelope(entityId),
          type: 'item',
          name,
          summary: '',
          description: '',
          fields: {},
        });
        return entityId;
      };
      const patch = async (
        who: Who,
        resourceClass: string,
        resourceId: string,
        body: { operation: 'reveal' | 'unreveal'; target: Visibility; expectedVersion: number },
      ) => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/campaigns/${campaign}/resources/${resourceClass}/${resourceId}/visibility`,
          headers: who.headers,
          payload: body,
        });
        expect(response.statusCode).toBe(200);
        return response.json() as { version: number };
      };
      const letter = await entity('Weathered Letter');
      const road = await entity('Old Road');
      await patch(owner, 'campaign_entity', road, {
        operation: 'reveal',
        target: { mode: 'everyone' },
        expectedVersion: 1,
      });
      const linkId = id();
      await upload(RELATIONSHIP_REPLICA_TABLE, {
        ...envelope(linkId),
        type: 'relationship',
        name: 'located_at',
        sourceEntityId: letter,
        targetEntityId: road,
        kind: 'located_at',
      });
      const a = await sync(replicaFor(playerA.id));
      const b = await sync(replicaFor(playerB.id));
      for (const replica of [a, b]) {
        expect(ids(replica, 'content_entities')).toEqual([road]);
        expect(ids(replica, 'content_entity_relationships')).toEqual([]);
        expect(replica.received).not.toContain(letter);
        expect(replica.received).not.toContain(linkId);
      }

      // Reveal the letter to player A through feature 04 (VisibilityService + entity adapter).
      const startedReveal = performance.now();
      const toA = { mode: 'players', playerIds: [playerA.id] } as Visibility;
      const revealed = await patch(owner, 'campaign_entity', letter, {
        operation: 'reveal',
        target: toA,
        expectedVersion: 1,
      });
      await sync(a);
      const revealMs = performance.now() - startedReveal;
      expect(ids(a, 'content_entities')).toEqual([letter, road].sort());
      expect(a.ops.some((op) => op.op === 'PUT' && op.id === letter)).toBe(true);
      const beforeB = b.checkpoint;
      await sync(b);
      expect(ids(b, 'content_entities')).toEqual([road]);
      expect(b.received).not.toContain(letter);
      expect(b.ops).toEqual([]);
      expect(b.checkpoint).toEqual(beforeB);
      // The link revealed within its endpoints (B-1 bound) reaches player A only.
      await patch(owner, 'entity_relationship', linkId, {
        operation: 'reveal',
        target: toA,
        expectedVersion: 1,
      });
      await sync(a);
      await sync(b);
      expect(ids(a, 'content_entity_relationships')).toEqual([linkId]);
      expect(ids(b, 'content_entity_relationships')).toEqual([]);
      expect(b.received).not.toContain(linkId);

      // Un-reveal the letter: the entity and, by D-07 narrowing in the same transaction, its link
      // are REMOVEs on player A's replica.
      const startedHide = performance.now();
      await patch(owner, 'campaign_entity', letter, {
        operation: 'unreveal',
        target: toA,
        expectedVersion: revealed.version,
      });
      await sync(a);
      const hideMs = performance.now() - startedHide;
      expect(ids(a, 'content_entities')).toEqual([road]);
      expect(ids(a, 'content_entity_relationships')).toEqual([]);
      expect(a.ops.some((op) => op.op === 'REMOVE' && op.id === letter)).toBe(true);
      expect(a.ops.some((op) => op.op === 'REMOVE' && op.id === linkId)).toBe(true);
      const [narrowedLink] = await sql`select visibility_mode from content_entity_relationships
        where id = ${linkId}`;
      expect(narrowedLink?.visibility_mode).toBe('gm_only');
      await sync(b);
      expect(b.received).not.toContain(letter);
      expect(b.received).not.toContain(linkId);
      console.info(
        `live content reveal: PATCH -> player A replica ${Math.round(revealMs)} ms; un-reveal -> REMOVE ${Math.round(hideMs)} ms`,
      );
    } finally {
      await app.close();
    }
  }, 120_000);

  test('handouts: a queued reveal through /sync/mutations reaches player A only, then leaves on un-reveal (feature 17)', async () => {
    if (sql === undefined || databaseUrl === undefined) throw new Error('database unavailable');
    const origin = 'https://table.invalid';
    const app = buildRuntimeApp({
      databaseUrl,
      allowedOrigin: origin,
      production: false,
      powerSyncEndpoint: ENDPOINT,
      powerSyncJwtSecret: SECRET,
      systems: [FIXTURE_SYSTEM_DEFINITION],
      logger: false,
    });
    try {
      await app.ready();
      const suffix = crypto.randomUUID().slice(0, 8);
      let counter = 0;
      const signUp = async () => {
        counter += 1;
        const account = await app.inject({
          method: 'POST',
          url: '/auth/accounts',
          payload: {
            username: `hand_${suffix}_${counter}`,
            password: 'correct horse battery staple',
          },
        });
        expect(account.statusCode).toBe(200);
        const raw = account.headers['set-cookie'];
        return {
          id: (account.json() as { user: { id: string } }).user.id,
          headers: {
            cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '',
            origin,
          },
        };
      };
      const owner = await signUp();
      const playerA = await signUp();
      const playerB = await signUp();
      const campaign = crypto.randomUUID();
      runtimeCampaigns.push(campaign);
      const created = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: owner.headers,
        payload: {
          id: campaign,
          system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
          gameMode: 'standard',
          options: {},
          moduleIds: [],
          name: 'Live handout',
          description: '',
        },
      });
      expect(created.statusCode).toBe(201);
      for (const player of [playerA, playerB]) {
        const invited = await app.inject({
          method: 'POST',
          url: `/campaigns/${campaign}/invitations`,
          headers: owner.headers,
          payload: { targetRole: 'player' },
        });
        const accepted = await app.inject({
          method: 'POST',
          url: `/invitations/${(invited.json() as { token: string }).token}/accept`,
          headers: player.headers,
        });
        expect(accepted.statusCode).toBe(200);
      }
      let causal = 0;
      const upload = async (
        operation: 'insert' | 'update',
        expectedVersion: number | null,
        payload: Record<string, unknown> & { readonly id: string },
        audited: boolean,
      ) => {
        causal += 1;
        const at = new Date().toISOString();
        const response = await app.inject({
          method: 'POST',
          url: '/sync/mutations',
          headers: owner.headers,
          payload: {
            campaignId: campaign,
            replicaId: crypto.randomUUID(),
            mutations: [
              {
                mutationId: id(),
                campaignId: campaign,
                featureId: CONTENT_SYNC_FEATURE_ID,
                tableName: ENTITY_REPLICA_TABLE,
                recordId: payload.id,
                operation,
                expectedVersion,
                payload,
                ...(audited
                  ? {
                      audit: {
                        campaignId: campaign,
                        action: 'content.changed',
                        targetType: ENTITY_REPLICA_TABLE,
                        targetId: payload.id,
                        at,
                        private: true,
                      },
                    }
                  : {}),
                causalSequence: causal,
                state: 'pending',
                attemptCount: 0,
                recordedAt: at,
              },
            ],
          },
        });
        expect((response.json() as { outcomes: { status: string }[] }).outcomes[0]?.status).toBe(
          'accepted',
        );
      };
      const now = new Date().toISOString();
      const handout = id();
      const record = {
        id: handout,
        campaignId: campaign,
        type: 'handout',
        name: 'Sealed letter',
        summary: '',
        description: 'The ferryman lies.',
        tags: [],
        fields: {},
        metadata: {},
        visibility: { mode: 'gm_only' } as Visibility,
        version: 1,
        createdAt: now,
        createdBy: owner.id,
        updatedAt: now,
        updatedBy: owner.id,
      };
      await upload('insert', null, record, true);
      const a = await sync(replicaFor(playerA.id));
      const b = await sync(replicaFor(playerB.id));
      for (const replica of [a, b]) {
        expect(ids(replica, 'content_entities')).toEqual([]);
        expect(replica.received).not.toContain(handout);
        expect(replica.received).not.toContain('The ferryman lies.');
      }

      const started = performance.now();
      await upload(
        'update',
        1,
        {
          ...record,
          version: 2,
          visibilityChange: {
            operation: 'reveal',
            target: { mode: 'players', playerIds: [playerA.id] },
          },
        },
        false,
      );
      await sync(a);
      const revealMs = performance.now() - started;
      expect(ids(a, 'content_entities')).toEqual([handout]);
      const beforeB = b.checkpoint;
      await sync(b);
      expect(ids(b, 'content_entities')).toEqual([]);
      expect(b.received).not.toContain(handout);
      expect(b.received).not.toContain('The ferryman lies.');
      expect(b.ops).toEqual([]);
      expect(b.checkpoint).toEqual(beforeB);

      await upload(
        'update',
        2,
        {
          ...record,
          version: 3,
          visibilityChange: { operation: 'unreveal', target: { mode: 'everyone' } },
        },
        false,
      );
      await sync(a);
      expect(ids(a, 'content_entities')).toEqual([]);
      expect(a.ops.some((op) => op.op === 'REMOVE' && op.id === handout)).toBe(true);
      console.info(`live handout reveal: mutation -> player A replica ${Math.round(revealMs)} ms`);
      expect(revealMs).toBeLessThan(5_000);
    } finally {
      await app.close();
    }
  }, 120_000);

  /**
   * Feature 09: zero hidden rolls on a player's replica, on the real service. Rows are committed through
   * the table, as the rest of this file seeds them; the applier path is covered by
   * `apps/api/src/modules/dice/security-acceptance.integration.test.ts`.
   */
  test('rolls: each requester receives exactly the permitted rolls; hidden churn changes nothing for a player', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [owner, gm, assistantGm, playerA, playerB, removedGm, nonMember] = (await seedUsers(
      7,
    )) as [string, string, string, string, string, string, string];
    const campaign = await seedCampaign(owner, [
      { user: owner, role: 'owner', removed: false },
      { user: gm, role: 'gm', removed: false },
      { user: assistantGm, role: 'assistant_gm', removed: false },
      { user: playerA, role: 'player', removed: false },
      { user: playerB, role: 'player', removed: false },
      { user: removedGm, role: 'gm', removed: true },
    ]);
    const roll = async (actor: string, label: string, mode: string, targets: readonly string[]) => {
      const rollId = id();
      await sql`insert into dice_rolls (id, campaign_id, actor_user_id, expression, result,
          natural_result, modified_result, roll_visibility, visibility_mode, visibility_targets,
          rolled_at)
        values (${rollId}, ${campaign}, ${actor}, '1d20',
          ${sql.json({
            terms: [
              { kind: 'dice', sign: 1, die: 'd20', faces: [{ value: 7, kept: true }], subtotal: 7 },
            ],
            natural: 7,
            modified: 7,
          })},
          7, 7, ${label}, ${mode}, ${sql.json([...targets].sort())}, now())`;
      return rollId;
    };
    const shared = await roll(gm, 'public', 'everyone', []);
    const hidden = await roll(gm, 'gm_only', 'gm_only', []);
    const blind = await roll(gm, 'blind', 'gm_only', []);
    const privateA = await roll(playerA, 'player_only', 'players', [playerA]);
    const whisperAB = await roll(playerA, 'whisper', 'players', [playerA, playerB]);
    const privateB = await roll(playerB, 'player_only', 'players', [playerB]);
    const everyRoll = [shared, hidden, blind, privateA, whisperAB, privateB].sort();

    for (const gmRole of [owner, gm, assistantGm]) {
      expect(ids(await sync(replicaFor(gmRole)), 'dice_rolls')).toEqual(everyRoll);
    }
    const replicaA = await sync(replicaFor(playerA));
    const replicaB = await sync(replicaFor(playerB));
    expect(ids(replicaA, 'dice_rolls')).toEqual([shared, privateA, whisperAB].sort());
    expect(ids(replicaB, 'dice_rolls')).toEqual([shared, whisperAB, privateB].sort());
    expect(ids(await sync(replicaFor(removedGm)), 'dice_rolls')).toEqual([]);
    expect(ids(await sync(replicaFor(nonMember)), 'dice_rolls')).toEqual([]);

    // Absent, not filtered: no hidden id anywhere in what the player's replica was ever sent.
    for (const replica of [replicaA, replicaB]) {
      expect(replica.received).not.toContain(hidden);
      expect(replica.received).not.toContain(blind);
      const stored = [...view(replica, 'dice_rolls').values()];
      expect(
        stored.filter((row) => ['gm_only', 'blind'].includes(String(row.roll_visibility))),
      ).toEqual([]);
    }
    expect(replicaB.received).not.toContain(privateA);
    expect(replicaA.received).not.toContain(privateB);

    // 25 hidden rolls: no op and no checkpoint change for a player.
    const before = replicaA.checkpoint;
    const churn: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      churn.push(await roll(gm, index % 2 === 0 ? 'gm_only' : 'blind', 'gm_only', []));
    }
    await sync(replicaA);
    expect(replicaA.ops).toEqual([]);
    expect(replicaA.checkpoint).toEqual(before);
    for (const rollId of churn) expect(replicaA.received).not.toContain(rollId);
    const ownerAfter = ids(await sync(replicaFor(owner)), 'dice_rolls');
    expect(churn.every((rollId) => ownerAfter.includes(rollId))).toBe(true);
    await sql`delete from dice_rolls where campaign_id = ${campaign}`;
  }, 120_000);

  /**
   * Feature 11: an application reaches exactly who may read its target. Rows are committed through the
   * table, as this file seeds; the applier path is `apps/api/src/modules/actions/security-acceptance`.
   */
  test('effect applications: each requester receives exactly the permitted records', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [owner, gm, playerA, playerB, removedGm] = (await seedUsers(5)) as [
      string,
      string,
      string,
      string,
      string,
    ];
    const campaign = await seedCampaign(owner, [
      { user: owner, role: 'owner', removed: false },
      { user: gm, role: 'gm', removed: false },
      { user: playerA, role: 'player', removed: false },
      { user: playerB, role: 'player', removed: false },
      { user: removedGm, role: 'gm', removed: true },
    ]);
    const application = async (mode: string, targets: readonly string[]) => {
      const applicationId = id();
      await sql`insert into effect_applications (id, campaign_id, actor_user_id, target_class,
          target_id, operations, visibility_mode, visibility_targets, applied_at)
        values (${applicationId}, ${campaign}, ${gm}, 'character', ${id()},
          ${sql.json([{ operation: { op: 'delta', path: 'resources.hp.current', value: -1 } }])},
          ${mode}, ${sql.json([...targets])}, now())`;
      return applicationId;
    };
    const shared = await application('everyone', []);
    const hidden = await application('gm_only', []);
    const forA = await application('players', [playerA]);
    for (const gmRole of [owner, gm]) {
      expect(ids(await sync(replicaFor(gmRole)), 'effect_applications')).toEqual(
        [shared, hidden, forA].sort(),
      );
    }
    const replicaA = await sync(replicaFor(playerA));
    const replicaB = await sync(replicaFor(playerB));
    expect(ids(replicaA, 'effect_applications')).toEqual([shared, forA].sort());
    expect(ids(replicaB, 'effect_applications')).toEqual([shared]);
    expect(replicaA.received).not.toContain(hidden);
    expect(replicaB.received).not.toContain(forA);
    expect(ids(await sync(replicaFor(removedGm)), 'effect_applications')).toEqual([]);

    const before = replicaA.checkpoint;
    for (let index = 0; index < 25; index += 1) await application('gm_only', []);
    await sync(replicaA);
    expect(replicaA.ops).toEqual([]);
    expect(replicaA.checkpoint).toEqual(before);
    await sql`delete from effect_applications where campaign_id = ${campaign}`;
  }, 120_000);

  test('sessions: every member holds the session and public entries; GM notes and GM-only entries reach GM roles only (feature 18)', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [owner, assistant, playerA, removedGm] = (await seedUsers(4)) as [
      string,
      string,
      string,
      string,
    ];
    const campaign = await seedCampaign(owner, [
      { user: owner, role: 'owner', removed: false },
      { user: assistant, role: 'assistant_gm', removed: false },
      { user: playerA, role: 'player', removed: false },
      { user: removedGm, role: 'gm', removed: true },
    ]);
    const session = id();
    try {
      await sql`insert into campaign_sessions (id, campaign_id, number, status, started_at,
          participant_user_ids, created_by, updated_by)
        values (${session}, ${campaign}, 1, 'active', now(), ${sql.json([owner, playerA])},
          ${owner}, ${owner})`;
      await sql`insert into session_gm_notes (id, campaign_id, body, created_by, updated_by)
        values (${session}, ${campaign}, 'The ferryman lies about the toll.', ${owner}, ${owner})`;
      const entry = async (mode: 'gm_only' | 'everyone', text: string) => {
        const entryId = id();
        await sql`insert into session_log_entries (id, campaign_id, session_id, kind, text,
            visibility_mode, created_by, updated_by)
          values (${entryId}, ${campaign}, ${session}, 'note', ${text}, ${mode}, ${owner}, ${owner})`;
        return entryId;
      };
      const shown = await entry('everyone', 'The bell rings twice.');
      const hidden = await entry('gm_only', 'Crates hide a second entrance.');

      for (const gmRole of [owner, assistant]) {
        const replica = await sync(replicaFor(gmRole));
        expect(ids(replica, 'campaign_sessions')).toEqual([session]);
        expect(ids(replica, 'session_gm_notes')).toEqual([session]);
        expect(ids(replica, 'session_log_entries')).toEqual([shown, hidden].sort());
      }
      const replicaA = await sync(replicaFor(playerA));
      expect(ids(replicaA, 'campaign_sessions')).toEqual([session]);
      expect(ids(replicaA, 'session_gm_notes')).toEqual([]);
      expect(ids(replicaA, 'session_log_entries')).toEqual([shown]);
      // Absent, not filtered at rendering: nothing in the payload names the notes or the hidden entry.
      expect(replicaA.received).not.toContain('ferryman');
      expect(replicaA.received).not.toContain(hidden);
      expect(ids(await sync(replicaFor(removedGm)), 'campaign_sessions')).toEqual([]);

      // GM-only churn and note edits change nothing on the player's replica.
      const before = replicaA.checkpoint;
      for (let index = 0; index < 10; index += 1) await entry('gm_only', `Hidden ${index}`);
      await sql`update session_gm_notes set body = 'Rewritten', version = version + 1
        where id = ${session}`;
      await sync(replicaA);
      expect(replicaA.ops).toEqual([]);
      expect(replicaA.checkpoint).toEqual(before);
    } finally {
      await sql`delete from session_log_entries where campaign_id = ${campaign}`;
      await sql`delete from session_gm_notes where campaign_id = ${campaign}`;
      await sql`delete from campaign_sessions where campaign_id = ${campaign}`;
    }
  }, 120_000);

  test('encounters: a player holds the encounter and visible participants, never instance states, GM notes, or a hidden participant (feature 19)', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [owner, assistant, playerA] = (await seedUsers(3)) as [string, string, string];
    const campaign = await seedCampaign(owner, [
      { user: owner, role: 'owner', removed: false },
      { user: assistant, role: 'assistant_gm', removed: false },
      { user: playerA, role: 'player', removed: false },
    ]);
    const encounter = id();
    try {
      await sql`insert into encounters (id, campaign_id, name, status, started_at, created_by,
          updated_by)
        values (${encounter}, ${campaign}, 'Ambush at the ford', 'active', now(), ${owner}, ${owner})`;
      await sql`insert into encounter_gm_notes (id, campaign_id, body, created_by, updated_by)
        values (${encounter}, ${campaign}, 'The leader flees at half.', ${owner}, ${owner})`;
      const participant = async (label: string, mode: 'gm_only' | 'everyone') => {
        const participantId = id();
        await sql`insert into encounter_participants (id, campaign_id, encounter_id, label,
            source_kind, source_id, position, conditions, visibility_mode, created_by, updated_by)
          values (${participantId}, ${campaign}, ${encounter}, ${label}, 'entity', ${id()}, 0,
            ${sql.json({ bleeding: 1 })}, ${mode}, ${owner}, ${owner})`;
        await sql`insert into encounter_participant_states (id, campaign_id, state, created_by,
            updated_by)
          values (${participantId}, ${campaign},
            ${sql.json({ fields: {}, resources: { hp: { current: 3 } }, tracks: {}, conditions: {}, inventory: {}, slots: {} })},
            ${owner}, ${owner})`;
        return participantId;
      };
      const visible = await participant('Bandit 1', 'everyone');
      const lurker = await participant('Lurker', 'gm_only');

      for (const gmRole of [owner, assistant]) {
        const replica = await sync(replicaFor(gmRole));
        expect(ids(replica, 'encounters')).toEqual([encounter]);
        expect(ids(replica, 'encounter_gm_notes')).toEqual([encounter]);
        expect(ids(replica, 'encounter_participants')).toEqual([visible, lurker].sort());
        expect(ids(replica, 'encounter_participant_states')).toEqual([visible, lurker].sort());
      }
      const replicaA = await sync(replicaFor(playerA));
      expect(ids(replicaA, 'encounters')).toEqual([encounter]);
      expect(ids(replicaA, 'encounter_participants')).toEqual([visible]);
      expect(ids(replicaA, 'encounter_gm_notes')).toEqual([]);
      expect(ids(replicaA, 'encounter_participant_states')).toEqual([]);
      // Absent, not filtered at rendering: no hit points, no notes, no hidden participant in the payload.
      expect(replicaA.received).toContain('bleeding');
      expect(replicaA.received).not.toContain('flees');
      expect(replicaA.received).not.toContain('Lurker');
      expect(replicaA.received).not.toContain('"current"');

      // Instance-state churn (damage) sends the player nothing; a reveal sends the participant.
      const before = replicaA.checkpoint;
      for (let index = 0; index < 5; index += 1) {
        await sql`update encounter_participant_states set version = version + 1,
            state = jsonb_set(state, '{resources,hp,current}', ${String(index)}::jsonb)
          where id = ${visible}`;
      }
      await sync(replicaA);
      expect(replicaA.ops).toEqual([]);
      expect(replicaA.checkpoint).toEqual(before);
      await sql`update encounter_participants set visibility_mode = 'everyone', version = version + 1
        where id = ${lurker}`;
      expect(ids(await sync(replicaA), 'encounter_participants')).toEqual([visible, lurker].sort());
    } finally {
      await sql`delete from encounter_participant_states where campaign_id = ${campaign}`;
      await sql`delete from encounter_participants where campaign_id = ${campaign}`;
      await sql`delete from encounter_gm_notes where campaign_id = ${campaign}`;
      await sql`delete from encounters where campaign_id = ${campaign}`;
    }
  }, 120_000);

  test('content relationships: a link to a hidden endpoint never reaches a player; narrowing is a REMOVE', async () => {
    if (sql === undefined) throw new Error('database unavailable');
    const [owner, player] = (await seedUsers(2)) as [string, string];
    const campaign = await seedCampaign(owner, [
      { user: owner, role: 'owner', removed: false },
      { user: player, role: 'player', removed: false },
    ]);
    const entity = async (mode: 'gm_only' | 'everyone') => {
      const entityId = id();
      await sql`insert into content_entities (id, campaign_id, type, name, visibility_mode,
          created_by, updated_by)
        values (${entityId}, ${campaign}, 'npc', 'Live probe', ${mode}, ${owner}, ${owner})`;
      return entityId;
    };
    const link = async (source: string, target: string, mode: 'gm_only' | 'everyone') => {
      const linkId = id();
      await sql`insert into content_entity_relationships (id, campaign_id, source_entity_id,
          target_entity_id, kind, visibility_mode, created_by, updated_by)
        values (${linkId}, ${campaign}, ${source}, ${target}, 'knows', ${mode}, ${owner},
          ${owner})`;
      return linkId;
    };
    const traveler = await entity('everyone');
    const road = await entity('everyone');
    const smuggler = await entity('gm_only');
    const livesAt = await link(traveler, road, 'everyone');
    // The write path bounds a link by its endpoints: one to a gm_only entity is gm_only.
    const hidden = await link(traveler, smuggler, 'gm_only');
    const ownerReplica = await sync(replicaFor(owner));
    const playerReplica = await sync(replicaFor(player));
    expect(ids(ownerReplica, 'content_entity_relationships')).toEqual([livesAt, hidden].sort());
    expect(ids(playerReplica, 'content_entity_relationships')).toEqual([livesAt]);
    expect(playerReplica.received).not.toContain(hidden);
    expect(playerReplica.received).not.toContain(smuggler);
    // Hiding an endpoint narrows its link (D-07 option A, the adapter's write shape).
    await sql`update content_entities set visibility_mode = 'gm_only', version = version + 1
      where id = ${traveler}`;
    await sql`update content_entity_relationships set visibility_mode = 'gm_only',
        version = version + 1 where id = ${livesAt}`;
    await sync(playerReplica);
    expect(ids(playerReplica, 'content_entity_relationships')).toEqual([]);
    expect(playerReplica.ops.some((op) => op.op === 'REMOVE' && op.id === livesAt)).toBe(true);
  }, 120_000);
});
