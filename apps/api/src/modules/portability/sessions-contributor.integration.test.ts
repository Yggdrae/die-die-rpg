import { afterAll, describe, expect, test } from 'bun:test';
import { ExportRegistry } from '@rpg/campaign-portability';
import { exportContributorProblems } from '@rpg/campaign-portability/testing';
import type { ImportContext } from '@rpg/contracts';
import { countSessionRecords, SESSION_MODULE_ID, SessionExporter } from '@rpg/sessions';
import {
  connectSessionsDatabase,
  PostgresSessionImportWriter,
  PostgresSessionRepository,
} from '@rpg/sessions/postgres';
import postgres from 'postgres';

/**
 * Feature 18 D-15 on PostgreSQL: sessions, GM notes, and log entries leave through the export contributor and return
 * through the import writer on a real transaction, owned by the importer. Members are never imported, so participants
 * are dropped with a warning; a scene feature 16 did not restore is cleared with a warning. Rows are deleted afterwards.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from campaign_sessions limit 1`;
    return true;
  } catch {
    return false;
  }
})();

const source = crypto.randomUUID();
const target = crypto.randomUUID();
const gm = crypto.randomUUID();
const player = crypto.randomUUID();
const importer = crypto.randomUUID();
const connection =
  available && databaseUrl !== undefined ? connectSessionsDatabase(databaseUrl) : undefined;

afterAll(async () => {
  if (available && sql !== undefined) {
    for (const table of ['session_log_entries', 'session_gm_notes', 'campaign_sessions']) {
      await sql.unsafe(`delete from ${table} where campaign_id in ($1, $2)`, [source, target]);
    }
  }
  await connection?.close();
  await sql?.end({ timeout: 1 });
});

describe.skipIf(!available)('session export and import on PostgreSQL', () => {
  test('sessions round trip to the importer; participants and unknown scenes are dropped', async () => {
    const database = connection?.db;
    if (database === undefined) throw new Error('database unavailable');
    const sessions = new PostgresSessionRepository(database);
    const ended = crypto.randomUUID();
    const open = crypto.randomUUID();
    const scene = crypto.randomUUID();
    const lostScene = crypto.randomUUID();
    await sessions.transaction(async (transaction) => {
      await sessions.insertSession(transaction, {
        id: ended,
        campaignId: source,
        number: 1,
        status: 'ended',
        startedAt: '2026-11-01T18:00:00.000Z',
        endedAt: '2026-11-01T21:00:00.000Z',
        currentSceneId: scene,
        participantUserIds: [gm, player],
        actorUserId: gm,
      });
      await sessions.insertNote(transaction, {
        id: ended,
        campaignId: source,
        body: 'Crates hide a second entrance.',
        actorUserId: gm,
      });
      await sessions.insertSession(transaction, {
        id: open,
        campaignId: source,
        number: 2,
        status: 'active',
        startedAt: '2026-11-02T18:00:00.000Z',
        currentSceneId: lostScene,
        participantUserIds: [gm],
        actorUserId: gm,
      });
      const entry = (kind: 'note' | 'scene' | 'status', text: string, extra = {}) =>
        sessions.insertEntry(transaction, {
          id: crypto.randomUUID(),
          campaignId: source,
          sessionId: ended,
          kind,
          text,
          visibilityMode: 'everyone',
          createdAt: '2026-11-01T19:00:00.000Z',
          actorUserId: gm,
          ...extra,
        });
      await entry('status', 'started');
      await entry('scene', '', { subjectId: scene });
      await entry('scene', '', { subjectId: lostScene });
      await entry('note', 'The bell rings', { visibilityMode: 'gm_only' });
    });

    const exporter = new SessionExporter(sessions, {
      writer: new PostgresSessionImportWriter(sessions),
      unwrap: (transaction) => transaction,
    });
    const registration = new ExportRegistry()
      .register(exporter, { placement: 'entities', countRecords: countSessionRecords })
      .get(SESSION_MODULE_ID);
    if (registration === undefined) throw new Error('not registered');
    expect(await exportContributorProblems(registration, source, { expectedRecords: 6 })).toEqual(
      [],
    );

    const chunk = await exporter.export(source);
    const remapped = new Map<string, string>();
    const restored = await sessions.transaction(async (transaction) =>
      exporter.restore(chunk, {
        campaignId: target,
        importerUserId: importer,
        transaction: transaction as unknown as ImportContext['transaction'],
        mapId: (kind, sourceId) => {
          if (kind === 'member') return undefined;
          if (kind === 'campaign_entity' && sourceId !== scene) return undefined;
          const mapped = remapped.get(sourceId) ?? crypto.randomUUID();
          remapped.set(sourceId, mapped);
          return mapped;
        },
      }),
    );
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.value.restoredCount).toBe(5);
    expect(restored.value.warnings.map((warning) => warning.code).sort()).toEqual([
      'session_participant_dropped',
      'session_participant_dropped',
      'session_scene_cleared',
      'session_scene_cleared',
    ]);

    const imported = await sessions.listSessions(target);
    expect(imported.map((row) => [row.number, row.status, row.createdBy])).toEqual([
      [1, 'ended', importer],
      [2, 'active', importer],
    ]);
    expect(imported[0]?.currentSceneId).toBe(remapped.get(scene));
    expect(imported[1]?.currentSceneId).toBeUndefined();
    expect(imported.every((row) => row.participantUserIds.length === 0)).toBe(true);
    expect((await sessions.listNotes(target)).map((note) => note.body)).toEqual([
      'Crates hide a second entrance.',
    ]);
    const entries = await sessions.listEntries(target);
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['note', 'scene', 'status']);
    expect(entries.find((entry) => entry.kind === 'note')?.visibility).toEqual({ mode: 'gm_only' });
  });
});
