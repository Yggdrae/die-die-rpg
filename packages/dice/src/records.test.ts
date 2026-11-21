import { describe, expect, test } from 'bun:test';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import type { ActorRef, Role, Visibility } from '@rpg/contracts';
import { InMemoryRepository } from '@rpg/contracts/testing';
import {
  evaluateRoll,
  parseRoll,
  type RandomSource,
  ROLL_LIMITS,
  seededRandom,
} from './engine/index.ts';
import { RollLocalRepository } from './offline.ts';
import { DICE_ROLL_POLICY, mayCreateRoll } from './policies.ts';
import {
  checkRollRecord,
  DICE_REPLICA_TABLES,
  diceReplicaProjection,
  MAX_WHISPER_RECIPIENTS,
  ROLL_RECORD_TYPE,
  ROLL_ROW_CODEC,
  type RollRecord,
  rollVisibilityAgrees,
  rollVisibilityToVisibility,
} from './records.ts';

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const EARLIER = '00000000-0000-4000-8000-000000000001';

function decider() {
  const policies = new ResourcePolicyRegistry();
  policies.register(DICE_ROLL_POLICY);
  return new AuthorizationService(policies);
}

function actorOf(role: Role, userId = ACTOR): ActorRef {
  return { userId, campaignId: CAMPAIGN, role };
}

function setup(role: Role | undefined, random: RandomSource = seededRandom(1)) {
  const authorization = decider();
  const store = new InMemoryRepository<RollRecord>();
  let ids = 0;
  const repository = new RollLocalRepository(
    store,
    { userId: ACTOR, campaignId: CAMPAIGN },
    async (roll) =>
      role !== undefined &&
      mayCreateRoll(authorization, actorOf(role), { campaignId: CAMPAIGN, ...roll }),
    {
      random,
      clock: () => new Date('2026-10-31T12:00:00.000Z'),
      createId: () => {
        ids += 1;
        return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
      },
    },
  );
  return { store, repository };
}

function record(overrides: Partial<RollRecord> = {}): RollRecord {
  const parsed = parseRoll('2d6+3');
  if (!parsed.ok) throw new Error('parse');
  const result = evaluateRoll(parsed.value, {}, seededRandom(3));
  if (!result.ok) throw new Error('evaluate');
  return {
    id: '00000000-0000-4000-8000-000000000099',
    campaignId: CAMPAIGN,
    type: ROLL_RECORD_TYPE,
    name: '2d6+3',
    tags: [],
    metadata: {},
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: '2026-10-31T12:00:00.000Z',
    createdBy: ACTOR,
    updatedAt: '2026-10-31T12:00:00.000Z',
    updatedBy: ACTOR,
    actorUserId: ACTOR,
    expression: '2d6+3',
    inputs: {},
    result: result.value,
    rollVisibility: 'public',
    rolledAt: '2026-10-31T12:00:00.000Z',
    ...overrides,
  };
}

describe('visibility mapping (D-11)', () => {
  test('every value maps to one standard Visibility', () => {
    expect(rollVisibilityToVisibility('public', ACTOR)).toEqual({ mode: 'everyone' });
    expect(rollVisibilityToVisibility('gm_only', ACTOR)).toEqual({ mode: 'gm_only' });
    expect(rollVisibilityToVisibility('blind', ACTOR)).toEqual({ mode: 'gm_only' });
    expect(rollVisibilityToVisibility('player_only', ACTOR)).toEqual({
      mode: 'players',
      playerIds: [ACTOR],
    });
    expect(rollVisibilityToVisibility('whisper', ACTOR, [OTHER, EARLIER, OTHER])).toEqual({
      mode: 'players',
      playerIds: [EARLIER, ACTOR, OTHER],
    });
  });

  test('a whisper names someone; nothing else takes recipients; the count is bounded', () => {
    expect(rollVisibilityToVisibility('whisper', ACTOR)).toBe('invalid_recipients');
    expect(rollVisibilityToVisibility('whisper', ACTOR, [ACTOR])).toBe('invalid_recipients');
    expect(rollVisibilityToVisibility('public', ACTOR, [OTHER])).toBe('invalid_recipients');
    const many = Array.from(
      { length: MAX_WHISPER_RECIPIENTS + 1 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    );
    expect(rollVisibilityToVisibility('whisper', ACTOR, many)).toBe('invalid_recipients');
  });

  test.each<[Parameters<typeof rollVisibilityAgrees>[0], Visibility, boolean]>([
    ['public', { mode: 'everyone' }, true],
    ['public', { mode: 'gm_only' }, false],
    ['gm_only', { mode: 'gm_only' }, true],
    ['gm_only', { mode: 'everyone' }, false],
    ['blind', { mode: 'gm_only' }, true],
    ['blind', { mode: 'players', playerIds: [ACTOR] }, false],
    ['player_only', { mode: 'players', playerIds: [ACTOR] }, true],
    ['player_only', { mode: 'players', playerIds: [OTHER] }, false],
    ['player_only', { mode: 'players', playerIds: [ACTOR, OTHER] }, false],
    ['whisper', { mode: 'players', playerIds: [ACTOR, OTHER] }, true],
    ['whisper', { mode: 'players', playerIds: [OTHER, ACTOR] }, false],
    ['whisper', { mode: 'players', playerIds: [ACTOR] }, false],
    ['whisper', { mode: 'players', playerIds: [EARLIER, OTHER] }, false],
  ])('%s with %j agrees: %p', (label, visibility, expected) => {
    expect(rollVisibilityAgrees(label, ACTOR, visibility)).toBe(expected);
  });
});

describe('D-12: an actor can only create a roll they could read', () => {
  const service = decider();
  const roll = (visibility: Visibility) => ({ campaignId: CAMPAIGN, id: EARLIER, visibility });

  test.each<[Role, boolean]>([
    ['owner', true],
    ['gm', true],
    ['assistant_gm', true],
    ['player', false],
    ['observer', false],
  ])('%s creating a GM-only roll: %p', (role, allowed) => {
    expect(mayCreateRoll(service, actorOf(role), roll({ mode: 'gm_only' }))).toBe(allowed);
  });

  test('a player can roll in the open, privately, and in a whisper they are part of', () => {
    const player = actorOf('player');
    expect(mayCreateRoll(service, player, roll({ mode: 'everyone' }))).toBe(true);
    expect(mayCreateRoll(service, player, roll({ mode: 'players', playerIds: [ACTOR] }))).toBe(
      true,
    );
    expect(mayCreateRoll(service, player, roll({ mode: 'players', playerIds: [OTHER] }))).toBe(
      false,
    );
  });

  test('an actor from another campaign is denied', () => {
    const foreign = { ...actorOf('owner'), campaignId: OTHER };
    expect(mayCreateRoll(service, foreign, roll({ mode: 'everyone' }))).toBe(false);
  });
});

describe('RollLocalRepository', () => {
  test('a roll is readable at once with its whole context', async () => {
    const { repository, store } = setup('player');
    const rolled = await repository.roll({
      expression: '1d20+ATTRIBUTE_A',
      inputs: { ATTRIBUTE_A: 2, UNRELATED_SECRET: 99 },
      visibility: 'public',
      actorRef: 'character-1',
      targetRef: 'goblin-1',
      action: 'attack',
      sessionId: EARLIER,
    });
    if (!rolled.ok) throw new Error(JSON.stringify(rolled.error));
    expect(rolled.value).toMatchObject({
      actorUserId: ACTOR,
      actorRef: 'character-1',
      targetRef: 'goblin-1',
      action: 'attack',
      name: 'attack',
      sessionId: EARLIER,
      expression: '1d20+ATTRIBUTE_A',
      rollVisibility: 'public',
      visibility: { mode: 'everyone' },
      rolledAt: '2026-10-31T12:00:00.000Z',
    });
    expect(rolled.value.result.modified).toBe(rolled.value.result.natural + 2);
    // FR-004: only what the expression named is kept.
    expect(rolled.value.inputs).toEqual({ ATTRIBUTE_A: 2 });
    expect(await repository.get(rolled.value.id)).toEqual(rolled.value);
    const stored = await store.get(rolled.value.id);
    expect(stored.ok).toBe(true);
    expect(checkRollRecord(rolled.value)).toBeUndefined();
  });

  test.each([
    ['gm_only', 'player'],
    ['blind', 'player'],
    ['gm_only', undefined],
    ['public', undefined],
    ['public', 'observer'],
  ] as const)('%s by %s is refused and leaves nothing', async (visibility, role) => {
    const { repository, store } = setup(role);
    const rolled = await repository.roll({ expression: '1d20', visibility });
    expect(rolled).toEqual({ ok: false, error: { code: 'hidden_from_roller' } });
    const listed = await store.list(CAMPAIGN);
    expect(listed.ok && listed.value).toEqual([]);
  });

  test.each(['gm_only', 'blind', 'public', 'player_only'] as const)(
    'a GM can roll %s',
    async (visibility) => {
      const { repository } = setup('gm');
      expect((await repository.roll({ expression: '1d20', visibility })).ok).toBe(true);
    },
  );

  test('a whisper includes the roller and the recipient', async () => {
    const { repository } = setup('player');
    const rolled = await repository.roll({
      expression: '1d20',
      visibility: 'whisper',
      recipients: [OTHER],
    });
    expect(rolled.ok && rolled.value.visibility).toEqual({
      mode: 'players',
      playerIds: [ACTOR, OTHER],
    });
    expect(await repository.roll({ expression: '1d20', visibility: 'whisper' })).toEqual({
      ok: false,
      error: { code: 'invalid_recipients' },
    });
  });

  test('a bad expression or a missing input rolls nothing', async () => {
    const { repository, store } = setup('gm');
    const bad = await repository.roll({ expression: '1d7', visibility: 'public' });
    expect(!bad.ok && bad.error.code).toBe('parse');
    const missing = await repository.roll({ expression: '1d6+x', visibility: 'public' });
    expect(!missing.ok && missing.error.code).toBe('evaluation');
    const listed = await store.list(CAMPAIGN);
    expect(listed.ok && listed.value).toEqual([]);
  });

  test('each roll gets its own identity, and lists are chronological and filterable', async () => {
    const { repository } = setup('gm');
    const first = await repository.roll({ expression: '1d6', visibility: 'public' });
    const second = await repository.roll({
      expression: '1d6',
      visibility: 'public',
      sessionId: EARLIER,
    });
    if (!first.ok || !second.ok) throw new Error('roll');
    expect(first.value.id).not.toBe(second.value.id);
    expect((await repository.list()).map((roll) => roll.id)).toEqual([
      first.value.id,
      second.value.id,
    ]);
    expect((await repository.list({ sessionId: EARLIER })).map((roll) => roll.id)).toEqual([
      second.value.id,
    ]);
  });

  test('the default source is cryptographic and yields a replayable record', async () => {
    const repository = new RollLocalRepository(
      new InMemoryRepository<RollRecord>(),
      { userId: ACTOR, campaignId: CAMPAIGN },
      async () => true,
    );
    const rolled = await repository.roll({ expression: '4d6kh3', visibility: 'public' });
    expect(rolled.ok && checkRollRecord(rolled.value)).toBeUndefined();
  });
});

describe('checkRollRecord', () => {
  test('a faithful record passes', () => {
    expect(checkRollRecord(record())).toBeUndefined();
  });

  test.each<[string, Partial<RollRecord> | Record<string, unknown>, string]>([
    ['an unknown field', { extra: 1 }, 'invalid_shape'],
    ['an unknown label', { rollVisibility: 'secret' }, 'invalid_shape'],
    ['an uppercase id', { actorUserId: 'ABC' }, 'invalid_shape'],
    ['NUL in a reference', { actorRef: 'a\u0000b' }, 'invalid_shape'],
    ['an impossible date', { rolledAt: '2026-13-45T00:00:00.000Z' }, 'invalid_shape'],
    ['a fractional input', { inputs: { x: 1.5 } }, 'invalid_shape'],
    ['a creator who is not the actor', { createdBy: OTHER }, 'actor_mismatch'],
    ['a second version', { version: 2 }, 'immutable_fields'],
    ['a tombstone', { deletedAt: '2026-10-31T12:00:00.000Z' }, 'immutable_fields'],
    ['tags', { tags: ['x'] }, 'immutable_fields'],
    ['a label and Visibility disagreeing', { rollVisibility: 'gm_only' }, 'visibility_mismatch'],
    ['an expression that does not parse', { expression: '1d7' }, 'not_replayable'],
    ['another expression', { expression: '2d6+4' }, 'not_replayable'],
    ['an input it did not name', { inputs: { x: 1 } }, 'not_replayable'],
  ])('%s is refused', (_name, overrides, defect) => {
    expect(checkRollRecord(record(overrides as Partial<RollRecord>))).toBe(defect as never);
  });

  test('a changed result is refused', () => {
    const faithful = record();
    expect(
      checkRollRecord({
        ...faithful,
        result: { ...faithful.result, modified: faithful.result.modified + 1 },
      }),
    ).toBe('not_replayable');
  });
});

describe('replica row', () => {
  test('a record survives the row round trip, with JSON and provider timestamps', () => {
    const faithful = record({
      action: 'attack',
      actorRef: 'c-1',
      sessionId: EARLIER,
      name: 'attack',
    });
    const row = ROLL_ROW_CODEC.toRow(faithful);
    expect(ROLL_ROW_CODEC.fromRow({ ...row, id: faithful.id })).toEqual(faithful);
    const providerTime = ROLL_ROW_CODEC.fromRow({
      ...row,
      id: faithful.id,
      rolled_at: '2026-10-31 12:00:00.000000Z',
      created_at: '2026-10-31 12:00:00.000000Z',
    });
    expect(providerTime?.rolledAt).toBe(faithful.rolledAt);
  });

  test('a row that does not map is never guessed', () => {
    const row = { ...ROLL_ROW_CODEC.toRow(record()), id: record().id };
    expect(ROLL_ROW_CODEC.fromRow({ ...row, result: '{broken' })).toBeUndefined();
    expect(ROLL_ROW_CODEC.fromRow({ ...row, visibility_mode: 'nobody' })).toBeUndefined();
    expect(ROLL_ROW_CODEC.fromRow({ ...row, roll_visibility: 'x' })).toBeUndefined();
    expect(ROLL_ROW_CODEC.fromRow({ ...row, rolled_at: 'never' })).toBeUndefined();
  });

  test('the codec writes exactly the replica columns', () => {
    expect(Object.keys(ROLL_ROW_CODEC.toRow(record())).sort()).toEqual(
      Object.keys(DICE_REPLICA_TABLES.dice_rolls.columns).sort(),
    );
    expect(diceReplicaProjection()[0]).toBe('id');
  });
});

describe('local budget (D-15)', () => {
  /** Projected local size in MB of 4 800 such rolls, with the freeze overhead of 2.2x on raw JSON. */
  function projectedMegabytes(expression: string, inputs: Readonly<Record<string, number>>) {
    const parsed = parseRoll(expression);
    if (!parsed.ok) throw new Error('parse');
    const result = evaluateRoll(parsed.value, inputs, seededRandom(4));
    if (!result.ok) throw new Error('evaluate');
    const row = ROLL_ROW_CODEC.toRow(
      record({
        expression,
        inputs,
        result: result.value,
        actorRef: 'character-00000000-0000-4000-8000-000000000001',
        targetRef: 'creature-00000000-0000-4000-8000-000000000002',
        action: 'attack',
        sessionId: EARLIER,
      }),
    );
    const bytes = new TextEncoder().encode(JSON.stringify(row)).length + 36;
    return (bytes * 2.2 * 4_800) / 1_000_000;
  }

  test('the projected 4 800 rolls of either MVP paradigm fit the 10 MB allowance', () => {
    expect(projectedMegabytes('1d20+ATTRIBUTE_A', { ATTRIBUTE_A: 3 })).toBeLessThan(10);
    expect(projectedMegabytes('4dF + skill', { skill: 3 })).toBeLessThan(10);
  });

  test('the largest roll the limits allow is still small', () => {
    const parsed = parseRoll(`${ROLL_LIMITS.totalDice}d100`);
    if (!parsed.ok) throw new Error('parse');
    const result = evaluateRoll(parsed.value, {}, seededRandom(4));
    if (!result.ok) throw new Error('evaluate');
    expect(JSON.stringify(result.value).length).toBeLessThan(5_000);
  });
});
