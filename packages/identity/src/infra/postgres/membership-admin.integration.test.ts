import { afterAll, describe, expect, test } from 'bun:test';
import type { AuditEvent, CampaignAccessRevoked } from '@rpg/contracts';
import { sql } from 'drizzle-orm';
import { MembershipService } from '../../application/membership-service.ts';
import { connectIdentityDatabase } from './database.ts';
import { PostgresMembershipRepository } from './membership-repository.ts';
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

type Role = 'gm' | 'assistant_gm' | 'player';
const forbidden = { ok: false as const, error: 'not_found_or_forbidden' as const };

describe.skipIf(connection === undefined)('PostgreSQL membership administration', () => {
  const db = () => {
    if (connection === undefined) throw new Error('database unavailable');
    return connection.db;
  };

  /** Records signals and proves, at publish time, that the change is already committed. */
  function harness() {
    const audits: Omit<AuditEvent, 'id'>[] = [];
    const signals: CampaignAccessRevoked[] = [];
    const committedAtPublish: boolean[] = [];
    const service = new MembershipService(
      new PostgresMembershipRepository(db()),
      {
        record: async (event) => {
          audits.push(event);
        },
      },
      {
        publish: async (event) => {
          const [row] = await db().execute<{ version: string; removed: boolean }>(sql`
            select version::text as version, removed_at is not null as removed
            from identity_campaign_memberships
            where campaign_id = ${event.campaignId} and user_id = ${event.userId}
          `);
          committedAtPublish.push(
            row !== undefined &&
              Number(row.version) === event.membershipVersion &&
              (event.reason !== 'removed' || row.removed),
          );
          signals.push(event);
        },
      },
      { integrationDegraded: () => undefined },
    );
    return { service, audits, signals, committedAtPublish };
  }

  async function insertUser(): Promise<string> {
    const userId = crypto.randomUUID();
    await db().execute(sql`
      insert into identity_users
        (id, username_display, username_normalized, created_at, updated_at)
      values
        (${userId}, ${`Admin_${userId.slice(0, 8)}`}, ${`admin_${userId.slice(0, 8)}`}, now(), now())
    `);
    return userId;
  }

  async function campaignWith(members: readonly Role[]) {
    const ownerId = await insertUser();
    const memberIds: string[] = [];
    for (const _ of members) memberIds.push(await insertUser());
    const campaignId = crypto.randomUUID();
    await db().transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into campaigns
          (id, name, description, game_mode, created_by, version, created_at, updated_at)
        values
          (${campaignId}, 'Admin Game', '', 'standard', ${ownerId}, 1, now(), now())
      `);
      await transaction.execute(sql`
        insert into campaign_system_pins (campaign_id, system_id, system_version, updated_at)
        values (${campaignId}, 'fixture-system', '0.1.0', now())
      `);
      await transaction
        .insert(identityCampaignMemberships)
        .values({ campaignId, userId: ownerId, role: 'owner' });
      for (const [index, role] of members.entries()) {
        await transaction
          .insert(identityCampaignMemberships)
          .values({ campaignId, userId: memberIds[index] ?? '', role });
      }
    });
    return { campaignId, ownerId, memberIds };
  }

  async function row(campaignId: string, userId: string) {
    const [found] = await db().execute<{ role: string; version: string; removed: boolean }>(sql`
      select role, version::text as version, removed_at is not null as removed
      from identity_campaign_memberships
      where campaign_id = ${campaignId} and user_id = ${userId}
    `);
    if (found === undefined) throw new Error('membership row missing');
    return { role: found.role, version: Number(found.version), removed: found.removed };
  }

  async function activeOwners(campaignId: string): Promise<readonly string[]> {
    const rows = await db().execute<{ userId: string }>(sql`
      select user_id as "userId" from identity_campaign_memberships
      where campaign_id = ${campaignId} and role = 'owner' and removed_at is null
    `);
    return rows.map((found) => found.userId);
  }

  async function author(campaignId: string, userId: string): Promise<void> {
    await db().execute(sql`
      insert into campaign_settings
        (campaign_id, namespace, value, member_visible, version, updated_at, updated_by)
      values
        (${campaignId}, ${`note-${userId.slice(0, 8)}`}, '{}'::jsonb, true, 1, now(), ${userId})
    `);
  }

  async function authoredCount(campaignId: string, userId: string): Promise<number> {
    const [found] = await db().execute<{ total: string }>(sql`
      select count(*)::text as total from campaign_settings
      where campaign_id = ${campaignId} and updated_by = ${userId}
    `);
    return Number(found?.total ?? 0);
  }

  describe('removal authority matrix', () => {
    const allowed: readonly (readonly ['owner' | 'gm', Role])[] = [
      ['owner', 'gm'],
      ['owner', 'assistant_gm'],
      ['owner', 'player'],
      ['gm', 'assistant_gm'],
      ['gm', 'player'],
    ];
    for (const [removerRole, targetRole] of allowed) {
      test(`${removerRole} removes ${targetRole}: access ends, content stays, signals fire post-commit`, async () => {
        const { campaignId, ownerId, memberIds } = await campaignWith(['gm', targetRole]);
        const [gmId = '', targetId = ''] = memberIds;
        const removerId = removerRole === 'owner' ? ownerId : gmId;
        await author(campaignId, targetId);
        const { service, audits, signals, committedAtPublish } = harness();

        expect(await service.remove(removerId, campaignId, targetId)).toEqual({
          ok: true,
          value: undefined,
        });

        expect(await service.resolve(targetId, campaignId)).toEqual({
          ok: false,
          error: 'membership_not_found',
        });
        expect(await row(campaignId, targetId)).toEqual({
          role: targetRole,
          version: 2,
          removed: true,
        });
        expect(await authoredCount(campaignId, targetId)).toBe(1);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          action: 'membership.removed',
          campaignId,
          targetId,
          actor: { userId: removerId },
        });
        expect(signals).toEqual([
          expect.objectContaining({
            campaignId,
            userId: targetId,
            membershipVersion: 2,
            reason: 'removed',
          }),
        ]);
        expect(committedAtPublish).toEqual([true]);
        expect(await activeOwners(campaignId)).toEqual([ownerId]);
      });
    }

    test('a gm cannot remove another gm and nothing is recorded or published', async () => {
      const { campaignId, memberIds } = await campaignWith(['gm', 'gm']);
      const [firstId = '', secondId = ''] = memberIds;
      const { service, audits, signals } = harness();
      expect(await service.remove(firstId, campaignId, secondId)).toEqual(forbidden);
      expect(await row(campaignId, secondId)).toEqual({ role: 'gm', version: 1, removed: false });
      expect(audits).toEqual([]);
      expect(signals).toEqual([]);
    });

    test('a gm removes themselves and loses access while the owner is unchanged', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm']);
      const gmId = memberIds[0] ?? '';
      const { service } = harness();
      expect(await service.remove(gmId, campaignId, gmId)).toEqual({ ok: true, value: undefined });
      expect((await service.resolve(gmId, campaignId)).ok).toBe(false);
      expect(await row(campaignId, gmId)).toMatchObject({ removed: true, version: 2 });
      expect(await row(campaignId, ownerId)).toEqual({ role: 'owner', version: 1, removed: false });
    });

    test('assistant_gm, player, and removed actors cannot remove anyone', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith([
        'assistant_gm',
        'player',
        'player',
        'gm',
      ]);
      const [assistantId = '', playerId = '', targetId = '', gmId = ''] = memberIds;
      const { service, signals } = harness();
      expect(await service.remove(assistantId, campaignId, targetId)).toEqual(forbidden);
      expect(await service.remove(playerId, campaignId, targetId)).toEqual(forbidden);
      expect(await service.remove(playerId, campaignId, playerId)).toEqual(forbidden);
      expect((await service.remove(ownerId, campaignId, gmId)).ok).toBe(true);
      expect(await service.remove(gmId, campaignId, targetId)).toEqual(forbidden);
      expect(await row(campaignId, targetId)).toMatchObject({ removed: false, version: 1 });
      expect(await service.remove(await insertUser(), campaignId, targetId)).toEqual(forbidden);
      expect(signals).toHaveLength(1);
    });

    test('the sole owner cannot be removed by anyone and removed targets cannot be removed again', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm', 'player']);
      const [gmId = '', playerId = ''] = memberIds;
      const { service, signals } = harness();
      for (const actor of [ownerId, gmId, playerId]) {
        expect(await service.remove(actor, campaignId, ownerId)).toEqual({
          ok: false,
          error: 'owner_cannot_be_removed',
        });
      }
      expect(await activeOwners(campaignId)).toEqual([ownerId]);
      expect((await service.remove(ownerId, campaignId, playerId)).ok).toBe(true);
      expect(await service.remove(ownerId, campaignId, playerId)).toEqual(forbidden);
      expect(await row(campaignId, playerId)).toMatchObject({ removed: true, version: 2 });
      expect(signals).toHaveLength(1);
    });
  });

  describe('role changes', () => {
    test('owner changes a non-owner role; prior role stops resolving and signals fire', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['player']);
      const playerId = memberIds[0] ?? '';
      await author(campaignId, playerId);
      const { service, audits, signals, committedAtPublish } = harness();

      const changed = await service.changeRole(ownerId, campaignId, playerId, 'assistant_gm');
      expect(changed).toMatchObject({
        ok: true,
        value: { role: 'assistant_gm', version: 2, user: { id: playerId } },
      });
      expect(await service.resolve(playerId, campaignId)).toEqual({
        ok: true,
        value: { userId: playerId, campaignId, role: 'assistant_gm' },
      });
      expect(await row(campaignId, playerId)).toEqual({
        role: 'assistant_gm',
        version: 2,
        removed: false,
      });
      expect(await authoredCount(campaignId, playerId)).toBe(1);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'membership.role_changed', targetId: playerId });
      expect(signals).toEqual([
        expect.objectContaining({ userId: playerId, membershipVersion: 2, reason: 'role_changed' }),
      ]);
      expect(committedAtPublish).toEqual([true]);
    });

    test('non-owners, the owner target, observer, and owner roles leave memberships unchanged', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith([
        'gm',
        'assistant_gm',
        'player',
      ]);
      const [gmId = '', assistantId = '', playerId = ''] = memberIds;
      const { service, audits, signals } = harness();
      for (const actor of [gmId, assistantId, playerId]) {
        expect(await service.changeRole(actor, campaignId, playerId, 'gm')).toEqual(forbidden);
      }
      expect(await service.changeRole(ownerId, campaignId, ownerId, 'gm')).toEqual(forbidden);
      expect(await service.changeRole(await insertUser(), campaignId, playerId, 'gm')).toEqual(
        forbidden,
      );
      for (const role of ['observer', 'owner'] as const) {
        expect(await service.changeRole(ownerId, campaignId, playerId, role)).toEqual({
          ok: false,
          error: 'invalid_role',
        });
      }
      expect(await row(campaignId, playerId)).toEqual({
        role: 'player',
        version: 1,
        removed: false,
      });
      expect(await row(campaignId, ownerId)).toMatchObject({ role: 'owner', version: 1 });
      expect(audits).toEqual([]);
      expect(signals).toEqual([]);
    });

    test('a removed member cannot be given a role', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['player']);
      const playerId = memberIds[0] ?? '';
      const { service } = harness();
      expect((await service.remove(ownerId, campaignId, playerId)).ok).toBe(true);
      expect(await service.changeRole(ownerId, campaignId, playerId, 'gm')).toEqual(forbidden);
      expect(await row(campaignId, playerId)).toMatchObject({ removed: true, version: 2 });
    });
  });

  describe('ownership transfer exposure', () => {
    test('transfer bumps both versions, preserves one owner, and signals both members', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['player']);
      const playerId = memberIds[0] ?? '';
      await author(campaignId, ownerId);
      const { service, audits, signals, committedAtPublish } = harness();

      const result = await service.transferOwnership(ownerId, campaignId, playerId);
      expect(result).toMatchObject({
        ok: true,
        value: {
          owner: { role: 'owner', version: 2, user: { id: playerId } },
          formerOwner: { role: 'gm', version: 2, user: { id: ownerId } },
        },
      });
      expect(await activeOwners(campaignId)).toEqual([playerId]);
      expect(await row(campaignId, ownerId)).toEqual({ role: 'gm', version: 2, removed: false });
      expect(await authoredCount(campaignId, ownerId)).toBe(1);
      expect(audits.map((event) => event.action)).toEqual([
        'membership.ownership_transferred',
        'membership.ownership_transferred',
      ]);
      expect(signals.map((event) => [event.userId, event.reason]).sort()).toEqual(
        [
          [ownerId, 'ownership_transferred'],
          [playerId, 'ownership_transferred'],
        ].sort(),
      );
      expect(committedAtPublish).toEqual([true, true]);
      expect(await service.transferOwnership(ownerId, campaignId, playerId)).toEqual(forbidden);
    });
  });

  describe('listing', () => {
    test('campaign list returns each current member once with one role for any member', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith([
        'gm',
        'assistant_gm',
        'player',
      ]);
      const [gmId = '', assistantId = '', playerId = ''] = memberIds;
      const { service } = harness();
      expect((await service.remove(ownerId, campaignId, assistantId)).ok).toBe(true);
      for (const viewer of [ownerId, gmId, playerId]) {
        const listed = await service.listCampaign(viewer, campaignId, {});
        if (!listed.ok) throw new Error(listed.error);
        expect(listed.value.nextCursor).toBeUndefined();
        expect(listed.value.items.map((item) => item.user.id).sort()).toEqual(
          [ownerId, gmId, playerId].sort(),
        );
        expect(listed.value.items.find((item) => item.user.id === gmId)?.role).toBe('gm');
      }
      expect(await service.listCampaign(assistantId, campaignId, {})).toEqual(forbidden);
      expect(await service.listCampaign(await insertUser(), campaignId, {})).toEqual(forbidden);
    });

    test('campaign list paginates without repeats or gaps', async () => {
      const { campaignId, ownerId } = await campaignWith([
        'gm',
        'player',
        'player',
        'assistant_gm',
      ]);
      const { service } = harness();
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const listed = await service.listCampaign(ownerId, campaignId, {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!listed.ok) throw new Error(listed.error);
        seen.push(...listed.value.items.map((item) => item.user.id));
        cursor = listed.value.nextCursor;
        if (cursor === undefined) break;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    test('self-only campaign list returns each current campaign once and omits removals', async () => {
      const userId = await insertUser();
      const first = await campaignWith([]);
      const second = await campaignWith([]);
      const third = await campaignWith([]);
      for (const [campaign, role] of [
        [first, 'player'],
        [second, 'gm'],
        [third, 'assistant_gm'],
      ] as const) {
        await db()
          .insert(identityCampaignMemberships)
          .values({ campaignId: campaign.campaignId, userId, role });
      }
      const { service } = harness();
      expect((await service.remove(third.ownerId, third.campaignId, userId)).ok).toBe(true);
      const listed = await service.listUser(userId, {});
      expect(listed.items.map((item) => item.campaignId).sort()).toEqual(
        [first.campaignId, second.campaignId].sort(),
      );
      expect(listed.items.every((item) => item.user.id === userId)).toBe(true);
      expect(await service.listCampaignIds(userId)).toHaveLength(2);
      expect((await service.listUser(await insertUser(), {})).items).toEqual([]);
    });

    test('a malformed cursor never reaches the database', async () => {
      const { campaignId, ownerId } = await campaignWith([]);
      const { service } = harness();
      expect(await service.listCampaign(ownerId, campaignId, { cursor: "'; drop" })).toEqual({
        ok: true,
        value: { items: [] },
      });
    });
  });

  describe('concurrency', () => {
    test('concurrent removals of one target succeed once and bump the version once', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm', 'player']);
      const [gmId = '', playerId = ''] = memberIds;
      const { service, signals } = harness();
      const results = await Promise.all([
        service.remove(ownerId, campaignId, playerId),
        service.remove(gmId, campaignId, playerId),
        service.remove(ownerId, campaignId, playerId),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await row(campaignId, playerId)).toMatchObject({ removed: true, version: 2 });
      expect(signals).toHaveLength(1);
    });

    test('a gm removing themselves racing the owner removing that gm yields one removal', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm']);
      const gmId = memberIds[0] ?? '';
      const { service } = harness();
      const results = await Promise.all([
        service.remove(gmId, campaignId, gmId),
        service.remove(ownerId, campaignId, gmId),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await row(campaignId, gmId)).toMatchObject({ removed: true, version: 2 });
      expect(await activeOwners(campaignId)).toEqual([ownerId]);
    });

    test('owner demoting a gm races that gm removing a player: authority uses the committed role', async () => {
      for (let round = 0; round < 8; round += 1) {
        const { campaignId, ownerId, memberIds } = await campaignWith(['gm', 'player', 'gm']);
        const [gmId = '', playerId = '', otherGmId = ''] = memberIds;
        const { service } = harness();
        const [demotion, removal] = await Promise.all([
          service.changeRole(ownerId, campaignId, gmId, 'player'),
          service.remove(gmId, campaignId, playerId),
        ]);
        expect(demotion.ok).toBe(true);
        const final = await row(campaignId, playerId);
        // Removal is valid only if it committed before the demotion took effect.
        expect(final.removed).toBe(removal.ok);
        if (!removal.ok) expect(removal).toEqual(forbidden);
        expect(await row(campaignId, otherGmId)).toMatchObject({ role: 'gm', removed: false });
      }
    });

    test('a gm removing a player racing the owner promoting that player to gm stays consistent', async () => {
      for (let round = 0; round < 8; round += 1) {
        const { campaignId, ownerId, memberIds } = await campaignWith(['gm', 'player']);
        const [gmId = '', playerId = ''] = memberIds;
        const { service } = harness();
        const [removal, promotion] = await Promise.all([
          service.remove(gmId, campaignId, playerId),
          service.changeRole(ownerId, campaignId, playerId, 'gm'),
        ]);
        const final = await row(campaignId, playerId);
        if (removal.ok) {
          // Removal committed first; the promotion then found no current member.
          expect(promotion).toEqual(forbidden);
          expect(final).toMatchObject({ removed: true, role: 'player', version: 2 });
        } else {
          // Promotion committed first; a gm cannot remove another gm.
          expect(removal).toEqual(forbidden);
          expect(promotion.ok).toBe(true);
          expect(final).toMatchObject({ removed: false, role: 'gm', version: 2 });
        }
      }
    });

    test('a gm removing a member racing an ownership transfer to that member keeps one owner', async () => {
      for (let round = 0; round < 8; round += 1) {
        const { campaignId, ownerId, memberIds } = await campaignWith(['gm', 'player']);
        const [gmId = '', playerId = ''] = memberIds;
        const { service } = harness();
        const [removal, transfer] = await Promise.all([
          service.remove(gmId, campaignId, playerId),
          service.transferOwnership(ownerId, campaignId, playerId),
        ]);
        expect([removal.ok, transfer.ok].filter(Boolean)).toHaveLength(1);
        expect(await activeOwners(campaignId)).toEqual([transfer.ok ? playerId : ownerId]);
        if (!transfer.ok) expect(removal.ok).toBe(true);
        if (!removal.ok) expect(removal.error).toBe('owner_cannot_be_removed');
      }
    });

    test('concurrent role changes of one member leave exactly one committed role and version', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['player']);
      const playerId = memberIds[0] ?? '';
      const { service } = harness();
      const results = await Promise.all([
        service.changeRole(ownerId, campaignId, playerId, 'gm'),
        service.changeRole(ownerId, campaignId, playerId, 'assistant_gm'),
      ]);
      expect(results.every((result) => result.ok)).toBe(true);
      const final = await row(campaignId, playerId);
      expect(final.version).toBe(3);
      expect(['gm', 'assistant_gm']).toContain(final.role);
      expect(await service.resolve(playerId, campaignId)).toMatchObject({
        ok: true,
        value: { role: final.role },
      });
    });
  });
});
