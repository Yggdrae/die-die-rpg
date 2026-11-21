import { afterAll, describe, expect, test } from 'bun:test';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import {
  CAMPAIGN_ENTITY_CLASS,
  CONTENT_SYNC_FEATURE_ID,
  ENTITY_RELATIONSHIP_CLASS,
  ENTITY_REPLICA_TABLE,
  type EntityRecord,
  PERSONAL_NOTE_CLASS,
  PERSONAL_NOTE_REPLICA_TABLE,
  type PersonalNoteRecord,
  RELATIONSHIP_REPLICA_TABLE,
  type RelationshipRecord,
  relationshipBoundViolations,
} from '@rpg/content';
import {
  connectContentDatabase,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
  PostgresRelationshipRepository,
  relationshipBoundRows,
} from '@rpg/content/postgres';
import type { Role, Visibility } from '@rpg/contracts';
import { FIXTURE_ENTITIES, FIXTURE_SYSTEM_DEFINITION, ITEMS, LOCATIONS, NPCS } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';
import { registerResourcePolicies } from '../sync/sync-rules.ts';

/**
 * Feature 16 task 16: content security acceptance on PostgreSQL through the real composition
 * root. The sandbox campaign (`PRD.md` s.82: five locations, six NPCs, five items) is written only
 * through the production paths (`POST /sync/mutations` and the feature 04 Visibility route, hold
 * acquire), including endpoint narrowing (D-07), tombstones, personal notes, and holds; then every
 * configured PowerSync stream query (`infra/powersync/sync-config.yaml`, verbatim, requester bound
 * as `$1`) runs against the real tables for each requester and must return exactly the rows the
 * feature 04 decision allows: owner, gm, assistant_gm, player A, player B, removed gm, non-member,
 * and the owner of another campaign. The live PowerSync counterpart is in
 * `sync-config.powersync.integration.test.ts`. Content, hold and receipt rows are deleted; audit
 * rows are append-only and stay, as do users and campaigns (as in earlier suites).
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
    await sql`select 1 from content_entities, content_entity_relationships, sync_long_text_holds
      limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];

afterAll(async () => {
  if (available && campaigns.length > 0) {
    await db`delete from sync_long_text_holds where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from content_entity_relationships where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from content_entities where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from content_personal_notes where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from sync_mutation_receipts where campaign_id = any(${campaigns}::uuid[])`;
  }
  await sql?.end({ timeout: 1 });
});

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

/** Every configured stream query and the table it reads (as the drift gate parses them). */
function streamQueries(yaml: string): { readonly table: string; readonly query: string }[] {
  const parsed = Bun.YAML.parse(yaml) as {
    readonly streams?: Record<string, { readonly query?: string; readonly queries?: string[] }>;
  };
  return Object.values(parsed.streams ?? {}).flatMap((value) =>
    [...(value.query === undefined ? [] : [value.query]), ...(value.queries ?? [])].map(
      (query) => ({
        table: (/\bFROM\s+([a-z_][a-z0-9_]*)/i.exec(query)?.[1] ?? '').toLowerCase(),
        query,
      }),
    ),
  );
}

/**
 * A configured PowerSync query as PostgreSQL (same rewrite as `sync-config.integration.test.ts`):
 * requester as `$1`, JSON-array value sets as tuples, `auth.user_id() IN <json column>` as
 * containment.
 */
function toPostgres(query: string): string {
  return query
    .replace(
      /auth\.user_id\(\) IN ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/g,
      (_match, column: string) => `${column} @> jsonb_build_array($1::uuid)`,
    )
    .replaceAll('auth.user_id()', '$1::uuid')
    .replace(
      /IN '(\[[^']*\])'/g,
      (_match, values: string) =>
        `IN (${(JSON.parse(values) as string[]).map((value) => `'${value}'`).join(', ')})`,
    );
}

const REPLICATED = [
  'content_entities',
  'content_entity_relationships',
  'content_personal_notes',
  'sync_long_text_holds',
] as const;
type Replicated = (typeof REPLICATED)[number];

type Who = { readonly id: string; readonly headers: Record<string, string> };
let sequence = 0;

async function runtime() {
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
      payload: { username: `sec_${suffix}_${counter}`, password: 'correct horse battery staple' },
    });
    expect(account.statusCode).toBe(200);
    const raw = account.headers['set-cookie'];
    return {
      id: (JSON.parse(account.body) as { user: { id: string } }).user.id,
      headers: { cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '', origin },
    };
  };
  const createCampaign = async (owner: Who) => {
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
        name: 'Security acceptance',
        description: '',
      },
    });
    expect(created.statusCode).toBe(201);
    return campaignId;
  };
  const invite = async (owner: Who, campaignId: string, member: Who, role: Role) => {
    const invited = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/invitations`,
      headers: owner.headers,
      payload: { targetRole: role },
    });
    expect(invited.statusCode).toBe(201);
    const accepted = await app.inject({
      method: 'POST',
      url: `/invitations/${(invited.json() as { token: string }).token}/accept`,
      headers: member.headers,
    });
    expect(accepted.statusCode).toBe(200);
  };
  const upload = async (
    who: Who,
    campaignId: string,
    table: string,
    recordId: string,
    operation: 'insert' | 'update' | 'tombstone',
    expectedVersion: number | null,
    payload: unknown,
  ) => {
    sequence += 1;
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
            mutationId: crypto.randomUUID(),
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
    return (response.json() as { outcomes: Record<string, unknown>[] }).outcomes[0];
  };
  const patch = async (
    who: Who,
    campaignId: string,
    resourceClass: string,
    id: string,
    payload: object,
  ) => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/campaigns/${campaignId}/resources/${resourceClass}/${id}/visibility`,
      headers: who.headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { version: number; visibility: Visibility };
  };
  return { app, signUp, createCampaign, invite, upload, patch };
}

function envelope(id: string, campaignId: string, userId: string) {
  const now = new Date().toISOString();
  return {
    id,
    campaignId,
    tags: [],
    metadata: {},
    version: 1,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
    updatedBy: userId,
  };
}

describe.skipIf(!available)('feature 16 security acceptance (runtime + PostgreSQL)', () => {
  test('every requester replicates exactly the feature 04 decision over the sandbox campaign', async () => {
    const h = await runtime();
    try {
      const owner = await h.signUp();
      const gm = await h.signUp();
      const assistantGm = await h.signUp();
      const playerA = await h.signUp();
      const playerB = await h.signUp();
      const removedGm = await h.signUp();
      const nonMember = await h.signUp();
      const otherOwner = await h.signUp();
      const campaign = await h.createCampaign(owner);
      const otherCampaign = await h.createCampaign(otherOwner);
      await h.invite(owner, campaign, gm, 'gm');
      await h.invite(owner, campaign, assistantGm, 'assistant_gm');
      await h.invite(owner, campaign, playerA, 'player');
      await h.invite(owner, campaign, playerB, 'player');
      await h.invite(owner, campaign, removedGm, 'gm');

      // The sandbox entities, written by every GM role (D-05), all gm_only at create (FR-010).
      const authors = [gm, assistantGm, owner, removedGm];
      const ids = new Map<string, { id: string; version: number }>();
      for (const [index, fixture] of FIXTURE_ENTITIES.entries()) {
        const author = authors[index % authors.length] as Who;
        const id = crypto.randomUUID();
        const record: EntityRecord = {
          ...envelope(id, campaign, author.id),
          type: fixture.type,
          name: fixture.name,
          tags: fixture.tags,
          visibility: { mode: 'gm_only' },
          summary: `About ${fixture.name}`,
          description: '',
          fields: { 'True name': `secret of ${fixture.name}` },
        };
        expect(
          await h.upload(author, campaign, ENTITY_REPLICA_TABLE, id, 'insert', null, record),
        ).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
        ids.set(fixture.id, { id, version: 1 });
      }
      const entity = (fixtureId: string) => ids.get(fixtureId) as { id: string; version: number };
      const reveal = async (
        resourceClass: string,
        ref: { id: string; version: number },
        to: Visibility,
      ) => {
        const changed = await h.patch(gm, campaign, resourceClass, ref.id, {
          operation: 'reveal',
          target: to,
          expectedVersion: ref.version,
        });
        ref.version = changed.version;
      };
      // Reveal per the fixture's Visibility (player A only for the Weathered Letter).
      for (const fixture of FIXTURE_ENTITIES) {
        if (fixture.visibility.mode === 'gm_only') continue;
        await reveal(
          CAMPAIGN_ENTITY_CLASS,
          entity(fixture.id),
          fixture.visibility.mode === 'players'
            ? { mode: 'players', playerIds: [playerA.id] }
            : { mode: 'everyone' },
        );
      }
      // The other campaign: one revealed entity no member of this campaign may receive.
      const elsewhere = crypto.randomUUID();
      expect(
        await h.upload(otherOwner, otherCampaign, ENTITY_REPLICA_TABLE, elsewhere, 'insert', null, {
          ...envelope(elsewhere, otherCampaign, otherOwner.id),
          type: 'npc',
          name: 'Stranger',
          visibility: { mode: 'gm_only' },
          summary: '',
          description: '',
          fields: {},
        } satisfies EntityRecord),
      ).toMatchObject({ status: 'accepted' });

      // Links (gm_only at create), some revealed within their endpoints.
      const link = async (source: string, target: string, kind: string) => {
        const id = crypto.randomUUID();
        const record: RelationshipRecord = {
          ...envelope(id, campaign, gm.id),
          type: 'relationship',
          name: kind,
          visibility: { mode: 'gm_only' },
          sourceEntityId: entity(source).id,
          targetEntityId: entity(target).id,
          kind,
        };
        expect(
          await h.upload(gm, campaign, RELATIONSHIP_REPLICA_TABLE, id, 'insert', null, record),
        ).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
        return { id, version: 1 };
      };
      const livesAt = await link(NPCS.merchant, LOCATIONS.village, 'lives_at');
      await reveal(ENTITY_RELATIONSHIP_CLASS, livesAt, { mode: 'everyone' });
      const hiddenLink = await link(NPCS.smuggler, LOCATIONS.abandonedWarehouse, 'knows');
      const letterAt = await link(ITEMS.weatheredLetter, LOCATIONS.oldRoad, 'located_at');
      await reveal(ENTITY_RELATIONSHIP_CLASS, letterAt, {
        mode: 'players',
        playerIds: [playerA.id],
      });
      const narrowed = await link(NPCS.traveler, LOCATIONS.oldRoad, 'located_at');
      await reveal(ENTITY_RELATIONSHIP_CLASS, narrowed, { mode: 'everyone' });
      const seenLinkTombstone = await link(NPCS.guard, LOCATIONS.village, 'located_at');
      await reveal(ENTITY_RELATIONSHIP_CLASS, seenLinkTombstone, { mode: 'everyone' });
      const unseenLinkTombstone = await link(NPCS.banditLeader, LOCATIONS.forestCamp, 'located_at');
      const brokenLink = await link(ITEMS.supplyCrate, LOCATIONS.tradingPost, 'located_at');
      await reveal(ENTITY_RELATIONSHIP_CLASS, brokenLink, { mode: 'everyone' });

      // D-07 option A: hiding the Traveler narrows its revealed link in the same transaction.
      await h.patch(gm, campaign, CAMPAIGN_ENTITY_CLASS, entity(NPCS.traveler).id, {
        operation: 'unreveal',
        target: { mode: 'everyone' },
        expectedVersion: entity(NPCS.traveler).version,
      });

      // Tombstones: a revealed entity (seen) and a gm_only one (unseen); two links likewise.
      const tombstone = async (table: string, ref: { id: string; version: number }) => {
        const [row] =
          table === ENTITY_REPLICA_TABLE
            ? await db`select * from content_entities where id = ${ref.id}`
            : await db`select * from content_entity_relationships where id = ${ref.id}`;
        const version = Number(row?.version);
        expect(
          await h.upload(gm, campaign, table, ref.id, 'tombstone', version, {
            id: ref.id,
            version: version + 1,
          }),
        ).toMatchObject({ status: 'accepted' });
      };
      await tombstone(ENTITY_REPLICA_TABLE, entity(ITEMS.supplyCrate));
      await tombstone(ENTITY_REPLICA_TABLE, entity(ITEMS.brokenSeal));
      await tombstone(RELATIONSHIP_REPLICA_TABLE, seenLinkTombstone);
      await tombstone(RELATIONSHIP_REPLICA_TABLE, unseenLinkTombstone);

      // Personal notes (players only, D-06): two of player A's (one deleted), one of player B's.
      const note = async (author: Who, name: string) => {
        const id = crypto.randomUUID();
        const record: PersonalNoteRecord = {
          ...envelope(id, campaign, author.id),
          type: 'note',
          name,
          visibility: { mode: 'players', playerIds: [author.id] },
          authorUserId: author.id,
          body: `${name} body`,
        };
        expect(
          await h.upload(author, campaign, PERSONAL_NOTE_REPLICA_TABLE, id, 'insert', null, record),
        ).toMatchObject({ status: 'accepted' });
        return id;
      };
      const noteA = await note(playerA, 'Elder lied');
      const deletedNoteA = await note(playerA, 'Wrong guess');
      expect(
        await h.upload(
          playerA,
          campaign,
          PERSONAL_NOTE_REPLICA_TABLE,
          deletedNoteA,
          'tombstone',
          1,
          {
            id: deletedNoteA,
            version: 2,
          },
        ),
      ).toMatchObject({ status: 'accepted' });
      const noteB = await note(playerB, 'Rowan suspects the guard');

      // Holds: a GM on a hidden entity and on a revealed one, player A on their own note.
      const acquire = async (
        who: Who,
        resourceClass: string,
        recordId: string,
        fieldPath: string,
      ) => {
        const response = await h.app.inject({
          method: 'POST',
          url: `/sync/holds/${campaign}/acquire`,
          headers: who.headers,
          payload: { resourceClass, recordId, fieldPath },
        });
        expect(response.statusCode).toBe(200);
        expect((response.json() as { acquired: boolean }).acquired).toBe(true);
      };
      await acquire(gm, CAMPAIGN_ENTITY_CLASS, entity(NPCS.smuggler).id, 'description');
      await acquire(owner, CAMPAIGN_ENTITY_CLASS, entity(LOCATIONS.village).id, 'description');
      await acquire(playerA, PERSONAL_NOTE_CLASS, noteA, 'body');

      // The removed GM leaves after writing; their device must receive nothing more.
      const removed = await h.app.inject({
        method: 'DELETE',
        url: `/campaigns/${campaign}/members/${removedGm.id}`,
        headers: owner.headers,
      });
      expect(removed.statusCode).toBeLessThan(300);

      // ---- The feature 04 decision over the authoritative rows -------------------------------
      if (databaseUrl === undefined) throw new Error('database unavailable');
      const content = connectContentDatabase(databaseUrl, { max: 1 });
      try {
        const entities = new PostgresEntityRepository(content.db);
        const relationships = new PostgresRelationshipRepository(content.db);
        const notes = new PostgresPersonalNoteRepository(content.db);
        const rows = {
          entities: [
            ...(await entities.list(campaign, { includeDeleted: true })),
            ...(await entities.list(otherCampaign, { includeDeleted: true })),
          ],
          relationships: await relationships.list(campaign, { includeDeleted: true }),
          notes: [
            ...(await notes.listByAuthor(campaign, playerA.id, { includeDeleted: true })),
            ...(await notes.listByAuthor(campaign, playerB.id, { includeDeleted: true })),
          ],
          holds: await db<
            { id: string; campaign_id: string; resource_class: string; holder: string }[]
          >`
            select campaign_id || ':' || resource_class || ':' || record_id || ':' || field_path
              as id, campaign_id, resource_class, holder_user_id as holder
            from sync_long_text_holds where campaign_id = any(${[campaign, otherCampaign]}::uuid[])`,
        };
        expect(rows.entities).toHaveLength(FIXTURE_ENTITIES.length + 1);
        expect(rows.relationships).toHaveLength(7);
        expect(rows.notes).toHaveLength(3);
        expect(rows.holds).toHaveLength(3);
        // The write path kept the D-07 bound on every live link.
        expect(
          relationshipBoundViolations(await relationshipBoundRows(content.db, campaign)),
        ).toEqual([]);

        const roles = new Map<string, Map<string, Role>>([
          [
            campaign,
            new Map<string, Role>([
              [owner.id, 'owner'],
              [gm.id, 'gm'],
              [assistantGm.id, 'assistant_gm'],
              [playerA.id, 'player'],
              [playerB.id, 'player'],
            ]),
          ],
          [otherCampaign, new Map<string, Role>([[otherOwner.id, 'owner']])],
        ]);
        const decider = new AuthorizationService(
          registerResourcePolicies(new ResourcePolicyRegistry()),
        );
        const reads = (
          userId: string,
          campaignId: string,
          resourceClass: string,
          visibility: Visibility,
          authorUserId?: string,
        ) => {
          const role = roles.get(campaignId)?.get(userId);
          return (
            role !== undefined &&
            decider.decide({ userId, campaignId, role }, 'read', {
              campaignId,
              resourceClass,
              resourceId: campaignId,
              visibility,
              version: 1,
              ...(authorUserId === undefined ? {} : { authorUserId }),
            }).allowed
          );
        };
        const gmRoles: readonly Role[] = ['owner', 'gm', 'assistant_gm'];
        const expected = (userId: string): Record<Replicated, string[]> => ({
          content_entities: rows.entities
            .filter((row) => reads(userId, row.campaignId, CAMPAIGN_ENTITY_CLASS, row.visibility))
            .map((row) => row.id)
            .sort(),
          content_entity_relationships: rows.relationships
            .filter((row) =>
              reads(userId, row.campaignId, ENTITY_RELATIONSHIP_CLASS, row.visibility),
            )
            .map((row) => row.id)
            .sort(),
          content_personal_notes: rows.notes
            .filter((row) =>
              reads(userId, row.campaignId, PERSONAL_NOTE_CLASS, row.visibility, row.authorUserId),
            )
            .map((row) => row.id)
            .sort(),
          // A hold names its record (B-3): entity holds reach the GM roles, note holds the holder.
          sync_long_text_holds: rows.holds
            .filter((row) => {
              const role = roles.get(row.campaign_id)?.get(userId);
              if (role === undefined) return false;
              if (row.resource_class === PERSONAL_NOTE_CLASS) return row.holder === userId;
              return gmRoles.includes(role);
            })
            .map((row) => row.id)
            .sort(),
        });

        // ---- What each requester's device would replicate --------------------------------------
        const configured = streamQueries(await Bun.file(SYNC_CONFIG).text()).filter((item) =>
          (REPLICATED as readonly string[]).includes(item.table),
        );
        expect(configured.map((item) => item.table).sort()).toEqual([...REPLICATED].sort());
        const ours = new Set<string>([campaign, otherCampaign]);
        const replicate = async (userId: string) => {
          const result = {} as Record<Replicated, string[]>;
          const payload: string[] = [];
          for (const item of configured) {
            const found = await db.unsafe<Record<string, unknown>[]>(toPostgres(item.query), [
              userId,
            ]);
            const mine = found.filter((row) => ours.has(String(row.campaign_id)));
            result[item.table as Replicated] = mine.map((row) => String(row.id)).sort();
            payload.push(JSON.stringify(mine));
          }
          return { result, payload: payload.join('\n') };
        };
        const requesters = {
          owner,
          gm,
          assistantGm,
          playerA,
          playerB,
          removedGm,
          nonMember,
          otherOwner,
        };
        const replicas = new Map<string, Awaited<ReturnType<typeof replicate>>>();
        for (const [name, who] of Object.entries(requesters)) {
          const replica = await replicate(who.id);
          replicas.set(name, replica);
          expect({ name, ...replica.result }).toEqual({ name, ...expected(who.id) });
        }

        // ---- Explicit zero-leak statements for the player replicas -----------------------------
        const hiddenEntities = rows.entities
          .filter((row) => row.visibility.mode === 'gm_only')
          .map((row) => row.id);
        const unseenTombstone = entity(ITEMS.brokenSeal).id;
        const hiddenLinks = [hiddenLink.id, unseenLinkTombstone.id, narrowed.id];
        const gmHolds = rows.holds.filter((row) => row.resource_class !== PERSONAL_NOTE_CLASS);
        for (const [name, other] of [
          ['playerA', noteB],
          ['playerB', noteA],
        ] as const) {
          const replica = replicas.get(name);
          if (replica === undefined) throw new Error('replica missing');
          for (const hidden of [...hiddenEntities, unseenTombstone, ...hiddenLinks, other]) {
            expect({ name, leaked: replica.payload.includes(hidden) }).toEqual({
              name,
              leaked: false,
            });
          }
          for (const hold of gmHolds) expect(replica.payload).not.toContain(hold.id);
          expect(replica.payload).not.toContain('secret of Smuggler');
        }
        const a = replicas.get('playerA')?.result;
        const b = replicas.get('playerB')?.result;
        // The letter and its bounded link reach player A only; seen tombstones reach both.
        expect(a?.content_entities).toContain(entity(ITEMS.weatheredLetter).id);
        expect(b?.content_entities).not.toContain(entity(ITEMS.weatheredLetter).id);
        expect(a?.content_entity_relationships).toEqual(
          [livesAt.id, letterAt.id, seenLinkTombstone.id, brokenLink.id].sort(),
        );
        expect(b?.content_entity_relationships).toEqual(
          [livesAt.id, seenLinkTombstone.id, brokenLink.id].sort(),
        );
        expect(a?.content_entities).toContain(entity(ITEMS.supplyCrate).id);
        expect(a?.content_personal_notes).toEqual([noteA, deletedNoteA].sort());
        expect(b?.content_personal_notes).toEqual([noteB]);
        // GM roles: every entity and link, no personal note, no note hold.
        for (const name of ['owner', 'gm', 'assistantGm']) {
          const replica = replicas.get(name);
          expect(replica?.result.content_personal_notes).toEqual([]);
          expect(replica?.result.content_entities).toHaveLength(FIXTURE_ENTITIES.length);
          expect(replica?.payload).not.toContain(noteA);
          expect(replica?.payload).not.toContain(noteB);
        }
        // Removed GM and non-member: nothing; the other campaign's owner: only that campaign.
        for (const name of ['removedGm', 'nonMember']) {
          expect(Object.values(replicas.get(name)?.result ?? {}).flat()).toEqual([]);
        }
        expect(replicas.get('otherOwner')?.result.content_entities).toEqual([elsewhere]);
        expect(replicas.get('otherOwner')?.payload).not.toContain(campaign);

        // The read API agrees with the replica for live entities (BDD "A player's list contains
        // only what the player may see").
        for (const [name, who] of Object.entries(requesters)) {
          const listed = await h.app.inject({
            method: 'GET',
            url: `/campaigns/${campaign}/entities?limit=200`,
            headers: { cookie: who.headers.cookie ?? '' },
          });
          const live = rows.entities
            .filter((row) => row.campaignId === campaign && row.deletedAt === undefined)
            .filter((row) => reads(who.id, campaign, CAMPAIGN_ENTITY_CLASS, row.visibility))
            .map((row) => row.id)
            .sort();
          if (roles.get(campaign)?.has(who.id) === true) {
            expect({
              name,
              ids: (listed.json() as { items: { id: string }[] }).items
                .map((item) => item.id)
                .sort(),
            }).toEqual({ name, ids: live });
          } else {
            expect({ name, status: listed.statusCode }).toEqual({ name, status: 404 });
          }
        }
      } finally {
        await content.close();
      }
    } finally {
      await h.app.close();
    }
  }, 120_000);
});
