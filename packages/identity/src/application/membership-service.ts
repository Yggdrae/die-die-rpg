import {
  type ActorRef,
  type AuditRecorder,
  type CampaignAccessRevocationPublisher,
  err,
  ok,
  type Result,
  type Role,
} from '@rpg/contracts';
import type { ActorResolver } from '../contracts/interfaces.ts';
import type { MembershipCacheRow, MembershipPage, MembershipView } from '../contracts/schemas.ts';
import {
  decideOwnershipTransfer,
  decideRemoval,
  decideRoleChange,
  isInvitationRole,
  isMvpRole,
} from '../domain/roles.ts';

export interface MembershipRecord {
  readonly campaignId: string;
  readonly userId: string;
  readonly username: string;
  readonly role: Role;
  readonly version: number;
  readonly updatedAt: Date;
  readonly removedAt: Date | null;
}

export type MembershipMutationError =
  | 'membership_not_found'
  | 'not_found_or_forbidden'
  | 'owner_cannot_be_removed'
  | 'invalid_role'
  | 'owner_conflict'
  | 'identity_unavailable';

/**
 * Minimal public fact about a membership row, current or removed. Authorizing history reads
 * (feature 06 audit of membership events) needs only existence and version: never a role
 * (`ActorResolver` stays the only role read) and never a username.
 */
export interface MembershipHistoryFact {
  readonly campaignId: string;
  readonly userId: string;
  readonly version: number;
  readonly removed: boolean;
}

export interface MembershipStore {
  find(campaignId: string, userId: string): Promise<MembershipRecord | undefined>;
  /** `find` on a caller's open transaction, keeping the row from changing until it ends. */
  findWithin(
    transaction: unknown,
    campaignId: string,
    userId: string,
  ): Promise<MembershipRecord | undefined>;
  listCampaign(
    campaignId: string,
    limit: number,
    cursor?: string,
  ): Promise<readonly MembershipRecord[]>;
  listUser(userId: string, limit: number, cursor?: string): Promise<readonly MembershipRecord[]>;
  remove(input: {
    readonly campaignId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
  }): Promise<Result<MembershipRecord, MembershipMutationError>>;
  changeRole(input: {
    readonly campaignId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly role: 'gm' | 'assistant_gm' | 'player';
  }): Promise<Result<MembershipRecord, MembershipMutationError>>;
  transferOwnership(input: {
    readonly campaignId: string;
    readonly actorUserId: string;
    readonly targetUserId: string;
  }): Promise<
    Result<
      { readonly owner: MembershipRecord; readonly formerOwner: MembershipRecord },
      MembershipMutationError
    >
  >;
}

/**
 * Post-commit integration failure. `detail` is the safe replay key (event name and committed
 * membership version) so the owning integration can retry; it never carries credentials.
 */
export interface MembershipLog {
  integrationDegraded(
    integration: 'audit' | 'revocation',
    campaignId: string,
    userId: string,
    detail: { readonly event: string; readonly membershipVersion: number },
  ): void;
}

function actorOf(
  membership: MembershipRecord | undefined,
  userId: string,
  campaignId: string,
): Result<ActorRef, 'membership_not_found'> {
  if (membership === undefined || membership.removedAt !== null || !isMvpRole(membership.role)) {
    return err('membership_not_found');
  }
  return ok({ userId, campaignId, role: membership.role });
}

export class MembershipService implements ActorResolver {
  constructor(
    private readonly store: MembershipStore,
    private readonly audit: AuditRecorder,
    private readonly revocations: CampaignAccessRevocationPublisher,
    private readonly log: MembershipLog,
  ) {}

  async resolve(
    userId: string,
    campaignId: string,
  ): Promise<Result<ActorRef, 'membership_not_found'>> {
    return actorOf(await this.store.find(campaignId, userId), userId, campaignId);
  }

  /** `resolve` on a caller's open write transaction; see `MembershipStore.findWithin`. */
  async resolveWithin(
    transaction: unknown,
    userId: string,
    campaignId: string,
  ): Promise<Result<ActorRef, 'membership_not_found'>> {
    return actorOf(
      await this.store.findWithin(transaction, campaignId, userId),
      userId,
      campaignId,
    );
  }

  /**
   * Whether `userId` has (or had) a membership in `campaignId`. Removed memberships still
   * resolve, so their audit history stays addressable; a user who never belonged does not.
   */
  async historyFact(
    campaignId: string,
    userId: string,
  ): Promise<MembershipHistoryFact | undefined> {
    const membership = await this.store.find(campaignId, userId);
    return membership === undefined
      ? undefined
      : {
          campaignId: membership.campaignId,
          userId: membership.userId,
          version: membership.version,
          removed: membership.removedAt !== null,
        };
  }

  async listCampaign(
    actorUserId: string,
    campaignId: string,
    input: { readonly limit?: number; readonly cursor?: string },
  ): Promise<Result<MembershipPage, 'not_found_or_forbidden'>> {
    if (!(await this.resolve(actorUserId, campaignId)).ok) return err('not_found_or_forbidden');
    const limit = input.limit ?? 50;
    if (!validCursor(input.cursor)) return ok({ items: [] });
    const rows = await this.store.listCampaign(campaignId, limit + 1, input.cursor);
    return ok(page(rows, limit));
  }

  async listUser(
    userId: string,
    input: { readonly limit?: number; readonly cursor?: string },
  ): Promise<MembershipPage> {
    const limit = input.limit ?? 50;
    if (!validCursor(input.cursor)) return { items: [] };
    return page(await this.store.listUser(userId, limit + 1, input.cursor), limit);
  }

  async listCampaignIds(userId: string): Promise<readonly string[]> {
    return (await this.store.listUser(userId, 10_000))
      .filter(activeMvp)
      .map((row) => row.campaignId);
  }

  async remove(
    actorUserId: string,
    campaignId: string,
    targetUserId: string,
  ): Promise<Result<void, MembershipMutationError>> {
    const actor = await this.store.find(campaignId, actorUserId);
    const target = await this.store.find(campaignId, targetUserId);
    if (!activeMvp(actor) || !activeMvp(target)) return err('not_found_or_forbidden');
    const decision = decideRemoval(actor.role, target.role, actorUserId === targetUserId);
    if (!decision.allowed) {
      return err(
        decision.reason === 'owner_cannot_be_removed'
          ? 'owner_cannot_be_removed'
          : 'not_found_or_forbidden',
      );
    }
    const removed = await this.store.remove({ campaignId, actorUserId, targetUserId });
    if (!removed.ok) return removed;
    await this.afterMutation(actor, removed.value, 'membership.removed', 'removed');
    return ok(undefined);
  }

  async changeRole(
    actorUserId: string,
    campaignId: string,
    targetUserId: string,
    role: Role,
  ): Promise<Result<MembershipView, MembershipMutationError>> {
    if (!isInvitationRole(role)) return err('invalid_role');
    const actor = await this.store.find(campaignId, actorUserId);
    const target = await this.store.find(campaignId, targetUserId);
    if (!activeMvp(actor) || !activeMvp(target)) return err('not_found_or_forbidden');
    if (!decideRoleChange(actor.role, target.role).allowed) return err('not_found_or_forbidden');
    const changed = await this.store.changeRole({ campaignId, actorUserId, targetUserId, role });
    if (!changed.ok) return changed;
    await this.afterMutation(actor, changed.value, 'membership.role_changed', 'role_changed');
    return ok(toView(changed.value));
  }

  async transferOwnership(
    actorUserId: string,
    campaignId: string,
    targetUserId: string,
  ): Promise<
    Result<
      { readonly owner: MembershipView; readonly formerOwner: MembershipView },
      MembershipMutationError
    >
  > {
    const actor = await this.store.find(campaignId, actorUserId);
    const target = await this.store.find(campaignId, targetUserId);
    if (!activeMvp(actor)) return err('not_found_or_forbidden');
    const decision = decideOwnershipTransfer(
      actor.role,
      activeMvp(target) ? target.role : undefined,
    );
    if (!decision.allowed) return err('not_found_or_forbidden');
    const transferred = await this.store.transferOwnership({
      campaignId,
      actorUserId,
      targetUserId,
    });
    if (!transferred.ok) return transferred;
    await this.afterMutation(
      actor,
      transferred.value.formerOwner,
      'membership.ownership_transferred',
      'ownership_transferred',
    );
    await this.afterMutation(
      actor,
      transferred.value.owner,
      'membership.ownership_transferred',
      'ownership_transferred',
    );
    return ok({
      owner: toView(transferred.value.owner),
      formerOwner: toView(transferred.value.formerOwner),
    });
  }

  private async afterMutation(
    actor: MembershipRecord,
    target: MembershipRecord,
    action: string,
    reason: 'removed' | 'role_changed' | 'ownership_transferred',
  ): Promise<void> {
    try {
      await this.audit.record({
        campaignId: actor.campaignId,
        actor: { userId: actor.userId, campaignId: actor.campaignId, role: actor.role },
        action,
        targetType: 'campaign_membership',
        targetId: target.userId,
        after: { role: target.role, version: target.version, removed: target.removedAt !== null },
        at: new Date().toISOString(),
        private: false,
      });
    } catch {
      this.log.integrationDegraded('audit', actor.campaignId, target.userId, {
        event: action,
        membershipVersion: target.version,
      });
    }
    try {
      await this.revocations.publish({
        campaignId: target.campaignId,
        userId: target.userId,
        membershipVersion: target.version,
        reason,
        committedAt: new Date().toISOString(),
      });
    } catch {
      this.log.integrationDegraded('revocation', actor.campaignId, target.userId, {
        event: reason,
        membershipVersion: target.version,
      });
    }
  }
}

function activeMvp(record: MembershipRecord | undefined): record is MembershipRecord & {
  readonly role: 'owner' | 'gm' | 'assistant_gm' | 'player';
} {
  return record !== undefined && record.removedAt === null && isMvpRole(record.role);
}

function toView(record: MembershipRecord): MembershipView {
  if (!isMvpRole(record.role)) throw new Error('invalid persisted membership role');
  return {
    user: { id: record.userId, username: record.username },
    campaignId: record.campaignId,
    role: record.role,
    version: record.version,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Maps an authoritative row, tombstones included, to the approved client cache shape. */
export function toMembershipCacheRow(record: MembershipRecord): MembershipCacheRow {
  if (!isMvpRole(record.role)) throw new Error('invalid persisted membership role');
  return {
    campaignId: record.campaignId,
    userId: record.userId,
    role: record.role,
    version: record.version,
    updatedAt: record.updatedAt.toISOString(),
    removedAt: record.removedAt === null ? null : record.removedAt.toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cursors are client-supplied; a malformed one yields an empty page, never a database error. */
function validCursor(cursor: string | undefined): boolean {
  if (cursor === undefined) return true;
  const parts = cursor.split(':');
  return parts.length === 2 && parts.every((part) => UUID.test(part));
}

function page(rows: readonly MembershipRecord[], limit: number): MembershipPage {
  const items = rows.slice(0, limit).filter(activeMvp).map(toView);
  const last = items.at(-1);
  return rows.length > limit && last !== undefined
    ? { items, nextCursor: `${last.campaignId}:${last.user.id}` }
    : { items };
}
