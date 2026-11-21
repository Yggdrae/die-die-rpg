import { afterAll, describe, expect, test } from 'bun:test';
import { inspectPackage } from '@rpg/campaign-portability';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from './runtime.ts';

/**
 * Feature 07 task 04 acceptance through the real composition root over HTTP and PostgreSQL:
 * owner/gm-only export (`_bdd.md` "A GM exports one campaign as one file", "A player cannot export
 * a campaign"), exact pins, manifest-only attachments with Visibility as stored, secret exclusion,
 * job metadata without package bytes, user-scoped delivery, retry idempotency, and the typical
 * campaign target. Raw SQL only seeds attachment rows and observes persistence.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from export_jobs limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const touchedCampaigns = new Set<string>();
afterAll(async () => {
  // Seeded attachment rows (no objects behind them) and job rows must not leak into other suites.
  if (sql !== undefined && touchedCampaigns.size > 0) {
    const ids = [...touchedCampaigns];
    await sql`delete from attachments where campaign_id = any(${ids}::uuid[])`;
    await sql`delete from export_jobs where campaign_id = any(${ids}::uuid[])`;
    await sql`delete from content_entity_relationships where campaign_id = any(${ids}::uuid[])`;
    await sql`delete from content_entities where campaign_id = any(${ids}::uuid[])`;
    await sql`delete from content_personal_notes where campaign_id = any(${ids}::uuid[])`;
  }
  await sql?.end({ timeout: 1 });
});

type Session = { cookie: string; userId: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function harness() {
  if (databaseUrl === undefined) throw new Error('no database');
  const logLines: string[] = [];
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    version: '7.7.7-test',
    logger: { stream: { write: (line) => logLines.push(line) } },
  });
  const suffix = crypto.randomUUID().slice(0, 8);
  const signUp = async (name: string): Promise<Session> => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: `${name}_${suffix}`, password: 'correct horse battery staple' },
    });
    expect(response.statusCode).toBe(200);
    const raw = response.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    return { cookie: (header ?? '').split(';')[0] ?? '', userId: response.json().user.id };
  };
  const call = (who: Session | undefined, method: Method, url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        ...(who === undefined ? {} : { cookie: who.cookie }),
        ...(method === 'GET' ? {} : { origin }),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const createCampaign = async (owner: Session, name = 'Ashen Road') => {
    const id = crypto.randomUUID();
    const created = await call(owner, 'POST', '/campaigns', {
      id,
      system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
      gameMode: 'standard',
      options: {},
      moduleIds: [],
      name,
      description: 'Contact the GM at gm@example.com.',
    });
    expect(created.statusCode).toBe(201);
    touchedCampaigns.add(id);
    return id;
  };
  const invite = async (owner: Session, campaignId: string, member: Session, role: string) => {
    const invited = await call(owner, 'POST', `/campaigns/${campaignId}/invitations`, {
      targetRole: role,
    });
    expect(invited.statusCode).toBe(201);
    const accepted = await call(member, 'POST', `/invitations/${invited.json().token}/accept`);
    expect(accepted.statusCode).toBe(200);
  };
  const exportCampaign = (
    who: Session | undefined,
    campaignId: string,
    jobId = crypto.randomUUID(),
  ) => call(who, 'POST', `/campaigns/${campaignId}/exports`, { jobId, acknowledgeGmSecrets: true });
  return { app, logLines, signUp, call, createCampaign, invite, exportCampaign };
}

async function seedAttachment(
  campaignId: string,
  createdBy: string,
  visibility: { mode: string; targets: string[] },
) {
  if (sql === undefined) throw new Error('no database');
  const id = crypto.randomUUID();
  const owner = crypto.randomUUID();
  const checksum = Buffer.alloc(32, 7);
  await sql`
    insert into attachments (
      id, campaign_id, owner_resource_class, owner_resource_id, filename, mime_type,
      declared_size, verified_size, declared_checksum, verified_checksum, object_key, status,
      visibility_mode, visibility_targets, created_by, updated_by, finalized_at
    ) values (
      ${id}, ${campaignId}, 'fixture_note', ${owner}, 'map.png', 'image/png',
      2048, 2048, ${checksum}, ${checksum}, ${`campaigns/${campaignId}/${owner}/${id}`}, 'ready',
      ${visibility.mode}, ${sql.json(visibility.targets)}, ${createdBy}, ${createdBy}, now()
    )`;
  return id;
}

/** Feature 16 rows seeded directly (the export reads them; writes are tested in feature 16). */
async function seedEntity(
  campaignId: string,
  createdBy: string,
  input: { type: string; name: string; mode: string; targets: string[]; deleted?: boolean },
) {
  if (sql === undefined) throw new Error('no database');
  const id = crypto.randomUUID();
  await sql`
    insert into content_entities (
      id, campaign_id, type, name, summary, visibility_mode, visibility_targets,
      created_by, updated_by, deleted_at
    ) values (
      ${id}, ${campaignId}, ${input.type}, ${input.name}, 'one line', ${input.mode},
      ${sql.json(input.targets)}, ${createdBy}, ${createdBy},
      ${input.deleted === true ? sql`now()` : null}
    )`;
  return id;
}

async function seedLink(campaignId: string, createdBy: string, source: string, target: string) {
  if (sql === undefined) throw new Error('no database');
  const id = crypto.randomUUID();
  await sql`
    insert into content_entity_relationships (
      id, campaign_id, source_entity_id, target_entity_id, kind, visibility_mode,
      visibility_targets, created_by, updated_by
    ) values (
      ${id}, ${campaignId}, ${source}, ${target}, 'knows', 'gm_only', '[]'::jsonb,
      ${createdBy}, ${createdBy}
    )`;
  return id;
}

describe.skipIf(!available)('campaign export (runtime + PostgreSQL)', () => {
  test('owner and gm export one package; every other actor is denied with no job', async () => {
    if (sql === undefined) return;
    const h = harness();
    try {
      const owner = await h.signUp('owner');
      const gm = await h.signUp('gm');
      const assistant = await h.signUp('agm');
      const player = await h.signUp('player');
      const outsider = await h.signUp('outsider');
      const campaignId = await h.createCampaign(owner);
      await h.invite(owner, campaignId, gm, 'gm');
      await h.invite(owner, campaignId, assistant, 'assistant_gm');
      await h.invite(owner, campaignId, player, 'player');
      const hidden = await seedAttachment(campaignId, owner.userId, {
        mode: 'gm_only',
        targets: [],
      });
      const targeted = await seedAttachment(campaignId, owner.userId, {
        mode: 'players',
        targets: [player.userId],
      });
      // Feature 16: a revealed NPC, a GM-only location written by the GM, a link between them,
      // and the player's personal note (never exported, D-12).
      const revealedNpc = await seedEntity(campaignId, owner.userId, {
        type: 'npc',
        name: 'Ferryman',
        mode: 'players',
        targets: [player.userId],
      });
      const hiddenLocation = await seedEntity(campaignId, gm.userId, {
        type: 'location',
        name: 'Drowned Chapel',
        mode: 'gm_only',
        targets: [],
      });
      const knows = await seedLink(campaignId, gm.userId, revealedNpc, hiddenLocation);
      await sql`
        insert into content_personal_notes (
          id, campaign_id, author_user_id, name, body, visibility_mode, visibility_targets,
          created_by, updated_by
        ) values (
          ${crypto.randomUUID()}, ${campaignId}, ${player.userId}, 'Suspicions',
          'PRIVATE-NOTE-BODY', 'players', ${sql.json([player.userId])},
          ${player.userId}, ${player.userId}
        )`;

      // Scenario: A player cannot export a campaign (also assistant_gm, non-member, anonymous).
      const missing = await h.exportCampaign(outsider, crypto.randomUUID());
      for (const who of [assistant, player, outsider]) {
        const jobId = crypto.randomUUID();
        const denied = await h.exportCampaign(who, campaignId, jobId);
        expect(denied.statusCode).toBe(404);
        expect(denied.json()).toEqual(missing.json());
        const [row] = await sql`select count(*)::int as n from export_jobs where id = ${jobId}`;
        expect(row?.n).toBe(0);
      }
      expect((await h.exportCampaign(undefined, campaignId)).statusCode).toBe(401);
      // The GM-secret warning must be acknowledged.
      const unacknowledged = await h.call(owner, 'POST', `/campaigns/${campaignId}/exports`, {
        jobId: crypto.randomUUID(),
      });
      expect(unacknowledged.statusCode).toBe(400);

      // Scenario: A GM exports one campaign as one file.
      for (const who of [owner, gm]) {
        const started = await h.exportCampaign(who, campaignId);
        expect(started.statusCode).toBe(201);
        const job = started.json();
        expect(job).toMatchObject({ campaignId, state: 'completed' });
        expect(job.summary).toEqual([
          { moduleId: 'attachments', chunkVersion: '1', records: 2, bytes: expect.any(Number) },
          { moduleId: 'campaign', chunkVersion: '1', records: 1, bytes: expect.any(Number) },
          { moduleId: 'characters', chunkVersion: '1', records: 0, bytes: expect.any(Number) },
          { moduleId: 'content', chunkVersion: '1', records: 3, bytes: expect.any(Number) },
          { moduleId: 'dice_rolls', chunkVersion: '1', records: 0, bytes: expect.any(Number) },
          { moduleId: 'encounters', chunkVersion: '1', records: 0, bytes: expect.any(Number) },
          { moduleId: 'sessions', chunkVersion: '1', records: 0, bytes: expect.any(Number) },
        ]);
        expect(JSON.stringify(job)).not.toMatch(/https?:|campaigns\/[0-9a-f-]{36}\//);

        const status = await h.call(who, 'GET', `/exports/${job.jobId}`);
        expect(status.statusCode).toBe(200);
        expect(status.json().fileAvailableUntil).toBeString();

        const file = await h.call(who, 'GET', `/exports/${job.jobId}/file`);
        expect(file.statusCode).toBe(200);
        expect(file.headers['content-type']).toBe('application/zip');
        expect(file.headers['cache-control']).toBe('no-store');
        expect(file.headers['content-disposition']).toBe(
          `attachment; filename="campaign-${job.jobId}.rpgpack"`,
        );
        const bytes = new Uint8Array(file.rawPayload);
        const inspected = await inspectPackage(bytes);
        expect(inspected.ok).toBe(true);
        if (!inspected.ok) return;
        const pkg = inspected.value;

        // Scenario: Export preserves the pinned rules context.
        expect(pkg.systemLock).toEqual({
          systemId: FIXTURE_SYSTEM_DEFINITION.summary.ref.systemId,
          version: FIXTURE_SYSTEM_DEFINITION.summary.ref.version,
        });
        expect(pkg.modulesLock).toEqual({ modules: [] });
        expect(pkg.manifest).toMatchObject({
          applicationVersion: '7.7.7-test',
          source: { campaignId },
          content: { attachmentBinaries: 'excluded', audit: 'excluded' },
        });
        expect(pkg.manifest.exportedBy.displayName).toStartWith(who === owner ? 'owner_' : 'gm_');

        // Scenario: P0 attachment export is manifest only; Visibility serialized as stored.
        const manifest = pkg.chunks.find((chunk) => chunk.moduleId === 'attachments')?.payload as {
          binaries: string;
          entries: { attachmentId: string; visibility: unknown; checksum: string }[];
        };
        expect(manifest.binaries).toBe('excluded');
        const byId = new Map(manifest.entries.map((entry) => [entry.attachmentId, entry]));
        expect(byId.get(hidden)?.visibility).toEqual({ mode: 'gm_only' });
        expect(byId.get(targeted)?.visibility).toEqual({
          mode: 'players',
          playerIds: [player.userId],
        });
        expect(byId.get(hidden)?.checksum).toBe('07'.repeat(32));

        // Feature 16 (BDD "Export carries entities with their visibility"): Visibility as stored.
        const contentChunk = pkg.chunks.find((chunk) => chunk.moduleId === 'content');
        expect(contentChunk?.path).toBe('entities/content.json');
        const content = contentChunk?.payload as {
          entities: { id: string; type: string; visibility: unknown; deleted: boolean }[];
          relationships: { id: string; visibility: unknown }[];
        };
        expect(
          content.entities.map((entity) => [entity.id, entity.type, entity.visibility]),
        ).toEqual(
          [
            [revealedNpc, 'npc', { mode: 'players', playerIds: [player.userId] }],
            [hiddenLocation, 'location', { mode: 'gm_only' }],
          ].sort((left, right) => ((left[0] as string) < (right[0] as string) ? -1 : 1)),
        );
        expect(content.relationships.map((link) => [link.id, link.visibility])).toEqual([
          [knows, { mode: 'gm_only' }],
        ]);

        // Scenario: Secrets are excluded — no credential, session, email field, key, URL, audit.
        const text = new TextDecoder().decode(bytes);
        for (const forbidden of [
          'password',
          'rpg_session',
          owner.cookie.split('=')[1] ?? 'x',
          'object_key',
          'objectKey',
          `campaigns/${campaignId}/`,
          'X-Amz',
          'audit_',
          'identity_',
          '"email"',
          // Scenario: Personal notes are not exported (feature 16 D-12).
          'PRIVATE-NOTE-BODY',
          'Suspicions',
        ]) {
          expect(text).not.toContain(forbidden);
        }
        // Member identifiers appear only inside Visibility targets, never as membership data.
        expect(text).not.toContain(gm.userId);
        expect(text).not.toContain(assistant.userId);

        // Job metadata holds safe evidence only, and bytes leave the server on delivery.
        const [row] = await sql`
          select state, encode(manifest_checksum, 'hex') as checksum, contributor_summary,
            error_code, requested_by
          from export_jobs where id = ${job.jobId}`;
        expect(row).toMatchObject({
          state: 'completed',
          checksum: pkg.manifestChecksum,
          error_code: null,
          requested_by: who.userId,
        });
        expect(JSON.stringify(row?.contributor_summary)).not.toContain('Ashen');
        const again = await h.call(who, 'GET', `/exports/${job.jobId}/file`);
        expect(again.statusCode).toBe(410);
        expect((await h.call(who, 'GET', `/exports/${job.jobId}`)).json().fileAvailableUntil).toBe(
          undefined,
        );
      }
      const columns = await sql`
        select column_name from information_schema.columns where table_name = 'export_jobs'`;
      expect(columns.map((column) => column.column_name).sort()).toEqual([
        'campaign_id',
        'completed_at',
        'contributor_summary',
        'created_at',
        'error_code',
        'id',
        'manifest_checksum',
        'requested_by',
        'state',
      ]);
      // Never replicated to devices.
      const published = await sql`
        select 1 from pg_publication_tables where tablename = 'export_jobs'`;
      expect(published.length).toBe(0);
    } finally {
      await h.app.close();
    }
  });

  test('status and file are scoped to the requesting, still-authorized user', async () => {
    if (sql === undefined) return;
    const h = harness();
    try {
      const owner = await h.signUp('owner');
      const gm = await h.signUp('gm');
      const player = await h.signUp('player');
      const campaignId = await h.createCampaign(owner);
      await h.invite(owner, campaignId, gm, 'gm');
      await h.invite(owner, campaignId, player, 'player');

      const started = await h.exportCampaign(gm, campaignId);
      expect(started.statusCode).toBe(201);
      const { jobId } = started.json();
      // Another member, even the owner, cannot read someone else's job or file.
      for (const who of [owner, player]) {
        expect((await h.call(who, 'GET', `/exports/${jobId}`)).statusCode).toBe(404);
        expect((await h.call(who, 'GET', `/exports/${jobId}/file`)).statusCode).toBe(404);
      }
      expect((await h.call(undefined, 'GET', `/exports/${jobId}/file`)).statusCode).toBe(401);
      // A job id reused by another user or for another campaign is refused, not regenerated.
      const otherCampaign = await h.createCampaign(owner, 'Second');
      expect((await h.exportCampaign(owner, campaignId, jobId)).statusCode).toBe(404);
      expect((await h.exportCampaign(owner, otherCampaign, jobId)).statusCode).toBe(404);

      // Retry with the same job id returns the same job and does not generate twice.
      const retried = await h.exportCampaign(gm, campaignId, jobId);
      expect(retried.statusCode).toBe(201);
      expect(retried.json()).toEqual(started.json());
      const [count] = await sql`select count(*)::int as n from export_jobs where id = ${jobId}`;
      expect(count?.n).toBe(1);

      // Demoted to player: the generated file is no longer downloadable (current role decides).
      const demoted = await h.call(
        owner,
        'PATCH',
        `/campaigns/${campaignId}/members/${gm.userId}/role`,
        {
          role: 'player',
        },
      );
      expect(demoted.statusCode).toBe(200);
      expect((await h.call(gm, 'GET', `/exports/${jobId}/file`)).statusCode).toBe(404);
      expect((await h.call(gm, 'GET', `/exports/${jobId}`)).statusCode).toBe(404);

      // A deleted campaign is a miss: no package and no job.
      const doomed = await h.createCampaign(owner, 'Doomed');
      const view = await h.call(owner, 'GET', `/campaigns/${doomed}`);
      expect(
        (
          await h.call(owner, 'DELETE', `/campaigns/${doomed}`, {
            expectedVersion: view.json().version,
          })
        ).statusCode,
      ).toBe(204);
      expect((await h.exportCampaign(owner, doomed)).statusCode).toBe(404);

      // Logs never carry package content or the campaign description.
      expect(h.logLines.join('\n')).not.toContain('gm@example.com');
    } finally {
      await h.app.close();
    }
  });

  test('typical campaign fixture is ready well within one minute', async () => {
    if (sql === undefined) return;
    const h = harness();
    try {
      const owner = await h.signUp('owner');
      const campaignId = await h.createCampaign(owner, 'Typical');
      // Feature 05 owner-class fixtures: 200 finalized attachments (MVP cap per campaign is far
      // lower in practice), plus the feature 16 sandbox scale (`PRD.md` s.82): five locations,
      // six NPCs, five items.
      for (let index = 0; index < 200; index += 1) {
        await seedAttachment(campaignId, owner.userId, {
          mode: index % 2 ? 'everyone' : 'gm_only',
          targets: [],
        });
      }
      for (const [type, count] of [
        ['location', 5],
        ['npc', 6],
        ['item', 5],
      ] as const) {
        for (let index = 0; index < count; index += 1) {
          await seedEntity(campaignId, owner.userId, {
            type,
            name: `${type} ${index}`,
            mode: index % 2 ? 'everyone' : 'gm_only',
            targets: [],
          });
        }
      }
      const started = performance.now();
      const created = await h.exportCampaign(owner, campaignId);
      const file = await h.call(owner, 'GET', `/exports/${created.json().jobId}/file`);
      const elapsed = performance.now() - started;
      expect(file.statusCode).toBe(200);
      expect(created.json().summary[0].records).toBe(200);
      expect(created.json().summary[3]).toMatchObject({ moduleId: 'content', records: 16 });
      expect(elapsed).toBeLessThan(60_000);
      console.info(`typical export: ${Math.round(elapsed)} ms, ${file.rawPayload.length} bytes`);
    } finally {
      await h.app.close();
    }
  });
});
