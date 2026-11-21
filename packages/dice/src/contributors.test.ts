import { describe, expect, test } from 'bun:test';
import {
  check,
  type ExportChunk,
  type ImportContext,
  ok,
  type Result,
  type Visibility,
} from '@rpg/contracts';
import {
  countDiceRecords,
  DICE_CHUNK_INVALID,
  DICE_ID_UNMAPPED,
  DICE_IMPORT_UNAVAILABLE,
  DICE_IMPORT_UNSUPPORTED,
  DICE_ROLL_INVALID,
  DiceChunk,
  type DiceRestorePlan,
  RollExporter,
} from './contributors.ts';
import { evaluateRoll, parseRoll, seededRandom } from './engine/index.ts';
import { ROLL_RECORD_TYPE, type RollRecord, type RollVisibility } from './records.ts';

/**
 * Unit checks with no database: byte-identical reads, what the chunk leaves out, and every import rule.
 * The PostgreSQL round trip is `apps/api/src/modules/portability/dice-contributor.integration.test.ts`.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000009c1';
const ACTOR = '00000000-0000-4000-8000-0000000009a1';
const OTHER = '00000000-0000-4000-8000-0000000009b2';
const IMPORTER = '00000000-0000-4000-8000-0000000009f1';
const AT = '2026-10-31T10:00:00.000Z';
const id = (suffix: string) => `00000000-0000-4000-8000-0000000009${suffix}`;

function roll(suffix: string, label: RollVisibility, visibility: Visibility): RollRecord {
  const parsed = parseRoll('1d20+ATTRIBUTE_A');
  if (!parsed.ok) throw new Error('parse');
  const inputs = { ATTRIBUTE_A: 2 };
  const result = evaluateRoll(parsed.value, inputs, seededRandom(Number.parseInt(suffix, 16)));
  if (!result.ok) throw new Error('evaluate');
  return {
    id: id(suffix),
    campaignId: CAMPAIGN,
    type: ROLL_RECORD_TYPE,
    name: 'attack',
    tags: [],
    metadata: {},
    visibility,
    version: 1,
    createdAt: AT,
    createdBy: ACTOR,
    updatedAt: AT,
    updatedBy: ACTOR,
    actorUserId: ACTOR,
    actorRef: 'character-secret-ref',
    targetRef: 'target-secret-ref',
    action: 'attack',
    sessionId: id('ee'),
    expression: '1d20+ATTRIBUTE_A',
    inputs,
    result: result.value,
    rollVisibility: label,
    rolledAt: AT,
  };
}

const ROLLS: readonly RollRecord[] = [
  roll('02', 'public', { mode: 'everyone' }),
  roll('01', 'blind', { mode: 'gm_only' }),
  roll('03', 'whisper', { mode: 'players', playerIds: [ACTOR, OTHER] }),
];

function capture() {
  const plans: DiceRestorePlan[] = [];
  const exporter = new RollExporter(
    { list: async () => ROLLS },
    {
      writer: {
        restoreWithin: async (_handle, plan): Promise<Result<void, string>> => {
          plans.push(plan);
          return ok(undefined);
        },
      },
      unwrap: () => 'handle',
    },
  );
  return { exporter, plans };
}

function context(mapped = true): ImportContext {
  return {
    campaignId: id('c2'),
    importerUserId: IMPORTER,
    transaction: { brand: 'ImportTransaction' },
    mapId: (kind, sourceId) =>
      kind === 'dice_roll' && mapped ? sourceId.replace('0009', '0010') : undefined,
  };
}

describe('export', () => {
  test('rows are ordered, valid, and two reads are identical', async () => {
    const { exporter } = capture();
    const first = await exporter.export(CAMPAIGN);
    expect(check(DiceChunk, first.payload)).toBe(true);
    const payload = first.payload as DiceChunk;
    expect(payload.rolls.map((row) => row.id)).toEqual([id('01'), id('02'), id('03')]);
    expect(countDiceRecords(payload)).toBe(3);
    expect(JSON.stringify(await exporter.export(CAMPAIGN))).toBe(JSON.stringify(first));
  });

  test('actor, session, and caller refs stay out; names are values, never keys', async () => {
    const { exporter } = capture();
    const text = JSON.stringify((await exporter.export(CAMPAIGN)).payload);
    for (const absent of [ACTOR.slice(-3) === 'x', 'secret-ref', id('ee')]) {
      expect(text).not.toContain(String(absent));
    }
    const payload = (await exporter.export(CAMPAIGN)).payload as DiceChunk;
    expect(payload.rolls[0]?.inputs).toEqual([{ name: 'ATTRIBUTE_A', value: 2 }]);
  });
});

describe('import', () => {
  test('restores results; hidden stays hidden, public stays public, targeted narrows', async () => {
    const { exporter, plans } = capture();
    const chunk = await exporter.export(CAMPAIGN);
    const validated = await exporter.validate(chunk);
    expect(validated.ok && validated.value.defines.length).toBe(3);
    const restored = await exporter.restore(chunk, context());
    expect(restored).toEqual({
      ok: true,
      value: {
        restoredCount: 3,
        warnings: [{ code: 'visibility_narrowed_to_gm_only', sourceId: id('03') }],
      },
    });
    const [plan] = plans;
    expect(plan?.campaignId).toBe(id('c2'));
    expect(plan?.actorUserId).toBe(IMPORTER);
    expect(
      plan?.rolls.map((row) => [row.id.slice(-2), row.rollVisibility, row.visibility.mode]),
    ).toEqual([
      ['01', 'blind', 'gm_only'],
      ['02', 'public', 'everyone'],
      ['03', 'gm_only', 'gm_only'],
    ]);
    expect(plan?.rolls[0]?.inputs).toEqual({ ATTRIBUTE_A: 2 });
    expect(plan?.rolls[0]?.result).toEqual(ROLLS[1]?.result as RollRecord['result']);
  });

  test('a validate writes nothing', async () => {
    const { exporter, plans } = capture();
    await exporter.validate(await exporter.export(CAMPAIGN));
    expect(plans).toEqual([]);
  });

  test('every hostile chunk gets a safe code', async () => {
    const { exporter } = capture();
    const good = await exporter.export(CAMPAIGN);
    const payload = good.payload as DiceChunk;
    const first = payload.rolls[0] as DiceChunk['rolls'][number];
    const refused: readonly [ExportChunk, string][] = [
      [{ ...good, moduleId: 'other' }, DICE_CHUNK_INVALID],
      [{ ...good, chunkVersion: '9' }, DICE_CHUNK_INVALID],
      [{ ...good, payload: { campaignId: CAMPAIGN } }, DICE_CHUNK_INVALID],
      [
        { ...good, payload: { ...payload, rolls: [{ ...first, secret: true }] } },
        DICE_CHUNK_INVALID,
      ],
      [
        {
          ...good,
          payload: {
            ...payload,
            rolls: [{ ...first, result: { ...first.result, modified: 999 } }],
          },
        },
        DICE_ROLL_INVALID,
      ],
      [
        { ...good, payload: { ...payload, rolls: [{ ...first, expression: '1d7' }] } },
        DICE_ROLL_INVALID,
      ],
    ];
    for (const [chunk, code] of refused) {
      expect(await exporter.validate(chunk)).toEqual({ ok: false, error: code });
    }
    expect(await exporter.restore(good, context(false))).toEqual({
      ok: false,
      error: DICE_ID_UNMAPPED,
    });
    expect(await new RollExporter({ list: async () => [] }).restore(good, context())).toEqual({
      ok: false,
      error: DICE_IMPORT_UNAVAILABLE,
    });
    expect(await exporter.import(CAMPAIGN, good)).toEqual({
      ok: false,
      error: DICE_IMPORT_UNSUPPORTED,
    });
  });
});
