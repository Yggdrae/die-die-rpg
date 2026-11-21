import { afterAll, describe, expect, test } from 'bun:test';
import {
  AuthorizationService,
  ResourcePolicyRegistry,
  runVisibilityAdapterContract,
} from '@rpg/authorization';
import type { ActorRef, Visibility } from '@rpg/contracts';
import { sql } from 'drizzle-orm';
import {
  type ContentAuditEvent,
  type ContentInvalidReason,
  EntityService,
  RelationshipService,
} from './application.ts';
import { relationshipBoundViolations } from './domain.ts';
import {
  connectContentDatabase,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
  PostgresRelationshipRepository,
  relationshipBoundRows,
} from './infra/postgres/repository.ts';
import {
  CAMPAIGN_ENTITY_POLICY,
  ENTITY_RELATIONSHIP_POLICY,
  PERSONAL_NOTE_POLICY,
} from './policies.ts';
import {
  EntityVisibilityAdapter,
  type NarrowingAuditRecorder,
  narrowingOriginId,
  RelationshipVisibilityAdapter,
} from './visibility-adapters.ts';

/**
 * Feature 16 tasks 08 and 09 on PostgreSQL: the relationship table's CHECKs and keys, the
 * `entity_relationship` adapter (feature 04 contract incl. the B-1 refusal), relationship writes,
 * endpoint narrowing (D-07 option A) with its audit, broken links after an endpoint delete, and a
 * two-connection race between a link create and an endpoint narrowing. After every scenario the
 * invariant assertion finds no live relationship wider than its endpoints. Rows are deleted.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate = databaseUrl === undefined ? undefined : connectContentDatabase(databaseUrl);
const connection = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate.db.execute(sql`select 1 from content_entity_relationships limit 1`);
    return candidate;
  } catch {
    await candidate.close();
    return undefined;
  }
})();
const second =
  connection !== undefined && databaseUrl !== undefined
    ? connectContentDatabase(databaseUrl)
    : undefined;

const campaigns: string[] = [];
afterAll(async () => {
  if (connection !== undefined && campaigns.length > 0) {
    const ids = sql.join(
      campaigns.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await connection.db.execute(
      sql`delete from content_entity_relationships where campaign_id in (${ids})`,
    );
    await connection.db.execute(sql`delete from content_entities where campaign_id in (${ids})`);
    await connection.db.execute(
      sql`delete from content_personal_notes where campaign_id in (${ids})`,
    );
  }
  await second?.close();
  await connection?.close();
});

const registry = new ResourcePolicyRegistry();
registry.register(CAMPAIGN_ENTITY_POLICY);
registry.register(PERSONAL_NOTE_POLICY);
registry.register(ENTITY_RELATIONSHIP_POLICY);
const decider = new AuthorizationService(registry);
const EVERYONE: Visibility = { mode: 'everyone' };
const GM_ONLY: Visibility = { mode: 'gm_only' };

function db() {
  if (connection === undefined) throw new Error('database unavailable');
  return connection.db;
}

function fixture(database = db()) {
  const entities = new PostgresEntityRepository(database);
  const relationships = new PostgresRelationshipRepository(database);
  const narrowingEvents: Parameters<NarrowingAuditRecorder['recordWithin']>[1][] = [];
  const audit: NarrowingAuditRecorder = {
    recordWithin: async (_executor, submission) => {
      narrowingEvents.push(submission);
      return 'recorded';
    },
  };
  return {
    entities,
    relationships,
    narrowingEvents,
    entityAdapter: new EntityVisibilityAdapter(entities, { relationships, audit }),
    relationshipAdapter: new RelationshipVisibilityAdapter(relationships, entities),
    entityService: new EntityService({ entities, decider }),
    relationshipService: new RelationshipService({
      entities,
      relationships,
      decider,
      members: { isMember: async () => true },
    }),
  };
}

function campaign() {
  const campaignId = crypto.randomUUID();
  campaigns.push(campaignId);
  const gm: ActorRef = { userId: crypto.randomUUID(), campaignId, role: 'gm' };
  return { campaignId, gm };
}

async function entity(campaignId: string, visibility: Visibility, name = 'Probe') {
  const created = await new PostgresEntityRepository(db()).insert(db(), {
    id: crypto.randomUUID(),
    campaignId,
    type: 'npc',
    name,
    summary: '',
    description: '',
    tags: [],
    fields: {},
    metadata: {},
    visibility,
    actorUserId: crypto.randomUUID(),
  });
  if (!created.ok) throw new Error('entity seed failed');
  return created.record;
}

async function link(
  campaignId: string,
  source: string,
  target: string,
  visibility: Visibility = GM_ONLY,
  kind = 'knows',
) {
  const created = await new PostgresRelationshipRepository(db()).insert(db(), {
    id: crypto.randomUUID(),
    campaignId,
    sourceEntityId: source,
    targetEntityId: target,
    kind,
    visibility,
    actorUserId: crypto.randomUUID(),
  });
  if (!created.ok) throw new Error(`link seed failed: ${created.reason}`);
  return created.record;
}

async function violations(campaignId: string) {
  return relationshipBoundViolations(await relationshipBoundRows(db(), campaignId));
}

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && typeof current.code === 'string' && /^\d{5}$/.test(current.code)) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

describe.skipIf(connection === undefined)('content_entity_relationships (PostgreSQL)', () => {
  test('CHECKs and keys: self-link, live duplicate, foreign endpoint; a tombstoned duplicate does not block', async () => {
    const { campaignId, gm } = campaign();
    const a = await entity(campaignId, EVERYONE);
    const b = await entity(campaignId, EVERYONE);
    const foreign = await entity(crypto.randomUUID(), EVERYONE);
    campaigns.push(foreign.campaignId);
    const repository = new PostgresRelationshipRepository(db());
    const attempt = async (input: { source: string; target: string }) => {
      try {
        await db().execute(
          sql`insert into content_entity_relationships (id, campaign_id, source_entity_id,
            target_entity_id, kind, visibility_mode, created_by, updated_by)
            values (${crypto.randomUUID()}, ${campaignId}, ${input.source}, ${input.target},
            'knows', 'gm_only', ${gm.userId}, ${gm.userId})`,
        );
        return 'inserted';
      } catch (error) {
        return sqlState(error);
      }
    };
    expect(await attempt({ source: a.id, target: a.id })).toBe('23514');
    expect(await attempt({ source: a.id, target: foreign.id })).toBe('23503');
    const first = await link(campaignId, a.id, b.id);
    const duplicate = await repository.insert(db(), {
      id: crypto.randomUUID(),
      campaignId,
      sourceEntityId: a.id,
      targetEntityId: b.id,
      kind: 'knows',
      visibility: GM_ONLY,
      actorUserId: gm.userId,
    });
    expect(duplicate).toEqual({ ok: false, reason: 'duplicate' });
    expect(await attempt({ source: a.id, target: b.id })).toBe('23505');
    // Another kind between the same pair is a different link.
    await link(campaignId, a.id, b.id, GM_ONLY, 'owns');
    const removed = await repository.tombstone(db(), {
      campaignId,
      id: first.id,
      expectedVersion: 1,
      actorUserId: gm.userId,
    });
    expect(removed.ok).toBe(true);
    expect((await link(campaignId, a.id, b.id)).kind).toBe('knows');
    // An endpoint row cannot be physically removed while a relationship references it.
    let blocked: string | undefined;
    try {
      await db().execute(sql`delete from content_entities where id = ${a.id}`);
    } catch (error) {
      blocked = sqlState(error);
    }
    expect(blocked).toBe('23503');
    expect(await violations(campaignId)).toEqual([]);
  });

  test('entity_relationship adapter: feature 04 contract incl. the B-1 refusal (11 checks)', async () => {
    const f = fixture();
    const report = await runVisibilityAdapterContract({
      adapter: f.relationshipAdapter,
      seed: async ({ campaignId, visibility }) => {
        campaigns.push(campaignId);
        const source = await entity(campaignId, EVERYONE);
        const target = await entity(campaignId, EVERYONE);
        return (await link(campaignId, source.id, target.id, visibility)).id;
      },
      tombstone: async (campaignId, resourceId) => {
        const current = await f.relationships.get(campaignId, resourceId);
        if (current === undefined) throw new Error('tombstone target missing');
        const deleted = await f.relationships.tombstone(db(), {
          campaignId,
          id: resourceId,
          expectedVersion: current.version,
          actorUserId: crypto.randomUUID(),
        });
        if (!deleted.ok) throw new Error('tombstone failed');
      },
      invariantViolation: async (campaignId) => {
        // "A relationship cannot outrun its endpoints": Merchant everyone, Smuggler gm_only.
        const merchant = await entity(campaignId, EVERYONE, 'Merchant');
        const smuggler = await entity(campaignId, GM_ONLY, 'Smuggler');
        const relationship = await link(campaignId, merchant.id, smuggler.id);
        return { resourceId: relationship.id, visibility: EVERYONE };
      },
    });
    expect(report.resourceClass).toBe('entity_relationship');
    expect(report.checks).toHaveLength(11);
    expect(report.checks).toContain('invariant_refused');
    expect(report.checks).toContain('tombstone_excluded');
    expect(report.findings).toEqual([]);
  });

  test('a relationship is revealed on its own, within its endpoints', async () => {
    const { campaignId } = campaign();
    const f = fixture();
    const a = await entity(campaignId, EVERYONE);
    const b = await entity(campaignId, { mode: 'players', playerIds: [crypto.randomUUID()] });
    const relationship = await link(campaignId, a.id, b.id);
    const audits: string[] = [];
    const within = await f.relationshipAdapter.writeVisibility({
      campaignId,
      resourceId: relationship.id,
      expectedVersion: 1,
      visibility: b.visibility,
      recordAudit: async () => void audits.push('reveal'),
    });
    expect(within.ok && within.facts).toMatchObject({ visibility: b.visibility, version: 2 });
    const wider = await f.relationshipAdapter.writeVisibility({
      campaignId,
      resourceId: relationship.id,
      expectedVersion: 2,
      visibility: EVERYONE,
      recordAudit: async () => void audits.push('wider'),
    });
    expect(wider).toEqual({ ok: false, reason: 'invariant_violation' });
    expect(audits).toEqual(['reveal']);
    // The endpoints' own Visibility is unchanged.
    expect((await f.entities.get(campaignId, a.id))?.visibility).toEqual(EVERYONE);
    expect(await violations(campaignId)).toEqual([]);
  });

  test('hiding an endpoint narrows its relationships in the same transaction, one audit each (D-07)', async () => {
    const { campaignId, gm } = campaign();
    const f = fixture();
    const casey = crypto.randomUUID();
    const rowan = crypto.randomUUID();
    const traveler = await entity(campaignId, EVERYONE, 'Traveler');
    const road = await entity(campaignId, EVERYONE, 'Old Road');
    const inn = await entity(campaignId, {
      mode: 'players',
      playerIds: [casey, rowan].sort(),
    });
    const livesAt = await link(campaignId, traveler.id, road.id, EVERYONE, 'lives_at');
    const knows = await link(campaignId, inn.id, traveler.id, inn.visibility);
    const hidden = await link(campaignId, road.id, traveler.id, GM_ONLY, 'related_to');
    const removed = await link(campaignId, traveler.id, inn.id, GM_ONLY, 'owns');
    await f.relationships.tombstone(db(), {
      campaignId,
      id: removed.id,
      expectedVersion: 1,
      actorUserId: gm.userId,
    });
    let entityAudits = 0;
    const narrowed = await f.entityAdapter.writeVisibility({
      campaignId,
      resourceId: traveler.id,
      expectedVersion: 1,
      visibility: { mode: 'players', playerIds: [casey] },
      actor: gm,
      recordAudit: async () => {
        entityAudits += 1;
      },
    });
    expect(narrowed.ok).toBe(true);
    expect(entityAudits).toBe(1);
    expect(await f.relationships.get(campaignId, livesAt.id)).toMatchObject({
      visibility: { mode: 'players', playerIds: [casey] },
      version: 2,
      updatedBy: gm.userId,
    });
    expect(await f.relationships.get(campaignId, knows.id)).toMatchObject({
      visibility: { mode: 'players', playerIds: [casey] },
      version: 2,
    });
    // Already within: untouched, unaudited. Tombstoned: untouched.
    expect((await f.relationships.get(campaignId, hidden.id))?.version).toBe(1);
    expect(
      (await f.relationships.get(campaignId, removed.id, { includeDeleted: true }))?.version,
    ).toBe(2);
    expect(f.narrowingEvents.map((item) => item.event.targetId).sort()).toEqual(
      [livesAt.id, knows.id].sort(),
    );
    for (const item of f.narrowingEvents) {
      expect(item.event).toMatchObject({
        action: 'visibility.unrevealed',
        targetType: 'entity_relationship',
        actor: gm,
        after: { version: 2 },
      });
      expect(item.originMutationId).toBe(narrowingOriginId(item.event.targetId, 2));
      expect(item.targetVisibility).toEqual({ visibility: GM_ONLY });
    }
    // Hiding completely narrows to gm_only.
    await f.entityAdapter.writeVisibility({
      campaignId,
      resourceId: traveler.id,
      expectedVersion: 2,
      visibility: GM_ONLY,
      actor: gm,
      recordAudit: async () => undefined,
    });
    expect((await f.relationships.get(campaignId, livesAt.id))?.visibility).toEqual(GM_ONLY);
    expect(f.narrowingEvents).toHaveLength(4);
    expect(await violations(campaignId)).toEqual([]);
  });

  test('a narrowing without an attributable actor is refused whole; widening narrows nothing', async () => {
    const { campaignId, gm } = campaign();
    const f = fixture();
    const a = await entity(campaignId, EVERYONE);
    const b = await entity(campaignId, EVERYONE);
    const relationship = await link(campaignId, a.id, b.id, EVERYONE);
    let threw = false;
    try {
      await f.entityAdapter.writeVisibility({
        campaignId,
        resourceId: a.id,
        expectedVersion: 1,
        visibility: GM_ONLY,
        recordAudit: async () => undefined,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect((await f.entities.get(campaignId, a.id))?.visibility).toEqual(EVERYONE);
    expect((await f.relationships.get(campaignId, relationship.id))?.version).toBe(1);
    const c = await entity(campaignId, GM_ONLY);
    await link(campaignId, c.id, a.id);
    expect(
      (
        await f.entityAdapter.writeVisibility({
          campaignId,
          resourceId: c.id,
          expectedVersion: 1,
          visibility: EVERYONE,
          actor: gm,
          recordAudit: async () => undefined,
        })
      ).ok,
    ).toBe(true);
    expect(f.narrowingEvents).toEqual([]);
  });

  test('relationship writes: create, refusals, delete; endpoint delete keeps the broken link', async () => {
    const { campaignId, gm } = campaign();
    const f = fixture();
    const events: ContentAuditEvent[] = [];
    const audit = async (_transaction: unknown, event: ContentAuditEvent) => {
      events.push(event);
    };
    const smuggler = await entity(campaignId, EVERYONE, 'Smuggler');
    const guild = await entity(campaignId, EVERYONE, 'River Guild');
    const warehouse = await entity(campaignId, GM_ONLY, 'Abandoned Warehouse');
    const create = (input: Partial<Parameters<RelationshipService['create']>[1]>) =>
      f.relationshipService.create(
        gm,
        {
          campaignId,
          id: crypto.randomUUID(),
          sourceEntityId: smuggler.id,
          targetEntityId: guild.id,
          kind: 'member_of',
          ...input,
        },
        { audit },
      );
    const memberOf = await create({});
    expect(memberOf.ok && memberOf.value).toMatchObject({
      kind: 'member_of',
      name: 'member of',
      visibility: GM_ONLY,
      version: 1,
    });
    expect((await create({ targetEntityId: warehouse.id, kind: 'lives_at' })).ok).toBe(true);
    const note = crypto.randomUUID();
    await new PostgresPersonalNoteRepository(db()).insert(db(), {
      id: note,
      campaignId,
      authorUserId: gm.userId,
      name: 'Private',
      body: '',
      tags: [],
      metadata: {},
    });
    const foreign = await entity(crypto.randomUUID(), EVERYONE);
    campaigns.push(foreign.campaignId);
    const gone = await entity(campaignId, EVERYONE, 'Gone');
    await f.entityService.tombstone(gm, { campaignId, id: gone.id, expectedVersion: 1 });
    const refused: [Partial<Parameters<RelationshipService['create']>[1]>, ContentInvalidReason][] =
      [
        [{}, 'duplicate_relationship'],
        [{ targetEntityId: smuggler.id }, 'self_link'],
        [{ kind: 'hates' }, 'unknown_kind'],
        [{ targetEntityId: foreign.id }, 'invalid_endpoint'],
        [{ targetEntityId: gone.id }, 'invalid_endpoint'],
        [{ targetEntityId: note }, 'invalid_endpoint'],
        [{ targetEntityId: crypto.randomUUID() }, 'invalid_endpoint'],
        [
          { targetEntityId: warehouse.id, kind: 'knows', visibility: EVERYONE },
          'incompatible_visibility',
        ],
        [
          { kind: 'knows', visibility: { mode: 'party', partyIds: [crypto.randomUUID()] } },
          'invalid_visibility',
        ],
      ];
    for (const [input, reason] of refused) {
      expect({ input, result: await create(input) }).toEqual({
        input,
        result: { ok: false, error: { code: 'invalid_payload', reason } },
      });
    }
    // An explicit Visibility within the endpoints is kept.
    const revealed = await create({ kind: 'knows', visibility: EVERYONE });
    expect(revealed.ok && revealed.value.visibility).toEqual(EVERYONE);
    // Players never create links.
    expect(
      await f.relationshipService.create(
        { ...gm, role: 'player' },
        {
          campaignId,
          id: crypto.randomUUID(),
          sourceEntityId: guild.id,
          targetEntityId: smuggler.id,
          kind: 'knows',
        },
      ),
    ).toEqual({ ok: false, error: { code: 'not_found_or_forbidden' } });
    expect(events.map((event) => event.action)).toEqual([
      'entity.relationship_created',
      'entity.relationship_created',
      'entity.relationship_created',
    ]);

    // Deleting the endpoint changes no relationship (broken link, BR-004).
    if (!memberOf.ok) throw new Error('unreachable');
    await f.entityService.tombstone(gm, { campaignId, id: guild.id, expectedVersion: 1 });
    expect(await f.relationships.get(campaignId, memberOf.value.id)).toMatchObject({
      version: 1,
      visibility: GM_ONLY,
    });
    // Deleting the link touches only the link.
    const unlinked = await f.relationshipService.tombstone(
      gm,
      { campaignId, id: memberOf.value.id, expectedVersion: 1 },
      { audit },
    );
    expect(unlinked.ok && unlinked.value.version).toBe(2);
    expect(
      await f.relationshipService.tombstone(gm, {
        campaignId,
        id: memberOf.value.id,
        expectedVersion: 2,
      }),
    ).toEqual({ ok: false, error: { code: 'record_deleted' } });
    expect(events.at(-1)).toMatchObject({
      action: 'entity.relationship_deleted',
      before: { kind: 'member_of', sourceEntityId: smuggler.id, targetEntityId: guild.id },
    });
    expect(await violations(campaignId)).toEqual([]);
  });

  test('concurrent link create and endpoint narrowing never commit a violating row (two connections)', async () => {
    if (second === undefined) throw new Error('second connection unavailable');
    const { campaignId, gm } = campaign();
    const one = fixture(db());
    const two = fixture(second.db);
    let created = 0;
    let refused = 0;
    for (let round = 0; round < 12; round += 1) {
      const source = await entity(campaignId, EVERYONE);
      const target = await entity(campaignId, EVERYONE);
      const [linked, narrowed] = await Promise.all([
        one.relationshipService.create(gm, {
          campaignId,
          id: crypto.randomUUID(),
          sourceEntityId: source.id,
          targetEntityId: target.id,
          kind: 'knows',
          visibility: EVERYONE,
        }),
        two.entityAdapter.writeVisibility({
          campaignId,
          resourceId: round % 2 === 0 ? source.id : target.id,
          expectedVersion: 1,
          visibility: GM_ONLY,
          actor: gm,
          recordAudit: async () => undefined,
        }),
      ]);
      expect(narrowed.ok).toBe(true);
      if (linked.ok) created += 1;
      else {
        expect(linked.error).toEqual({
          code: 'invalid_payload',
          reason: 'incompatible_visibility',
        });
        refused += 1;
      }
      expect(await violations(campaignId)).toEqual([]);
    }
    expect(created + refused).toBe(12);
  });
});
