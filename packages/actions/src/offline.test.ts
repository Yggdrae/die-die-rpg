import { describe, expect, test } from 'bun:test';
import { InMemoryRepository } from '@rpg/contracts/testing';
import type { ResolvedPlan } from './engine/planner.ts';
import { EMPTY_TARGET_STATE, type TargetState } from './engine/state.ts';
import { EffectLocalRepository } from './offline.ts';
import {
  checkEffectRecord,
  EFFECT_RECORD_TYPE,
  EFFECT_ROW_CODEC,
  type EffectRecord,
} from './records.ts';

const CAMPAIGN = '00000000-0000-4000-8000-000000001101';
const ACTOR = '00000000-0000-4000-8000-0000000011a1';
const TARGET = { targetClass: 'character', targetId: '00000000-0000-4000-8000-0000000011b1' };
const OTHER = { targetClass: 'creature', targetId: '00000000-0000-4000-8000-0000000011b2' };
const AT = '2026-11-01T12:00:00.000Z';

function damage(amount: number): ResolvedPlan {
  const path = 'resources.hp.current';
  return {
    action: 'hit',
    outcome: 'landed',
    operations: [
      { operation: { op: 'delta', path, value: -amount } },
      { operation: { op: 'clamp', path, min: 0, max: 10 } },
    ],
    changes: [],
    followUps: [],
    edited: false,
  };
}

function setup() {
  const store = new InMemoryRepository<EffectRecord>();
  let ids = 0;
  let tick = 0;
  const repository = new EffectLocalRepository(
    store,
    { userId: ACTOR, campaignId: CAMPAIGN },
    {
      clock: () => new Date(Date.parse(AT) + 1000 * tick++),
      createId: () => {
        ids += 1;
        return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
      },
    },
  );
  return { store, repository };
}

const BASE: TargetState = { ...EMPTY_TARGET_STATE, resources: { hp: { current: 8 } } };

describe('EffectLocalRepository', () => {
  test('an application is recorded at once, shaped as the authority expects', async () => {
    const { repository } = setup();
    const applied = await repository.apply(
      { ...TARGET, visibility: { mode: 'everyone' } },
      damage(3),
      { sessionId: TARGET.targetId },
    );
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    expect(applied.value).toMatchObject({
      type: EFFECT_RECORD_TYPE,
      actorUserId: ACTOR,
      name: 'hit',
      action: 'hit',
      outcome: 'landed',
      targetClass: 'character',
      changes: [],
      edited: false,
    });
    expect(applied.value.acceptedAt).toBeUndefined();
    expect(checkEffectRecord(applied.value)).toBeUndefined();
    expect(await repository.get(applied.value.id)).toEqual(applied.value);
  });

  test('a plan with only follow-ups records nothing', async () => {
    const { repository } = setup();
    expect(
      await repository.apply(
        { ...TARGET, visibility: { mode: 'everyone' } },
        { operations: [], changes: [], followUps: ['save'], edited: false },
      ),
    ).toEqual({ ok: false, error: { code: 'nothing_to_apply' } });
    expect(await repository.list()).toEqual([]);
  });

  test('the display adds what is pending, for this target only, and never what was accepted', async () => {
    const { repository, store } = setup();
    const visible = { visibility: { mode: 'everyone' } as const };
    const first = await repository.apply({ ...TARGET, ...visible }, damage(3));
    await repository.apply({ ...OTHER, ...visible }, damage(5));
    expect((await repository.displayedState(TARGET, BASE)).resources.hp?.current).toBe(5);
    expect((await repository.displayedState(OTHER, BASE)).resources.hp?.current).toBe(3);
    if (!first.ok) throw new Error('apply');
    // Accepted: the owner's replica already holds it, so the overlay must not count it again.
    await store.upsert({ ...first.value, acceptedAt: AT }, 1);
    expect((await repository.displayedState(TARGET, BASE)).resources.hp?.current).toBe(8);
  });

  test('a rejected record stops counting', async () => {
    const { repository } = setup();
    const applied = await repository.apply(
      { ...TARGET, visibility: { mode: 'everyone' } },
      damage(3),
    );
    if (!applied.ok) throw new Error('apply');
    const display = await repository.displayedState(TARGET, BASE, new Set([applied.value.id]));
    expect(display.resources.hp?.current).toBe(8);
  });

  test('lists are chronological and filter by session', async () => {
    const { repository } = setup();
    const visible = { ...TARGET, visibility: { mode: 'everyone' } as const };
    const first = await repository.apply(visible, damage(1));
    const second = await repository.apply(visible, damage(1), { sessionId: OTHER.targetId });
    if (!first.ok || !second.ok) throw new Error('apply');
    expect((await repository.list()).map((record) => record.id)).toEqual([
      first.value.id,
      second.value.id,
    ]);
    expect(
      (await repository.list({ sessionId: OTHER.targetId })).map((record) => record.id),
    ).toEqual([second.value.id]);
  });
});

describe('checkEffectRecord', () => {
  function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '00000000-0000-4000-8000-000000000099',
      campaignId: CAMPAIGN,
      type: EFFECT_RECORD_TYPE,
      name: 'hit',
      tags: [],
      metadata: {},
      visibility: { mode: 'everyone' },
      version: 1,
      createdAt: AT,
      createdBy: ACTOR,
      updatedAt: AT,
      updatedBy: ACTOR,
      actorUserId: ACTOR,
      ...TARGET,
      operations: damage(1).operations,
      changes: [],
      edited: false,
      appliedAt: AT,
      ...overrides,
    };
  }

  test('a faithful record passes', () => {
    expect(checkEffectRecord(valid())).toBeUndefined();
  });

  test.each<[string, Record<string, unknown>, string]>([
    ['an unknown field', { extra: 1 }, 'invalid_shape'],
    ['no operations', { operations: [] }, 'invalid_shape'],
    ['an unsafe target class', { targetClass: 'Robert; drop' }, 'invalid_shape'],
    ['NUL in a reference', { action: 'a\u0000b' }, 'invalid_shape'],
    ['an impossible date', { appliedAt: '2026-13-45T00:00:00.000Z' }, 'invalid_shape'],
    ['a creator who is not the actor', { createdBy: OTHER.targetId }, 'actor_mismatch'],
    ['a second version', { version: 2 }, 'immutable_fields'],
    ['a tombstone', { deletedAt: AT }, 'immutable_fields'],
    ['a client claiming acceptance', { acceptedAt: AT }, 'authority_fields'],
    [
      'a client claiming changes',
      { changes: [{ path: 'fields.a', before: 1, after: 2 }] },
      'authority_fields',
    ],
    [
      'a prototype path',
      { operations: [{ operation: { op: 'set', path: 'fields.__proto__', value: 1 } }] },
      'invalid_operation',
    ],
    [
      'a guard on a bad path',
      {
        operations: [
          {
            operation: { op: 'set', path: 'fields.a', value: 1 },
            requires: { path: 'nope', equals: 1 },
          },
        ],
      },
      'invalid_operation',
    ],
    [
      'a fractional delta',
      { operations: [{ operation: { op: 'delta', path: 'fields.a', value: 1.5 } }] },
      'invalid_operation',
    ],
    [
      'a zero delta',
      { operations: [{ operation: { op: 'delta', path: 'fields.a', value: 0 } }] },
      'invalid_operation',
    ],
  ])('%s is refused', (_name, overrides, defect) => {
    expect(checkEffectRecord(valid(overrides))).toBe(defect as never);
  });
});

describe('replica row', () => {
  test('a record survives the round trip, pending and accepted', async () => {
    const { repository } = setup();
    const applied = await repository.apply(
      { ...TARGET, visibility: { mode: 'everyone' } },
      { ...damage(1), edited: true },
      { rollId: TARGET.targetId },
    );
    if (!applied.ok) throw new Error('apply');
    const row = EFFECT_ROW_CODEC.toRow(applied.value);
    expect(EFFECT_ROW_CODEC.fromRow({ ...row, id: applied.value.id })).toEqual(applied.value);
    const accepted = EFFECT_ROW_CODEC.fromRow({
      ...row,
      id: applied.value.id,
      accepted_at: '2026-11-01 12:00:05.000000Z',
      changes: JSON.stringify([{ path: 'resources.hp.current', before: 8, after: 7 }]),
    });
    expect(accepted?.acceptedAt).toBe('2026-11-01T12:00:05.000Z');
    expect(accepted?.changes.length).toBe(1);
  });

  test('a row that does not map is never guessed', () => {
    expect(
      EFFECT_ROW_CODEC.fromRow({
        id: TARGET.targetId,
        campaign_id: CAMPAIGN,
        actor_user_id: ACTOR,
        target_class: 'character',
        target_id: TARGET.targetId,
        operations: '{broken',
        changes: '[]',
        edited: 0,
        visibility_mode: 'everyone',
        visibility_targets: '[]',
        version: 1,
        applied_at: AT,
      }),
    ).toBeUndefined();
  });
});
