import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresAuditRuntime } from '@rpg/audit';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import {
  CONTENT_SYNC_FEATURE_ID,
  ENTITY_REPLICA_TABLE,
  EntityLocalRepository,
  type EntityRecord,
  PERSONAL_NOTE_REPLICA_TABLE,
  PersonalNoteLocalRepository,
  type PersonalNoteRecord,
} from '@rpg/content';
import {
  connectContentDatabase,
  EntityService,
  EntityVisibilityAdapter,
  PersonalNoteService,
  PostgresEntityRepository,
  PostgresPersonalNoteRepository,
  PostgresRelationshipRepository,
  RelationshipVisibilityAdapter,
} from '@rpg/content/postgres';
import {
  type ActorRef,
  err,
  ok,
  type RepositoryError,
  type Result,
  type Role,
  type SyncedRepository,
} from '@rpg/contracts';
import { createPostgresIdentityRuntime } from '@rpg/identity';
import {
  AuthorityMutationService,
  type CurrentAccessResolver,
  LongTextHoldService,
  MutationApplierRegistry,
  type MutationAuditParticipant,
  type MutationBatch,
  type MutationOutcome,
  type PendingMutation,
  SyncStatusStore,
} from '@rpg/sync';
import {
  ConflictHub,
  MutationQueue,
  SqliteReplicaStore,
  SqliteSyncedRepository,
} from '@rpg/sync/bun';
import {
  connectSyncDatabase,
  PostgresLongTextHoldRepository,
  PostgresMutationReceiptStore,
} from '@rpg/sync/postgres';
import postgres from 'postgres';
import { mutationAuditParticipantFor } from '../audit/composition.ts';
import { createAuditRendererRegistry } from '../audit/contributors.ts';
import { registerResourcePolicies } from '../sync/sync-rules.ts';
import { EntitySyncMutationApplier, PersonalNoteSyncMutationApplier } from './appliers.ts';

/**
 * Feature 16 task 06 on PostgreSQL, through `AuthorityMutationService` with the real feature 06
 * recorder, receipt store, and feature 03 long-text holds: accept, conflict, deny after a role
 * downgrade, invalid payloads, tombstones, replays, the B-2 session hold check, the
 * in-transaction server-authored audit, author-private notes, and an offline device round trip.
 * Content, hold, and receipt rows are deleted afterwards; audit rows are append-only and stay.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sql =
  databaseUrl === undefined
    ? undefined
    : postgres(databaseUrl, { max: 2, onnotice: () => undefined });
const available = await (async () => {
  if (sql === undefined) return false;
  try {
    await sql`select 1 from content_entities, sync_long_text_holds, audit_campaign_events limit 1`;
    return true;
  } catch {
    return false;
  }
})();
const db = sql as NonNullable<typeof sql>;
const connections =
  available && databaseUrl !== undefined
    ? {
        content: connectContentDatabase(databaseUrl),
        sync: connectSyncDatabase(databaseUrl),
        audit: createPostgresAuditRuntime({
          connectionString: databaseUrl,
          diagnostics: { degraded: () => {}, deadLettered: () => {}, repaired: () => {} },
          registry: createAuditRendererRegistry(),
          maxConnections: 2,
        }),
      }
    : undefined;
const campaigns: string[] = [];
const files: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers) await close();
  if (available && campaigns.length > 0) {
    await db`delete from content_entities where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from content_personal_notes where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from sync_long_text_holds where campaign_id = any(${campaigns}::uuid[])`;
    await db`delete from sync_mutation_receipts where campaign_id = any(${campaigns}::uuid[])`;
  }
  await connections?.content.close();
  await connections?.sync.close();
  await connections?.audit.close();
  await sql?.end({ timeout: 1 });
  for (const file of files) rmSync(file, { recursive: true, force: true });
});

const SECRET = 'The ferryman is the lich';
let sequence = 0;

function harness(identityAccess?: { campaignId: string; access: CurrentAccessResolver }) {
  if (connections === undefined) throw new Error('database unavailable');
  const campaignId = identityAccess?.campaignId ?? crypto.randomUUID();
  campaigns.push(campaignId);
  const roles = new Map<string, Role>();
  const member = (role: Role) => {
    const userId = crypto.randomUUID();
    roles.set(userId, role);
    return userId;
  };
  const access: CurrentAccessResolver = identityAccess?.access ?? {
    resolve: async (userId: string, campaign: string): Promise<ActorRef | undefined> => {
      const role = roles.get(userId);
      return campaign === campaignId && role !== undefined
        ? { userId, campaignId, role }
        : undefined;
    },
  };
  const resolve = (userId: string, campaign: string) => access.resolve(userId, campaign);
  const entities = new PostgresEntityRepository(connections.content.db);
  const notes = new PostgresPersonalNoteRepository(connections.content.db);
  const policies = registerResourcePolicies(
    new ResourcePolicyRegistry({ requireVisibilityAdapters: true }),
    [
      new EntityVisibilityAdapter(entities),
      new RelationshipVisibilityAdapter(
        new PostgresRelationshipRepository(connections.content.db),
        entities,
      ),
    ],
  );
  const decider = new AuthorizationService(policies);
  const holds = new LongTextHoldService(new PostgresLongTextHoldRepository(connections.sync.db));
  const appliers = new MutationApplierRegistry();
  const entityService = new EntityService({
    entities,
    decider,
    members: { isMember: async (c, u) => (await resolve(u, c)) !== undefined },
  });
  appliers.register(new EntitySyncMutationApplier(entityService, holds));
  appliers.register(
    new PersonalNoteSyncMutationApplier(new PersonalNoteService({ notes, decider }), holds),
  );
  const real = mutationAuditParticipantFor(connections.audit.recorder);
  const within: boolean[] = [];
  /** Runs inside the write transaction, after the write matched and before it commits. */
  const inTransaction: { pause?: (() => Promise<void>) | undefined } = {};
  const participant: MutationAuditParticipant = {
    recordMutationOutcome: (input) => real.recordMutationOutcome(input),
    recordAcceptedWithin: async (transaction, input) => {
      await inTransaction.pause?.();
      const held = (await real.recordAcceptedWithin?.(transaction, input)) === true;
      within.push(held);
      return held;
    },
  };
  const authority = new AuthorityMutationService(
    access,
    appliers,
    new PostgresMutationReceiptStore(connections.sync.db),
    participant,
  );
  const upload = (
    userId: string,
    mutations: PendingMutation[],
    sessionId?: string,
  ): Promise<readonly MutationOutcome[]> =>
    authority.apply(
      userId,
      { campaignId, replicaId: crypto.randomUUID(), mutations },
      sessionId === undefined ? {} : { sessionId },
    );
  const one = async (userId: string, mutation: PendingMutation, sessionId?: string) =>
    (await upload(userId, [mutation], sessionId))[0] as MutationOutcome;
  return {
    campaignId,
    roles,
    member,
    entities,
    entityService,
    notes,
    holds,
    within,
    inTransaction,
    upload,
    one,
    authority,
  };
}

function mutation(input: {
  readonly campaignId: string;
  readonly table?: string;
  readonly recordId: string;
  readonly operation: PendingMutation['operation'];
  readonly expectedVersion: number | null;
  readonly payload: unknown;
  readonly withAudit?: boolean;
}): PendingMutation {
  const table = input.table ?? ENTITY_REPLICA_TABLE;
  const at = new Date().toISOString();
  sequence += 1;
  return {
    mutationId: crypto.randomUUID(),
    campaignId: input.campaignId,
    featureId: CONTENT_SYNC_FEATURE_ID,
    tableName: table,
    recordId: input.recordId,
    operation: input.operation,
    expectedVersion: input.expectedVersion,
    payload: input.payload,
    ...(input.withAudit === false
      ? {}
      : {
          // Client-composed envelope: the authority must replace its content.
          audit: {
            campaignId: input.campaignId,
            action: 'content.updated',
            targetType: table,
            targetId: input.recordId,
            before: { description: SECRET },
            after: { description: SECRET },
            at,
            private: false,
          },
        }),
    causalSequence: sequence,
    state: 'pending',
    attemptCount: 0,
    recordedAt: at,
  };
}

function entity(
  campaignId: string,
  userId: string,
  overrides: Partial<EntityRecord> & Record<string, unknown> = {},
): EntityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    campaignId,
    type: 'npc',
    name: 'Ferryman',
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 1,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
    updatedBy: userId,
    summary: 'Asks for silver, takes copper',
    description: '',
    fields: {},
    ...overrides,
  };
}

async function auditRows(mutationId: string) {
  return db`select action, target_type, before_value, after_value, target_visibility
    from audit_campaign_events where origin_mutation_id = ${mutationId}
    union all
    select action, target_type, before_value, after_value, target_visibility
    from audit_private_events where origin_mutation_id = ${mutationId}`;
}

async function row(table: 'content_entities' | 'content_personal_notes', id: string) {
  const [found] =
    table === 'content_entities'
      ? await db`select name, description, version::int as version, deleted_at
          from content_entities where id = ${id}`
      : await db`select name, body as description, version::int as version, deleted_at
          from content_personal_notes where id = ${id}`;
  return found;
}

/** Device-side store for the rule-parity check: records what would be queued. */
class MemoryEntityRecords implements SyncedRepository<EntityRecord> {
  readonly rows = new Map<string, EntityRecord>();
  readonly queued: EntityRecord[] = [];
  readonly conflicts = { subscribe: () => () => undefined };

  async get(id: string): Promise<Result<EntityRecord, RepositoryError>> {
    const found = this.rows.get(id);
    return found === undefined ? err({ kind: 'not_found', id }) : ok(found);
  }

  async list(): Promise<Result<EntityRecord[], RepositoryError>> {
    return ok([...this.rows.values()]);
  }

  async upsert(value: EntityRecord): Promise<Result<EntityRecord, RepositoryError>> {
    this.queued.push(value);
    this.rows.set(value.id, value);
    return ok(value);
  }

  async softDelete(): Promise<Result<void, RepositoryError>> {
    return ok(undefined);
  }
}

describe.skipIf(!available)('content sync mutation appliers (PostgreSQL)', () => {
  test('accept, replay without a second event, server-authored audit held in the transaction', async () => {
    const h = harness();
    const gm = h.member('gm');
    const record = entity(h.campaignId, gm);
    const insert = mutation({
      campaignId: h.campaignId,
      recordId: record.id,
      operation: 'insert',
      expectedVersion: null,
      payload: record,
    });
    const accepted = await h.one(gm, insert);
    expect(accepted).toEqual({
      mutationId: insert.mutationId,
      status: 'accepted',
      acceptedVersion: 1,
      serverCursor: `content_entities:${record.id}:1`,
    });
    expect(h.within).toEqual([true]);
    // Replay of the same mutation: same outcome, no second write or event.
    expect(await h.one(gm, insert)).toEqual(accepted);
    const rows = await auditRows(insert.mutationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'entity.created',
      target_type: 'campaign_entity',
      target_visibility: { visibility: { mode: 'gm_only' } },
    });
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(await row('content_entities', record.id)).toMatchObject({ version: 1 });
  });

  test('stale structured edit is a conflict with both values; deny after a role downgrade', async () => {
    const h = harness();
    const avery = h.member('gm');
    const blake = h.member('assistant_gm');
    const record = entity(h.campaignId, avery);
    await h.one(
      avery,
      mutation({
        campaignId: h.campaignId,
        recordId: record.id,
        operation: 'insert',
        expectedVersion: null,
        payload: record,
      }),
    );
    const first = mutation({
      campaignId: h.campaignId,
      recordId: record.id,
      operation: 'update',
      expectedVersion: 1,
      payload: { ...record, name: 'Avery rename', version: 2 },
    });
    const second = mutation({
      campaignId: h.campaignId,
      recordId: record.id,
      operation: 'update',
      expectedVersion: 1,
      payload: { ...record, name: 'Blake rename', version: 2 },
    });
    expect(await h.one(avery, first)).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
    const conflict = await h.one(blake, second);
    expect(conflict).toMatchObject({
      status: 'conflict',
      expectedVersion: 1,
      actualVersion: 2,
      currentValue: { id: record.id, name: 'Avery rename', version: 2 },
    });
    // The submitted value travels on the mutation; the authority keeps the accepted one.
    expect((second.payload as EntityRecord).name).toBe('Blake rename');
    expect(await auditRows(second.mutationId)).toHaveLength(0);

    // Blake recorded an offline edit, then was downgraded to player before reconnecting.
    h.roles.set(blake, 'player');
    const offline = mutation({
      campaignId: h.campaignId,
      recordId: record.id,
      operation: 'update',
      expectedVersion: 2,
      payload: { ...record, name: 'Offline edit', version: 3 },
    });
    expect(await h.one(blake, offline)).toEqual({
      mutationId: offline.mutationId,
      status: 'error',
      code: 'not_found_or_forbidden',
      retryable: false,
    });
    expect(await row('content_entities', record.id)).toMatchObject({
      name: 'Avery rename',
      version: 2,
    });
    expect(await auditRows(offline.mutationId)).toHaveLength(0);
  });

  test('invalid type, over-limit fields, missing envelope, and update operations without a base are invalid_payload', async () => {
    const h = harness();
    const gm = h.member('owner');
    const cases: PendingMutation[] = [
      mutation({
        campaignId: h.campaignId,
        recordId: crypto.randomUUID(),
        operation: 'insert',
        expectedVersion: null,
        payload: null,
      }),
    ];
    for (const overrides of [
      { type: 'villain' },
      { summary: 's'.repeat(281) },
      { tags: ['t'.repeat(65)] },
      { fields: { Price: 'one', price: 'two' } },
      { description: 'd'.repeat(50_001) },
    ]) {
      const record = entity(h.campaignId, gm, overrides);
      cases.push(
        mutation({
          campaignId: h.campaignId,
          recordId: record.id,
          operation: 'insert',
          expectedVersion: null,
          payload: record,
        }),
      );
    }
    const unaudited = entity(h.campaignId, gm);
    cases.push(
      mutation({
        campaignId: h.campaignId,
        recordId: unaudited.id,
        operation: 'insert',
        expectedVersion: null,
        payload: unaudited,
        withAudit: false,
      }),
    );
    const mismatched = entity(h.campaignId, gm);
    cases.push(
      mutation({
        campaignId: h.campaignId,
        recordId: crypto.randomUUID(),
        operation: 'insert',
        expectedVersion: null,
        payload: mismatched,
      }),
    );
    for (const item of cases) {
      expect(await h.one(gm, item)).toEqual({
        mutationId: item.mutationId,
        status: 'error',
        code: 'invalid_payload',
        retryable: false,
      });
      expect(await row('content_entities', item.recordId)).toBeUndefined();
    }
  });

  test('tombstone is accepted with version + 1; a later update of the tombstone is rejected', async () => {
    const h = harness();
    const gm = h.member('gm');
    const record = entity(h.campaignId, gm);
    await h.one(
      gm,
      mutation({
        campaignId: h.campaignId,
        recordId: record.id,
        operation: 'insert',
        expectedVersion: null,
        payload: record,
      }),
    );
    const removal = mutation({
      campaignId: h.campaignId,
      recordId: record.id,
      operation: 'tombstone',
      expectedVersion: 1,
      payload: { ...record, version: 2, deletedAt: new Date().toISOString() },
    });
    expect(await h.one(gm, removal)).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
    expect((await auditRows(removal.mutationId))[0]).toMatchObject({
      action: 'entity.deleted',
      before_value: { type: 'npc', name: 'Ferryman' },
    });
    const edit = mutation({
      campaignId: h.campaignId,
      recordId: record.id,
      operation: 'update',
      expectedVersion: 2,
      payload: { ...record, name: 'Zombie', version: 3 },
    });
    expect(await h.one(gm, edit)).toMatchObject({ status: 'error', code: 'record_deleted' });
    const stored = await row('content_entities', record.id);
    expect(stored).toMatchObject({ name: 'Ferryman', version: 2 });
    expect(stored?.deleted_at).not.toBeNull();
  });

  test('description writes need a current hold of the uploading session (B-2)', async () => {
    const h = harness();
    const avery = h.member('gm');
    const blake = h.member('gm');
    const record = entity(h.campaignId, avery);
    await h.one(
      avery,
      mutation({
        campaignId: h.campaignId,
        recordId: record.id,
        operation: 'insert',
        expectedVersion: null,
        payload: record,
      }),
    );
    const field = {
      campaignId: h.campaignId,
      resourceClass: 'campaign_entity',
      recordId: record.id,
      fieldPath: 'description',
    };
    const session = crypto.randomUUID();
    const otherSession = crypto.randomUUID();
    const hold = await h.holds.acquire(field, { userId: avery, sessionId: session });
    if (!('version' in hold)) throw new Error('hold not acquired');
    const write = (holdVersion: number | undefined, text = 'Held text') =>
      mutation({
        campaignId: h.campaignId,
        recordId: record.id,
        operation: 'update',
        expectedVersion: 1,
        payload: {
          ...record,
          description: text,
          version: 2,
          ...(holdVersion === undefined ? {} : { holdVersion }),
        },
      });
    const rejected = async (who: string, item: PendingMutation, sessionId?: string) => {
      expect(await h.one(who, item, sessionId)).toMatchObject({
        status: 'error',
        code: 'hold_required',
        retryable: false,
      });
      expect(await row('content_entities', record.id)).toMatchObject({
        description: '',
        version: 1,
      });
      expect(await auditRows(item.mutationId)).toHaveLength(0);
    };
    // No session in the context, no hold version, a different session of the same user, and
    // another user's session are all rejected.
    await rejected(avery, write(hold.version));
    await rejected(avery, write(undefined), session);
    await rejected(avery, write(hold.version), otherSession);
    await rejected(blake, write(hold.version), otherSession);
    // Expired hold.
    await db`update sync_long_text_holds set expires_at = now() - interval '1 second'
      where record_id = ${record.id}`;
    await rejected(avery, write(hold.version), session);
    // Re-acquired, then taken over by Blake: Avery's text is refused.
    const renewed = await h.holds.acquire(field, { userId: avery, sessionId: session });
    if (!('version' in renewed)) throw new Error('hold not reacquired');
    const taken = await h.holds.takeover(field, { userId: blake, sessionId: otherSession });
    await rejected(avery, write(renewed.version), session);
    // The current holder's session writes.
    const held = write(taken.version, SECRET);
    expect(await h.one(blake, held, otherSession)).toMatchObject({
      status: 'accepted',
      acceptedVersion: 2,
    });
    expect(await row('content_entities', record.id)).toMatchObject({
      description: SECRET,
      version: 2,
    });
    const [event] = await auditRows(held.mutationId);
    expect(event).toMatchObject({
      action: 'entity.updated',
      target_type: 'campaign_entity',
      after_value: { type: 'npc', changed: ['description'] },
    });
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  /** Stops a write inside its transaction until `release`; `atWrite` resolves once it is there. */
  function pauseWrite(h: ReturnType<typeof harness>) {
    let reached = () => {};
    let release = () => {};
    const atWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.inTransaction.pause = async () => {
      h.inTransaction.pause = undefined;
      reached();
      await released;
    };
    return { atWrite, release: () => release() };
  }

  /** Another connection's view: a statement on the hold table is blocked by a row lock. */
  async function untilHoldChangeBlocks() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [blocked] = await db`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike '%sync_long_text_holds%'`;
      if (blocked?.n === 1) return;
      await Bun.sleep(25);
    }
    throw new Error('no hold change is waiting for the write');
  }

  test('a takeover waits for a held write in flight: the write lands before it, never after', async () => {
    const h = harness();
    const avery = h.member('gm');
    const blake = h.member('gm');
    const record = entity(h.campaignId, avery);
    await h.one(
      avery,
      mutation({
        campaignId: h.campaignId,
        recordId: record.id,
        operation: 'insert',
        expectedVersion: null,
        payload: record,
      }),
    );
    const field = {
      campaignId: h.campaignId,
      resourceClass: 'campaign_entity',
      recordId: record.id,
      fieldPath: 'description',
    };
    const session = crypto.randomUUID();
    const hold = await h.holds.acquire(field, { userId: avery, sessionId: session });
    if (!('version' in hold)) throw new Error('hold not acquired');
    const write = (expectedVersion: number, holdVersion: number, text: string) =>
      mutation({
        campaignId: h.campaignId,
        recordId: record.id,
        operation: 'update',
        expectedVersion,
        payload: { ...record, description: text, version: expectedVersion + 1, holdVersion },
      });

    // The write passed the check and has not committed; the takeover cannot commit in between.
    const paused = pauseWrite(h);
    const writing = h.one(avery, write(1, hold.version, 'Written in time'), session);
    await paused.atWrite;
    let takenOver = false;
    const takingOver = h.holds
      .takeover(field, { userId: blake, sessionId: crypto.randomUUID() })
      .then((taken) => {
        takenOver = true;
        return taken;
      });
    await untilHoldChangeBlocks();
    expect(takenOver).toBe(false);
    expect(await row('content_entities', record.id)).toMatchObject({ description: '', version: 1 });
    paused.release();
    expect(await writing).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
    const taken = await takingOver;
    expect(taken.version).toBe(hold.version + 1);

    // Committed takeover first: the previous holder's next write is refused and changes nothing.
    expect(await h.one(avery, write(2, hold.version, 'Too late'), session)).toMatchObject({
      status: 'error',
      code: 'hold_required',
    });
    expect(await row('content_entities', record.id)).toMatchObject({
      description: 'Written in time',
      version: 2,
    });
  }, 30_000);

  test('a takeover waits for a personal note body write in flight', async () => {
    const h = harness();
    const casey = h.member('player');
    const now = new Date().toISOString();
    const note: PersonalNoteRecord = {
      id: crypto.randomUUID(),
      campaignId: h.campaignId,
      type: 'note',
      name: 'Road',
      tags: [],
      metadata: {},
      visibility: { mode: 'players', playerIds: [casey] },
      version: 1,
      createdAt: now,
      createdBy: casey,
      updatedAt: now,
      updatedBy: casey,
      authorUserId: casey,
      body: '',
    };
    await h.one(
      casey,
      mutation({
        campaignId: h.campaignId,
        table: PERSONAL_NOTE_REPLICA_TABLE,
        recordId: note.id,
        operation: 'insert',
        expectedVersion: null,
        payload: note,
      }),
    );
    const field = {
      campaignId: h.campaignId,
      resourceClass: 'personal_note',
      recordId: note.id,
      fieldPath: 'body',
    };
    const session = crypto.randomUUID();
    const hold = await h.holds.acquire(field, { userId: casey, sessionId: session });
    if (!('version' in hold)) throw new Error('hold not acquired');
    const paused = pauseWrite(h);
    const writing = h.one(
      casey,
      mutation({
        campaignId: h.campaignId,
        table: PERSONAL_NOTE_REPLICA_TABLE,
        recordId: note.id,
        operation: 'update',
        expectedVersion: 1,
        payload: { ...note, body: 'In time', version: 2, holdVersion: hold.version },
      }),
      session,
    );
    await paused.atWrite;
    let takenOver = false;
    const takingOver = h.holds
      .takeover(field, { userId: casey, sessionId: crypto.randomUUID() })
      .then(() => {
        takenOver = true;
      });
    await untilHoldChangeBlocks();
    expect(takenOver).toBe(false);
    paused.release();
    expect(await writing).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
    await takingOver;
    expect(await row('content_personal_notes', note.id)).toMatchObject({
      description: 'In time',
      version: 2,
    });
  }, 30_000);

  test('racing takeovers and held writes: once a takeover returned, no write of the old holder lands', async () => {
    const h = harness();
    const avery = h.member('gm');
    const blake = h.member('gm');
    const outcomes = { accepted: 0, refused: 0 };
    for (let round = 0; round < 24; round += 1) {
      const record = entity(h.campaignId, avery);
      await h.one(
        avery,
        mutation({
          campaignId: h.campaignId,
          recordId: record.id,
          operation: 'insert',
          expectedVersion: null,
          payload: record,
        }),
      );
      const field = {
        campaignId: h.campaignId,
        resourceClass: 'campaign_entity',
        recordId: record.id,
        fieldPath: 'description',
      };
      const session = crypto.randomUUID();
      const hold = await h.holds.acquire(field, { userId: avery, sessionId: session });
      if (!('version' in hold)) throw new Error('hold not acquired');
      const writing = h.one(
        avery,
        mutation({
          campaignId: h.campaignId,
          recordId: record.id,
          operation: 'update',
          expectedVersion: 1,
          payload: { ...record, description: 'Raced', version: 2, holdVersion: hold.version },
        }),
        session,
      );
      // Spreads the takeover over the write's check-to-commit window.
      await Bun.sleep(round % 6);
      await h.holds.takeover(field, { userId: blake, sessionId: crypto.randomUUID() });
      const atTakeover = await row('content_entities', record.id);
      const outcome = await writing;
      const after = await row('content_entities', record.id);
      if (outcome.status === 'accepted') {
        outcomes.accepted += 1;
        // Applied before the takeover: already committed when the takeover returned.
        expect(atTakeover).toMatchObject({ description: 'Raced', version: 2 });
      } else {
        outcomes.refused += 1;
        expect(outcome).toMatchObject({ status: 'error', code: 'hold_required' });
        expect(after).toMatchObject({ description: '', version: 1 });
      }
    }
    expect(outcomes.accepted + outcomes.refused).toBe(24);
    console.info(
      `hold race: ${outcomes.accepted} applied before the takeover, ${outcomes.refused} refused`,
    );
  }, 60_000);

  describe('access changed while a write is in flight (real memberships)', () => {
    /** One campaign whose owner and GM are real membership rows, resolved by feature 01. */
    async function seeded() {
      if (connections === undefined || databaseUrl === undefined) {
        throw new Error('database unavailable');
      }
      const identity = createPostgresIdentityRuntime({
        connectionString: databaseUrl,
        campaignNames: { getDisplayName: async () => undefined },
        audit: { record: async () => undefined },
        revocations: { publish: async () => undefined },
        membershipLog: { integrationDegraded: () => undefined },
        // Account flows are not exercised here.
        recoveryAudit: {} as never,
        authenticationLog: {} as never,
        recoveryLog: {} as never,
      });
      closers.push(identity.close);
      const memberships = identity.memberships;
      const campaignId = crypto.randomUUID();
      const owner = crypto.randomUUID();
      const gm = crypto.randomUUID();
      await db.begin(async (transaction) => {
        for (const id of [owner, gm]) {
          const name = `fence_${id.slice(0, 13)}`;
          await transaction`insert into identity_users
            (id, username_display, username_normalized, created_at, updated_at)
            values (${id}, ${name}, ${name}, now(), now())`;
        }
        await transaction`insert into campaigns
          (id, name, description, game_mode, created_by, version, created_at, updated_at)
          values (${campaignId}, 'Fence', '', 'standard', ${owner}, 1, now(), now())`;
        await transaction`insert into campaign_system_pins
          (campaign_id, system_id, system_version, updated_at)
          values (${campaignId}, 'fixture-system', '0.1.0', now())`;
        await transaction`insert into identity_campaign_memberships (campaign_id, user_id, role)
          values (${campaignId}, ${owner}, 'owner'), (${campaignId}, ${gm}, 'gm')`;
      });
      const h = harness({
        campaignId,
        access: {
          resolve: async (userId, campaign) => {
            const actor = await memberships.resolve(userId, campaign);
            return actor.ok ? actor.value : undefined;
          },
          resolveWithin: async (transaction, userId, campaign) => {
            const actor = await memberships.resolveWithin(transaction, userId, campaign);
            return actor.ok ? actor.value : undefined;
          },
        },
      });
      const record = entity(campaignId, gm);
      expect(
        await h.one(
          gm,
          mutation({
            campaignId,
            recordId: record.id,
            operation: 'insert',
            expectedVersion: null,
            payload: record,
          }),
        ),
      ).toMatchObject({ status: 'accepted' });
      const rename = () =>
        mutation({
          campaignId,
          recordId: record.id,
          operation: 'update',
          expectedVersion: 1,
          payload: { ...record, name: 'Renamed', version: 2 },
        });
      return { h, campaignId, gm, record, rename };
    }

    /**
     * Runs `change` on the membership in a transaction left open until the returned `commit`:
     * uploads still resolve the old row, as in the window between authorizing and committing.
     */
    async function openChange(
      change: (transaction: postgres.TransactionSql) => Promise<unknown>,
    ): Promise<{ commit(): Promise<void> }> {
      let changed: () => void = () => {};
      const applied = new Promise<void>((resolve) => {
        changed = resolve;
      });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const done = db.begin(async (transaction) => {
        await change(transaction);
        changed();
        await released;
      });
      await applied;
      return {
        commit: async () => {
          release();
          await done;
        },
      };
    }

    async function untilMembershipLockWaits() {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [blocked] = await db`
          select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%identity_campaign_memberships%'`;
        if (blocked?.n === 1) return;
        await Bun.sleep(25);
      }
      throw new Error('nothing is waiting on the membership row');
    }

    test('a removal committing during the write refuses it and nothing lands', async () => {
      const { h, campaignId, gm, record, rename } = await seeded();
      const removal = await openChange(
        (transaction) => transaction`update identity_campaign_memberships
          set removed_at = now(), version = version + 1
          where campaign_id = ${campaignId} and user_id = ${gm}`,
      );
      const item = rename();
      const writing = h.one(gm, item);
      await untilMembershipLockWaits();
      await removal.commit();
      expect(await writing).toEqual({
        mutationId: item.mutationId,
        status: 'error',
        code: 'not_found_or_forbidden',
        retryable: false,
      });
      expect(await row('content_entities', record.id)).toMatchObject({
        name: 'Ferryman',
        version: 1,
      });
      expect(await auditRows(item.mutationId)).toHaveLength(0);
    }, 30_000);

    test('a role change committing during the write refuses it; the retry decides anew', async () => {
      const { h, campaignId, gm, record, rename } = await seeded();
      const downgrade = await openChange(
        (transaction) => transaction`update identity_campaign_memberships
          set role = 'player', version = version + 1
          where campaign_id = ${campaignId} and user_id = ${gm}`,
      );
      const item = rename();
      const writing = h.one(gm, item);
      await untilMembershipLockWaits();
      await downgrade.commit();
      expect(await writing).toEqual({
        mutationId: item.mutationId,
        status: 'error',
        code: 'authority_unavailable',
        retryable: true,
      });
      expect(await row('content_entities', record.id)).toMatchObject({ version: 1 });
      expect(await h.one(gm, item)).toMatchObject({
        status: 'error',
        code: 'not_found_or_forbidden',
        retryable: false,
      });
    }, 30_000);

    test('a removal started after the check waits for the write it can no longer stop', async () => {
      const { h, campaignId, gm, record, rename } = await seeded();
      let reached: () => void = () => {};
      const atAudit = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.inTransaction.pause = async () => {
        h.inTransaction.pause = undefined;
        reached();
        await released;
      };
      const writing = h.one(gm, rename());
      await atAudit;
      const removing = db`update identity_campaign_memberships
        set removed_at = now(), version = version + 1
        where campaign_id = ${campaignId} and user_id = ${gm}`.then(() => undefined);
      await untilMembershipLockWaits();
      release();
      expect(await writing).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
      await removing;
      expect(await row('content_entities', record.id)).toMatchObject({
        name: 'Renamed',
        version: 2,
      });
      const later = mutation({
        campaignId,
        recordId: record.id,
        operation: 'update',
        expectedVersion: 2,
        payload: { ...record, name: 'After removal', version: 3 },
      });
      expect(await h.one(gm, later)).toMatchObject({ code: 'not_found_or_forbidden' });
    }, 30_000);
  });

  test("a player's mutation of another author's note is identical to a missing id", async () => {
    const h = harness();
    const casey = h.member('player');
    const rowan = h.member('player');
    const gm = h.member('gm');
    const now = new Date().toISOString();
    const note = (author: string): PersonalNoteRecord => ({
      id: crypto.randomUUID(),
      campaignId: h.campaignId,
      type: 'note',
      name: 'Elder lied about the road',
      tags: [],
      metadata: {},
      visibility: { mode: 'players', playerIds: [author] },
      version: 1,
      createdAt: now,
      createdBy: author,
      updatedAt: now,
      updatedBy: author,
      authorUserId: author,
      body: SECRET,
    });
    const caseys = note(casey);
    const created = mutation({
      campaignId: h.campaignId,
      table: PERSONAL_NOTE_REPLICA_TABLE,
      recordId: caseys.id,
      operation: 'insert',
      expectedVersion: null,
      payload: caseys,
    });
    expect(await h.one(casey, created)).toMatchObject({ status: 'accepted', acceptedVersion: 1 });
    expect((await auditRows(created.mutationId))[0]).toMatchObject({
      action: 'entity.personal_note_created',
      target_type: 'personal_note',
      target_visibility: {
        visibility: { mode: 'players', playerIds: [casey] },
        authorUserId: casey,
      },
    });
    const missing = { ...caseys, id: crypto.randomUUID() };
    const outcomes: unknown[] = [];
    for (const [who, target] of [
      [rowan, caseys],
      [rowan, missing],
      [gm, caseys],
      [gm, missing],
    ] as const) {
      const item = mutation({
        campaignId: h.campaignId,
        table: PERSONAL_NOTE_REPLICA_TABLE,
        recordId: target.id,
        operation: 'update',
        expectedVersion: 1,
        payload: { ...target, name: 'Hijacked', version: 2 },
      });
      const { mutationId: _ignored, ...rest } = await h.one(who, item);
      outcomes.push(rest);
    }
    expect(new Set(outcomes.map((item) => JSON.stringify(item)))).toEqual(
      new Set([
        JSON.stringify({ status: 'error', code: 'not_found_or_forbidden', retryable: false }),
      ]),
    );
    // A GM-role create of a personal note is denied too (D-06).
    const gmNote = note(gm);
    expect(
      await h.one(
        gm,
        mutation({
          campaignId: h.campaignId,
          table: PERSONAL_NOTE_REPLICA_TABLE,
          recordId: gmNote.id,
          operation: 'insert',
          expectedVersion: null,
          payload: gmNote,
        }),
      ),
    ).toMatchObject({ status: 'error', code: 'not_found_or_forbidden' });
    expect(await row('content_personal_notes', caseys.id)).toMatchObject({ version: 1 });
  });

  test('a domain failure after the in-transaction audit insert rolls back both', async () => {
    if (connections === undefined) throw new Error('database unavailable');
    const h = harness();
    const gm = h.member('gm');
    const service = new EntityService({
      entities: h.entities,
      decider: new AuthorizationService(registerResourcePolicies(new ResourcePolicyRegistry(), [])),
    });
    const id = crypto.randomUUID();
    const origin = crypto.randomUUID();
    let threw = false;
    try {
      await service.create(
        { userId: gm, campaignId: h.campaignId, role: 'gm' },
        { campaignId: h.campaignId, id, type: 'npc', name: 'Rolled back' },
        {
          audit: async (transaction, event) => {
            const recorded = await connections.audit.recorder.recordWithin(transaction, {
              event: {
                campaignId: h.campaignId,
                actor: { userId: gm, campaignId: h.campaignId, role: 'gm' },
                action: event.action,
                targetType: event.targetType,
                targetId: id,
                ...(event.after === undefined ? {} : { after: event.after }),
                at: new Date().toISOString(),
                private: false,
              },
              originMutationId: origin,
              targetVisibility: event.targetVisibility,
            });
            expect(recorded).toBe('recorded');
            throw new Error('domain failure after the audit insert');
          },
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await row('content_entities', id)).toBeUndefined();
    expect(await auditRows(origin)).toHaveLength(0);
  });

  test('custom fields (D-01): device and authority reject the same inputs; edits are versioned; audit names only fields', async () => {
    const h = harness();
    const gm = h.member('gm');
    const blake = h.member('assistant_gm');
    const actor = { userId: gm, campaignId: h.campaignId };
    const record = entity(h.campaignId, gm, { fields: { Allegiance: 'Guild', Age: '40' } });
    expect(
      await h.one(
        gm,
        mutation({
          campaignId: h.campaignId,
          recordId: record.id,
          operation: 'insert',
          expectedVersion: null,
          payload: record,
        }),
      ),
    ).toMatchObject({ status: 'accepted' });
    const device = new MemoryEntityRecords();
    device.rows.set(record.id, record);
    const local = new EntityLocalRepository(device, actor);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`Field ${i}`, 'v']));
    const invalid: [Record<string, unknown>, string][] = [
      [{ Price: 'one silver', price: 'two' }, 'duplicate_field_label'],
      [{ Price: 'a', ' PRICE ': 'b' }, 'duplicate_field_label'],
      [many, 'too_many_fields'],
      [{ ['l'.repeat(65)]: 'v' }, 'field_label_too_long'],
      [{ Note: 'v'.repeat(1_001) }, 'field_value_too_long'],
      [{ '  ': 'v' }, 'field_label_empty'],
      [{ Price: 1 }, 'invalid_field_value'],
    ];
    for (const [fields, code] of invalid) {
      const onDevice = await local.update(record.id, { fields } as never, 1);
      const atAuthority = await h.entityService.update(
        { userId: gm, campaignId: h.campaignId, role: 'gm' },
        { campaignId: h.campaignId, id: record.id, expectedVersion: 1, changes: { fields } },
      );
      expect([onDevice, atAuthority]).toEqual([
        { ok: false, error: code },
        { ok: false, error: { code: 'invalid_payload', reason: code } },
      ] as never);
      const upload = mutation({
        campaignId: h.campaignId,
        recordId: record.id,
        operation: 'update',
        expectedVersion: 1,
        payload: { ...record, fields, version: 2 },
      });
      expect(await h.one(gm, upload)).toMatchObject({ status: 'error', code: 'invalid_payload' });
      expect(await auditRows(upload.mutationId)).toHaveLength(0);
    }
    expect(device.queued).toHaveLength(0);
    expect(await row('content_entities', record.id)).toMatchObject({ version: 1 });

    // An accepted field edit: version + 1, audit names "fields" and never a label or value.
    const priced = { Allegiance: 'Guild', Age: '40', Price: 'one silver' };
    const edit = mutation({
      campaignId: h.campaignId,
      recordId: record.id,
      operation: 'update',
      expectedVersion: 1,
      payload: { ...record, fields: priced, version: 2 },
    });
    expect(await h.one(gm, edit)).toMatchObject({ status: 'accepted', acceptedVersion: 2 });
    const [stored] = await db`select fields from content_entities where id = ${record.id}`;
    expect(stored?.fields).toEqual(priced);
    const rows = await auditRows(edit.mutationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'entity.updated',
      before_value: {},
      after_value: { type: 'npc', changed: ['fields'] },
    });
    for (const secret of ['Price', 'one silver', 'Allegiance', 'Guild']) {
      expect(JSON.stringify(rows)).not.toContain(secret);
    }

    // A concurrent field edit from the same base is a conflict with both values (BR-011).
    const stale = mutation({
      campaignId: h.campaignId,
      recordId: record.id,
      operation: 'update',
      expectedVersion: 1,
      payload: { ...record, fields: { Allegiance: 'Crown' }, version: 2 },
    });
    expect(await h.one(blake, stale)).toMatchObject({
      status: 'conflict',
      expectedVersion: 1,
      actualVersion: 2,
      currentValue: { id: record.id, fields: priced, version: 2 },
    });
    expect((stale.payload as EntityRecord).fields).toEqual({ Allegiance: 'Crown' });
    expect(await auditRows(stale.mutationId)).toHaveLength(0);

    // A name-only edit whose fields arrive in another key order does not claim a field change.
    const reordered = Object.fromEntries(Object.entries(priced).reverse());
    const rename = mutation({
      campaignId: h.campaignId,
      recordId: record.id,
      operation: 'update',
      expectedVersion: 2,
      payload: { ...record, name: 'Ferryman Grey', fields: reordered, version: 3 },
    });
    expect(await h.one(gm, rename)).toMatchObject({ status: 'accepted', acceptedVersion: 3 });
    const [renamed] = await auditRows(rename.mutationId);
    expect(renamed).toMatchObject({
      before_value: { name: 'Ferryman' },
      after_value: { type: 'npc', name: 'Ferryman Grey' },
    });
    expect(renamed?.after_value.changed).toBeUndefined();
  });

  test('offline create, update, and delete through the device repository round-trip to accepted', async () => {
    const h = harness();
    const gm = h.member('gm');
    const directory = mkdtempSync(join(tmpdir(), 'rpg-content-'));
    files.push(directory);
    const store = new SqliteReplicaStore(join(directory, 'replica.sqlite'));
    const status = new SyncStatusStore();
    const hub = new ConflictHub();
    const actor = { userId: gm, campaignId: h.campaignId, role: 'gm' as const };
    const local = new EntityLocalRepository(
      new SqliteSyncedRepository<EntityRecord>(
        store,
        ENTITY_REPLICA_TABLE,
        CONTENT_SYNC_FEATURE_ID,
        actor,
        status,
        hub,
      ),
      actor,
    );
    status.setConnected(false);
    const npc = await local.quickCreate({
      type: 'npc',
      name: 'Smuggler',
      summary: 'Knows the docks',
    });
    if (!npc.ok) throw new Error('local create failed');
    const item = await local.quickCreate({ type: 'item', name: 'Silver key' });
    if (!item.ok) throw new Error('local create failed');
    const renamed = await local.update(npc.value.id, { tags: ['Docks'] }, 1);
    expect(renamed.ok && renamed.value.tags).toEqual(['docks']);
    expect((await local.remove(item.value.id, 1)).ok).toBe(true);
    const generic = await local.quickCreate({ name: 'Rumor' });
    expect(generic.ok && generic.value.type).toBe('note');
    expect((await local.list({ nameFragment: 'smug' })).map((record) => record.name)).toEqual([
      'Smuggler',
    ]);
    expect(status.snapshot().pendingCount).toBe(5);

    const queue = new MutationQueue(store, status, hub);
    const uploader = {
      upload: (batch: MutationBatch) =>
        h.authority.apply(gm, batch, { sessionId: crypto.randomUUID() }),
    };
    expect((await queue.drainWithOutcomes(h.campaignId, crypto.randomUUID(), uploader)).state).toBe(
      'offline',
    );
    status.setConnected(true);
    const report = await queue.drainWithOutcomes(h.campaignId, crypto.randomUUID(), uploader);
    expect(report.state).toBe('uploaded');
    expect(report.outcomes.map((outcome) => outcome.result)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
      'accepted',
    ]);
    expect(status.snapshot().pendingCount).toBe(0);
    expect(await row('content_entities', npc.value.id)).toMatchObject({ version: 2 });
    expect((await row('content_entities', item.value.id))?.deleted_at).not.toBeNull();
    const [tags] = await db`select tags from content_entities where id = ${npc.value.id}`;
    expect(tags?.tags).toEqual(['docks']);

    // A player's own personal note round-trips too.
    const casey = h.member('player');
    const caseyActor = { userId: casey, campaignId: h.campaignId, role: 'player' as const };
    const notes = new PersonalNoteLocalRepository(
      new SqliteSyncedRepository<PersonalNoteRecord>(
        store,
        PERSONAL_NOTE_REPLICA_TABLE,
        CONTENT_SYNC_FEATURE_ID,
        caseyActor,
        status,
        hub,
      ),
      caseyActor,
    );
    const written = await notes.create({ name: 'Elder lied about the road', body: 'He did.' });
    if (!written.ok) throw new Error('note create failed');
    const noteReport = await queue.drainWithOutcomes(h.campaignId, crypto.randomUUID(), {
      upload: (batch) => h.authority.apply(casey, batch),
    });
    expect(noteReport.outcomes.map((outcome) => outcome.result)).toEqual(['accepted']);
    expect(await row('content_personal_notes', written.value.id)).toMatchObject({
      description: 'He did.',
      version: 1,
    });
    store.close();
  });
});
