import { err, ok, type Result, type Role } from '@rpg/contracts';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type {
  InvitationError,
  InvitationRecord,
  InvitationStore,
} from '../../application/invitation-service.ts';
import type {
  MembershipMutationError,
  MembershipRecord,
  MembershipStore,
} from '../../application/membership-service.ts';
import type {
  CampaignMembershipTransaction,
  CampaignMembershipWriter,
  MembershipError,
} from '../../contracts/interfaces.ts';
import {
  decideOwnershipTransfer,
  decideRemoval,
  decideRoleChange,
  isMvpRole,
} from '../../domain/roles.ts';
import type { IdentityDatabase, IdentityTransaction } from './database.ts';
import { inIdentityTransaction } from './database.ts';
import { identityCampaignMemberships, identityInvitations, identityUsers } from './schema.ts';

export interface CampaignDisplayNameReader {
  getDisplayName(campaignId: string): Promise<string | undefined>;
}

export class PostgresCampaignMembershipWriter implements CampaignMembershipWriter {
  async createOwner(
    input: { readonly userId: string; readonly campaignId: string },
    transaction: CampaignMembershipTransaction,
  ): Promise<
    Result<
      { readonly userId: string; readonly campaignId: string; readonly role: 'owner' },
      MembershipError
    >
  > {
    if (!isSqlExecutor(transaction.handle)) return err('owner_conflict');
    try {
      const rows = await transaction.handle.execute<{ userId: string }>(sql`
        insert into identity_campaign_memberships
          (campaign_id, user_id, role, created_at, updated_at, version)
        values
          (${input.campaignId}, ${input.userId}, 'owner', transaction_timestamp(), transaction_timestamp(), 1)
        returning user_id as "userId"
      `);
      return rows.length === 1 ? ok({ ...input, role: 'owner' as const }) : err('owner_conflict');
    } catch {
      return err('owner_conflict');
    }
  }
}

export class PostgresMembershipRepository implements MembershipStore {
  constructor(private readonly db: IdentityDatabase) {}

  async find(campaignId: string, userId: string) {
    return findMembership(this.db, campaignId, userId);
  }

  async listCampaign(campaignId: string, limit: number, cursor?: string) {
    const cursorUserId = cursor?.split(':').at(-1);
    return this.db
      .select(membershipSelection)
      .from(identityCampaignMemberships)
      .innerJoin(identityUsers, eq(identityUsers.id, identityCampaignMemberships.userId))
      .where(
        and(
          eq(identityCampaignMemberships.campaignId, campaignId),
          isNull(identityCampaignMemberships.removedAt),
          cursorUserId === undefined
            ? undefined
            : gt(identityCampaignMemberships.userId, cursorUserId),
        ),
      )
      .orderBy(asc(identityCampaignMemberships.userId))
      .limit(limit);
  }

  async listUser(userId: string, limit: number, cursor?: string) {
    const cursorCampaignId = cursor?.split(':')[0];
    return this.db
      .select(membershipSelection)
      .from(identityCampaignMemberships)
      .innerJoin(identityUsers, eq(identityUsers.id, identityCampaignMemberships.userId))
      .where(
        and(
          eq(identityCampaignMemberships.userId, userId),
          isNull(identityCampaignMemberships.removedAt),
          cursorCampaignId === undefined
            ? undefined
            : gt(identityCampaignMemberships.campaignId, cursorCampaignId),
        ),
      )
      .orderBy(asc(identityCampaignMemberships.campaignId))
      .limit(limit);
  }

  async remove(input: {
    readonly campaignId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
  }): Promise<Result<MembershipRecord, MembershipMutationError>> {
    try {
      return await inIdentityTransaction(this.db, async (transaction) => {
        const rows = await lockMemberships(transaction, input.campaignId, [
          input.actorUserId,
          input.targetUserId,
        ]);
        const actor = rows.find((row) => row.userId === input.actorUserId);
        const target = rows.find((row) => row.userId === input.targetUserId);
        if (!activeMvp(actor) || !activeMvp(target)) return err('not_found_or_forbidden');
        const decision = decideRemoval(
          actor.role,
          target.role,
          input.actorUserId === input.targetUserId,
        );
        if (!decision.allowed) {
          return err(
            decision.reason === 'owner_cannot_be_removed'
              ? 'owner_cannot_be_removed'
              : 'not_found_or_forbidden',
          );
        }
        const [updated] = await transaction
          .update(identityCampaignMemberships)
          .set({
            removedAt: sql`transaction_timestamp()`,
            updatedAt: sql`transaction_timestamp()`,
            version: sql`${identityCampaignMemberships.version} + 1`,
          })
          .where(
            and(
              eq(identityCampaignMemberships.campaignId, input.campaignId),
              eq(identityCampaignMemberships.userId, input.targetUserId),
              isNull(identityCampaignMemberships.removedAt),
            ),
          )
          .returning();
        if (updated === undefined) return err('membership_not_found');
        return ok({ ...target, ...updated, role: target.role });
      });
    } catch {
      return err<'identity_unavailable'>('identity_unavailable');
    }
  }

  async changeRole(input: {
    readonly campaignId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly role: 'gm' | 'assistant_gm' | 'player';
  }): Promise<Result<MembershipRecord, MembershipMutationError>> {
    try {
      return await inIdentityTransaction(this.db, async (transaction) => {
        const rows = await lockMemberships(transaction, input.campaignId, [
          input.actorUserId,
          input.targetUserId,
        ]);
        const actor = rows.find((row) => row.userId === input.actorUserId);
        const target = rows.find((row) => row.userId === input.targetUserId);
        if (!activeMvp(actor) || !activeMvp(target)) return err('not_found_or_forbidden');
        if (!decideRoleChange(actor.role, target.role).allowed)
          return err('not_found_or_forbidden');
        const [updated] = await transaction
          .update(identityCampaignMemberships)
          .set({
            role: input.role,
            updatedAt: sql`transaction_timestamp()`,
            version: sql`${identityCampaignMemberships.version} + 1`,
          })
          .where(
            and(
              eq(identityCampaignMemberships.campaignId, input.campaignId),
              eq(identityCampaignMemberships.userId, input.targetUserId),
              isNull(identityCampaignMemberships.removedAt),
            ),
          )
          .returning();
        if (updated === undefined) return err('membership_not_found');
        return ok({ ...target, ...updated, role: input.role });
      });
    } catch {
      return err<'identity_unavailable'>('identity_unavailable');
    }
  }

  async transferOwnership(input: {
    readonly campaignId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
  }): Promise<
    Result<
      { readonly owner: MembershipRecord; readonly formerOwner: MembershipRecord },
      MembershipMutationError
    >
  > {
    try {
      return await inIdentityTransaction(this.db, async (transaction) => {
        const rows = await transaction
          .select(membershipSelection)
          .from(identityCampaignMemberships)
          .innerJoin(identityUsers, eq(identityUsers.id, identityCampaignMemberships.userId))
          .where(
            and(
              eq(identityCampaignMemberships.campaignId, input.campaignId),
              isNull(identityCampaignMemberships.removedAt),
            ),
          )
          .orderBy(asc(identityCampaignMemberships.userId))
          .for('update');
        const actor = rows.find((row) => row.userId === input.actorUserId);
        const target = rows.find((row) => row.userId === input.targetUserId);
        if (!activeMvp(actor)) return err('not_found_or_forbidden');
        const decision = decideOwnershipTransfer(
          actor.role,
          activeMvp(target) ? target.role : undefined,
        );
        if (!decision.allowed || target === undefined) return err('not_found_or_forbidden');

        const [formerOwner] = await transaction
          .update(identityCampaignMemberships)
          .set({
            role: 'gm',
            updatedAt: sql`transaction_timestamp()`,
            version: sql`${identityCampaignMemberships.version} + 1`,
          })
          .where(
            and(
              eq(identityCampaignMemberships.campaignId, input.campaignId),
              eq(identityCampaignMemberships.userId, input.actorUserId),
              eq(identityCampaignMemberships.role, 'owner'),
              isNull(identityCampaignMemberships.removedAt),
            ),
          )
          .returning();
        const [owner] = await transaction
          .update(identityCampaignMemberships)
          .set({
            role: 'owner',
            updatedAt: sql`transaction_timestamp()`,
            version: sql`${identityCampaignMemberships.version} + 1`,
          })
          .where(
            and(
              eq(identityCampaignMemberships.campaignId, input.campaignId),
              eq(identityCampaignMemberships.userId, input.targetUserId),
              isNull(identityCampaignMemberships.removedAt),
            ),
          )
          .returning();
        if (formerOwner === undefined || owner === undefined) return err('owner_conflict');
        return ok({
          formerOwner: { ...actor, ...formerOwner, role: 'gm' as const },
          owner: { ...target, ...owner, role: 'owner' as const },
        });
      });
    } catch {
      return err<'owner_conflict'>('owner_conflict');
    }
  }
}

export class PostgresInvitationRepository implements InvitationStore {
  constructor(
    private readonly db: IdentityDatabase,
    private readonly campaigns: CampaignDisplayNameReader,
  ) {}

  async issue(input: {
    readonly id: string;
    readonly campaignId: string;
    readonly actorUserId: string;
    readonly targetRole: 'gm' | 'assistant_gm' | 'player';
    readonly tokenDigest: Uint8Array;
    readonly expiresInSeconds: number;
  }): Promise<Result<InvitationRecord, InvitationError>> {
    try {
      const result = await inIdentityTransaction(this.db, async (transaction) => {
        const actor = await findMembership(transaction, input.campaignId, input.actorUserId, true);
        if (!activeMvp(actor) || (actor.role !== 'owner' && actor.role !== 'gm')) {
          return err<'not_found_or_forbidden'>('not_found_or_forbidden');
        }
        const [inserted] = await transaction
          .insert(identityInvitations)
          .values({
            id: input.id,
            campaignId: input.campaignId,
            createdByUserId: input.actorUserId,
            targetRole: input.targetRole,
            tokenDigest: input.tokenDigest,
            expiresAt: sql`transaction_timestamp() + ${input.expiresInSeconds} * interval '1 second'`,
          })
          .returning();
        if (inserted === undefined) return err<'identity_unavailable'>('identity_unavailable');
        return ok(inserted);
      });
      if (!result.ok) return result;
      const name = await this.campaigns.getDisplayName(input.campaignId);
      if (name === undefined) return err('not_found_or_forbidden');
      return ok({
        id: result.value.id,
        campaignId: result.value.campaignId,
        campaignDisplayName: name,
        targetRole: input.targetRole,
        expiresAt: result.value.expiresAt,
        state: 'usable',
      });
    } catch {
      return err('identity_unavailable');
    }
  }

  async preview(tokenDigest: Uint8Array) {
    const [row] = await this.db
      .select({
        id: identityInvitations.id,
        campaignId: identityInvitations.campaignId,
        targetRole: sql<Role>`${identityInvitations.targetRole}`,
        expiresAt: identityInvitations.expiresAt,
        usable: sql<boolean>`${identityInvitations.usedAt} IS NULL AND ${identityInvitations.revokedAt} IS NULL AND ${identityInvitations.expiresAt} > transaction_timestamp()`,
      })
      .from(identityInvitations)
      .where(eq(identityInvitations.tokenDigest, tokenDigest))
      .limit(1);
    if (row === undefined || !row.usable) return undefined;
    const campaignDisplayName = await this.campaigns.getDisplayName(row.campaignId);
    if (campaignDisplayName === undefined) return undefined;
    if (!isMvpRole(row.targetRole)) return undefined;
    return {
      id: row.id,
      campaignId: row.campaignId,
      campaignDisplayName,
      targetRole: row.targetRole,
      expiresAt: row.expiresAt,
      state: 'usable' as const,
    };
  }

  async accept(input: { readonly tokenDigest: Uint8Array; readonly userId: string }) {
    try {
      return await inIdentityTransaction(this.db, async (transaction) => {
        const [invitation] = await transaction
          .select()
          .from(identityInvitations)
          .where(eq(identityInvitations.tokenDigest, input.tokenDigest))
          .limit(1)
          .for('update');
        if (
          invitation === undefined ||
          invitation.usedAt !== null ||
          invitation.revokedAt !== null ||
          invitation.expiresAt.getTime() <= Date.now()
        ) {
          return err<'unusable_invitation'>('unusable_invitation');
        }
        const existing = await findMembership(
          transaction,
          invitation.campaignId,
          input.userId,
          true,
        );
        if (existing !== undefined && existing.removedAt === null) {
          return err<'membership_already_exists'>('membership_already_exists');
        }
        const targetRole = invitation.targetRole as Role;
        if (!isMvpRole(targetRole) || targetRole === 'owner') {
          return err<'unusable_invitation'>('unusable_invitation');
        }
        if (existing === undefined) {
          await transaction.insert(identityCampaignMemberships).values({
            campaignId: invitation.campaignId,
            userId: input.userId,
            role: targetRole,
          });
        } else {
          await transaction
            .update(identityCampaignMemberships)
            .set({
              role: targetRole,
              removedAt: null,
              updatedAt: sql`transaction_timestamp()`,
              version: sql`${identityCampaignMemberships.version} + 1`,
            })
            .where(
              and(
                eq(identityCampaignMemberships.campaignId, invitation.campaignId),
                eq(identityCampaignMemberships.userId, input.userId),
              ),
            );
        }
        await transaction
          .update(identityInvitations)
          .set({ usedAt: sql`transaction_timestamp()`, acceptedByUserId: input.userId })
          .where(eq(identityInvitations.id, invitation.id));
        const membership = await findMembership(transaction, invitation.campaignId, input.userId);
        if (!activeMvp(membership)) return err<'identity_unavailable'>('identity_unavailable');
        return ok({
          user: { id: membership.userId, username: membership.username },
          campaignId: membership.campaignId,
          role: membership.role,
          version: membership.version,
          updatedAt: membership.updatedAt.toISOString(),
        });
      });
    } catch {
      return err<'identity_unavailable'>('identity_unavailable');
    }
  }

  async revoke(input: {
    readonly invitationId: string;
    readonly campaignId: string;
    readonly actorUserId: string;
  }) {
    try {
      return await inIdentityTransaction(this.db, async (transaction) => {
        const actor = await findMembership(transaction, input.campaignId, input.actorUserId, true);
        if (!activeMvp(actor) || (actor.role !== 'owner' && actor.role !== 'gm')) {
          return err<'not_found_or_forbidden'>('not_found_or_forbidden');
        }
        const revoked = await transaction
          .update(identityInvitations)
          .set({ revokedAt: sql`transaction_timestamp()`, revokedByUserId: input.actorUserId })
          .where(
            and(
              eq(identityInvitations.id, input.invitationId),
              eq(identityInvitations.campaignId, input.campaignId),
              isNull(identityInvitations.usedAt),
              isNull(identityInvitations.revokedAt),
            ),
          )
          .returning({ id: identityInvitations.id });
        return revoked.length === 1
          ? ok(undefined)
          : err<'not_found_or_forbidden'>('not_found_or_forbidden');
      });
    } catch {
      return err<'identity_unavailable'>('identity_unavailable');
    }
  }

  async list(input: { readonly campaignId: string; readonly actorUserId: string }) {
    const actor = await findMembership(this.db, input.campaignId, input.actorUserId);
    if (!activeMvp(actor) || (actor.role !== 'owner' && actor.role !== 'gm')) {
      return err<'not_found_or_forbidden'>('not_found_or_forbidden');
    }
    const rows = await this.db
      .select({
        id: identityInvitations.id,
        campaignId: identityInvitations.campaignId,
        targetRole: sql<Role>`${identityInvitations.targetRole}`,
        expiresAt: identityInvitations.expiresAt,
        usedAt: identityInvitations.usedAt,
        revokedAt: identityInvitations.revokedAt,
        expired: sql<boolean>`${identityInvitations.expiresAt} <= transaction_timestamp()`,
      })
      .from(identityInvitations)
      .where(eq(identityInvitations.campaignId, input.campaignId))
      .orderBy(asc(identityInvitations.createdAt));
    const campaignDisplayName = (await this.campaigns.getDisplayName(input.campaignId)) ?? '';
    return ok(
      rows
        .filter((row) => isMvpRole(row.targetRole))
        .map((row) => ({
          id: row.id,
          campaignId: row.campaignId,
          campaignDisplayName,
          targetRole: row.targetRole,
          expiresAt: row.expiresAt,
          state:
            row.usedAt !== null
              ? ('used' as const)
              : row.revokedAt !== null
                ? ('revoked' as const)
                : row.expired
                  ? ('expired' as const)
                  : ('usable' as const),
        })),
    );
  }
}

const membershipSelection = {
  campaignId: identityCampaignMemberships.campaignId,
  userId: identityCampaignMemberships.userId,
  username: identityUsers.usernameDisplay,
  role: sql<Role>`${identityCampaignMemberships.role}`,
  version: identityCampaignMemberships.version,
  updatedAt: identityCampaignMemberships.updatedAt,
  removedAt: identityCampaignMemberships.removedAt,
};

async function findMembership(
  executor: IdentityDatabase | IdentityTransaction,
  campaignId: string,
  userId: string,
  lock = false,
): Promise<MembershipRecord | undefined> {
  const query = executor
    .select(membershipSelection)
    .from(identityCampaignMemberships)
    .innerJoin(identityUsers, eq(identityUsers.id, identityCampaignMemberships.userId))
    .where(
      and(
        eq(identityCampaignMemberships.campaignId, campaignId),
        eq(identityCampaignMemberships.userId, userId),
      ),
    )
    .limit(1);
  const rows = lock && 'rollback' in executor ? await query.for('update') : await query;
  return rows[0];
}

async function lockMemberships(
  transaction: IdentityTransaction,
  campaignId: string,
  userIds: readonly string[],
) {
  const unique = [...new Set(userIds)].sort();
  if (unique.length === 0) return [];
  return transaction
    .select(membershipSelection)
    .from(identityCampaignMemberships)
    .innerJoin(identityUsers, eq(identityUsers.id, identityCampaignMemberships.userId))
    .where(
      and(
        eq(identityCampaignMemberships.campaignId, campaignId),
        or(...unique.map((userId) => eq(identityCampaignMemberships.userId, userId))),
      ),
    )
    .orderBy(asc(identityCampaignMemberships.userId))
    .for('update');
}

function activeMvp(record: MembershipRecord | undefined): record is MembershipRecord & {
  readonly role: 'owner' | 'gm' | 'assistant_gm' | 'player';
} {
  return record !== undefined && record.removedAt === null && isMvpRole(record.role);
}

interface SqlExecutor {
  execute<T>(query: ReturnType<typeof sql>): Promise<readonly T[]>;
}

function isSqlExecutor(value: unknown): value is SqlExecutor {
  return (
    typeof value === 'object' &&
    value !== null &&
    'execute' in value &&
    typeof value.execute === 'function'
  );
}
