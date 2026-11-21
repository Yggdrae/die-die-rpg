import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { MembershipService } from '../../application/membership-service.ts';
import type { ActorResolver } from '../../contracts/interfaces.ts';
import { connectIdentityDatabase, type IdentityTransaction } from './database.ts';
import {
  PostgresCampaignMembershipWriter,
  PostgresMembershipRepository,
} from './membership-repository.ts';
import { identityCampaignMemberships } from './schema.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const candidate = databaseUrl === undefined ? undefined : connectIdentityDatabase(databaseUrl);
const connection = await (async () => {
  if (candidate === undefined) return undefined;
  try {
    await candidate.db.execute(sql`select 1`);
    return candidate;
  } catch {
    await candidate.close();
    return undefined;
  }
})();

afterAll(async () => connection?.close());

/**
 * Settles a promise without Bun's `expect(promise).rejects`, which stalls postgres.js I/O.
 * Query-time failures arrive wrapped by Drizzle; expose the PostgreSQL error itself.
 */
function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: postgresError(error) }),
  );
}

function postgresError(error: unknown): unknown {
  let current = error;
  while (current instanceof Error && !('code' in current) && current.cause !== undefined) {
    current = current.cause;
  }
  return current;
}

describe.skipIf(connection === undefined)('PostgreSQL membership and ownership invariants', () => {
  const db = () => {
    if (connection === undefined) throw new Error('database unavailable');
    return connection.db;
  };
  const writer = new PostgresCampaignMembershipWriter();
  const service = () =>
    new MembershipService(
      new PostgresMembershipRepository(db()),
      { record: async () => undefined },
      { publish: async () => undefined },
      { integrationDegraded: () => undefined },
    );

  async function insertUser(): Promise<string> {
    const userId = crypto.randomUUID();
    await db().execute(sql`
      insert into identity_users
        (id, username_display, username_normalized, created_at, updated_at)
      values
        (${userId}, ${`Owner_${userId.slice(0, 8)}`}, ${`owner_${userId.slice(0, 8)}`}, now(), now())
    `);
    return userId;
  }

  async function insertCampaignRows(
    transaction: IdentityTransaction,
    campaignId: string,
    ownerId: string,
  ) {
    await transaction.execute(sql`
      insert into campaigns
        (id, name, description, game_mode, created_by, version, created_at, updated_at)
      values
        (${campaignId}, 'Owner Game', '', 'standard', ${ownerId}, 1, now(), now())
    `);
    await transaction.execute(sql`
      insert into campaign_system_pins (campaign_id, system_id, system_version, updated_at)
      values (${campaignId}, 'fixture-system', '0.1.0', now())
    `);
  }

  /** Creates a committed campaign through the feature 02 transaction contract plus members. */
  async function campaignWith(members: readonly ('gm' | 'assistant_gm' | 'player')[]) {
    const ownerId = await insertUser();
    const memberIds: string[] = [];
    for (const _ of members) memberIds.push(await insertUser());
    const campaignId = crypto.randomUUID();
    await db().transaction(async (transaction) => {
      await insertCampaignRows(transaction, campaignId, ownerId);
      const owner = await writer.createOwner(
        { campaignId, userId: ownerId },
        { handle: transaction },
      );
      if (!owner.ok) throw new Error(owner.error);
      for (const [index, role] of members.entries()) {
        await transaction.insert(identityCampaignMemberships).values({
          campaignId,
          userId: memberIds[index] ?? '',
          role,
        });
      }
    });
    return { campaignId, ownerId, memberIds };
  }

  async function activeOwners(campaignId: string): Promise<readonly string[]> {
    const rows = await db().execute<{ userId: string }>(sql`
      select user_id as "userId"
      from identity_campaign_memberships
      where campaign_id = ${campaignId} and role = 'owner' and removed_at is null
    `);
    return rows.map((row) => row.userId);
  }

  async function campaignExists(campaignId: string): Promise<boolean> {
    const rows = await db().execute<{ id: string }>(
      sql`select id from campaigns where id = ${campaignId}`,
    );
    return rows.length === 1;
  }

  describe('ActorResolver and membership persistence', () => {
    test('active membership resolves; absent and removed return membership_not_found', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['player']);
      const playerId = memberIds[0] ?? '';
      const memberships = service();
      expect(await memberships.resolve(playerId, campaignId)).toEqual({
        ok: true,
        value: { userId: playerId, campaignId, role: 'player' },
      });
      expect(await memberships.resolve(await insertUser(), campaignId)).toEqual({
        ok: false,
        error: 'membership_not_found',
      });
      expect(await memberships.remove(ownerId, campaignId, playerId)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await memberships.resolve(playerId, campaignId)).toEqual({
        ok: false,
        error: 'membership_not_found',
      });
    });

    test('client-supplied role claims cannot affect resolution', async () => {
      const { campaignId, memberIds } = await campaignWith(['player']);
      const playerId = memberIds[0] ?? '';
      const resolver: ActorResolver = service();
      const withClaim = resolver.resolve as (
        userId: string,
        campaignId: string,
        claimedRole: unknown,
      ) => ReturnType<ActorResolver['resolve']>;
      expect(await withClaim.call(resolver, playerId, campaignId, 'owner')).toEqual({
        ok: true,
        value: { userId: playerId, campaignId, role: 'player' },
      });
    });

    test('observer is not persistable and a second active owner is rejected immediately', async () => {
      const { campaignId } = await campaignWith([]);
      const observer = await settle(
        db()
          .insert(identityCampaignMemberships)
          .values({
            campaignId,
            userId: await insertUser(),
            role: 'observer',
          }),
      );
      expect(observer.ok).toBe(false);
      expect(!observer.ok && observer.error).toMatchObject({
        code: '23514',
        constraint_name: 'identity_campaign_memberships_role_check',
      });
      const secondOwner = await settle(
        db()
          .insert(identityCampaignMemberships)
          .values({
            campaignId,
            userId: await insertUser(),
            role: 'owner',
          }),
      );
      expect(!secondOwner.ok && secondOwner.error).toMatchObject({
        code: '23505',
        constraint_name: 'identity_campaign_memberships_active_owner_uidx',
      });
      expect(await activeOwners(campaignId)).toHaveLength(1);
    });

    test('removed rows stay tombstones and are excluded from current lists', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm', 'player']);
      const [gmId = '', playerId = ''] = memberIds;
      const memberships = service();
      expect((await memberships.remove(ownerId, campaignId, playerId)).ok).toBe(true);
      const [tombstone] = await db().execute<{ removed: boolean; version: string }>(sql`
        select removed_at is not null as removed, version::text as version
        from identity_campaign_memberships
        where campaign_id = ${campaignId} and user_id = ${playerId}
      `);
      expect(tombstone?.removed).toBe(true);
      expect(tombstone?.version).toBe('2');

      const firstPage = await memberships.listCampaign(ownerId, campaignId, { limit: 1 });
      expect(firstPage.ok).toBe(true);
      if (!firstPage.ok) return;
      expect(firstPage.value.items).toHaveLength(1);
      expect(firstPage.value.nextCursor).toBeDefined();
      const secondPage = await memberships.listCampaign(ownerId, campaignId, {
        limit: 1,
        ...(firstPage.value.nextCursor === undefined ? {} : { cursor: firstPage.value.nextCursor }),
      });
      if (!secondPage.ok) throw new Error(secondPage.error);
      expect(secondPage.value.nextCursor).toBeUndefined();
      const listed = [...firstPage.value.items, ...secondPage.value.items].map(
        (item) => item.user.id,
      );
      expect(listed.sort()).toEqual([gmId, ownerId].sort());

      expect((await memberships.listUser(playerId, {})).items).toEqual([]);
      expect((await memberships.listUser(gmId, {})).items.map((item) => item.campaignId)).toEqual([
        campaignId,
      ]);
      expect(await memberships.listCampaign(playerId, campaignId, {})).toEqual({
        ok: false,
        error: 'not_found_or_forbidden',
      });
    });
  });

  describe('atomic campaign ownership', () => {
    test('campaign rows and initial owner commit together', async () => {
      const { campaignId, ownerId } = await campaignWith([]);
      expect(await campaignExists(campaignId)).toBe(true);
      expect(await activeOwners(campaignId)).toEqual([ownerId]);
    });

    test('a failure after createOwner rolls back campaign and owner together', async () => {
      const ownerId = await insertUser();
      const campaignId = crypto.randomUUID();
      const outcome = await settle(
        db().transaction(async (transaction) => {
          await insertCampaignRows(transaction, campaignId, ownerId);
          const owner = await writer.createOwner(
            { campaignId, userId: ownerId },
            { handle: transaction },
          );
          expect(owner.ok).toBe(true);
          throw new Error('later creation step failed');
        }),
      );
      expect(outcome.ok).toBe(false);
      expect(await campaignExists(campaignId)).toBe(false);
      expect(await activeOwners(campaignId)).toEqual([]);
    });

    test('createOwner cannot create a second owner in the same transaction', async () => {
      const ownerId = await insertUser();
      const otherId = await insertUser();
      const campaignId = crypto.randomUUID();
      const outcome = await settle(
        db().transaction(async (transaction) => {
          await insertCampaignRows(transaction, campaignId, ownerId);
          expect(
            (await writer.createOwner({ campaignId, userId: ownerId }, { handle: transaction })).ok,
          ).toBe(true);
          const second = await writer.createOwner(
            { campaignId, userId: otherId },
            { handle: transaction },
          );
          expect(second).toEqual({ ok: false, error: 'owner_conflict' });
          throw new Error(second.ok ? 'unexpected owner' : second.error);
        }),
      );
      expect(outcome.ok).toBe(false);
      expect(await campaignExists(campaignId)).toBe(false);
    });

    test('concurrent creations of one campaign commit one campaign with one owner', async () => {
      const ownerId = await insertUser();
      const campaignId = crypto.randomUUID();
      const attempt = () =>
        settle(
          db().transaction(async (transaction) => {
            await insertCampaignRows(transaction, campaignId, ownerId);
            const owner = await writer.createOwner(
              { campaignId, userId: ownerId },
              { handle: transaction },
            );
            if (!owner.ok) throw new Error(owner.error);
          }),
        );
      const results = await Promise.all([attempt(), attempt(), attempt()]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await activeOwners(campaignId)).toEqual([ownerId]);
    });

    test('commit rejects zero active owners from demotion, removal, or deletion', async () => {
      const { campaignId, ownerId } = await campaignWith(['gm']);
      const mutations = [
        sql`update identity_campaign_memberships set role = 'gm'
            where campaign_id = ${campaignId} and user_id = ${ownerId}`,
        sql`update identity_campaign_memberships set removed_at = now()
            where campaign_id = ${campaignId} and user_id = ${ownerId}`,
        sql`delete from identity_campaign_memberships
            where campaign_id = ${campaignId} and user_id = ${ownerId}`,
      ];
      for (const mutation of mutations) {
        const outcome = await settle(
          db().transaction(async (transaction) => {
            await transaction.execute(mutation);
          }),
        );
        expect(!outcome.ok && outcome.error).toMatchObject({
          code: '23514',
          constraint_name: 'campaigns_exactly_one_active_owner',
        });
      }
      expect(await activeOwners(campaignId)).toEqual([ownerId]);
    });

    test('promotion without demotion is rejected as a second active owner', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm']);
      const outcome = await settle(
        db().transaction(async (transaction) => {
          await transaction.execute(sql`
            update identity_campaign_memberships set role = 'owner'
            where campaign_id = ${campaignId} and user_id = ${memberIds[0] ?? ''}
          `);
        }),
      );
      expect(!outcome.ok && outcome.error).toMatchObject({ code: '23505' });
      expect(await activeOwners(campaignId)).toEqual([ownerId]);
    });

    test('the sole owner cannot be removed by anyone', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm']);
      const memberships = service();
      expect(await memberships.remove(ownerId, campaignId, ownerId)).toEqual({
        ok: false,
        error: 'owner_cannot_be_removed',
      });
      expect(await memberships.remove(memberIds[0] ?? '', campaignId, ownerId)).toEqual({
        ok: false,
        error: 'owner_cannot_be_removed',
      });
      expect(await activeOwners(campaignId)).toEqual([ownerId]);
    });

    test('only the current owner can transfer, and only to a current member', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm', 'player']);
      const [gmId = '', playerId = ''] = memberIds;
      const memberships = service();
      const forbidden = { ok: false as const, error: 'not_found_or_forbidden' as const };
      expect(await memberships.transferOwnership(gmId, campaignId, playerId)).toEqual(forbidden);
      expect(await memberships.transferOwnership(ownerId, campaignId, await insertUser())).toEqual(
        forbidden,
      );
      expect(await memberships.transferOwnership(ownerId, campaignId, ownerId)).toEqual(forbidden);
      expect((await memberships.remove(ownerId, campaignId, playerId)).ok).toBe(true);
      expect(await memberships.transferOwnership(ownerId, campaignId, playerId)).toEqual(forbidden);
      expect(await activeOwners(campaignId)).toEqual([ownerId]);

      const transferred = await memberships.transferOwnership(ownerId, campaignId, gmId);
      expect(transferred.ok).toBe(true);
      if (!transferred.ok) return;
      expect(transferred.value.owner).toMatchObject({ role: 'owner', user: { id: gmId } });
      expect(transferred.value.formerOwner).toMatchObject({ role: 'gm', user: { id: ownerId } });
      expect(await activeOwners(campaignId)).toEqual([gmId]);
      expect(await memberships.resolve(ownerId, campaignId)).toEqual({
        ok: true,
        value: { userId: ownerId, campaignId, role: 'gm' },
      });
    });

    test('concurrent transfers never expose an invalid committed owner count', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith([
        'gm',
        'player',
        'assistant_gm',
      ]);
      const memberships = service();
      let observing = true;
      const observedCounts = new Set<number>();
      const observer = (async () => {
        while (observing) observedCounts.add((await activeOwners(campaignId)).length);
      })();
      const results = await Promise.all(
        memberIds.map((targetId) => memberships.transferOwnership(ownerId, campaignId, targetId)),
      );
      observing = false;
      await observer;
      const winners = results.filter((result) => result.ok);
      expect(winners).toHaveLength(1);
      expect(
        results.filter((result) => !result.ok).map((result) => !result.ok && result.error),
      ).toEqual(['not_found_or_forbidden', 'not_found_or_forbidden']);
      expect([...observedCounts]).toEqual([1]);
      const owners = await activeOwners(campaignId);
      expect(owners).toHaveLength(1);
      expect(memberIds).toContain(owners[0] ?? '');
    });

    test('transfer racing removal of its target leaves exactly one owner', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm']);
      const gmId = memberIds[0] ?? '';
      const memberships = service();
      const [transfer, removal] = await Promise.all([
        memberships.transferOwnership(ownerId, campaignId, gmId),
        memberships.remove(ownerId, campaignId, gmId),
      ]);
      expect([transfer.ok, removal.ok].filter(Boolean)).toHaveLength(1);
      expect(await activeOwners(campaignId)).toEqual([transfer.ok ? gmId : ownerId]);
    });
  });
});
