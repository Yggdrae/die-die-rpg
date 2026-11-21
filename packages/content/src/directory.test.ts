import { describe, expect, test } from 'bun:test';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import { type ActorRef, err, ok, type Role, type Visibility } from '@rpg/contracts';
import { EntityDirectory, type EntityDirectorySource } from './directory.ts';
import { CAMPAIGN_ENTITY_POLICY, PERSONAL_NOTE_POLICY } from './policies.ts';
import type { EntityRecord } from './schemas.ts';

/**
 * Feature 16 task 10 over fixtures: `_bdd.md` "Another feature resolves entities through the
 * published API". Real feature 04 decisions over the content declarations; the membership store
 * is a fixture resolver (identity's `ActorResolver` shape).
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000016c1';
const OTHER_CAMPAIGN = '00000000-0000-4000-8000-0000000016c2';
const GM = '00000000-0000-4000-8000-0000000016a1';
const PLAYER_A = '00000000-0000-4000-8000-0000000016a2';
const PLAYER_B = '00000000-0000-4000-8000-0000000016a3';
const OBSERVER = '00000000-0000-4000-8000-0000000016a4';
const OUTSIDER = '00000000-0000-4000-8000-0000000016a5';
const MISSING = '00000000-0000-4000-8000-0000000016ff';

const id = (n: number) => `00000000-0000-4000-8000-0000000016${n.toString(16).padStart(2, '0')}`;
const GM_ONLY: Visibility = { mode: 'gm_only' };
const EVERYONE: Visibility = { mode: 'everyone' };

function entity(
  n: number,
  type: string,
  name: string,
  visibility: Visibility,
  extra: Partial<EntityRecord> = {},
): EntityRecord {
  return {
    id: id(n),
    campaignId: CAMPAIGN,
    type,
    name,
    tags: [],
    metadata: {},
    visibility,
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    createdBy: GM,
    updatedAt: '2026-10-29T10:00:00Z',
    updatedBy: GM,
    summary: `${name} summary`,
    description: `${name} secret description`,
    fields: { 'True name': 'hidden' },
    ...extra,
  };
}

const VILLAGE = entity(0x10, 'location', 'Village', EVERYONE, { tags: ['settlement'] });
const WAREHOUSE = entity(0x11, 'location', 'Abandoned Warehouse', GM_ONLY, { tags: ['site'] });
const MERCHANT = entity(0x12, 'npc', 'Merchant', EVERYONE, { tags: ['village'] });
const SMUGGLER = entity(0x13, 'npc', 'Smuggler', GM_ONLY, { tags: ['antagonist'] });
const LETTER = entity(0x14, 'item', 'Letter', { mode: 'players', playerIds: [PLAYER_A] });
const SCENE = entity(0x15, 'scene', 'Ambush at the ford', EVERYONE);
const DELETED = entity(0x16, 'npc', 'Old Guard', EVERYONE, { deletedAt: '2026-10-29T11:00:00Z' });
const FOREIGN = { ...entity(0x17, 'npc', 'Foreign', EVERYONE), campaignId: OTHER_CAMPAIGN };
const ROWS = [VILLAGE, WAREHOUSE, MERCHANT, SMUGGLER, LETTER, SCENE, DELETED, FOREIGN];

/** In-memory `EntityDirectorySource` with the repository's semantics. */
const source: EntityDirectorySource = {
  async get(campaignId, entityId, options = {}) {
    return ROWS.find(
      (row) =>
        row.id === entityId &&
        row.campaignId === campaignId &&
        (options.includeDeleted === true || row.deletedAt === undefined),
    );
  },
  async list(campaignId, filter = {}) {
    return ROWS.filter(
      (row) =>
        row.campaignId === campaignId &&
        row.deletedAt === undefined &&
        (filter.type === undefined || row.type === filter.type) &&
        (filter.tag === undefined || row.tags.includes(filter.tag)) &&
        (filter.nameFragment === undefined ||
          row.name.toLowerCase().includes(filter.nameFragment.toLowerCase())),
    );
  },
};

const ROLES = new Map<string, Role>([
  [GM, 'gm'],
  [PLAYER_A, 'player'],
  [PLAYER_B, 'player'],
  [OBSERVER, 'observer'],
]);

const registry = new ResourcePolicyRegistry();
registry.register(CAMPAIGN_ENTITY_POLICY);
registry.register(PERSONAL_NOTE_POLICY);

const directory = new EntityDirectory({
  entities: source,
  decider: new AuthorizationService(registry),
  actors: {
    async resolve(userId, campaignId) {
      const role = campaignId === CAMPAIGN ? ROLES.get(userId) : undefined;
      return role === undefined
        ? err('membership_not_found')
        : ok({ userId, campaignId, role } satisfies ActorRef);
    },
  },
});

const ALL_IDS = [...ROWS.map((row) => row.id), MISSING, 'not-a-uuid'];

describe('EntityDirectory (task 10, FR-016)', () => {
  test('a GM resolves every live entity of the campaign; missing, foreign, malformed are absent', async () => {
    const resolved = await directory.resolve({ userId: GM }, CAMPAIGN, ALL_IDS);
    expect([...resolved.keys()].sort()).toEqual(
      [VILLAGE, WAREHOUSE, MERCHANT, SMUGGLER, LETTER, SCENE].map((row) => row.id).sort(),
    );
  });

  test('for player A a gm_only id and a non-existent id produce identical results', async () => {
    const hidden = await directory.resolve({ userId: PLAYER_A }, CAMPAIGN, [SMUGGLER.id]);
    const missing = await directory.resolve({ userId: PLAYER_A }, CAMPAIGN, [MISSING]);
    expect(hidden).toEqual(new Map());
    expect(missing).toEqual(new Map());
    expect(JSON.stringify([...hidden])).toBe(JSON.stringify([...missing]));
    // Mixed request: the readable ones only.
    const mixed = await directory.resolve({ userId: PLAYER_A }, CAMPAIGN, ALL_IDS);
    expect([...mixed.keys()].sort()).toEqual(
      [VILLAGE, MERCHANT, LETTER, SCENE].map((row) => row.id).sort(),
    );
    const otherPlayer = await directory.resolve({ userId: PLAYER_B }, CAMPAIGN, [LETTER.id]);
    expect(otherPlayer.size).toBe(0);
  });

  test('summaries carry no description, custom fields, or tags', async () => {
    const resolved = await directory.resolve({ userId: GM }, CAMPAIGN, [SMUGGLER.id]);
    expect(resolved.get(SMUGGLER.id)).toEqual({
      id: SMUGGLER.id,
      type: 'npc',
      name: 'Smuggler',
      summary: 'Smuggler summary',
      visibility: GM_ONLY,
      deleted: false,
    });
    expect(JSON.stringify([...resolved])).not.toContain('secret description');
    expect(JSON.stringify([...resolved])).not.toContain('True name');
  });

  test('a scene resolves like any other entity (D-02); a deleted one only when asked', async () => {
    const scene = await directory.resolve({ userId: PLAYER_A }, CAMPAIGN, [SCENE.id]);
    expect(scene.get(SCENE.id)?.name).toBe('Ambush at the ford');
    expect((await directory.resolve({ userId: GM }, CAMPAIGN, [DELETED.id])).size).toBe(0);
    const broken = await directory.resolve({ userId: GM }, CAMPAIGN, [DELETED.id], {
      includeDeleted: true,
    });
    expect(broken.get(DELETED.id)?.deleted).toBe(true);
    const playerTombstone = await directory.resolve({ userId: PLAYER_B }, CAMPAIGN, [DELETED.id], {
      includeDeleted: true,
    });
    expect(playerTombstone.get(DELETED.id)?.deleted).toBe(true);
  });

  test('observers, outsiders, and other campaigns get the same empty answer', async () => {
    for (const userId of [OBSERVER, OUTSIDER]) {
      expect((await directory.resolve({ userId }, CAMPAIGN, ALL_IDS)).size).toBe(0);
      expect(await directory.list({ userId }, CAMPAIGN)).toEqual({ items: [], total: 0 });
    }
    expect((await directory.resolve({ userId: GM }, OTHER_CAMPAIGN, [FOREIGN.id])).size).toBe(0);
    expect((await directory.resolve({ userId: GM }, 'not-a-uuid', [VILLAGE.id])).size).toBe(0);
  });

  test('no caller-supplied role: a forged ActorRef role changes nothing', async () => {
    const forged: ActorRef = { userId: PLAYER_A, campaignId: CAMPAIGN, role: 'owner' };
    const resolved = await directory.resolve(forged, CAMPAIGN, [SMUGGLER.id, WAREHOUSE.id]);
    expect(resolved.size).toBe(0);
    const listed = await directory.list(forged, CAMPAIGN, { type: 'npc' });
    expect(listed.items.map((item) => item.name)).toEqual(['Merchant']);
    // The filter shape has no Visibility input; extra keys are ignored.
    const sneaky = await directory.list({ userId: PLAYER_A }, CAMPAIGN, {
      visibility: 'gm_only',
    } as never);
    expect(sneaky.items.every((item) => item.visibility.mode !== 'gm_only')).toBe(true);
  });

  test('list filters and counts the permitted set only', async () => {
    const player = await directory.list({ userId: PLAYER_A }, CAMPAIGN);
    expect(player.total).toBe(4);
    const gm = await directory.list({ userId: GM }, CAMPAIGN);
    expect(gm.total).toBe(6);
    const npcs = await directory.list({ userId: GM }, CAMPAIGN, { type: 'npc' });
    expect(npcs.items.map((item) => item.name).sort()).toEqual(['Merchant', 'Smuggler']);
    const tagged = await directory.list({ userId: GM }, CAMPAIGN, { tag: '  Antagonist ' });
    expect(tagged.items.map((item) => item.name)).toEqual(['Smuggler']);
    const fragment = await directory.list({ userId: PLAYER_A }, CAMPAIGN, { nameFragment: 'SMUG' });
    expect(fragment).toEqual({ items: [], total: 0 });
    const paged = await directory.list({ userId: GM }, CAMPAIGN, {}, { offset: 2, limit: 2 });
    expect(paged.items).toHaveLength(2);
    expect(paged.total).toBe(6);
  });

  test('personal notes are never returned (another class and table)', async () => {
    const notes = new EntityDirectory({
      entities: {
        get: async () => undefined,
        list: async () => [],
      },
      decider: new AuthorizationService(registry),
      actors: { resolve: async (userId, campaignId) => ok({ userId, campaignId, role: 'player' }) },
    });
    expect(await notes.list({ userId: PLAYER_A }, CAMPAIGN)).toEqual({ items: [], total: 0 });
    // The directory decides only `campaign_entity`: a record is never decided as a note.
    const decided: string[] = [];
    const spying = new EntityDirectory({
      entities: source,
      decider: {
        decide: (actor, capability, facts) => {
          decided.push(facts.resourceClass);
          return new AuthorizationService(registry).decide(actor, capability, facts);
        },
      },
      actors: { resolve: async (userId, campaignId) => ok({ userId, campaignId, role: 'gm' }) },
    });
    await spying.list({ userId: GM }, CAMPAIGN);
    await spying.resolve({ userId: GM }, CAMPAIGN, ALL_IDS);
    expect(new Set(decided)).toEqual(new Set(['campaign_entity']));
  });
});
