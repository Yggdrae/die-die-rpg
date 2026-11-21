import { afterAll, describe, expect, test } from 'bun:test';
import { ResourcePolicyRegistry } from '@rpg/authorization';
import {
  CONTENT_SYNC_FEATURE_ID,
  ENTITY_REPLICA_TABLE,
  type EntityRecord,
  isWithin,
  PERSONAL_NOTE_REPLICA_TABLE,
  RELATIONSHIP_REPLICA_TABLE,
  type RelationshipRecord,
} from '@rpg/content';
import type { Visibility } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { compileProviderQueries, POSTGRES_DIALECT } from '@rpg/sync';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';
import { registerResourcePolicies, SYNC_RULE_BINDINGS } from '../sync/sync-rules.ts';

/**
 * Feature 16 tasks 08 and 09 through the runtime composition on PostgreSQL: relationship
 * mutations over `POST /sync/mutations` (accept, refusals, audit), the generic feature 04 route
 * refusing a reveal wider than an endpoint (B-1), hiding an endpoint narrowing its links with
 * audit (D-07 option A) and dropping them from a player's compiled stream, and the relationships
 * read route with broken links. Content rows are deleted; audit rows are append-only and stay.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const db = sql as NonNullable<typeof sql>;
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from content_entity_relationships limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];

afterAll(async () => {
  if (available && campaigns.length > 0) {
    await db`delete from content_entity_relationships where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from content_entities where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from content_personal_notes where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from sync_mutation_receipts where campaign_id = any(${campaigns}::uuid[])`;
  }
  await sql?.end({ timeout: 1 });
});

type Who = { readonly id: string; readonly headers: Record<string, string> };
const EVERYONE: Visibility = { mode: 'everyone' };
const GM_ONLY: Visibility = { mode: 'gm_only' };
let sequence = 0;

async function harness() {
  if (databaseUrl === undefined) throw new Error('database unavailable');
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    systems: [FIXTURE_SYSTEM_DEFINITION],
    logger: false,
  });
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 8);
  let counter = 0;
  const signUp = async (): Promise<Who> => {
    counter += 1;
    const account = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: `rel_${suffix}_${counter}`, password: 'correct horse battery staple' },
    });
    expect(account.statusCode).toBe(200);
    const raw = account.headers['set-cookie'];
    return {
      id: (JSON.parse(account.body) as { user: { id: string } }).user.id,
      headers: { cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '', origin },
    };
  };
  const owner = await signUp();
  const casey = await signUp();
  const campaignId = crypto.randomUUID();
  campaigns.push(campaignId);
  const created = await app.inject({
    method: 'POST',
    url: '/campaigns',
    headers: owner.headers,
    payload: {
      id: campaignId,
      system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
      gameMode: 'standard',
      options: {},
      moduleIds: [],
      name: 'Relationships',
      description: '',
    },
  });
  expect(created.statusCode).toBe(201);
  await db`insert into identity_campaign_memberships (campaign_id, user_id, role)
    values (${campaignId}, ${casey.id}, 'player')`;

  const upload = async (
    who: Who,
    table: string,
    recordId: string,
    operation: 'insert' | 'update' | 'tombstone',
    expectedVersion: number | null,
    payload: unknown,
  ) => {
    sequence += 1;
    const mutationId = crypto.randomUUID();
    const at = new Date().toISOString();
    const response = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: who.headers,
      payload: {
        campaignId,
        replicaId: crypto.randomUUID(),
        mutations: [
          {
            mutationId,
            campaignId,
            featureId: CONTENT_SYNC_FEATURE_ID,
            tableName: table,
            recordId,
            operation,
            expectedVersion,
            payload,
            audit: {
              campaignId,
              action: 'content.changed',
              targetType: table,
              targetId: recordId,
              at,
              private: false,
            },
            causalSequence: sequence,
            state: 'pending',
            attemptCount: 0,
            recordedAt: at,
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const [outcome] = (response.json() as { outcomes: Record<string, unknown>[] }).outcomes;
    return { mutationId, outcome };
  };
  const now = new Date().toISOString();
  const envelope = (id: string, userId: string) => ({
    id,
    campaignId,
    tags: [],
    metadata: {},
    version: 1,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
    updatedBy: userId,
  });
  const createEntity = async (name: string, visibility: Visibility, type = 'npc') => {
    const id = crypto.randomUUID();
    const record: EntityRecord = {
      ...envelope(id, owner.id),
      type,
      name,
      visibility,
      summary: '',
      description: '',
      fields: {},
    };
    const { outcome } = await upload(owner, ENTITY_REPLICA_TABLE, id, 'insert', null, record);
    expect(outcome).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
    return id;
  };
  const relationship = (
    id: string,
    source: string,
    target: string,
    kind: string,
    visibility: Visibility = GM_ONLY,
  ): RelationshipRecord => ({
    ...envelope(id, owner.id),
    type: 'relationship',
    name: kind,
    visibility,
    sourceEntityId: source,
    targetEntityId: target,
    kind,
  });
  const linkVia = async (
    source: string,
    target: string,
    kind: string,
    visibility: Visibility = GM_ONLY,
  ) => {
    const id = crypto.randomUUID();
    const result = await upload(
      owner,
      RELATIONSHIP_REPLICA_TABLE,
      id,
      'insert',
      null,
      relationship(id, source, target, kind, visibility),
    );
    return { id, ...result };
  };
  const patch = (who: Who, resourceClass: string, id: string, payload: object) =>
    app.inject({
      method: 'PATCH',
      url: `/campaigns/${campaignId}/resources/${resourceClass}/${id}/visibility`,
      headers: who.headers,
      payload,
    });
  const auditRows = (targetId: string) =>
    db`select action, target_type, origin_mutation_id, actor_user_id, before_value, after_value
      from audit_campaign_events where target_id = ${targetId}
      union all
      select action, target_type, origin_mutation_id, actor_user_id, before_value, after_value
      from audit_private_events where target_id = ${targetId}`;
  const stored = async (id: string) => {
    const [row] = await db`select visibility_mode, visibility_targets, version::int as version,
      deleted_at from content_entity_relationships where id = ${id}`;
    return row;
  };
  /** The compiled `entity_relationship` stream rule, PostgreSQL rendering, on the real tables. */
  const relationshipQuery =
    compileProviderQueries(
      registerResourcePolicies(new ResourcePolicyRegistry()),
      SYNC_RULE_BINDINGS,
      {
        source: 'identity_campaign_memberships',
        userColumn: 'user_id',
        campaignColumn: 'campaign_id',
        roleColumn: 'role',
        removedAtColumn: 'removed_at',
      },
      POSTGRES_DIALECT,
    ).find((item) => item.resourceClass === 'entity_relationship')?.query ?? '';
  const replicated = async (who: Who) =>
    (await db.unsafe<{ id: string; campaign_id: string }[]>(relationshipQuery, [who.id]))
      .filter((row) => row.campaign_id === campaignId)
      .map((row) => row.id);
  const invariantHolds = async () => {
    const rows = await db`select r.visibility_mode as r_mode, r.visibility_targets as r_targets,
        s.visibility_mode as s_mode, s.visibility_targets as s_targets,
        t.visibility_mode as t_mode, t.visibility_targets as t_targets
      from content_entity_relationships r
      join content_entities s on s.campaign_id = r.campaign_id and s.id = r.source_entity_id
      join content_entities t on t.campaign_id = r.campaign_id and t.id = r.target_entity_id
      where r.campaign_id = ${campaignId} and r.deleted_at is null`;
    const visibility = (mode: string, targets: string[]): Visibility =>
      mode === 'players' ? { mode, playerIds: targets } : ({ mode } as Visibility);
    return rows.every((row) =>
      isWithin(
        visibility(row.r_mode, row.r_targets),
        visibility(row.s_mode, row.s_targets),
        visibility(row.t_mode, row.t_targets),
      ),
    );
  };
  return {
    app,
    owner,
    casey,
    campaignId,
    upload,
    createEntity,
    relationship,
    linkVia,
    patch,
    auditRows,
    stored,
    replicated,
    invariantHolds,
  };
}

describe.skipIf(!available)('relationships through the runtime (PostgreSQL)', () => {
  test('sync link writes: accepted with one audit event; update, self, note, and unknown kind refused', async () => {
    const h = await harness();
    try {
      const smuggler = await h.createEntity('Smuggler', EVERYONE);
      const guild = await h.createEntity('River Guild', EVERYONE, 'faction');
      const member = await h.linkVia(smuggler, guild, 'member_of');
      expect(member.outcome).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
      const events = await h.auditRows(member.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'entity.relationship_created',
        target_type: 'entity_relationship',
        origin_mutation_id: member.mutationId,
        after_value: { kind: 'member_of', sourceEntityId: smuggler, targetEntityId: guild },
      });
      // A new relationship is GM-only: players see both NPCs but not the link.
      expect(await h.replicated(h.casey)).toEqual([]);
      expect(await h.replicated(h.owner)).toEqual([member.id]);

      const noteId = crypto.randomUUID();
      const now = new Date().toISOString();
      const note = await h.upload(h.casey, PERSONAL_NOTE_REPLICA_TABLE, noteId, 'insert', null, {
        id: noteId,
        campaignId: h.campaignId,
        type: 'note',
        name: 'Private',
        tags: [],
        metadata: {},
        visibility: { mode: 'players', playerIds: [h.casey.id] },
        version: 1,
        createdAt: now,
        createdBy: h.casey.id,
        updatedAt: now,
        updatedBy: h.casey.id,
        authorUserId: h.casey.id,
        body: '',
      });
      expect(note.outcome).toMatchObject({ status: 'accepted' });
      const refusals = [
        await h.linkVia(smuggler, smuggler, 'knows'),
        await h.linkVia(smuggler, noteId, 'knows'),
        await h.linkVia(smuggler, guild, 'hates'),
        await h.linkVia(smuggler, guild, 'member_of'),
        await h.upload(
          h.owner,
          RELATIONSHIP_REPLICA_TABLE,
          member.id,
          'update',
          1,
          h.relationship(member.id, smuggler, guild, 'knows'),
        ),
      ];
      for (const refusal of refusals) {
        expect(refusal.outcome).toMatchObject({
          status: 'error',
          code: 'invalid_payload',
          retryable: false,
        });
        expect(await h.auditRows(refusal.mutationId)).toHaveLength(0);
      }
      // A player cannot link.
      const byPlayer = await h.upload(
        h.casey,
        RELATIONSHIP_REPLICA_TABLE,
        crypto.randomUUID(),
        'insert',
        null,
        h.relationship(crypto.randomUUID(), guild, smuggler, 'knows'),
      );
      expect(byPlayer.outcome).toMatchObject({ status: 'error' });
      const unlink = await h.upload(
        h.owner,
        RELATIONSHIP_REPLICA_TABLE,
        member.id,
        'tombstone',
        1,
        h.relationship(member.id, smuggler, guild, 'member_of'),
      );
      expect(unlink.outcome).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
      expect((await h.auditRows(member.id)).map((row) => row.action).sort()).toEqual([
        'entity.relationship_created',
        'entity.relationship_deleted',
      ]);
    } finally {
      await h.app.close();
    }
  });

  test('a reveal beyond an endpoint is 400 incompatible_visibility, unchanged, unaudited (B-1)', async () => {
    const h = await harness();
    try {
      const merchant = await h.createEntity('Merchant', EVERYONE);
      const smuggler = await h.createEntity('Smuggler', GM_ONLY);
      const link = await h.linkVia(merchant, smuggler, 'knows');
      const response = await h.patch(h.owner, 'entity_relationship', link.id, {
        operation: 'reveal',
        target: { mode: 'everyone' },
        expectedVersion: 1,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'validation_failed',
        details: { reason: 'incompatible_visibility' },
      });
      expect(await h.stored(link.id)).toMatchObject({ visibility_mode: 'gm_only', version: 1 });
      expect((await h.auditRows(link.id)).map((row) => row.action)).toEqual([
        'entity.relationship_created',
      ]);
      // A player gets the safe 404, as for any reveal.
      const byPlayer = await h.patch(h.casey, 'entity_relationship', link.id, {
        operation: 'reveal',
        target: { mode: 'everyone' },
        expectedVersion: 1,
      });
      expect(byPlayer.statusCode).toBe(404);
      expect(await h.invariantHolds()).toBe(true);
    } finally {
      await h.app.close();
    }
  });

  test('hiding an endpoint hides its relationships: narrowed, audited, gone from the player stream (D-07)', async () => {
    const h = await harness();
    try {
      const traveler = await h.createEntity('Traveler', EVERYONE);
      const road = await h.createEntity('Old Road', EVERYONE, 'location');
      const livesAt = await h.linkVia(traveler, road, 'lives_at', EVERYONE);
      expect(livesAt.outcome).toMatchObject({ status: 'accepted' });
      expect(await h.replicated(h.casey)).toEqual([livesAt.id]);
      const hidden = await h.patch(h.owner, 'campaign_entity', traveler, {
        operation: 'unreveal',
        target: { mode: 'everyone' },
        expectedVersion: 1,
      });
      expect(hidden.statusCode).toBe(200);
      expect(await h.stored(livesAt.id)).toMatchObject({ visibility_mode: 'gm_only', version: 2 });
      const narrowing = (await h.auditRows(livesAt.id)).filter(
        (row) => row.action === 'visibility.unrevealed',
      );
      expect(narrowing).toHaveLength(1);
      expect(narrowing[0]).toMatchObject({
        target_type: 'entity_relationship',
        actor_user_id: h.owner.id,
        before_value: { visibility: { mode: 'everyone' }, version: 1 },
        after_value: { visibility: { mode: 'gm_only' }, version: 2 },
      });
      expect(await h.replicated(h.casey)).toEqual([]);
      expect(await h.replicated(h.owner)).toEqual([livesAt.id]);
      expect(await h.invariantHolds()).toBe(true);
    } finally {
      await h.app.close();
    }
  });

  test('the relationships route lists both directions; a deleted endpoint is a broken link', async () => {
    const h = await harness();
    try {
      const guard = await h.createEntity('Guard', EVERYONE);
      const village = await h.createEntity('Village', EVERYONE, 'location');
      const spy = await h.createEntity('Spy', GM_ONLY);
      const livesAt = await h.linkVia(guard, village, 'lives_at', EVERYONE);
      const watches = await h.linkVia(spy, village, 'knows');
      const list = async (who: Who, id: string) => {
        const response = await h.app.inject({
          method: 'GET',
          url: `/campaigns/${h.campaignId}/entities/${id}/relationships`,
          headers: who.headers,
        });
        return {
          status: response.statusCode,
          items: response.statusCode === 200 ? (response.json() as { items: unknown[] }).items : [],
          body: response.body,
        };
      };
      const gmView = await list(h.owner, village);
      expect(gmView.items).toHaveLength(2);
      expect(gmView.items).toContainEqual(
        expect.objectContaining({
          id: livesAt.id,
          kind: 'lives_at',
          name: 'lives at',
          sourceEntityId: guard,
          targetEntityId: village,
          other: expect.objectContaining({ id: guard, name: 'Guard', deleted: false }),
        }),
      );
      const playerView = await list(h.casey, village);
      expect(playerView.items).toHaveLength(1);
      expect(playerView.body).not.toContain(spy);
      expect(playerView.body).not.toContain(watches.id);
      // Delete Guard: the relationship survives as a broken link.
      const removed = await h.upload(h.owner, ENTITY_REPLICA_TABLE, guard, 'tombstone', 1, {});
      expect(removed.outcome).toMatchObject({ status: 'accepted' });
      expect(await h.stored(livesAt.id)).toMatchObject({ version: 1, deleted_at: null });
      for (const who of [h.owner, h.casey]) {
        const view = await list(who, village);
        expect(view.items).toContainEqual(
          expect.objectContaining({ id: livesAt.id, other: { deleted: true } }),
        );
      }
      // The deleted entity itself and a hidden one are the safe 404.
      expect((await list(h.casey, guard)).status).toBe(404);
      expect((await list(h.casey, spy)).status).toBe(404);
      expect(await h.invariantHolds()).toBe(true);
    } finally {
      await h.app.close();
    }
  });
});
