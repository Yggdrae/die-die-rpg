import { afterAll, describe, expect, test } from 'bun:test';
import { AttachmentManifestExporter } from '@rpg/attachments';
import { visibilityForImport } from '@rpg/authorization';
import {
  buildPackage,
  canonicalBytes,
  concatParts,
  deriveImportId,
  ExportRegistry,
  ImportCoordinator,
  ImportService,
  type InspectedPackage,
  inspectPackage,
  type PackageChunk,
  type PackageInput,
  sha256Hex,
} from '@rpg/campaign-portability';
import {
  connectPortabilityDatabase,
  importTransactionHandle,
  PostgresImportCommitStore,
  PostgresImportJobRepository,
  PostgresImportTransactions,
} from '@rpg/campaign-portability/postgres';
import {
  CampaignExporter,
  CampaignImporter,
  CampaignSettingRegistry,
  connectCampaignDatabase,
  PostgresCampaignRepository,
  StaticSystemCatalog,
  type SystemDefinition,
} from '@rpg/campaigns';
import {
  type ContentChunk,
  ContentExporter,
  relationshipBoundViolations,
  visibilityWithin,
} from '@rpg/content';
import {
  type ContentSqlExecutor,
  connectContentDatabase,
  PostgresContentImportWriter,
  PostgresEntityRepository,
  PostgresRelationshipRepository,
  relationshipBoundRows,
} from '@rpg/content/postgres';
import {
  type ExportableModule,
  type ExportChunk,
  type ImportableModule,
  type ImportWarning,
  ok,
  type Visibility,
} from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { PostgresCampaignMembershipWriter } from '@rpg/identity';
import postgres from 'postgres';
import { catalogRulesAvailability } from './modules/portability/composition.ts';
import { buildRuntimeApp } from './runtime.ts';

/**
 * Feature 07 tasks 06–07 acceptance through the real composition root over HTTP and PostgreSQL:
 * export → import → equivalent campaign (minus the documented exclusions: attachment binaries
 * and therefore attachment rows, memberships, audit), the importer as sole owner, exact pins,
 * preserved unknown chunks surviving byte-for-byte, retry idempotency, deliberate second import,
 * unavailable system, fuzzed hostile packages rejected with no side effect, and rollback of every
 * row when a contributor fails. Raw SQL only seeds attachment rows and observes persistence.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql = databaseUrl === undefined ? undefined : postgres(databaseUrl, { max: 2 });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from import_jobs limit 1`;
    await sql`select 1 from import_preserved_chunks limit 1`;
    return true;
  } catch {
    return false;
  }
})();

/** A system with an option and a module, so pins and settings are exercised. */
const PORTABLE_SYSTEM: SystemDefinition = {
  ...FIXTURE_SYSTEM_DEFINITION,
  summary: {
    ...FIXTURE_SYSTEM_DEFINITION.summary,
    ref: { systemId: 'portable-system', version: '1.2.0' },
    name: 'Portable System',
  },
  options: [
    {
      key: 'difficulty',
      label: 'Difficulty',
      type: 'select',
      default: 'normal',
      values: ['normal', 'hard'],
    },
  ],
  compatibleModules: [{ id: 'bestiary', version: '2.0.0', name: 'Bestiary' }],
};
const NEWER_SYSTEM: SystemDefinition = {
  ...PORTABLE_SYSTEM,
  summary: { ...PORTABLE_SYSTEM.summary, ref: { systemId: 'portable-system', version: '1.3.0' } },
};

const touchedCampaigns = new Set<string>();
const touchedJobs = new Set<string>();
afterAll(async () => {
  if (sql !== undefined) {
    const ids = [...touchedCampaigns];
    if (ids.length > 0) {
      await sql`delete from attachments where campaign_id = any(${ids}::uuid[])`;
      await sql`delete from export_jobs where campaign_id = any(${ids}::uuid[])`;
      await sql`delete from import_preserved_chunks where campaign_id = any(${ids}::uuid[])`;
      await deleteContent(ids);
    }
    const jobs = [...touchedJobs];
    if (jobs.length > 0) {
      const imported = await sql<{ campaign_id: string }[]>`
        select campaign_id from import_jobs where id = any(${jobs}::uuid[]) and campaign_id is not null`;
      const importedIds = imported.map((row) => row.campaign_id);
      if (importedIds.length > 0) {
        await sql`delete from export_jobs where campaign_id = any(${importedIds}::uuid[])`;
        await sql`delete from import_preserved_chunks where campaign_id = any(${importedIds}::uuid[])`;
        await deleteContent(importedIds);
      }
      await sql`delete from import_jobs where id = any(${jobs}::uuid[])`;
    }
  }
  await sql?.end({ timeout: 1 });
});

type Session = { cookie: string; userId: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function harness(
  systems: readonly SystemDefinition[] = [FIXTURE_SYSTEM_DEFINITION, PORTABLE_SYSTEM],
) {
  if (databaseUrl === undefined) throw new Error('no database');
  const logLines: string[] = [];
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    version: '7.7.7-test',
    systems,
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
      system: PORTABLE_SYSTEM.summary.ref,
      gameMode: 'standard',
      options: { difficulty: 'hard' },
      moduleIds: ['bestiary'],
      name,
      description: 'The caravan never reached the pass.',
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
  const exportBytes = async (who: Session, campaignId: string): Promise<Uint8Array> => {
    const started = await call(who, 'POST', `/campaigns/${campaignId}/exports`, {
      jobId: crypto.randomUUID(),
      acknowledgeGmSecrets: true,
    });
    expect(started.statusCode).toBe(201);
    const file = await call(who, 'GET', `/exports/${started.json().jobId}/file`);
    expect(file.statusCode).toBe(200);
    return new Uint8Array(file.rawPayload);
  };
  const importPackage = async (
    who: Session | undefined,
    bytes: Uint8Array,
    jobId: string = crypto.randomUUID(),
    headers: Record<string, string> = {},
  ) => {
    touchedJobs.add(jobId);
    const response = await app.inject({
      method: 'POST',
      url: `/imports/${jobId}`,
      headers: {
        'content-type': 'application/zip',
        origin,
        ...(who === undefined ? {} : { cookie: who.cookie }),
        ...headers,
      },
      payload: Buffer.from(bytes),
    });
    if (response.statusCode === 201 && response.json().campaignId !== undefined) {
      touchedCampaigns.add(response.json().campaignId);
    }
    return response;
  };
  return { app, logLines, signUp, call, createCampaign, invite, exportBytes, importPackage };
}

async function deleteContent(ids: readonly string[]) {
  if (sql === undefined || ids.length === 0) return;
  await sql`delete from content_entity_relationships where campaign_id = any(${ids}::uuid[])`;
  await sql`delete from content_entities where campaign_id = any(${ids}::uuid[])`;
}

function targetsOf(visibility: Visibility): string[] {
  return visibility.mode === 'players'
    ? visibility.playerIds
    : visibility.mode === 'party'
      ? visibility.partyIds
      : [];
}

/** Feature 16 rows seeded directly (their writes are tested in feature 16). */
async function seedEntity(
  campaignId: string,
  createdBy: string,
  input: { type: string; name: string; visibility: Visibility; deleted?: boolean },
) {
  if (sql === undefined) throw new Error('no database');
  const id = crypto.randomUUID();
  await sql`
    insert into content_entities (
      id, campaign_id, type, name, summary, description, tags, fields, visibility_mode,
      visibility_targets, created_by, updated_by, deleted_at
    ) values (
      ${id}, ${campaignId}, ${input.type}, ${input.name}, 'one line', '# Notes',
      ${sql.json(['sandbox'])}, ${sql.json({ Price: 'one silver' })}, ${input.visibility.mode},
      ${sql.json(targetsOf(input.visibility))}, ${createdBy}, ${createdBy},
      ${input.deleted === true ? sql`now()` : null}
    )`;
  return id;
}

async function seedLink(
  campaignId: string,
  createdBy: string,
  input: { source: string; target: string; kind: string; visibility: Visibility },
) {
  if (sql === undefined) throw new Error('no database');
  const id = crypto.randomUUID();
  await sql`
    insert into content_entity_relationships (
      id, campaign_id, source_entity_id, target_entity_id, kind, visibility_mode,
      visibility_targets, created_by, updated_by
    ) values (
      ${id}, ${campaignId}, ${input.source}, ${input.target}, ${input.kind},
      ${input.visibility.mode}, ${sql.json(targetsOf(input.visibility))}, ${createdBy}, ${createdBy}
    )`;
  return id;
}

/**
 * A small mixed-Visibility content set: GM-only NPC, revealed location, an item revealed to one
 * player (whose membership is never imported), a tombstone a live link still references, links
 * at every Visibility. Returns the source ids.
 */
async function seedContent(campaignId: string, gmUserId: string, playerUserId: string) {
  const npc = await seedEntity(campaignId, gmUserId, {
    type: 'npc',
    name: 'Ferryman',
    visibility: { mode: 'gm_only' },
  });
  const location = await seedEntity(campaignId, gmUserId, {
    type: 'location',
    name: 'Ford',
    visibility: { mode: 'everyone' },
  });
  const letter = await seedEntity(campaignId, gmUserId, {
    type: 'item',
    name: 'Weathered Letter',
    visibility: { mode: 'players', playerIds: [playerUserId] },
  });
  const crate = await seedEntity(campaignId, gmUserId, {
    type: 'item',
    name: 'Supply Crate',
    visibility: { mode: 'everyone' },
    deleted: true,
  });
  const lives = await seedLink(campaignId, gmUserId, {
    source: npc,
    target: location,
    kind: 'lives_at',
    visibility: { mode: 'gm_only' },
  });
  const found = await seedLink(campaignId, gmUserId, {
    source: letter,
    target: location,
    kind: 'located_at',
    visibility: { mode: 'players', playerIds: [playerUserId] },
  });
  const broken = await seedLink(campaignId, gmUserId, {
    source: crate,
    target: location,
    kind: 'located_at',
    visibility: { mode: 'everyone' },
  });
  return { npc, location, letter, crate, lives, found, broken };
}

async function seedAttachment(
  campaignId: string,
  createdBy: string,
  visibility: Visibility,
  ownerRef: { resourceClass: string; resourceId: string } = {
    resourceClass: 'fixture_note',
    resourceId: crypto.randomUUID(),
  },
) {
  if (sql === undefined) throw new Error('no database');
  const id = crypto.randomUUID();
  const owner = ownerRef.resourceId;
  const checksum = Buffer.alloc(32, 7);
  const targets =
    visibility.mode === 'players'
      ? visibility.playerIds
      : visibility.mode === 'party'
        ? visibility.partyIds
        : [];
  await sql`
    insert into attachments (
      id, campaign_id, owner_resource_class, owner_resource_id, filename, mime_type,
      declared_size, verified_size, declared_checksum, verified_checksum, object_key, status,
      visibility_mode, visibility_targets, created_by, updated_by, finalized_at
    ) values (
      ${id}, ${campaignId}, ${ownerRef.resourceClass}, ${owner}, 'map.png', 'image/png',
      2048, 2048, ${checksum}, ${checksum}, ${`campaigns/${campaignId}/${owner}/${id}`}, 'ready',
      ${visibility.mode}, ${sql.json(targets)}, ${createdBy}, ${createdBy}, now()
    )`;
  return id;
}

async function inspected(bytes: Uint8Array): Promise<InspectedPackage> {
  const result = await inspectPackage(bytes);
  if (!result.ok) throw new Error(`fixture package invalid: ${result.error.code}`);
  return result.value;
}

/** Rebuilds a package from an inspected one, with changes (still valid, checksums recomputed). */
async function rebuild(
  pkg: InspectedPackage,
  change: (input: PackageInput) => PackageInput,
): Promise<Uint8Array> {
  const input: PackageInput = {
    applicationVersion: pkg.manifest.applicationVersion,
    exportedAt: pkg.manifest.exportedAt,
    exportedBy: pkg.manifest.exportedBy,
    campaignId: pkg.manifest.source.campaignId,
    systemLock: pkg.systemLock,
    modulesLock: pkg.modulesLock,
    chunks: pkg.chunks.map(
      (chunk): PackageChunk => ({
        placement: chunk.placement,
        moduleId: chunk.moduleId,
        chunkVersion: chunk.chunkVersion,
        payload: chunk.payload,
      }),
    ),
    preserved: pkg.preserved.map((chunk) => ({
      moduleId: chunk.moduleId,
      chunkVersion: chunk.chunkVersion,
      payload: chunk.payload,
    })),
  };
  return concatParts((await buildPackage(change(input))).parts);
}

async function sideEffects(userId: string) {
  if (sql === undefined) throw new Error('no database');
  const [row] = await sql<{ campaigns: number; memberships: number; preserved: number }[]>`
    select
      (select count(*)::int from campaigns where created_by = ${userId}) as campaigns,
      (select count(*)::int from identity_campaign_memberships where user_id = ${userId}) as memberships,
      (select count(*)::int from import_preserved_chunks) as preserved`;
  return row;
}

describe.skipIf(!available)('campaign import (runtime + PostgreSQL)', () => {
  test('round trip: export → import → equivalent campaign owned by the importer', async () => {
    if (sql === undefined) return;
    const h = harness();
    try {
      const owner = await h.signUp('owner');
      const player = await h.signUp('player');
      const importer = await h.signUp('importer');
      const sourceId = await h.createCampaign(owner);
      await h.invite(owner, sourceId, player, 'player');
      await seedAttachment(sourceId, owner.userId, { mode: 'gm_only' });
      await seedAttachment(sourceId, owner.userId, { mode: 'players', playerIds: [player.userId] });
      // Feature 16 task 17: entities and links, and an attachment owned by an entity.
      const content = await seedContent(sourceId, owner.userId, player.userId);
      const portrait = await seedAttachment(
        sourceId,
        owner.userId,
        { mode: 'gm_only' },
        { resourceClass: 'campaign_entity', resourceId: content.npc },
      );
      const original = await h.exportBytes(owner, sourceId);
      const source = await inspected(original);
      const sourceView = (await h.call(owner, 'GET', `/campaigns/${sourceId}`)).json();

      // Anonymous, cross-origin and wrong media type never reach the importer.
      expect((await h.importPackage(undefined, original)).statusCode).toBe(401);
      expect(
        (await h.importPackage(importer, original, undefined, { origin: 'https://evil.invalid' }))
          .statusCode,
      ).toBe(403);
      const wrongType = await h.importPackage(importer, original, undefined, {
        'content-type': 'application/x-tar',
      });
      expect(wrongType.statusCode).toBe(415);
      expect(wrongType.json() as unknown).toEqual({
        code: 'unsupported_media_type',
        message: 'Request rejected.',
      });
      expect((await h.importPackage(importer, new Uint8Array())).statusCode).toBe(400);
      expect(await sideEffects(importer.userId)).toMatchObject({ campaigns: 0, memberships: 0 });

      // Scenario: Import creates a new campaign with a new owner.
      const jobId = crypto.randomUUID();
      const imported = await h.importPackage(importer, original, jobId);
      expect(imported.statusCode).toBe(201);
      const job = imported.json();
      expect(job).toMatchObject({ jobId, state: 'completed' });
      expect(job.campaignId).not.toBe(sourceId);
      expect(job.report.modules).toEqual([
        {
          moduleId: 'campaign',
          chunkVersion: '1',
          outcome: 'restored',
          restoredCount: 1,
          warnings: [],
        },
        {
          moduleId: 'attachments',
          chunkVersion: '1',
          outcome: 'restored',
          restoredCount: 0,
          warnings: [{ code: 'attachment_binary_not_restored', count: 3 }],
        },
        {
          moduleId: 'characters',
          chunkVersion: '1',
          outcome: 'restored',
          restoredCount: 0,
          warnings: [],
        },
        {
          moduleId: 'content',
          chunkVersion: '1',
          outcome: 'restored',
          restoredCount: 7,
          // The letter and its link targeted a player whose membership is not imported.
          warnings: expect.arrayContaining([
            { code: 'visibility_narrowed_to_gm_only', sourceId: content.letter },
            { code: 'visibility_narrowed_to_gm_only', sourceId: content.found },
          ]),
        },
        {
          moduleId: 'dice_rolls',
          chunkVersion: '1',
          outcome: 'restored',
          restoredCount: 0,
          warnings: [],
        },
        {
          moduleId: 'encounters',
          chunkVersion: '1',
          outcome: 'restored',
          restoredCount: 0,
          warnings: [],
        },
        {
          moduleId: 'sessions',
          chunkVersion: '1',
          outcome: 'restored',
          restoredCount: 0,
          warnings: [],
        },
      ]);
      expect(job.report.modules[3].warnings).toHaveLength(2);
      const campaignId: string = job.campaignId;

      const view = await h.call(importer, 'GET', `/campaigns/${campaignId}`);
      expect(view.statusCode).toBe(200);
      const restored = view.json();
      for (const field of ['name', 'description', 'system', 'gameMode', 'modulePins', 'settings']) {
        expect(restored[field]).toEqual(sourceView[field]);
      }
      expect(restored.version).toBe(1);

      // Sole owner; original memberships are not restored; the source owner and player see nothing.
      const members = await h.call(importer, 'GET', `/campaigns/${campaignId}/members`);
      expect(members.statusCode).toBe(200);
      expect(
        members
          .json()
          .items.map((item: { user: { id: string }; role: string }) => [item.user.id, item.role]),
      ).toEqual([[importer.userId, 'owner']]);
      for (const outsider of [owner, player]) {
        expect((await h.call(outsider, 'GET', `/campaigns/${campaignId}`)).statusCode).toBe(404);
      }
      // Feature 04 decides on the new campaign like any other: the importer may export it.
      const reexported = await inspected(await h.exportBytes(importer, campaignId));

      // Scenario: Contributor counts and versions survive (attachments: documented exclusion).
      const chunkOf = (pkg: InspectedPackage, moduleId: string) =>
        pkg.chunks.find((chunk) => chunk.moduleId === moduleId);
      expect(canonicalBytes(chunkOf(reexported, 'campaign')?.payload)).toEqual(
        canonicalBytes(chunkOf(source, 'campaign')?.payload),
      );
      expect(reexported.systemLock).toEqual(source.systemLock);
      expect(reexported.modulesLock).toEqual({
        modules: [{ moduleId: 'bestiary', version: '2.0.0' }],
      });
      expect(reexported.manifest.source.campaignId).toBe(campaignId);
      expect(
        (chunkOf(reexported, 'attachments')?.payload as { entries?: unknown[] } | undefined)
          ?.entries,
      ).toEqual([]);
      // Scenario: Visibility does not widen — no restored record and no new member can read it.
      const [attachments] =
        await sql`select count(*)::int as n from attachments where campaign_id = ${campaignId}`;
      expect(attachments?.n).toBe(0);

      // Scenario: Export carries entities with their visibility (import half, feature 16 task 17).
      const sourceContent = chunkOf(source, 'content')?.payload as ContentChunk;
      const importedContent = chunkOf(reexported, 'content')?.payload as ContentChunk;
      const perType = (chunk: ContentChunk) => {
        const counts: Record<string, number> = {};
        for (const row of chunk.entities) {
          const key = `${row.type}${row.deleted ? ':deleted' : ''}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
      };
      expect(perType(importedContent)).toEqual(perType(sourceContent));
      expect(perType(importedContent)).toEqual({ npc: 1, location: 1, item: 1, 'item:deleted': 1 });
      expect(importedContent.relationships).toHaveLength(sourceContent.relationships.length);
      const newId = (kind: string, id: string) => deriveImportId(jobId, kind, id);
      const importedById = new Map(importedContent.entities.map((row) => [row.id, row]));
      for (const row of sourceContent.entities) {
        const restoredRow = importedById.get(await newId('campaign_entity', row.id));
        expect(restoredRow).toMatchObject({ type: row.type, name: row.name, deleted: row.deleted });
        expect(restoredRow?.fields).toEqual(row.fields);
        // Equal or narrower; a players target never becomes everyone.
        expect(visibilityWithin(restoredRow?.visibility as Visibility, row.visibility)).toBe(true);
        if (row.visibility.mode !== 'everyone') {
          expect(restoredRow?.visibility.mode).not.toBe('everyone');
        }
      }
      const linksById = new Map(importedContent.relationships.map((row) => [row.id, row]));
      for (const row of sourceContent.relationships) {
        const restoredLink = linksById.get(await newId('entity_relationship', row.id));
        expect(restoredLink).toMatchObject({
          kind: row.kind,
          sourceEntityId: await newId('campaign_entity', row.sourceEntityId),
          targetEntityId: await newId('campaign_entity', row.targetEntityId),
        });
        expect(visibilityWithin(restoredLink?.visibility as Visibility, row.visibility)).toBe(true);
        if (row.visibility.mode !== 'everyone') {
          expect(restoredLink?.visibility.mode).not.toBe('everyone');
        }
      }
      expect(importedById.get(await newId('campaign_entity', content.letter))?.visibility).toEqual({
        mode: 'gm_only',
      });
      expect(
        importedById.get(await newId('campaign_entity', content.location))?.visibility,
      ).toEqual({ mode: 'everyone' });
      // The broken link survives with its deleted endpoint.
      expect(linksById.get(await newId('entity_relationship', content.broken))).toBeDefined();
      expect(importedById.get(await newId('campaign_entity', content.crate))?.deleted).toBe(true);
      // The D-07 bound holds on every imported live link.
      if (databaseUrl !== undefined) {
        const reader = connectContentDatabase(databaseUrl, { max: 1 });
        try {
          expect(
            relationshipBoundViolations(await relationshipBoundRows(reader.db, campaignId)),
          ).toEqual([]);
        } finally {
          await reader.close();
        }
      }
      // Imported rows belong to the importer; source actors are not carried.
      const actors = await sql`select distinct created_by from content_entities
        where campaign_id = ${campaignId}`;
      expect(actors.map((row) => row.created_by)).toEqual([importer.userId]);
      // An attachment owned by an entity resolves to the imported entity id (P0 restores no
      // attachment row: no binaries; the owner mapping is the one the content rows use).
      const manifest = chunkOf(source, 'attachments')?.payload as {
        entries: { attachmentId: string; owner: { resourceClass: string; resourceId: string } }[];
      };
      const owned = manifest.entries.find((entry) => entry.attachmentId === portrait);
      expect(owned?.owner).toEqual({ resourceClass: 'campaign_entity', resourceId: content.npc });
      const ownerId = await newId(owned?.owner.resourceClass ?? '', owned?.owner.resourceId ?? '');
      const [ownerRow] = await sql`select name from content_entities
        where campaign_id = ${campaignId} and id = ${ownerId}`;
      expect(ownerRow?.name).toBe('Ferryman');

      // Audit is never imported; the import itself is one feature 02 event on the new campaign.
      const events = await sql<{ action: string }[]>`
        select action from audit_campaign_events where campaign_id = ${campaignId} order by campaign_sequence`;
      expect(events.map((event) => event.action)).toEqual(['campaign.imported']);

      // Job metadata: safe report, manifest checksum, no package content.
      const [row] = await sql`
        select state, campaign_id, encode(source_manifest_checksum, 'hex') as checksum, report, requested_by
        from import_jobs where id = ${jobId}`;
      expect(row).toMatchObject({
        state: 'completed',
        campaign_id: campaignId,
        checksum: source.manifestChecksum,
        requested_by: importer.userId,
      });
      expect(JSON.stringify(row?.report)).not.toContain('Ashen');
      expect(JSON.stringify(job)).not.toContain('caravan');
      expect(h.logLines.join('\n')).not.toContain('caravan');

      // Job state never replicates, and a preserved chunk's payload never reaches a device: only
      // its identity streams, so an offline export can refuse (feature 07 task 05).
      const published = await sql`
        select tablename from pg_publication_tables where tablename = 'import_jobs'`;
      expect(published.length).toBe(0);
      const config = await Bun.file(
        new URL('../../../infra/powersync/sync-config.yaml', import.meta.url),
      ).text();
      const [chunkQuery] = config
        .split('- >-')
        .filter((block) => /FROM import_preserved_chunks\b/.test(block));
      expect(chunkQuery).toBeDefined();
      expect(chunkQuery).not.toContain('payload');
    } finally {
      await h.app.close();
    }
  });

  test('retry is idempotent per job; a deliberate second import creates a distinct campaign', async () => {
    if (sql === undefined) return;
    const h = harness();
    try {
      const owner = await h.signUp('owner');
      const importer = await h.signUp('importer');
      const other = await h.signUp('other');
      const bytes = await h.exportBytes(owner, await h.createCampaign(owner));

      const jobId = crypto.randomUUID();
      const first = await h.importPackage(importer, bytes, jobId);
      expect(first.json().state).toBe('completed');
      const retried = await h.importPackage(importer, bytes, jobId);
      expect(retried.statusCode).toBe(201);
      expect(retried.json()).toEqual(first.json());
      expect(await sideEffects(importer.userId)).toMatchObject({ campaigns: 1, memberships: 1 });
      // Another user cannot reuse or read the job.
      expect((await h.importPackage(other, bytes, jobId)).statusCode).toBe(404);
      expect((await h.call(other, 'GET', `/imports/${jobId}`)).statusCode).toBe(404);
      expect((await h.call(importer, 'GET', `/imports/${jobId}`)).json()).toEqual(first.json());

      // Scenario: Retrying a completed import does not mutate the first campaign.
      const firstCampaign = (
        await h.call(importer, 'GET', `/campaigns/${first.json().campaignId}`)
      ).json();
      const second = await h.importPackage(importer, bytes);
      expect(second.json().state).toBe('completed');
      expect(second.json().campaignId).not.toBe(first.json().campaignId);
      expect(
        (await h.call(importer, 'GET', `/campaigns/${first.json().campaignId}`)).json(),
      ).toEqual(firstCampaign);
      expect(await sideEffects(importer.userId)).toMatchObject({ campaigns: 2, memberships: 2 });
    } finally {
      await h.app.close();
    }
  });

  test('Scenario: Unknown chunks are reported and preserved byte-for-byte through a round trip', async () => {
    if (sql === undefined) return;
    const h = harness();
    try {
      const owner = await h.signUp('owner');
      const importer = await h.signUp('importer');
      const pkg = await inspected(await h.exportBytes(owner, await h.createCampaign(owner)));
      const future = { items: [{ id: 'x', note: 'opaque', nested: { z: 1, a: [true, null] } }] };
      const legacy = { kept: 'from an older import' };
      const bytes = await rebuild(pkg, (input) => ({
        ...input,
        chunks: [
          ...input.chunks,
          { placement: 'entities', moduleId: 'future-notes', chunkVersion: '4', payload: future },
        ],
        preserved: [{ moduleId: 'legacy', chunkVersion: '3', payload: legacy }],
      }));
      const withUnknown = await inspected(bytes);
      const imported = await h.importPackage(importer, bytes);
      expect(imported.json().state).toBe('completed');
      expect(imported.json().report.modules.slice(7)).toEqual([
        {
          moduleId: 'future-notes',
          chunkVersion: '4',
          outcome: 'preserved',
          restoredCount: 0,
          warnings: [{ code: 'unknown_module' }],
        },
        {
          moduleId: 'legacy',
          chunkVersion: '3',
          outcome: 'preserved',
          restoredCount: 0,
          warnings: [{ code: 'preserved_from_package' }],
        },
      ]);
      const campaignId = imported.json().campaignId;
      const rows = await sql`
        select module_id, chunk_version from import_preserved_chunks
        where campaign_id = ${campaignId} order by module_id`;
      expect(rows.map((row) => [row.module_id, row.chunk_version])).toEqual([
        ['future-notes', '4'],
        ['legacy', '3'],
      ]);

      // Re-export: both reappear under unknown/ with identical canonical bytes.
      const again = await inspected(await h.exportBytes(importer, campaignId));
      expect(again.preserved.map((chunk) => chunk.path)).toEqual([
        'unknown/future-notes/4.json',
        'unknown/legacy/3.json',
      ]);
      const checksumOf = async (payload: unknown) => sha256Hex(canonicalBytes(payload));
      expect(await checksumOf(again.preserved[0]?.payload)).toBe(await checksumOf(future));
      expect(again.preserved[1]?.checksum).toBe(
        withUnknown.preserved.find((chunk) => chunk.moduleId === 'legacy')?.checksum as string,
      );
      // And a second import of the re-export keeps them preserved again, never executed.
      const third = await h.importPackage(
        importer,
        concatParts(
          (
            await buildPackage({
              applicationVersion: again.manifest.applicationVersion,
              exportedAt: again.manifest.exportedAt,
              exportedBy: again.manifest.exportedBy,
              campaignId: again.manifest.source.campaignId,
              systemLock: again.systemLock,
              modulesLock: again.modulesLock,
              chunks: again.chunks.map((chunk) => ({ ...chunk })),
              preserved: again.preserved.map((chunk) => ({ ...chunk })),
            })
          ).parts,
        ),
      );
      expect(third.json().state).toBe('completed');
      expect(
        third
          .json()
          .report.modules.filter((module: { outcome: string }) => module.outcome === 'preserved'),
      ).toHaveLength(2);
    } finally {
      await h.app.close();
    }
  });

  test('Scenario: An unavailable pinned system blocks before write (no substitution)', async () => {
    if (sql === undefined) return;
    const exporting = harness();
    // This installation only has a newer version of the same system.
    const importing = harness([FIXTURE_SYSTEM_DEFINITION, NEWER_SYSTEM]);
    try {
      const owner = await exporting.signUp('owner');
      const bytes = await exporting.exportBytes(owner, await exporting.createCampaign(owner));
      const importer = await importing.signUp('importer');
      const before = await sideEffects(importer.userId);
      const result = await importing.importPackage(importer, bytes);
      expect(result.statusCode).toBe(201);
      expect(result.json()).toMatchObject({
        state: 'failed',
        errorCode: 'system_unavailable',
        failure: { unavailable: { system: { systemId: 'portable-system', version: '1.2.0' } } },
        report: { modules: [] },
      });
      expect(result.json().campaignId).toBeUndefined();
      expect(await sideEffects(importer.userId)).toEqual(before);
    } finally {
      await exporting.app.close();
      await importing.app.close();
    }
  });

  test('Scenario: Invalid package input changes nothing (defects and seeded fuzzing)', async () => {
    if (sql === undefined) return;
    const h = harness();
    try {
      const owner = await h.signUp('owner');
      const importer = await h.signUp('importer');
      const valid = await h.exportBytes(owner, await h.createCampaign(owner));
      const pkg = await inspected(valid);
      const before = await sideEffects(importer.userId);
      const [jobsBefore] =
        await sql`select count(*)::int as n from import_jobs where requested_by = ${importer.userId}`;

      const campaignChunk = pkg.chunks.find((chunk) => chunk.moduleId === 'campaign');
      const attachmentChunk = pkg.chunks.find((chunk) => chunk.moduleId === 'attachments');
      const hostile: [string, Uint8Array, string][] = [
        ['malformed container', valid.slice(0, valid.length - 30), 'malformed_container'],
        ['corrupted entry (CRC)', flipInEntry(valid, 'campaign.json'), 'crc_mismatch'],
        [
          'campaign root failing its schema',
          await rebuild(pkg, (input) => ({
            ...input,
            chunks: input.chunks.map((chunk) =>
              chunk.moduleId === 'campaign'
                ? { ...chunk, payload: { ...(campaignChunk?.payload as object), name: '' } }
                : chunk,
            ),
          })),
          'chunk_rejected',
        ],
        [
          'campaign root with an undeclared module pin',
          await rebuild(pkg, (input) => ({
            ...input,
            chunks: input.chunks.map((chunk) =>
              chunk.moduleId === 'campaign'
                ? {
                    ...chunk,
                    payload: {
                      ...(campaignChunk?.payload as object),
                      modulePins: [{ moduleId: 'bestiary', version: '9.9.9' }],
                    },
                  }
                : chunk,
            ),
          })),
          'chunk_rejected',
        ],
        [
          'unavailable module pin in modules.lock',
          await rebuild(pkg, (input) => ({
            ...input,
            modulesLock: { modules: [{ moduleId: 'bestiary', version: '3.0.0' }] },
          })),
          'module_unavailable',
        ],
        [
          'duplicate attachment ids',
          await rebuild(pkg, (input) => ({
            ...input,
            chunks: input.chunks.map((chunk) =>
              chunk.moduleId === 'attachments'
                ? {
                    ...chunk,
                    payload: {
                      ...(attachmentChunk?.payload as object),
                      entries: [attachmentEntry(), attachmentEntry()],
                    },
                  }
                : chunk,
            ),
          })),
          'duplicate_source_id',
        ],
        [
          'attachment manifest failing its schema',
          await rebuild(pkg, (input) => ({
            ...input,
            chunks: input.chunks.map((chunk) =>
              chunk.moduleId === 'attachments'
                ? { ...chunk, payload: { binaries: 'included', entries: [] } }
                : chunk,
            ),
          })),
          'chunk_rejected',
        ],
      ];
      // Seeded mutation fuzzing: byte flips, truncations and splices of the valid package.
      let seed = 0x7f4a7c15;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) >>> 0;
        return seed / 2 ** 32;
      };
      for (let index = 0; index < 40; index += 1) {
        const mutated = valid.slice();
        const kind = index % 3;
        if (kind === 0) {
          for (let flips = 0; flips < 1 + Math.floor(random() * 4); flips += 1) {
            const at = Math.floor(random() * mutated.length);
            mutated[at] = (mutated[at] ?? 0) ^ (1 + Math.floor(random() * 255));
          }
          hostile.push([`fuzz flip ${index}`, mutated, '*']);
        } else if (kind === 1) {
          hostile.push([
            `fuzz truncate ${index}`,
            valid.slice(0, Math.floor(random() * valid.length)),
            '*',
          ]);
        } else {
          const at = Math.floor(random() * valid.length);
          const junk = crypto.getRandomValues(new Uint8Array(1 + Math.floor(random() * 64)));
          hostile.push([
            `fuzz splice ${index}`,
            concatParts([valid.slice(0, at), junk, valid.slice(at)]),
            '*',
          ]);
        }
      }

      let rejected = 0;
      for (const [name, bytes, code] of hostile) {
        const response = await h.importPackage(importer, bytes);
        if (bytes.length === 0) {
          expect(response.statusCode).toBe(400);
          rejected += 1;
          continue;
        }
        expect(response.statusCode, name).toBe(201);
        const job = response.json();
        if (job.state === 'completed') {
          // A mutation that only touched bytes the format ignores (e.g. a ZIP comment field) is
          // still a valid package; it must then be a correct, complete import.
          expect(code, name).toBe('*');
          continue;
        }
        rejected += 1;
        expect(job.state, name).toBe('failed');
        if (code !== '*') expect(job.errorCode, name).toBe(code);
        expect(job.campaignId, name).toBeUndefined();
        expect(JSON.stringify(job), name).not.toContain('caravan');
      }
      expect(rejected).toBeGreaterThan(hostile.length / 2);
      const after = await sideEffects(importer.userId);
      const completed = await sql`
        select campaign_id from import_jobs where requested_by = ${importer.userId} and state = 'completed'`;
      // Only fully valid packages (if any survived fuzzing) created a campaign.
      expect(after?.campaigns).toBe((before?.campaigns ?? 0) + completed.length);
      expect(after?.memberships).toBe((before?.memberships ?? 0) + completed.length);
      const [jobsAfter] =
        await sql`select count(*)::int as n from import_jobs where requested_by = ${importer.userId}`;
      expect((jobsAfter?.n ?? 0) - (jobsBefore?.n ?? 0)).toBe(
        hostile.filter(([, bytes]) => bytes.length > 0).length,
      );
    } finally {
      await h.app.close();
    }
  });
});

describe.skipIf(!available)('atomic import coordinator (PostgreSQL)', () => {
  /**
   * The production feature 02 importer and feature 05 contributor, plus two test contributors:
   * `notes` writes a row through the import transaction and narrows targeted Visibility with
   * feature 04's rule; `zz-broken` fails after it. Every row must roll back.
   */
  test('Scenario: A contributor failure rolls back the whole import', async () => {
    if (sql === undefined || databaseUrl === undefined) return;
    const portability = connectPortabilityDatabase(databaseUrl);
    const campaigns = connectCampaignDatabase(databaseUrl);
    const contentDb = connectContentDatabase(databaseUrl);
    const h = harness();
    try {
      const owner = await h.signUp('owner');
      const importer = await h.signUp('importer');
      const player = await h.signUp('player');
      const sourceCampaign = await h.createCampaign(owner);
      await h.invite(owner, sourceCampaign, player, 'player');
      // Feature 16 task 17: the real content contributor restores before the broken one fails.
      await seedContent(sourceCampaign, owner.userId, player.userId);
      const pkg = await inspected(await h.exportBytes(owner, sourceCampaign));
      const targetedNote = crypto.randomUUID();
      const bytes = await rebuild(pkg, (input) => ({
        ...input,
        chunks: [
          ...input.chunks,
          {
            placement: 'documents',
            moduleId: 'notes',
            chunkVersion: '1',
            payload: {
              notes: [
                { id: targetedNote, visibility: { mode: 'players', playerIds: [owner.userId] } },
                { id: crypto.randomUUID(), visibility: { mode: 'everyone' } },
              ],
            },
          },
          { placement: 'documents', moduleId: 'zz-broken', chunkVersion: '1', payload: {} },
        ],
      }));

      const catalog = new StaticSystemCatalog([PORTABLE_SYSTEM]);
      const repository = new PostgresCampaignRepository(campaigns.db);
      const writes: Visibility[] = [];
      const warnings: ImportWarning[] = [];
      const notes: ImportableModule = {
        moduleId: 'notes',
        importChunkVersions: ['1'],
        validate: async (chunk: ExportChunk) =>
          ok({
            defines: (chunk.payload as { notes: { id: string }[] }).notes.map((note) => ({
              kind: 'note',
              sourceId: note.id,
            })),
            warnings: [],
          }),
        restore: async (chunk, context) => {
          const restoredWarnings: ImportWarning[] = [];
          for (const note of (chunk.payload as { notes: { id: string; visibility: Visibility }[] })
            .notes) {
            const result = visibilityForImport(note.visibility, context.mapId, note.id);
            writes.push(result.visibility);
            if (result.warning !== undefined) restoredWarnings.push(result.warning);
            // A real row on the shared transaction (any table works for the rollback proof).
            await new PostgresImportCommitStore().preserve(
              context.transaction,
              context.campaignId,
              [
                {
                  moduleId: `note-${writes.length}`,
                  chunkVersion: '1',
                  payload: {},
                  checksum: '00'.repeat(32),
                },
              ],
            );
          }
          warnings.push(...restoredWarnings);
          return ok({ restoredCount: writes.length, warnings: restoredWarnings });
        },
      };
      const contentRepositories = {
        entities: new PostgresEntityRepository(contentDb.db),
        relationships: new PostgresRelationshipRepository(contentDb.db),
      };
      const contentWrites: number[] = [];
      const contentContributor = new ContentExporter(contentRepositories, {
        writer: {
          restoreWithin: async (handle, plan) => {
            const written = await new PostgresContentImportWriter(
              contentRepositories,
            ).restoreWithin(handle, plan);
            // Inside the import transaction the links (and their endpoints) are visible.
            contentWrites.push(
              (await relationshipBoundRows(handle as ContentSqlExecutor, plan.campaignId)).length,
            );
            return written;
          },
        },
        unwrap: importTransactionHandle,
      });
      const contentRows = async () => {
        const [row] = await sql<{ n: number }[]>`select count(*)::int as n from content_entities
          where created_by = ${importer.userId}`;
        return row?.n ?? -1;
      };
      const build = (broken: 'err' | 'throw' | 'none') => {
        const registry = new ExportRegistry()
          .register(new CampaignExporter(repository), {
            placement: 'campaign',
            importer: new CampaignImporter({
              catalog,
              settings: new CampaignSettingRegistry(),
              writer: repository,
              ownerWriter: new PostgresCampaignMembershipWriter(),
              unwrap: importTransactionHandle,
            }),
          })
          .register(new AttachmentManifestExporter({ listReadyInCampaign: async () => [] }), {
            placement: 'attachments-manifest',
          })
          .register(contentContributor, { placement: 'entities' })
          .register(
            {
              ...notes,
              export: async () => ({ moduleId: 'notes', chunkVersion: '1', payload: {} }),
              import: async () => ok(undefined),
            },
            { placement: 'documents' },
          );
        if (broken !== 'none') {
          const brokenModule: ExportableModule & ImportableModule = {
            moduleId: 'zz-broken',
            importChunkVersions: ['1'],
            export: async () => ({ moduleId: 'zz-broken', chunkVersion: '1', payload: {} }),
            import: async () => ok(undefined),
            validate: async () => ok({ defines: [], warnings: [] }),
            restore: async () => {
              if (broken === 'throw') throw new Error('internal detail: password=hunter2');
              return { ok: false, error: 'notes_link_unresolved' };
            },
          };
          registry.register(brokenModule, { placement: 'documents' });
        }
        const jobs = new PostgresImportJobRepository(portability.db);
        return new ImportService({
          jobs,
          registry,
          rules: catalogRulesAvailability(catalog),
          coordinator: new ImportCoordinator({
            transactions: new PostgresImportTransactions(portability.db),
            store: new PostgresImportCommitStore(),
          }),
        });
      };

      for (const [mode, detail] of [
        ['err', 'notes_link_unresolved'],
        ['throw', undefined],
      ] as const) {
        const before = await sideEffects(importer.userId);
        const jobId = crypto.randomUUID();
        touchedJobs.add(jobId);
        writes.length = 0;
        const result = await build(mode).start({ jobId, userId: importer.userId, bytes });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toMatchObject({
          state: 'failed',
          errorCode: 'contributor_failed',
          failure: { moduleId: 'zz-broken', ...(detail === undefined ? {} : { detail }) },
        });
        expect(JSON.stringify(result.value)).not.toContain('hunter2');
        // The notes contributor did write before the failure: everything rolled back.
        expect(writes.length).toBe(2);
        expect(await sideEffects(importer.userId)).toEqual(before);
        // Feature 16: content rows were written inside the transaction, none survive.
        expect(contentWrites.at(-1)).toBe(3);
        expect(await contentRows()).toBe(0);
        const [job] = await sql`select campaign_id, state from import_jobs where id = ${jobId}`;
        expect(job).toEqual({ campaign_id: null, state: 'failed' });
      }

      // Without the broken contributor the same plan commits; it reports it as unknown (preserved).
      writes.length = 0;
      warnings.length = 0;
      const jobId = crypto.randomUUID();
      touchedJobs.add(jobId);
      const committed = await build('none').start({ jobId, userId: importer.userId, bytes });
      expect(committed.ok && committed.value.state).toBe('completed');
      if (!committed.ok || committed.value.campaignId === undefined) return;
      touchedCampaigns.add(committed.value.campaignId);
      // Scenario: Visibility does not widen — the targeted note narrowed with a warning.
      expect(writes).toEqual([{ mode: 'gm_only' }, { mode: 'everyone' }]);
      expect(warnings).toEqual([
        { code: 'visibility_narrowed_to_gm_only', sourceId: targetedNote },
      ]);
      expect(
        committed.value.report.modules.map((module) => [module.moduleId, module.outcome]),
      ).toEqual([
        ['campaign', 'restored'],
        ['attachments', 'restored'],
        ['content', 'restored'],
        ['notes', 'restored'],
        ['characters', 'preserved'],
        ['dice_rolls', 'preserved'],
        ['encounters', 'preserved'],
        ['sessions', 'preserved'],
        ['zz-broken', 'preserved'],
      ]);
      expect(await contentRows()).toBe(4);
    } finally {
      await h.app.close();
      await portability.close();
      await campaigns.close();
      await contentDb.close();
    }
  });
});

function attachmentEntry() {
  return {
    attachmentId: '00000000-0000-4000-8000-0000000000f1',
    owner: { resourceClass: 'fixture_note', resourceId: '00000000-0000-4000-8000-0000000000f2' },
    filename: 'map.png',
    mime: 'image/png',
    size: 10,
    checksum: '07'.repeat(32),
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: '2026-10-27T12:00:00.000Z',
    finalizedAt: '2026-10-27T12:00:00.000Z',
  };
}

/** Flips one byte inside a stored entry's data (stored = uncompressed, so CRC/checksum fail). */
function flipInEntry(bytes: Uint8Array, name: string): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  for (let index = 0; index + 30 < bytes.length; index += 1) {
    if (
      bytes[index] !== 0x50 ||
      bytes[index + 1] !== 0x4b ||
      bytes[index + 2] !== 0x03 ||
      bytes[index + 3] !== 0x04
    ) {
      continue;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const nameLength = view.getUint16(index + 26, true);
    const extra = view.getUint16(index + 28, true);
    const found = bytes.slice(index + 30, index + 30 + nameLength);
    if (found.length === encoded.length && found.every((byte, at) => byte === encoded[at])) {
      const copy = bytes.slice();
      const at = index + 30 + nameLength + extra + 2;
      copy[at] = (copy[at] ?? 0) ^ 0x01;
      return copy;
    }
  }
  throw new Error(`entry ${name} not found`);
}
