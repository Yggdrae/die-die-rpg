import { afterAll, describe, expect, test } from 'bun:test';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import type { ActorRef, Role } from '@rpg/contracts';
import { sql } from 'drizzle-orm';
import {
  type ContentAuditEvent,
  type ContentAuditHook,
  EntityService,
  PersonalNoteService,
} from './application.ts';
import { CONTENT_AUDIT_DECLARATIONS } from './audit-declarations.ts';
import {
  connectContentDatabase,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
} from './infra/postgres/repository.ts';
import { CAMPAIGN_ENTITY_POLICY, PERSONAL_NOTE_POLICY } from './policies.ts';
import { CONTENT_CONFIGURATION, defineContentConfiguration, ENTITY_TYPES } from './types.ts';

/**
 * Feature 16 task 05 on PostgreSQL: the application services validate, decide through feature 04
 * (real `AuthorizationService` over the content declarations), write with compare-and-set, and call
 * the audit hook once inside the write transaction. The hook here is a recording fixture; the
 * real feature 06 recorder is exercised by the API applier tests. Rows are deleted afterwards.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate = databaseUrl === undefined ? undefined : connectContentDatabase(databaseUrl);
const connection = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate.db.execute(sql`select 1 from content_entities limit 1`);
    return candidate;
  } catch {
    await candidate.close();
    return undefined;
  }
})();

const campaigns: string[] = [];
afterAll(async () => {
  if (connection === undefined) return;
  if (campaigns.length > 0) {
    const ids = sql.join(
      campaigns.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await connection.db.execute(sql`delete from content_entities where campaign_id in (${ids})`);
    await connection.db.execute(
      sql`delete from content_personal_notes where campaign_id in (${ids})`,
    );
  }
  await connection.close();
});

const registry = new ResourcePolicyRegistry();
registry.register(CAMPAIGN_ENTITY_POLICY);
registry.register(PERSONAL_NOTE_POLICY);
const decider = new AuthorizationService(registry);

function campaign() {
  const campaignId = crypto.randomUUID();
  campaigns.push(campaignId);
  const actor = (role: Role, userId: string = crypto.randomUUID()): ActorRef => ({
    userId,
    campaignId,
    role,
  });
  return { campaignId, actor };
}

/** Records every event and the transaction it was called on. */
function auditLog() {
  const events: ContentAuditEvent[] = [];
  const hook: ContentAuditHook = async (transaction, event) => {
    expect(typeof transaction.execute).toBe('function');
    events.push(event);
  };
  return { events, hook };
}

const SECRET_TEXT = 'The ferryman is the lich in disguise';
const SECRET_LABEL = 'True name';
const SECRET_VALUE = 'Vorgath';

describe.skipIf(connection === undefined)('content application services (PostgreSQL)', () => {
  const entities = () =>
    new PostgresEntityRepository((connection as NonNullable<typeof connection>).db);
  const notes = () =>
    new PostgresPersonalNoteRepository((connection as NonNullable<typeof connection>).db);
  const members = new Set<string>();
  const service = () =>
    new EntityService({
      entities: entities(),
      decider,
      members: { isMember: async (_campaignId, userId) => members.has(userId) },
    });

  test('every enabled type created without Visibility is stored gm_only (BR-002)', async () => {
    const { campaignId, actor } = campaign();
    const gm = actor('gm');
    const audit = auditLog();
    const enabled = CONTENT_CONFIGURATION.types.filter((type) => type.enabled);
    expect(enabled.length).toBe(ENTITY_TYPES.length);
    for (const type of enabled) {
      const created = await service().create(
        gm,
        { campaignId, id: crypto.randomUUID(), type: type.id, name: `A ${type.label}` },
        { audit: audit.hook },
      );
      if (!created.ok) throw new Error(`create failed for ${type.id}`);
      expect(created.value.visibility).toEqual({ mode: 'gm_only' });
      expect(created.value.version).toBe(1);
      expect(created.value.createdBy).toBe(gm.userId);
    }
    expect(audit.events).toHaveLength(enabled.length);
    expect(audit.events.every((event) => event.action === 'entity.created')).toBe(true);
    expect(audit.events.every((event) => event.targetType === 'campaign_entity')).toBe(true);
  });

  test('quick create captures a name and one line; explicit Visibility is kept after reveal', async () => {
    const { campaignId, actor } = campaign();
    const gm = actor('assistant_gm');
    const player = crypto.randomUUID();
    members.add(player);
    const ferryman = await service().create(gm, {
      campaignId,
      id: crypto.randomUUID(),
      type: 'npc',
      name: '  Ferryman ',
      summary: 'Asks for silver, takes copper',
    });
    expect(ferryman.ok && ferryman.value).toMatchObject({
      type: 'npc',
      name: 'Ferryman',
      summary: 'Asks for silver, takes copper',
      visibility: { mode: 'gm_only' },
    });
    const road = await service().create(gm, {
      campaignId,
      id: crypto.randomUUID(),
      type: 'location',
      name: 'Old Road',
      visibility: { mode: 'everyone' },
    });
    expect(road.ok && road.value.visibility).toEqual({ mode: 'everyone' });
    const targeted = await service().create(gm, {
      campaignId,
      id: crypto.randomUUID(),
      type: 'item',
      name: 'Silver key',
      visibility: { mode: 'players', playerIds: [player] },
    });
    expect(targeted.ok && targeted.value.visibility).toEqual({
      mode: 'players',
      playerIds: [player],
    });
    const stranger = await service().create(gm, {
      campaignId,
      id: crypto.randomUUID(),
      type: 'item',
      name: 'Bad target',
      visibility: { mode: 'players', playerIds: [crypto.randomUUID()] },
    });
    expect(stranger).toEqual({
      ok: false,
      error: { code: 'invalid_payload', reason: 'target_not_member' },
    });
    const party = await service().create(gm, {
      campaignId,
      id: crypto.randomUUID(),
      type: 'item',
      name: 'Party loot',
      visibility: { mode: 'party', partyIds: [crypto.randomUUID()] },
    });
    expect(party).toEqual({
      ok: false,
      error: { code: 'invalid_payload', reason: 'invalid_visibility' },
    });
  });

  test('player and observer creates/updates of campaign_entity are denied; nothing stored (D-04)', async () => {
    const { campaignId, actor } = campaign();
    const audit = auditLog();
    for (const role of ['player', 'observer'] as const) {
      const id = crypto.randomUUID();
      expect(
        await service().create(
          actor(role),
          { campaignId, id, type: 'npc', name: 'Denied' },
          { audit: audit.hook },
        ),
      ).toEqual({ ok: false, error: { code: 'not_found_or_forbidden' } });
      expect(await entities().get(campaignId, id, { includeDeleted: true })).toBeUndefined();
    }
    const id = crypto.randomUUID();
    const created = await service().create(actor('owner'), {
      campaignId,
      id,
      type: 'npc',
      name: 'Visible',
      visibility: { mode: 'everyone' },
    });
    expect(created.ok).toBe(true);
    for (const role of ['player', 'observer'] as const) {
      expect(
        await service().update(
          actor(role),
          { campaignId, id, expectedVersion: 1, changes: { name: 'Renamed' } },
          { audit: audit.hook },
        ),
      ).toEqual({ ok: false, error: { code: 'not_found_or_forbidden' } });
      expect(
        await service().tombstone(actor(role), { campaignId, id, expectedVersion: 1 }),
      ).toEqual({ ok: false, error: { code: 'not_found_or_forbidden' } });
    }
    // Another campaign's GM is denied like a missing record.
    const foreign = { userId: crypto.randomUUID(), campaignId: crypto.randomUUID(), role: 'gm' };
    expect(
      await service().update(foreign as ActorRef, {
        campaignId,
        id,
        expectedVersion: 1,
        changes: { name: 'Renamed' },
      }),
    ).toEqual({ ok: false, error: { code: 'not_found_or_forbidden' } });
    expect(audit.events).toEqual([]);
    expect((await entities().get(campaignId, id))?.name).toBe('Visible');
  });

  test('structured edit increments the version; stale edit is a conflict with the current record', async () => {
    const { campaignId, actor } = campaign();
    const gm = actor('gm');
    const other = actor('gm');
    const audit = auditLog();
    const id = crypto.randomUUID();
    await service().create(gm, { campaignId, id, type: 'npc', name: 'Bandit' });
    const renamed = await service().update(
      gm,
      {
        campaignId,
        id,
        expectedVersion: 1,
        changes: { name: 'Bandit Leader', tags: [' Antagonist ', 'antagonist', 'Village'] },
      },
      { audit: audit.hook },
    );
    expect(renamed.ok && renamed.value).toMatchObject({
      name: 'Bandit Leader',
      version: 2,
      tags: ['antagonist', 'village'],
      updatedBy: gm.userId,
    });
    const stale = await service().update(
      other,
      { campaignId, id, expectedVersion: 1, changes: { name: 'Lost update' } },
      { audit: audit.hook },
    );
    expect(stale.ok).toBe(false);
    if (stale.ok || stale.error.code !== 'version_conflict') throw new Error('expected conflict');
    expect(stale.error.current).toMatchObject({ name: 'Bandit Leader', version: 2 });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toEqual({
      action: 'entity.updated',
      targetType: 'campaign_entity',
      before: { name: 'Bandit', tags: [] },
      after: { type: 'npc', name: 'Bandit Leader', tags: ['antagonist', 'village'] },
      targetVisibility: { visibility: { mode: 'gm_only' } },
    });
  });

  test('no long text, field label, or field value reaches an audit payload', async () => {
    const { campaignId, actor } = campaign();
    const gm = actor('gm');
    const audit = auditLog();
    const id = crypto.randomUUID();
    await service().create(
      gm,
      {
        campaignId,
        id,
        type: 'npc',
        name: 'Ferryman',
        description: SECRET_TEXT,
        fields: { [SECRET_LABEL]: SECRET_VALUE },
      },
      { audit: audit.hook },
    );
    const updated = await service().update(
      gm,
      {
        campaignId,
        id,
        expectedVersion: 1,
        changes: {
          description: `${SECRET_TEXT} (revised)`,
          fields: { [SECRET_LABEL]: `${SECRET_VALUE} the Pale` },
        },
      },
      { audit: audit.hook, longText: async () => true },
    );
    expect(updated.ok).toBe(true);
    await service().tombstone(gm, { campaignId, id, expectedVersion: 2 }, { audit: audit.hook });
    expect(audit.events.map((event) => event.action)).toEqual([
      'entity.created',
      'entity.updated',
      'entity.deleted',
    ]);
    const serialized = JSON.stringify(audit.events);
    for (const secret of [SECRET_TEXT, SECRET_LABEL, SECRET_VALUE]) {
      expect(serialized).not.toContain(secret);
    }
    expect(audit.events[0]?.after?.changed).toEqual(['description', 'fields']);
    expect(audit.events[1]?.after).toEqual({ type: 'npc', changed: ['description', 'fields'] });
    // Every payload satisfies its registered schema (feature 06 rejects anything else).
    const { Value } = await import('@sinclair/typebox/value');
    for (const event of audit.events) {
      const declaration = CONTENT_AUDIT_DECLARATIONS.find((item) => item.action === event.action);
      for (const value of [event.before, event.after]) {
        if (value !== undefined && declaration?.payload !== undefined) {
          expect(Value.Check(declaration.payload, value)).toBe(true);
        }
      }
    }
  });

  test('description change without a hold is hold_required and leaves the row unchanged', async () => {
    const { campaignId, actor } = campaign();
    const gm = actor('gm');
    const audit = auditLog();
    const id = crypto.randomUUID();
    await service().create(gm, { campaignId, id, type: 'npc', name: 'Ferryman' });
    for (const longText of [undefined, async () => false]) {
      expect(
        await service().update(
          gm,
          { campaignId, id, expectedVersion: 1, changes: { description: 'Typed without hold' } },
          { audit: audit.hook, ...(longText === undefined ? {} : { longText }) },
        ),
      ).toEqual({ ok: false, error: { code: 'hold_required' } });
    }
    // An unchanged description needs no hold.
    const tagged = await service().update(gm, {
      campaignId,
      id,
      expectedVersion: 1,
      changes: { description: '', tags: ['river'] },
    });
    expect(tagged.ok && tagged.value).toMatchObject({ description: '', version: 2 });
    expect(audit.events).toEqual([]);
  });

  test('a deleted entity cannot be edited; delete is a soft delete with version + 1', async () => {
    const { campaignId, actor } = campaign();
    const gm = actor('gm');
    const audit = auditLog();
    const id = crypto.randomUUID();
    await service().create(gm, { campaignId, id, type: 'npc', name: 'Guard' });
    await service().update(gm, { campaignId, id, expectedVersion: 1, changes: { summary: 'x' } });
    const deleted = await service().tombstone(
      gm,
      { campaignId, id, expectedVersion: 2 },
      { audit: audit.hook },
    );
    expect(deleted.ok && deleted.value.version).toBe(3);
    expect(deleted.ok && typeof deleted.value.deletedAt).toBe('string');
    expect(await entities().get(campaignId, id)).toBeUndefined();
    expect(
      await service().update(
        gm,
        { campaignId, id, expectedVersion: 3, changes: { name: 'Zombie' } },
        { audit: audit.hook },
      ),
    ).toEqual({ ok: false, error: { code: 'record_deleted' } });
    expect(
      await service().tombstone(gm, { campaignId, id, expectedVersion: 3 }, { audit: audit.hook }),
    ).toEqual({ ok: false, error: { code: 'record_deleted' } });
    // A player learns nothing about the tombstone.
    expect(
      await service().update(actor('player'), {
        campaignId,
        id,
        expectedVersion: 3,
        changes: { name: 'Zombie' },
      }),
    ).toEqual({ ok: false, error: { code: 'not_found_or_forbidden' } });
    expect(await entities().get(campaignId, id, { includeDeleted: true })).toMatchObject({
      name: 'Guard',
      version: 3,
    });
    expect(audit.events.map((event) => event.action)).toEqual(['entity.deleted']);
  });

  test('updates never change Visibility; type rules; limits; an existing id is never overwritten', async () => {
    const { campaignId, actor } = campaign();
    const gm = actor('gm');
    const id = crypto.randomUUID();
    await service().create(gm, { campaignId, id, type: 'note', name: 'Untyped' });
    expect(
      await service().update(gm, {
        campaignId,
        id,
        expectedVersion: 1,
        changes: {},
        visibility: { mode: 'everyone' },
      }),
    ).toEqual({
      ok: false,
      error: { code: 'invalid_payload', reason: 'visibility_change_not_allowed' },
    });
    expect(
      await service().update(gm, {
        campaignId,
        id,
        expectedVersion: 1,
        changes: { type: 'villain' },
      }),
    ).toEqual({ ok: false, error: { code: 'invalid_payload', reason: 'unknown_type' } });
    const retyped = await service().update(gm, {
      campaignId,
      id,
      expectedVersion: 1,
      changes: { type: 'npc' },
    });
    expect(retyped.ok && retyped.value.type).toBe('npc');
    for (const [changes, reason] of [
      [{ name: '   ' }, 'name_required'],
      [{ summary: 's'.repeat(281) }, 'summary_too_long'],
      [{ tags: ['t'.repeat(65)] }, 'tag_too_long'],
      [{ fields: { Price: 'one', price: 'two' } }, 'duplicate_field_label'],
      [{ metadata: [] }, 'invalid_metadata'],
    ] as const) {
      expect(await service().update(gm, { campaignId, id, expectedVersion: 2, changes })).toEqual({
        ok: false,
        error: { code: 'invalid_payload', reason },
      });
    }
    expect(
      await service().create(gm, {
        campaignId,
        id: crypto.randomUUID(),
        type: 'villain',
        name: 'X',
      }),
    ).toEqual({ ok: false, error: { code: 'invalid_payload', reason: 'unknown_type' } });
    expect(await service().create(gm, { campaignId, id, type: 'npc', name: 'Overwrite' })).toEqual({
      ok: false,
      error: { code: 'not_found_or_forbidden' },
    });
    expect((await entities().get(campaignId, id))?.name).toBe('Untyped');
  });

  test('a type removed from configuration stays editable but cannot be created', async () => {
    const { campaignId, actor } = campaign();
    const gm = actor('gm');
    const withVehicle = defineContentConfiguration({
      types: [
        ...ENTITY_TYPES,
        {
          id: 'vehicle',
          label: 'Vehicle',
          pluralLabel: 'Vehicles',
          quickCreate: { secondField: 'summary' },
          enabled: true,
        },
      ],
      kinds: CONTENT_CONFIGURATION.kinds,
    });
    const id = crypto.randomUUID();
    const created = await new EntityService({
      entities: entities(),
      decider,
      configuration: withVehicle,
    }).create(gm, { campaignId, id, type: 'vehicle', name: 'Barge' });
    expect(created.ok).toBe(true);
    const without = new EntityService({ entities: entities(), decider });
    const renamed = await without.update(gm, {
      campaignId,
      id,
      expectedVersion: 1,
      changes: { type: 'vehicle', name: 'River barge' },
    });
    expect(renamed.ok && renamed.value).toMatchObject({ type: 'vehicle', name: 'River barge' });
    expect(
      await without.create(gm, { campaignId, id: crypto.randomUUID(), type: 'vehicle', name: 'X' }),
    ).toEqual({ ok: false, error: { code: 'invalid_payload', reason: 'unknown_type' } });
    expect((await without.tombstone(gm, { campaignId, id, expectedVersion: 2 })).ok).toBe(true);
  });

  test('an audit hook failure rolls the write back', async () => {
    const { campaignId, actor } = campaign();
    const gm = actor('gm');
    const id = crypto.randomUUID();
    let threw = false;
    try {
      await service().create(
        gm,
        { campaignId, id, type: 'npc', name: 'Rolled back' },
        {
          audit: async () => {
            throw new Error('domain failure after audit');
          },
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await entities().get(campaignId, id, { includeDeleted: true })).toBeUndefined();
  });

  test('personal notes: players only, author-private, snapshot players:[author] (D-06, BR-007)', async () => {
    const { campaignId, actor } = campaign();
    const casey = actor('player');
    const rowan = actor('player');
    const audit = auditLog();
    const notesService = new PersonalNoteService({ notes: notes(), decider });
    for (const role of ['owner', 'gm', 'assistant_gm', 'observer'] as const) {
      expect(
        await notesService.create(
          actor(role),
          { campaignId, id: crypto.randomUUID(), name: 'GM note' },
          { audit: audit.hook },
        ),
      ).toEqual({ ok: false, error: { code: 'not_found_or_forbidden' } });
    }
    const id = crypto.randomUUID();
    const created = await notesService.create(
      casey,
      { campaignId, id, name: 'Elder lied about the road', body: SECRET_TEXT },
      { audit: audit.hook },
    );
    expect(created.ok && created.value).toMatchObject({
      authorUserId: casey.userId,
      visibility: { mode: 'players', playerIds: [casey.userId] },
      body: SECRET_TEXT,
    });
    for (const other of [rowan, actor('gm'), actor('owner')]) {
      expect(
        await notesService.update(other, {
          campaignId,
          id,
          expectedVersion: 1,
          changes: { name: 'Hijacked' },
        }),
      ).toEqual({ ok: false, error: { code: 'not_found_or_forbidden' } });
      expect(
        await notesService.update(other, {
          campaignId,
          id: crypto.randomUUID(),
          expectedVersion: 1,
          changes: { name: 'Hijacked' },
        }),
      ).toEqual({ ok: false, error: { code: 'not_found_or_forbidden' } });
    }
    expect(
      await notesService.update(casey, {
        campaignId,
        id,
        expectedVersion: 1,
        changes: { body: 'edited without hold' },
      }),
    ).toEqual({ ok: false, error: { code: 'hold_required' } });
    const edited = await notesService.update(
      casey,
      { campaignId, id, expectedVersion: 1, changes: { body: 'held edit', tags: ['Clue'] } },
      { audit: audit.hook, longText: async (field) => field === 'body' },
    );
    expect(edited.ok && edited.value).toMatchObject({
      body: 'held edit',
      tags: ['clue'],
      version: 2,
    });
    const removed = await notesService.tombstone(
      casey,
      { campaignId, id, expectedVersion: 2 },
      { audit: audit.hook },
    );
    expect(removed.ok).toBe(true);
    expect(audit.events.map((event) => event.action)).toEqual([
      'entity.personal_note_created',
      'entity.personal_note_updated',
      'entity.personal_note_deleted',
    ]);
    for (const event of audit.events) {
      expect(event.targetType).toBe('personal_note');
      expect(event.targetVisibility).toEqual({
        visibility: { mode: 'players', playerIds: [casey.userId] },
        authorUserId: casey.userId,
      });
    }
    expect(JSON.stringify(audit.events)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(audit.events)).not.toContain('held edit');
  });
});
