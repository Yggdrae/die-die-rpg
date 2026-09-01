import { afterAll, describe, expect, test } from 'bun:test';
import { count, eq, sql } from 'drizzle-orm';
import { InvitationService } from '../../application/invitation-service.ts';
import { MembershipService } from '../../application/membership-service.ts';
import { connectIdentityDatabase } from './database.ts';
import {
  PostgresInvitationRepository,
  PostgresMembershipRepository,
} from './membership-repository.ts';
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

describe.skipIf(connection === undefined)('PostgreSQL membership and invitation invariants', () => {
  test('one concurrent invitation consumer wins and ownership transfer stays exact', async () => {
    if (connection === undefined) return;
    const ownerId = crypto.randomUUID();
    const firstUserId = crypto.randomUUID();
    const secondUserId = crypto.randomUUID();
    const campaignId = crypto.randomUUID();
    for (const [index, userId] of [ownerId, firstUserId, secondUserId].entries()) {
      await connection.db.execute(sql`
        insert into identity_users
          (id, username_display, username_normalized, created_at, updated_at)
        values
          (${userId}, ${`Member_${index}_${userId.slice(0, 6)}`}, ${`member_${index}_${userId.slice(0, 6)}`}, now(), now())
      `);
    }
    await connection.db.transaction(async (transaction) => {
      await transaction.execute(sql`
        insert into campaigns
          (id, name, description, game_mode, created_by, version, created_at, updated_at)
        values
          (${campaignId}, 'Invite Game', '', 'standard', ${ownerId}, 1, now(), now())
      `);
      await transaction.execute(sql`
        insert into campaign_system_pins (campaign_id, system_id, system_version, updated_at)
        values (${campaignId}, 'fixture-system', '0.1.0', now())
      `);
      await transaction.insert(identityCampaignMemberships).values({
        campaignId,
        userId: ownerId,
        role: 'owner',
      });
    });

    const invitations = new InvitationService(
      new PostgresInvitationRepository(connection.db, {
        getDisplayName: async () => 'Invite Game',
      }),
    );
    const issued = await invitations.issue(ownerId, campaignId, { targetRole: 'player' });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const results = await Promise.all([
      invitations.accept(firstUserId, issued.value.token),
      invitations.accept(secondUserId, issued.value.token),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const winner = results.find((result) => result.ok);
    if (winner === undefined || !winner.ok) return;
    const [membershipCount] = await connection.db
      .select({ count: count() })
      .from(identityCampaignMemberships)
      .where(eq(identityCampaignMemberships.campaignId, campaignId));
    expect(membershipCount?.count).toBe(2);
    const [consumed] = await connection.db
      .select({ usedAt: identityInvitations.usedAt })
      .from(identityInvitations)
      .where(eq(identityInvitations.id, issued.value.invitation.id));
    expect(consumed?.usedAt).toBeInstanceOf(Date);

    const memberships = new MembershipService(
      new PostgresMembershipRepository(connection.db),
      { record: async () => undefined },
      { publish: async () => undefined },
      { integrationDegraded: () => undefined },
    );
    const transferred = await memberships.transferOwnership(
      ownerId,
      campaignId,
      winner.value.user.id,
    );
    expect(transferred.ok).toBe(true);
    const [owners] = await connection.db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from identity_campaign_memberships
      where campaign_id = ${campaignId} and role = 'owner' and removed_at is null
    `);
    expect(owners?.count).toBe(1);
  });
});
