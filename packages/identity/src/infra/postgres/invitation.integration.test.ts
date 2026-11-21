import { afterAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { AccountSessionService } from '../../application/account-session-service.ts';
import { InvitationService } from '../../application/invitation-service.ts';
import { MembershipService } from '../../application/membership-service.ts';
import { digestOpaqueCredential } from '../credentials.ts';
import { Argon2PasswordHasher } from '../password-hasher.ts';
import { connectIdentityDatabase } from './database.ts';
import {
  PostgresInvitationRepository,
  PostgresMembershipRepository,
} from './membership-repository.ts';
import { AccountRepository, SessionRepository } from './repositories.ts';
import { identityCampaignMemberships, identityInvitations } from './schema.ts';

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

type MemberRole = 'gm' | 'assistant_gm' | 'player';
type Unusable = 'expired' | 'revoked' | 'already used' | 'not recognized';
const UNUSABLE: readonly Unusable[] = ['expired', 'revoked', 'already used', 'not recognized'];
const UNKNOWN_TOKEN = 'Z'.repeat(43);

describe.skipIf(connection === undefined)('PostgreSQL invitation lifecycle', () => {
  const db = () => {
    if (connection === undefined) throw new Error('database unavailable');
    return connection.db;
  };
  const names = new Map<string, string>();
  const invitations = () =>
    new InvitationService(
      new PostgresInvitationRepository(db(), {
        getDisplayName: async (campaignId) => names.get(campaignId),
      }),
      { record: async () => undefined },
      { integrationDegraded: () => undefined },
    );
  const memberships = () =>
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
        (${userId}, ${`Invitee_${userId.slice(0, 8)}`}, ${`invitee_${userId.slice(0, 8)}`}, now(), now())
    `);
    return userId;
  }

  /** Committed campaign with one owner and the requested additional members. */
  async function campaignWith(members: readonly MemberRole[] = []) {
    const ownerId = await insertUser();
    const memberIds: string[] = [];
    for (const _ of members) memberIds.push(await insertUser());
    const campaignId = crypto.randomUUID();
    names.set(campaignId, `Game ${campaignId.slice(0, 8)}`);
    await db().transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into campaigns
          (id, name, description, game_mode, created_by, version, created_at, updated_at)
        values
          (${campaignId}, ${names.get(campaignId) ?? ''}, '', 'standard', ${ownerId}, 1, now(), now())
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

  async function issue(actorUserId: string, campaignId: string, targetRole: MemberRole = 'player') {
    const issued = await invitations().issue(actorUserId, campaignId, { targetRole });
    if (!issued.ok) throw new Error(`fixture issue failed: ${issued.error}`);
    return issued.value;
  }

  async function invitationRows(campaignId: string) {
    return db()
      .select()
      .from(identityInvitations)
      .where(eq(identityInvitations.campaignId, campaignId));
  }

  async function membershipRows(where: { campaignId?: string; userId?: string }) {
    return db()
      .select()
      .from(identityCampaignMemberships)
      .where(
        and(
          where.campaignId === undefined
            ? undefined
            : eq(identityCampaignMemberships.campaignId, where.campaignId),
          where.userId === undefined
            ? undefined
            : eq(identityCampaignMemberships.userId, where.userId),
        ),
      );
  }

  async function activeOwnerCount(campaignId: string) {
    const rows = await membershipRows({ campaignId });
    return rows.filter((row) => row.role === 'owner' && row.removedAt === null).length;
  }

  /** Puts a fresh invitation into one unusable state and returns its raw token. */
  async function unusableToken(state: Unusable): Promise<{ token: string; campaignId: string }> {
    const { campaignId, ownerId } = await campaignWith();
    if (state === 'not recognized') return { token: UNKNOWN_TOKEN, campaignId };
    const issued = await issue(ownerId, campaignId);
    if (state === 'expired') {
      // Exactly at the boundary in committed time: created 5 minutes ago, expires now.
      await db().execute(sql`
        update identity_invitations
        set created_at = now() - interval '5 minutes', expires_at = now()
        where id = ${issued.invitation.id}
      `);
    } else if (state === 'revoked') {
      const revoked = await invitations().revoke(ownerId, campaignId, issued.invitation.id);
      if (!revoked.ok) throw new Error('fixture revoke failed');
    } else {
      const accepted = await invitations().accept(await insertUser(), issued.token);
      if (!accepted.ok) throw new Error('fixture accept failed');
    }
    return { token: issued.token, campaignId };
  }

  describe('issuance authorization', () => {
    for (const inviter of ['owner', 'gm'] as const) {
      test(`${inviter} creates an expiring, revocable, single-use invitation with the selected role`, async () => {
        const { campaignId, ownerId, memberIds } = await campaignWith(['gm']);
        const actorId = inviter === 'owner' ? ownerId : (memberIds[0] ?? '');
        for (const targetRole of ['gm', 'assistant_gm', 'player'] as const) {
          const issued = await invitations().issue(actorId, campaignId, { targetRole });
          expect(issued.ok).toBe(true);
          if (!issued.ok) continue;
          expect(issued.value.invitation).toMatchObject({
            campaignId,
            targetRole,
            state: 'usable',
          });
        }
        const rows = await invitationRows(campaignId);
        expect(rows.map((row) => row.targetRole).sort()).toEqual(['assistant_gm', 'gm', 'player']);
        for (const row of rows) {
          expect(row.usedAt).toBeNull();
          expect(row.revokedAt).toBeNull();
          expect(row.createdByUserId).toBe(actorId);
          // Default lifetime is seven days of database time.
          expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
        }
      });
    }

    test('assistant_gm, player, non-member, and removed gm cannot create invitations', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith([
        'assistant_gm',
        'player',
        'gm',
      ]);
      const [assistantId, playerId, removedGmId] = memberIds;
      expect((await memberships().remove(ownerId, campaignId, removedGmId ?? '')).ok).toBe(true);
      for (const actorId of [assistantId, playerId, removedGmId, await insertUser()]) {
        expect(
          await invitations().issue(actorId ?? '', campaignId, { targetRole: 'player' }),
        ).toEqual({ ok: false, error: 'not_found_or_forbidden' });
      }
      expect(await invitationRows(campaignId)).toHaveLength(0);
    });

    test('observer and owner target roles create nothing and keep exactly one owner', async () => {
      const { campaignId, ownerId } = await campaignWith();
      for (const targetRole of ['observer', 'owner'] as const) {
        expect(await invitations().issue(ownerId, campaignId, { targetRole })).toEqual({
          ok: false,
          error: 'invalid_role',
        });
      }
      expect(await invitationRows(campaignId)).toHaveLength(0);
      expect(await activeOwnerCount(campaignId)).toBe(1);
    });

    test('the database rejects a persisted owner or observer target role', async () => {
      const { campaignId, ownerId } = await campaignWith();
      for (const role of ['owner', 'observer']) {
        let rejected = false;
        try {
          await db().execute(sql`
            insert into identity_invitations
              (id, campaign_id, created_by_user_id, target_role, token_digest, expires_at)
            values
              (${crypto.randomUUID()}, ${campaignId}, ${ownerId}, ${role},
               ${await digestOpaqueCredential(crypto.randomUUID().replaceAll('-', '').padEnd(43, 'x'))},
               now() + interval '1 day')
          `);
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      }
    });

    test('lifetime is bounded to five minutes through 30 days inclusive', async () => {
      const { campaignId, ownerId } = await campaignWith();
      for (const expiresInSeconds of [5 * 60 - 1, 30 * 24 * 60 * 60 + 1]) {
        expect(
          await invitations().issue(ownerId, campaignId, {
            targetRole: 'player',
            expiresInSeconds,
          }),
        ).toEqual({ ok: false, error: 'invalid_lifetime' });
      }
      for (const expiresInSeconds of [5 * 60, 30 * 24 * 60 * 60]) {
        const issued = await invitations().issue(ownerId, campaignId, {
          targetRole: 'player',
          expiresInSeconds,
        });
        expect(issued.ok).toBe(true);
      }
      const lifetimes = (await invitationRows(campaignId))
        .map((row) => (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000)
        .sort((a, b) => a - b);
      expect(lifetimes).toEqual([5 * 60, 30 * 24 * 60 * 60]);
    });

    test('the raw token is returned once and only its SHA-256 digest is stored', async () => {
      const { campaignId, ownerId } = await campaignWith();
      const issued = await issue(ownerId, campaignId);
      expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [row] = await invitationRows(campaignId);
      expect(row?.tokenDigest).toEqual(await digestOpaqueCredential(issued.token));
      const [raw] = await db().execute<{ row: string }>(
        sql`select row_to_json(i)::text as row from identity_invitations i where id = ${issued.invitation.id}`,
      );
      expect(raw?.row).not.toContain(issued.token);
      const listed = await invitations().list(ownerId, campaignId);
      expect(listed.ok).toBe(true);
      expect(JSON.stringify(listed)).not.toContain(issued.token);
      expect(Object.keys(issued.invitation).sort()).toEqual([
        'campaignId',
        'expiresAt',
        'id',
        'state',
        'targetRole',
      ]);
    });
  });

  describe('preview', () => {
    test('a usable invitation previews only display name, target role, and expiry', async () => {
      const { campaignId, ownerId } = await campaignWith();
      const issued = await issue(ownerId, campaignId, 'assistant_gm');
      const preview = await invitations().preview(issued.token);
      expect(preview).toEqual({
        ok: true,
        value: {
          campaignDisplayName: names.get(campaignId) ?? '',
          targetRole: 'assistant_gm',
          expiresAt: issued.invitation.expiresAt,
        },
      });
      const serialized = JSON.stringify(preview);
      expect(serialized).not.toContain(campaignId);
      expect(serialized).not.toContain(ownerId);
      expect(serialized).not.toContain(issued.invitation.id);
    });

    test('every unusable state previews as the same generic result', async () => {
      const results = [];
      for (const state of UNUSABLE) {
        const { token } = await unusableToken(state);
        results.push(await invitations().preview(token));
      }
      for (const result of results) {
        expect(result).toEqual({ ok: false, error: 'unusable_invitation' });
      }
    });
  });

  describe('acceptance', () => {
    test('a logged-in non-member joins with exactly the invitation role and consumes it', async () => {
      const { campaignId, ownerId } = await campaignWith();
      const userId = await insertUser();
      const issued = await issue(ownerId, campaignId, 'gm');
      const accepted = await invitations().accept(userId, issued.token);
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      expect(accepted.value).toMatchObject({ campaignId, role: 'gm', user: { id: userId } });
      const rows = await membershipRows({ campaignId, userId });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe('gm');
      const [invitation] = await invitationRows(campaignId);
      expect(invitation?.usedAt).toBeInstanceOf(Date);
      expect(invitation?.acceptedByUserId).toBe(userId);
      expect(await invitations().accept(await insertUser(), issued.token)).toEqual({
        ok: false,
        error: 'unusable_invitation',
      });
      expect(await invitations().preview(issued.token)).toEqual({
        ok: false,
        error: 'unusable_invitation',
      });
    });

    test('a logged-out user keeps the invitation pending through account creation', async () => {
      const { campaignId, ownerId } = await campaignWith();
      const issued = await issue(ownerId, campaignId);
      expect((await invitations().preview(issued.token)).ok).toBe(true);
      const accounts = new AccountSessionService(
        new AccountRepository(db()),
        new SessionRepository(db()),
        new Argon2PasswordHasher(),
        {
          accountCreated: () => undefined,
          loginSucceeded: () => undefined,
          loginFailed: () => undefined,
          sessionRevoked: () => undefined,
        },
      );
      const created = await accounts.createAccount({
        username: `late_${crypto.randomUUID().slice(0, 8)}`,
        password: 'correct horse battery staple',
      });
      if (!created.ok) throw new Error(`fixture account failed: ${created.error}`);
      const [pending] = await invitationRows(campaignId);
      expect(pending?.usedAt).toBeNull();
      const accepted = await invitations().accept(created.value.view.user.id, issued.token);
      expect(accepted.ok && accepted.value.campaignId).toBe(campaignId);
    });

    for (const state of UNUSABLE) {
      test(`a ${state} invitation fails closed and creates no membership`, async () => {
        const { token, campaignId } = await unusableToken(state);
        const userId = await insertUser();
        expect(await invitations().accept(userId, token)).toEqual({
          ok: false,
          error: 'unusable_invitation',
        });
        expect(await membershipRows({ userId })).toHaveLength(0);
        expect(await membershipRows({ campaignId })).toHaveLength(state === 'already used' ? 2 : 1);
      });
    }

    test('an existing active member is rejected without a role change or consumption', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['player']);
      const playerId = memberIds[0] ?? '';
      const issued = await issue(ownerId, campaignId, 'gm');
      for (const userId of [playerId, ownerId]) {
        expect(await invitations().accept(userId, issued.token)).toEqual({
          ok: false,
          error: 'membership_already_exists',
        });
      }
      const rows = await membershipRows({ campaignId });
      expect(rows.find((row) => row.userId === playerId)).toMatchObject({
        role: 'player',
        version: 1,
      });
      expect(await activeOwnerCount(campaignId)).toBe(1);
      const [invitation] = await invitationRows(campaignId);
      expect(invitation?.usedAt).toBeNull();
    });

    test('a removed member rejoins by reactivating the tombstone with the invited role', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['player']);
      const playerId = memberIds[0] ?? '';
      expect((await memberships().remove(ownerId, campaignId, playerId)).ok).toBe(true);
      const issued = await issue(ownerId, campaignId, 'assistant_gm');
      const accepted = await invitations().accept(playerId, issued.token);
      expect(accepted.ok && accepted.value.role).toBe('assistant_gm');
      const rows = await membershipRows({ campaignId, userId: playerId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ role: 'assistant_gm', removedAt: null, version: 3 });
      expect(await memberships().resolve(playerId, campaignId)).toEqual({
        ok: true,
        value: { userId: playerId, campaignId, role: 'assistant_gm' },
      });
    });

    test('an invitation grants nothing outside its campaign and role', async () => {
      const campaignA = await campaignWith();
      const campaignB = await campaignWith();
      const userId = await insertUser();
      const issued = await issue(campaignA.ownerId, campaignA.campaignId, 'player');
      expect((await invitations().accept(userId, issued.token)).ok).toBe(true);
      const rows = await membershipRows({ userId });
      expect(rows.map((row) => [row.campaignId, row.role])).toEqual([
        [campaignA.campaignId, 'player'],
      ]);
      expect((await memberships().resolve(userId, campaignB.campaignId)).ok).toBe(false);
    });
  });

  describe('concurrency', () => {
    test('exactly one of many concurrent acceptances of one invitation wins', async () => {
      const { campaignId, ownerId } = await campaignWith();
      const issued = await issue(ownerId, campaignId);
      const userIds = await Promise.all(Array.from({ length: 6 }, () => insertUser()));
      const results = await Promise.all(
        userIds.map((userId) => invitations().accept(userId, issued.token)),
      );
      const winners = results.filter((result) => result.ok);
      expect(winners).toHaveLength(1);
      for (const result of results) {
        if (!result.ok) expect(result.error).toBe('unusable_invitation');
      }
      const winner = winners[0];
      if (winner === undefined || !winner.ok) return;
      const joined = (await membershipRows({ campaignId })).filter((row) => row.role !== 'owner');
      expect(joined.map((row) => row.userId)).toEqual([winner.value.user.id]);
      const [invitation] = await invitationRows(campaignId);
      expect(invitation?.acceptedByUserId).toBe(winner.value.user.id);
    });

    test('concurrent tombstone reactivation through one invitation wins once', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['player', 'player']);
      for (const userId of memberIds) {
        expect((await memberships().remove(ownerId, campaignId, userId)).ok).toBe(true);
      }
      const issued = await issue(ownerId, campaignId, 'gm');
      const results = await Promise.all(
        memberIds.map((userId) => invitations().accept(userId, issued.token)),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const active = (await membershipRows({ campaignId })).filter(
        (row) => row.removedAt === null && row.role !== 'owner',
      );
      expect(active).toHaveLength(1);
      expect(active[0]?.role).toBe('gm');
    });

    test('one user racing two invitations to one campaign joins once and consumes one', async () => {
      const { campaignId, ownerId } = await campaignWith();
      const userId = await insertUser();
      const first = await issue(ownerId, campaignId, 'player');
      const second = await issue(ownerId, campaignId, 'assistant_gm');
      const results = await Promise.all([
        invitations().accept(userId, first.token),
        invitations().accept(userId, second.token),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toEqual({
        ok: false,
        error: 'membership_already_exists',
      });
      const rows = await membershipRows({ campaignId, userId });
      expect(rows).toHaveLength(1);
      const used = (await invitationRows(campaignId)).filter((row) => row.usedAt !== null);
      expect(used).toHaveLength(1);
      expect(used[0]?.targetRole).toBe(rows[0]?.role);
    });

    test('revocation racing acceptance leaves either a consumed or a revoked invitation', async () => {
      const { campaignId, ownerId } = await campaignWith();
      const userId = await insertUser();
      const issued = await issue(ownerId, campaignId);
      const [accepted, revoked] = await Promise.all([
        invitations().accept(userId, issued.token),
        invitations().revoke(ownerId, campaignId, issued.invitation.id),
      ]);
      expect(accepted.ok).not.toBe(revoked.ok);
      const [row] = await invitationRows(campaignId);
      expect((row?.usedAt === null) !== (row?.revokedAt === null)).toBe(true);
      expect(await membershipRows({ userId })).toHaveLength(accepted.ok ? 1 : 0);
    });
  });

  describe('revocation', () => {
    test('any current owner or gm revokes an unused invitation regardless of creator', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['gm']);
      const gmId = memberIds[0] ?? '';
      const byOwner = await issue(ownerId, campaignId);
      const byGm = await issue(gmId, campaignId);
      expect(await invitations().revoke(gmId, campaignId, byOwner.invitation.id)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await invitations().revoke(ownerId, campaignId, byGm.invitation.id)).toEqual({
        ok: true,
        value: undefined,
      });
      for (const token of [byOwner.token, byGm.token]) {
        expect(await invitations().accept(await insertUser(), token)).toEqual({
          ok: false,
          error: 'unusable_invitation',
        });
      }
      const rows = await invitationRows(campaignId);
      expect(rows.find((row) => row.id === byOwner.invitation.id)?.revokedByUserId).toBe(gmId);
    });

    test('other roles, outsiders, other campaigns, and used invitations cannot be revoked', async () => {
      const { campaignId, ownerId, memberIds } = await campaignWith(['assistant_gm', 'player']);
      const other = await campaignWith();
      const issued = await issue(ownerId, campaignId);
      for (const actorId of [...memberIds, await insertUser(), other.ownerId]) {
        expect(await invitations().revoke(actorId, campaignId, issued.invitation.id)).toEqual({
          ok: false,
          error: 'not_found_or_forbidden',
        });
      }
      expect(
        await invitations().revoke(other.ownerId, other.campaignId, issued.invitation.id),
      ).toEqual({ ok: false, error: 'not_found_or_forbidden' });
      expect((await invitations().preview(issued.token)).ok).toBe(true);
      expect((await invitations().accept(await insertUser(), issued.token)).ok).toBe(true);
      expect(await invitations().revoke(ownerId, campaignId, issued.invitation.id)).toEqual({
        ok: false,
        error: 'not_found_or_forbidden',
      });
    });
  });
});
