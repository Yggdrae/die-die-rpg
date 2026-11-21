import { afterAll, describe, expect, test } from 'bun:test';
import { ExportRegistry } from '@rpg/campaign-portability';
import { exportContributorProblems } from '@rpg/campaign-portability/testing';
import type { ImportContext } from '@rpg/contracts';
import {
  countDiceRecords,
  type DiceChunk,
  evaluateRoll,
  parseRoll,
  ROLL_RECORD_TYPE,
  RollExporter,
  type RollRecord,
  seededRandom,
} from '@rpg/dice';
import {
  connectDiceDatabase,
  PostgresDiceImportWriter,
  PostgresRollRepository,
} from '@rpg/dice/postgres';
import postgres from 'postgres';

/**
 * Feature 09 D-16 on PostgreSQL: roll history leaves through the export contributor and returns through
 * the import writer, on a real transaction. Rows are deleted afterwards.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from dice_rolls limit 1`;
    return true;
  } catch {
    return false;
  }
})();

const source = crypto.randomUUID();
const target = crypto.randomUUID();
const actor = crypto.randomUUID();
const importer = crypto.randomUUID();
const connection =
  available && databaseUrl !== undefined ? connectDiceDatabase(databaseUrl) : undefined;

afterAll(async () => {
  if (available && sql !== undefined) {
    await sql`delete from dice_rolls where campaign_id in (${source}, ${target})`;
  }
  await connection?.close();
  await sql?.end({ timeout: 1 });
});

function roll(expression: string, seed: number, overrides: Partial<RollRecord> = {}): RollRecord {
  const parsed = parseRoll(expression);
  if (!parsed.ok) throw new Error('parse');
  const inputs: Readonly<Record<string, number>> = expression.includes('skill') ? { skill: 2 } : {};
  const result = evaluateRoll(parsed.value, inputs, seededRandom(seed));
  if (!result.ok) throw new Error('evaluate');
  const at = '2026-10-31T10:00:00.000Z';
  return {
    id: crypto.randomUUID(),
    campaignId: source,
    type: ROLL_RECORD_TYPE,
    name: expression,
    tags: [],
    metadata: {},
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: at,
    createdBy: actor,
    updatedAt: at,
    updatedBy: actor,
    actorUserId: actor,
    expression,
    inputs,
    result: result.value,
    rollVisibility: 'public',
    rolledAt: at,
    ...overrides,
  };
}

describe.skipIf(!available)('roll export and import on PostgreSQL', () => {
  test('history round trips, and a targeted roll narrows without widening', async () => {
    const database = connection?.db;
    if (database === undefined) throw new Error('database unavailable');
    const rolls = new PostgresRollRepository(database);
    const other = crypto.randomUUID();
    const seeds = [
      roll('4dF + skill', 1),
      roll('1d20', 2, { visibility: { mode: 'gm_only' }, rollVisibility: 'blind' }),
      roll('6d6 success>=6', 3, {
        visibility: { mode: 'players', playerIds: [actor, other].sort() },
        rollVisibility: 'whisper',
      }),
    ];
    await rolls.transaction(async (transaction) => {
      for (const record of seeds) {
        expect((await rolls.insert(transaction, record)).ok).toBe(true);
      }
    });

    const exporter = new RollExporter(rolls, {
      writer: new PostgresDiceImportWriter(rolls),
      unwrap: (transaction) => transaction,
    });
    const registry = new ExportRegistry().register(exporter, {
      placement: 'entities',
      countRecords: countDiceRecords,
    });
    const registration = registry.get('dice_rolls');
    if (registration === undefined) throw new Error('not registered');
    expect(await exportContributorProblems(registration, source, { expectedRecords: 3 })).toEqual(
      [],
    );

    const chunk = await exporter.export(source);
    const restored = await rolls.transaction(async (transaction) =>
      exporter.restore(chunk, {
        campaignId: target,
        importerUserId: importer,
        // The test's own stand-in for the feature 07 transaction capability.
        transaction: transaction as unknown as ImportContext['transaction'],
        mapId: (_kind, sourceId) =>
          _kind === 'dice_roll'
            ? `${sourceId.slice(0, -1)}${sourceId.endsWith('a') ? 'b' : 'a'}`
            : undefined,
      }),
    );
    expect(restored.ok && restored.value.restoredCount).toBe(3);
    expect(restored.ok && restored.value.warnings.map((warning) => warning.code)).toEqual([
      'visibility_narrowed_to_gm_only',
    ]);

    const imported = await rolls.list(target);
    expect(imported.every((record) => record.actorUserId === importer)).toBe(true);
    expect(imported.map((record) => record.rollVisibility).sort()).toEqual([
      'blind',
      'gm_only',
      'public',
    ]);
    expect(imported.map((record) => record.result.modified).sort()).toEqual(
      seeds.map((record) => record.result.modified).sort(),
    );
    // Importing the same chunk again collides, and collides safely.
    const payload = chunk.payload as DiceChunk;
    expect(payload.rolls.length).toBe(3);
    const collision = await rolls.transaction(async (transaction) =>
      exporter.restore(chunk, {
        campaignId: target,
        importerUserId: importer,
        transaction: transaction as unknown as ImportContext['transaction'],
        mapId: (_kind, sourceId) => `${sourceId.slice(0, -1)}${sourceId.endsWith('a') ? 'b' : 'a'}`,
      }),
    );
    expect(collision).toEqual({ ok: false, error: 'dice_restore_conflict' });
  });
});
