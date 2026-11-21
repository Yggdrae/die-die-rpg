import { afterAll, describe, expect, test } from 'bun:test';
import {
  ACTIONS_SYNC_FEATURE_ID,
  EFFECT_REPLICA_TABLE,
  EffectLocalRepository,
  type EffectRecord,
} from '@rpg/actions';
import { runEffectTargetContract } from '@rpg/actions/testing';
import { editPlan, initialCharacterState, type SheetEdit } from '@rpg/characters';
import type { Role } from '@rpg/contracts';
import { InMemoryRepository } from '@rpg/contracts/testing';
import {
  ENCOUNTER_NOTE_REPLICA_TABLE,
  ENCOUNTER_REPLICA_TABLE,
  ENCOUNTERS_SYNC_FEATURE_ID,
  EncounterLocalRepository,
  type EncounterNoteRecord,
  type EncounterRecord,
  PARTICIPANT_CLASS,
  PARTICIPANT_REPLICA_TABLE,
  PARTICIPANT_STATE_REPLICA_TABLE,
  type ParticipantDraft,
  ParticipantLocalRepository,
  type ParticipantRecord,
} from '@rpg/encounters';
import {
  connectEncountersDatabase,
  encounterParticipantTargetAdapter,
  PostgresEncounterRepository,
} from '@rpg/encounters/postgres';
import { FIXTURE_SYSTEM_DEFINITION, FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import postgres from 'postgres';
import { buildRuntimeApp } from '../../runtime.ts';

/**
 * Feature 19 on PostgreSQL through the real composition root (`_techspec.md` "Authority"): the lifecycle and the
 * final end (D-10), participants and their instance states (D-02, D-04), effects through feature 11 on the
 * `encounter_participant` adapter (merge, `gm_only` records, resend), the matrix, audit once per mutation (D-14),
 * and the configured `authorized_encounters` queries returning no instance state, GM note, or hidden participant to
 * a player. The live PowerSync counterpart is in `sync-config.powersync.integration.test.ts`.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const origin = 'https://table.invalid';
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const db = sql as NonNullable<typeof sql>;
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from encounters, encounter_gm_notes, encounter_participants,
      encounter_participant_states limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const campaigns: string[] = [];

afterAll(async () => {
  if (available && campaigns.length > 0) {
    for (const table of [
      'effect_applications',
      'encounter_participant_states',
      'encounter_participants',
      'encounter_gm_notes',
      'encounters',
      'sync_mutation_receipts',
    ]) {
      await db.unsafe(`delete from ${table} where campaign_id = any($1::uuid[])`, [campaigns]);
    }
  }
  await sql?.end({ timeout: 1 });
});

const SYNC_CONFIG = new URL('../../../../../infra/powersync/sync-config.yaml', import.meta.url);

/** One configured `authorized_encounters` query, as PostgreSQL (requester `$1`). */
async function streamQuery(table: string): Promise<string> {
  const parsed = Bun.YAML.parse(await Bun.file(SYNC_CONFIG).text()) as {
    readonly streams: Record<string, { readonly queries?: string[] }>;
  };
  const query = (parsed.streams.authorized_encounters?.queries ?? []).find((item) =>
    new RegExp(`\\bFROM ${table}\\b`).test(item),
  );
  if (query === undefined) throw new Error(`${table} stream query not found`);
  return query
    .replace(
      /auth\.user_id\(\) IN ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/g,
      (_match, column: string) => `${column} @> jsonb_build_array($1::uuid)`,
    )
    .replaceAll('auth.user_id()', '$1::uuid')
    .replace(
      /IN '(\[[^']*\])'/g,
      (_match, values: string) =>
        `IN (${(JSON.parse(values) as string[]).map((value) => `'${value}'`).join(', ')})`,
    );
}

type Who = { readonly id: string; readonly headers: Record<string, string> };
type Outcome = Record<string, unknown> & { readonly status: string; readonly code?: string };
let sequence = 0;

async function runtime() {
  if (databaseUrl === undefined) throw new Error('database unavailable');
  const app = buildRuntimeApp({
    databaseUrl,
    allowedOrigin: origin,
    production: false,
    powerSyncEndpoint: 'http://localhost:8080',
    powerSyncJwtSecret: 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
    systems: [FIXTURE_SYSTEM_DEFINITION],
    logger: false,
  });
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 8);
  let counter = 0;
  const signUp = async (): Promise<Who> => {
    counter += 1;
    const account = await app.inject({
      method: 'POST',
      url: '/auth/accounts',
      payload: { username: `en_${suffix}_${counter}`, password: 'correct horse battery staple' },
    });
    expect(account.statusCode).toBe(200);
    const raw = account.headers['set-cookie'];
    return {
      id: (JSON.parse(account.body) as { user: { id: string } }).user.id,
      headers: { cookie: ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0] ?? '', origin },
    };
  };
  const createCampaign = async (owner: Who) => {
    const campaignId = crypto.randomUUID();
    campaigns.push(campaignId);
    const created = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: owner.headers,
      payload: {
        id: campaignId,
        system: FIXTURE_SYSTEM_DEFINITION.summary.ref,
        gameMode: 'standard',
        options: {},
        moduleIds: [],
        name: 'Encounters',
        description: '',
      },
    });
    expect(created.statusCode).toBe(201);
    return campaignId;
  };
  const invite = async (owner: Who, campaignId: string, member: Who, role: Role) => {
    const invited = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/invitations`,
      headers: owner.headers,
      payload: { targetRole: role },
    });
    expect(invited.statusCode).toBe(201);
    const accepted = await app.inject({
      method: 'POST',
      url: `/invitations/${(invited.json() as { token: string }).token}/accept`,
      headers: member.headers,
    });
    expect(accepted.statusCode).toBe(200);
  };
  const upload = async (
    who: Who,
    campaignId: string,
    input: {
      readonly table: string;
      readonly recordId: string;
      readonly operation: 'insert' | 'update' | 'tombstone';
      readonly expectedVersion: number | null;
      readonly payload: unknown;
      readonly featureId?: string;
      readonly mutationId?: string;
      readonly audited?: boolean;
    },
  ): Promise<Outcome> => {
    sequence += 1;
    const at = new Date().toISOString();
    const response = await app.inject({
      method: 'POST',
      url: '/sync/mutations',
      headers: who.headers,
      payload: {
        campaignId,
        replicaId: crypto.randomUUID(),
        mutations: [
          {
            mutationId: input.mutationId ?? crypto.randomUUID(),
            campaignId,
            featureId: input.featureId ?? ENCOUNTERS_SYNC_FEATURE_ID,
            tableName: input.table,
            recordId: input.recordId,
            operation: input.operation,
            expectedVersion: input.expectedVersion,
            payload: input.payload,
            ...(input.audited === true
              ? {
                  audit: {
                    campaignId,
                    action: 'encounters.created',
                    targetType: input.table,
                    targetId: input.recordId,
                    at,
                    private: false,
                  },
                }
              : {}),
            causalSequence: sequence,
            state: 'pending',
            attemptCount: 0,
            recordedAt: at,
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { outcomes: Outcome[] }).outcomes[0] as Outcome;
  };
  return { app, signUp, createCampaign, invite, upload };
}

/** The device repositories over in-memory replicas: the payloads are exactly what a device queues. */
function device(campaignId: string, userId: string) {
  const actor = { userId, campaignId };
  const effectRows = new InMemoryRepository<EffectRecord>();
  const effects = new EffectLocalRepository(effectRows, actor);
  return {
    encounters: new EncounterLocalRepository(new InMemoryRepository<EncounterRecord>(), actor),
    participants: new ParticipantLocalRepository(
      new InMemoryRepository<ParticipantRecord>(),
      { list: async () => [] },
      effects,
      actor,
    ),
    effects,
  };
}

async function started(campaignId: string, userId: string, name = 'Ambush at the ford') {
  const local = device(campaignId, userId);
  const created = await local.encounters.start({ name, sessionId: crypto.randomUUID() });
  if (!created.ok) throw new Error('start refused');
  return { local, encounter: created.value };
}

function noteRecord(encounter: EncounterRecord, userId: string, body: string): EncounterNoteRecord {
  const now = new Date().toISOString();
  return {
    id: encounter.id,
    campaignId: encounter.campaignId,
    type: 'encounter_gm_note',
    name: 'GM notes',
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
    updatedBy: userId,
    body,
  };
}

/** One feature 11 application on an instance, planned from the given state (the device's view). */
async function damage(
  local: ReturnType<typeof device>,
  participant: ParticipantRecord,
  edit: SheetEdit = { kind: 'adjust_resource', resource: 'focus', by: -1 },
) {
  const state = initialCharacterState(FIXTURE_SYSTEM_PACKAGE, participant.name);
  const plan = editPlan(FIXTURE_SYSTEM_PACKAGE, state, edit, true);
  if (!plan.ok) throw new Error(plan.error);
  const applied = await local.effects.apply(
    { targetClass: PARTICIPANT_CLASS, targetId: participant.id, visibility: { mode: 'gm_only' } },
    plan.value,
  );
  if (!applied.ok) throw new Error(applied.error.code);
  return applied.value;
}

async function auditOf(campaignId: string, targetId: string) {
  return db<{ action: string; origin_mutation_id: string }[]>`
    select action, origin_mutation_id from (
      select action, origin_mutation_id, accepted_at from audit_campaign_events
      where campaign_id = ${campaignId} and target_id = ${targetId}
      union all
      select action, origin_mutation_id, accepted_at from audit_private_events
      where campaign_id = ${campaignId} and target_id = ${targetId}
    ) events
    order by accepted_at`.then((rows) => [...rows]);
}

async function focusOf(id: string): Promise<number | undefined> {
  const [row] = await db<{ state: { resources: { focus?: { current: number } } } }[]>`
    select state from encounter_participant_states where id = ${id}`;
  return row?.state.resources.focus?.current;
}

describe.skipIf(!available)('encounters at the authority (PostgreSQL)', () => {
  test('lifecycle: start audited once, details, a stale change, and the final end', async () => {
    const { app, signUp, createCampaign, invite, upload } = await runtime();
    try {
      const gm = await signUp();
      const player = await signUp();
      const campaignId = await createCampaign(gm);
      await invite(gm, campaignId, player, 'player');
      const { local, encounter } = await started(campaignId, gm.id);
      const mutationId = crypto.randomUUID();
      const insert = {
        table: ENCOUNTER_REPLICA_TABLE,
        recordId: encounter.id,
        operation: 'insert' as const,
        expectedVersion: null,
        payload: encounter,
        mutationId,
      };
      expect(await upload(gm, campaignId, insert)).toMatchObject({ status: 'accepted' });
      expect(await upload(gm, campaignId, insert)).toMatchObject({ status: 'accepted' });
      expect(await auditOf(campaignId, encounter.id)).toEqual([
        { action: 'encounter.started', origin_mutation_id: mutationId },
      ]);
      expect(
        await upload(gm, campaignId, { ...insert, mutationId: undefined, audited: true }),
      ).toMatchObject({ status: 'error', code: 'invalid_payload' });
      const crafted = (await started(campaignId, player.id)).encounter;
      expect(
        await upload(player, campaignId, {
          table: ENCOUNTER_REPLICA_TABLE,
          recordId: crafted.id,
          operation: 'insert',
          expectedVersion: null,
          payload: crafted,
        }),
      ).toMatchObject({ status: 'error', code: 'not_found_or_forbidden' });

      const lit = await local.encounters.change(encounter.id, {
        kind: 'environment',
        environment: 'Dusk, river mist',
      });
      if (!lit.ok) throw new Error('change refused');
      const update = (payload: EncounterRecord, version: number) =>
        upload(gm, campaignId, {
          table: ENCOUNTER_REPLICA_TABLE,
          recordId: encounter.id,
          operation: 'update',
          expectedVersion: version,
          payload,
        });
      expect(await update(lit.value, 1)).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
      expect(await update(lit.value, 1)).toMatchObject({ status: 'conflict', actualVersion: 2 });
      expect(await update({ ...lit.value, name: 'Renamed' }, 2)).toMatchObject({
        status: 'error',
        code: 'invalid_encounter',
      });
      const ended = await local.encounters.end(encounter.id);
      if (!ended.ok) throw new Error('end refused');
      const endId = crypto.randomUUID();
      expect(
        await upload(gm, campaignId, {
          table: ENCOUNTER_REPLICA_TABLE,
          recordId: encounter.id,
          operation: 'update',
          expectedVersion: 2,
          payload: ended.value,
          mutationId: endId,
        }),
      ).toMatchObject({ status: 'accepted', acceptedVersion: 3 });
      expect((await auditOf(campaignId, encounter.id)).map((row) => row.action)).toEqual([
        'encounter.started',
        'encounter.ended',
      ]);
      // The end is final (D-10).
      expect(await update({ ...lit.value, environment: 'Later', version: 3 }, 3)).toMatchObject({
        status: 'error',
        code: 'invalid_encounter',
      });
      const [row] = await db<{ status: string; environment: string }[]>`
        select status, environment from encounters where id = ${encounter.id}`;
      expect(row).toEqual({ status: 'ended', environment: 'Dusk, river mist' });

      // GM notes: versioned, GM roles only.
      const note = (who: Who, body: string, version: number | null) =>
        upload(who, campaignId, {
          table: ENCOUNTER_NOTE_REPLICA_TABLE,
          recordId: encounter.id,
          operation: version === null ? 'insert' : 'update',
          expectedVersion: version,
          payload: { ...noteRecord(encounter, who.id, body), version: version ?? 1 },
        });
      expect(await note(gm, 'The leader flees at half', null)).toMatchObject({
        status: 'accepted',
      });
      expect(await note(gm, 'Stale', 2)).toMatchObject({ status: 'conflict', actualVersion: 1 });
      expect(await note(player, 'Mine', null)).toMatchObject({
        status: 'error',
        code: 'not_found_or_forbidden',
      });
    } finally {
      await app.close();
    }
  }, 60_000);

  test('participants, instance states through feature 11, visibility, and the player stream', async () => {
    const { app, signUp, createCampaign, invite, upload } = await runtime();
    try {
      const gm = await signUp();
      const player = await signUp();
      const campaignId = await createCampaign(gm);
      await invite(gm, campaignId, player, 'player');
      const { local, encounter } = await started(campaignId, gm.id);
      expect(
        await upload(gm, campaignId, {
          table: ENCOUNTER_REPLICA_TABLE,
          recordId: encounter.id,
          operation: 'insert',
          expectedVersion: null,
          payload: encounter,
        }),
      ).toMatchObject({ status: 'accepted' });
      await upload(gm, campaignId, {
        table: ENCOUNTER_NOTE_REPLICA_TABLE,
        recordId: encounter.id,
        operation: 'insert',
        expectedVersion: null,
        payload: noteRecord(encounter, gm.id, 'Reinforcements in round three'),
      });

      const bandit = crypto.randomUUID();
      const drafts: ParticipantDraft[] = [
        { sourceKind: 'character', sourceId: crypto.randomUUID(), label: 'Ash' },
        { sourceKind: 'entity', sourceId: bandit, label: 'Bandit', count: 3 },
        { sourceKind: 'entity', sourceId: crypto.randomUUID(), label: 'Lurker', hidden: true },
      ];
      const added = await local.participants.add(FIXTURE_SYSTEM_PACKAGE, encounter, drafts);
      if (!added.ok) throw new Error('add refused');
      expect(added.value.map((row) => row.name)).toEqual([
        'Ash',
        'Bandit 1',
        'Bandit 2',
        'Bandit 3',
        'Lurker',
      ]);
      const [ash, first, second, third, lurker] = added.value as [
        ParticipantRecord,
        ParticipantRecord,
        ParticipantRecord,
        ParticipantRecord,
        ParticipantRecord,
      ];
      const addId = crypto.randomUUID();
      for (const participant of added.value) {
        const insert = {
          table: PARTICIPANT_REPLICA_TABLE,
          recordId: participant.id,
          operation: 'insert' as const,
          expectedVersion: null,
          payload: participant,
          ...(participant.id === first.id ? { mutationId: addId } : {}),
        };
        expect(await upload(gm, campaignId, insert)).toMatchObject({ status: 'accepted' });
        if (participant.id === first.id) {
          expect(await upload(gm, campaignId, insert)).toMatchObject({ status: 'accepted' });
        }
      }
      expect(await auditOf(campaignId, first.id)).toEqual([
        { action: 'encounter.participant_added', origin_mutation_id: addId },
      ]);
      // D-02: a character participant holds no state; each instance has its own.
      const states = await db<{ id: string }[]>`
        select id from encounter_participant_states where campaign_id = ${campaignId}`;
      expect(states.map((row) => row.id).sort()).toEqual(
        [first.id, second.id, third.id, lurker.id].sort(),
      );
      expect(await focusOf(first.id)).toBe(6);
      // A player may not add one; a crafted state part is refused.
      const crafted = await device(campaignId, player.id).participants.add(
        FIXTURE_SYSTEM_PACKAGE,
        { ...encounter, createdBy: player.id },
        [{ sourceKind: 'entity', sourceId: bandit, label: 'Mine' }],
      );
      if (!crafted.ok) throw new Error('local add refused');
      expect(
        await upload(player, campaignId, {
          table: PARTICIPANT_REPLICA_TABLE,
          recordId: crafted.value[0]?.id ?? '',
          operation: 'insert',
          expectedVersion: null,
          payload: crafted.value[0],
        }),
      ).toMatchObject({ status: 'error', code: 'not_found_or_forbidden' });

      // FR-006, FR-007: two offline damages on Bandit 1 merge; Bandit 2 is untouched.
      const effect = (who: Who, record: EffectRecord, mutationId?: string) =>
        upload(who, campaignId, {
          table: EFFECT_REPLICA_TABLE,
          featureId: ACTIONS_SYNC_FEATURE_ID,
          recordId: record.id,
          operation: 'insert',
          expectedVersion: null,
          payload: record,
          ...(mutationId === undefined ? {} : { mutationId }),
        });
      const hit = await damage(local, first);
      const other = await damage(device(campaignId, gm.id), first);
      expect(await effect(gm, hit)).toMatchObject({ status: 'accepted' });
      expect(await effect(gm, hit, crypto.randomUUID())).toMatchObject({ status: 'accepted' });
      expect(await effect(gm, other)).toMatchObject({ status: 'accepted' });
      expect(await focusOf(first.id)).toBe(4);
      expect(await focusOf(second.id)).toBe(6);
      const [recorded] = await db<{ visibility_mode: string }[]>`
        select visibility_mode from effect_applications where id = ${hit.id}`;
      // Enemy statistics: the record is GM-only whatever the device said (D-05).
      expect(recorded?.visibility_mode).toBe('gm_only');
      expect(
        await effect(player, await damage(device(campaignId, player.id), second)),
      ).toMatchObject({ status: 'error' });
      expect(await focusOf(second.id)).toBe(6);
      // A character participant has no instance: the character is the target (write-through).
      expect(await effect(gm, await damage(local, ash))).toMatchObject({ status: 'error' });

      // The configured stream: the player holds the encounter and the visible participants only.
      const ids = async (table: string, who: Who) =>
        (await db.unsafe<{ id: string }[]>(await streamQuery(table), [who.id])).map(
          (row) => row.id,
        );
      expect(await ids(ENCOUNTER_REPLICA_TABLE, player)).toContain(encounter.id);
      expect(await ids(ENCOUNTER_NOTE_REPLICA_TABLE, player)).not.toContain(encounter.id);
      expect(await ids(ENCOUNTER_NOTE_REPLICA_TABLE, gm)).toContain(encounter.id);
      expect(
        (await ids(PARTICIPANT_STATE_REPLICA_TABLE, player)).filter((id) =>
          [first.id, second.id, third.id, lurker.id].includes(id),
        ),
      ).toEqual([]);
      expect((await ids(PARTICIPANT_STATE_REPLICA_TABLE, gm)).sort()).toEqual(
        expect.arrayContaining([first.id, lurker.id]),
      );
      const playerParticipants = await ids(PARTICIPANT_REPLICA_TABLE, player);
      expect(playerParticipants).toContain(first.id);
      expect(playerParticipants).not.toContain(lurker.id);

      // D-05: reveal is one way and audited; removal is versioned and audited.
      const revealed = await local.participants.reveal(lurker);
      if (!revealed.ok) throw new Error('reveal refused');
      expect(
        await upload(gm, campaignId, {
          table: PARTICIPANT_REPLICA_TABLE,
          recordId: lurker.id,
          operation: 'update',
          expectedVersion: 1,
          payload: revealed.value,
        }),
      ).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
      expect(await ids(PARTICIPANT_REPLICA_TABLE, player)).toContain(lurker.id);
      expect(
        await upload(gm, campaignId, {
          table: PARTICIPANT_REPLICA_TABLE,
          recordId: lurker.id,
          operation: 'update',
          expectedVersion: 2,
          payload: { ...revealed.value, version: 2, visibility: { mode: 'gm_only' } },
        }),
      ).toMatchObject({ status: 'error', code: 'invalid_encounter' });
      // The instance's damage did not move the participant's version (D-13).
      expect(
        await upload(gm, campaignId, {
          table: PARTICIPANT_REPLICA_TABLE,
          recordId: first.id,
          operation: 'tombstone',
          expectedVersion: 1,
          payload: null,
        }),
      ).toMatchObject({ status: 'accepted' });
      expect((await auditOf(campaignId, lurker.id)).map((row) => row.action)).toEqual([
        'encounter.participant_added',
        'encounter.participant_revealed',
      ]);
      expect((await auditOf(campaignId, first.id)).map((row) => row.action)).toEqual([
        'encounter.participant_added',
        'encounter.participant_removed',
      ]);
      expect(await ids(PARTICIPANT_REPLICA_TABLE, player)).toContain(first.id);
      const [gone] = await db<{ deleted_at: Date | null }[]>`
        select deleted_at from encounter_participants where id = ${first.id}`;
      expect(gone?.deleted_at).not.toBeNull();

      // D-10: after the end, an instance refuses effects.
      const ended = await local.encounters.end(encounter.id);
      if (!ended.ok) throw new Error('end refused');
      expect(
        await upload(gm, campaignId, {
          table: ENCOUNTER_REPLICA_TABLE,
          recordId: encounter.id,
          operation: 'update',
          expectedVersion: 1,
          payload: ended.value,
        }),
      ).toMatchObject({ status: 'accepted' });
      expect(await effect(gm, await damage(local, second))).toMatchObject({ status: 'error' });
      expect(await focusOf(second.id)).toBe(6);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('the participant adapter passes the feature 11 target contract', async () => {
    if (databaseUrl === undefined) throw new Error('database unavailable');
    const connection = connectEncountersDatabase(databaseUrl);
    const repository = new PostgresEncounterRepository(connection.db);
    const campaign = crypto.randomUUID();
    campaigns.push(campaign);
    const owner = crypto.randomUUID();
    const local = device(campaign, owner);
    const created = await local.encounters.start({ name: 'Contract' });
    if (!created.ok) throw new Error('start refused');
    const added = await local.participants.add(FIXTURE_SYSTEM_PACKAGE, created.value, [
      { sourceKind: 'entity', sourceId: crypto.randomUUID(), label: 'Probe' },
    ]);
    if (!added.ok) throw new Error('add refused');
    const participant = added.value[0] as ParticipantRecord;
    class Rollback extends Error {}
    try {
      await repository.transaction(async (transaction) => {
        await repository.insertEncounter(transaction, {
          id: created.value.id,
          campaignId: campaign,
          name: 'Contract',
          status: 'active',
          startedAt: created.value.startedAt,
          environment: '',
          actorUserId: owner,
        });
        await repository.insertParticipant(transaction, {
          id: participant.id,
          campaignId: campaign,
          encounterId: created.value.id,
          label: participant.name,
          sourceKind: 'entity',
          sourceId: participant.sourceId,
          position: 0,
          conditions: {},
          visibilityMode: 'everyone',
          state: initialCharacterState(FIXTURE_SYSTEM_PACKAGE, participant.name),
          actorUserId: owner,
        });
        expect(
          await runEffectTargetContract({
            adapter: encounterParticipantTargetAdapter({
              encounters: repository,
              system: async () => FIXTURE_SYSTEM_PACKAGE,
            }),
            transaction: transaction as never,
            campaignId: campaign,
            targetId: participant.id,
            otherCampaignId: crypto.randomUUID(),
            actorUserId: owner,
          }),
        ).toEqual([]);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    } finally {
      await connection.close();
    }
  }, 60_000);
});
