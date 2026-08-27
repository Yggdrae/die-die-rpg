import type { ActorRef, EntityEnvelope, SystemRef, Visibility } from '@rpg/contracts';
import { CAMPAIGN_ID, ITEMS, LOCATIONS, NPCS, USERS } from './ids.ts';

/**
 * "The Missing Caravan" (`PRD.md` s.82).
 *
 * Deliberately disposable and deliberately generic. A small caravan vanished between a
 * village and a trading post; the party is hired to find out what happened. The content
 * exists to exercise the application, not to be a good adventure, and nothing here should
 * resemble a real campaign or spoil one (`PRD.md` s.81).
 *
 * Visibility values are mixed on purpose. A fixture where everything is public lets a
 * feature pass its tests without ever exercising the filtering that keeps secrets secret.
 */

const NOW = '2026-08-27T09:00:00Z';

/**
 * The fixture system is intentionally neither Cairn nor Fate.
 *
 * If Track C builds against a Cairn-shaped fixture, a hidden assumption about Cairn passes
 * every test until wave 3. Using a third shape is the cheapest available check on the
 * architectural criterion in `PRD.md` s.89.
 */
export const FIXTURE_SYSTEM: SystemRef = {
  systemId: 'fixture-system',
  version: '0.1.0',
};

const GM_ONLY: Visibility = { mode: 'gm_only' };
const EVERYONE: Visibility = { mode: 'everyone' };
const PLAYER_A_ONLY: Visibility = { mode: 'players', playerIds: [USERS.playerA] };

function entity(
  id: string,
  type: string,
  name: string,
  visibility: Visibility,
  tags: string[] = [],
  metadata: Record<string, unknown> = {},
): EntityEnvelope {
  return {
    id,
    campaignId: CAMPAIGN_ID,
    type,
    name,
    tags,
    metadata,
    visibility,
    version: 1,
    createdAt: NOW,
    createdBy: USERS.gm,
    updatedAt: NOW,
    updatedBy: USERS.gm,
  };
}

/** One actor per role in `PRD.md` s.60, so authorization matrices have real inputs. */
export const ACTORS: Record<string, ActorRef> = {
  gm: { userId: USERS.gm, campaignId: CAMPAIGN_ID, role: 'gm' },
  owner: { userId: USERS.gm, campaignId: CAMPAIGN_ID, role: 'owner' },
  assistantGm: { userId: USERS.assistantGm, campaignId: CAMPAIGN_ID, role: 'assistant_gm' },
  playerA: { userId: USERS.playerA, campaignId: CAMPAIGN_ID, role: 'player' },
  playerB: { userId: USERS.playerB, campaignId: CAMPAIGN_ID, role: 'player' },
  observer: { userId: USERS.observer, campaignId: CAMPAIGN_ID, role: 'observer' },
};

export const FIXTURE_LOCATIONS: EntityEnvelope[] = [
  entity(LOCATIONS.village, 'location', 'Village', EVERYONE, ['settlement']),
  entity(LOCATIONS.oldRoad, 'location', 'Old Road', EVERYONE, ['travel']),
  entity(LOCATIONS.abandonedWarehouse, 'location', 'Abandoned Warehouse', GM_ONLY, ['site'], {
    note: 'Crates hide a second entrance.',
  }),
  entity(LOCATIONS.forestCamp, 'location', 'Forest Camp', GM_ONLY, ['site']),
  entity(LOCATIONS.tradingPost, 'location', 'Trading Post', EVERYONE, ['settlement']),
];

export const FIXTURE_NPCS: EntityEnvelope[] = [
  entity(NPCS.merchant, 'npc', 'Merchant', EVERYONE, ['village']),
  entity(NPCS.villageElder, 'npc', 'Village Elder', EVERYONE, ['village']),
  entity(NPCS.guard, 'npc', 'Guard', EVERYONE, ['village']),
  entity(NPCS.traveler, 'npc', 'Traveler', EVERYONE, ['road']),
  entity(NPCS.smuggler, 'npc', 'Smuggler', GM_ONLY, ['antagonist']),
  entity(NPCS.banditLeader, 'npc', 'Bandit Leader', GM_ONLY, ['antagonist']),
];

export const FIXTURE_ITEMS: EntityEnvelope[] = [
  // Revealed to one player only, so reveal-scoping has something real to test.
  entity(ITEMS.weatheredLetter, 'item', 'Weathered Letter', PLAYER_A_ONLY, ['handout']),
  entity(ITEMS.merchantLedger, 'item', 'Merchant Ledger', GM_ONLY, ['handout', 'clue-source']),
  entity(ITEMS.brokenSeal, 'item', 'Broken Seal', GM_ONLY, ['clue-source']),
  entity(ITEMS.supplyCrate, 'item', 'Supply Crate', EVERYONE, []),
  entity(ITEMS.oldMap, 'item', 'Old Map', EVERYONE, ['handout']),
];

export const FIXTURE_ENTITIES: EntityEnvelope[] = [
  ...FIXTURE_LOCATIONS,
  ...FIXTURE_NPCS,
  ...FIXTURE_ITEMS,
];

export const FIXTURE_CAMPAIGN = {
  id: CAMPAIGN_ID,
  name: 'The Missing Caravan',
  description:
    'A small caravan vanished between the village and the trading post. The party is hired to find out what happened.',
  system: FIXTURE_SYSTEM,
} as const;
