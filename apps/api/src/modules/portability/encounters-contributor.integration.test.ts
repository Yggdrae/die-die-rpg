import { afterAll, describe, expect, test } from 'bun:test';
import { ExportRegistry } from '@rpg/campaign-portability';
import { exportContributorProblems } from '@rpg/campaign-portability/testing';
import { initialCharacterState } from '@rpg/characters';
import type { ImportContext } from '@rpg/contracts';
import { countEncounterRecords, ENCOUNTER_MODULE_ID, EncounterExporter } from '@rpg/encounters';
import {
  connectEncountersDatabase,
  PostgresEncounterImportWriter,
  PostgresEncounterRepository,
} from '@rpg/encounters/postgres';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import postgres from 'postgres';

/**
 * Feature 19 D-15 on PostgreSQL: encounters, GM notes, participants, and instance states leave through the export
 * contributor and return through the import writer on a real transaction, owned by the importer. A session or
 * location not restored is cleared with a warning; a participant whose source was not restored is dropped with one.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from encounters, encounter_participant_states limit 1`;
    return true;
  } catch {
    return false;
  }
})();

const source = crypto.randomUUID();
const target = crypto.randomUUID();
const gm = crypto.randomUUID();
const importer = crypto.randomUUID();
const connection =
  available && databaseUrl !== undefined ? connectEncountersDatabase(databaseUrl) : undefined;

afterAll(async () => {
  if (available && sql !== undefined) {
    for (const table of [
      'encounter_participant_states',
      'encounter_participants',
      'encounter_gm_notes',
      'encounters',
    ]) {
      await sql.unsafe(`delete from ${table} where campaign_id in ($1, $2)`, [source, target]);
    }
  }
  await connection?.close();
  await sql?.end({ timeout: 1 });
});

describe.skipIf(!available)('encounter export and import on PostgreSQL', () => {
  test('encounters round trip to the importer with their links mapped', async () => {
    const database = connection?.db;
    if (database === undefined) throw new Error('database unavailable');
    const encounters = new PostgresEncounterRepository(database);
    const ended = crypto.randomUUID();
    const open = crypto.randomUUID();
    const session = crypto.randomUUID();
    const lostLocation = crypto.randomUUID();
    const character = crypto.randomUUID();
    const bandit = crypto.randomUUID();
    const lostEntity = crypto.randomUUID();
    const state = {
      ...initialCharacterState(FIXTURE_SYSTEM_PACKAGE, 'Bandit 1'),
      resources: { focus: { current: 2 } },
    };
    await encounters.transaction(async (transaction) => {
      await encounters.insertEncounter(transaction, {
        id: ended,
        campaignId: source,
        sessionId: session,
        name: 'Ambush at the ford',
        status: 'ended',
        startedAt: '2026-11-01T18:00:00.000Z',
        endedAt: '2026-11-01T18:30:00.000Z',
        environment: 'Dusk, river mist',
        locationId: lostLocation,
        actorUserId: gm,
      });
      await encounters.insertNote(transaction, {
        id: ended,
        campaignId: source,
        body: 'The leader flees at half',
        actorUserId: gm,
      });
      await encounters.insertEncounter(transaction, {
        id: open,
        campaignId: source,
        name: 'Second wave',
        status: 'active',
        startedAt: '2026-11-02T18:00:00.000Z',
        environment: '',
        actorUserId: gm,
      });
      const participant = (
        encounterId: string,
        label: string,
        sourceKind: 'character' | 'entity',
        sourceId: string,
        hidden = false,
      ) =>
        encounters.insertParticipant(transaction, {
          id: crypto.randomUUID(),
          campaignId: source,
          encounterId,
          label,
          sourceKind,
          sourceId,
          position: 0,
          conditions: {},
          visibilityMode: hidden ? 'gm_only' : 'everyone',
          ...(sourceKind === 'entity' ? { state } : {}),
          actorUserId: gm,
        });
      await participant(ended, 'Ash', 'character', character);
      await participant(ended, 'Bandit 1', 'entity', bandit, true);
      await participant(open, 'Wraith', 'entity', lostEntity);
    });

    const exporter = new EncounterExporter(encounters, {
      writer: new PostgresEncounterImportWriter(encounters),
      unwrap: (transaction) => transaction,
    });
    const registration = new ExportRegistry()
      .register(exporter, { placement: 'entities', countRecords: countEncounterRecords })
      .get(ENCOUNTER_MODULE_ID);
    if (registration === undefined) throw new Error('not registered');
    expect(await exportContributorProblems(registration, source, { expectedRecords: 5 })).toEqual(
      [],
    );

    const chunk = await exporter.export(source);
    const remapped = new Map<string, string>();
    const restored = await encounters.transaction(async (transaction) =>
      exporter.restore(chunk, {
        campaignId: target,
        importerUserId: importer,
        transaction: transaction as unknown as ImportContext['transaction'],
        mapId: (_kind, sourceId) => {
          if (sourceId === lostLocation || sourceId === lostEntity) return undefined;
          const mapped = remapped.get(sourceId) ?? crypto.randomUUID();
          remapped.set(sourceId, mapped);
          return mapped;
        },
      }),
    );
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.value.restoredCount).toBe(4);
    expect(restored.value.warnings.map((warning) => warning.code).sort()).toEqual([
      'encounter_link_cleared',
      'encounter_participant_dropped',
    ]);

    const imported = await encounters.listEncounters(target);
    expect(imported.map((row) => [row.name, row.status, row.createdBy])).toEqual([
      ['Ambush at the ford', 'ended', importer],
      ['Second wave', 'active', importer],
    ]);
    expect(imported[0]?.sessionId).toBe(remapped.get(session));
    expect(imported[0]?.locationId).toBeUndefined();
    expect((await encounters.listNotes(target)).map((note) => note.body)).toEqual([
      'The leader flees at half',
    ]);
    const participants = await encounters.listParticipants(target);
    expect(participants.map((row) => [row.name, row.visibility.mode]).sort()).toEqual([
      ['Ash', 'everyone'],
      ['Bandit 1', 'gm_only'],
    ]);
    expect(participants.find((row) => row.name === 'Ash')?.sourceId).toBe(remapped.get(character));
    const states = await encounters.listStates(target);
    expect(states.map((row) => row.state.resources.focus?.current)).toEqual([2]);
  });
});
