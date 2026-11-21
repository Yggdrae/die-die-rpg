import {
  err,
  type RepositoryError,
  type Result,
  type SyncedRepository,
  type Visibility,
} from '@rpg/contracts';
import type { ResolvedPlan } from './engine/planner.ts';
import { projectTargetState, type TargetState } from './engine/state.ts';
import {
  checkEffectRecord,
  EFFECT_RECORD_TYPE,
  type EffectRecord,
  type EffectRecordDefect,
  effectDisplayName,
} from './records.ts';

/**
 * Feature 11 published device API (FR-011, FR-013, consumed by features 15, 18, 19). One local write: the
 * record and its queue entry commit together, so a plan is applied whole or not at all on the device. The
 * target's displayed state is `displayedState` (D-11), so this feature never writes the owner's replica.
 *
 * The record id is generated before queueing, and that id is the idempotency key (FR-012).
 */

export interface EffectTargetRef {
  readonly targetClass: string;
  readonly targetId: string;
  /** The target's Visibility as the device knows it; the authority replaces it (D-16). */
  readonly visibility: Visibility;
}

export type LocalEffectError =
  | { readonly code: 'nothing_to_apply' }
  | { readonly code: 'invalid_record'; readonly defect: EffectRecordDefect }
  | { readonly code: 'storage'; readonly failure: RepositoryError };

export class EffectLocalRepository {
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    private readonly records: SyncedRepository<EffectRecord>,
    private readonly actor: { readonly userId: string; readonly campaignId: string },
    options: { readonly clock?: () => Date; readonly createId?: () => string } = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** A resolved plan with only follow-ups has nothing to record: run the follow-ups instead. */
  async apply(
    target: EffectTargetRef,
    plan: ResolvedPlan,
    context: { readonly rollId?: string; readonly sessionId?: string } = {},
  ): Promise<Result<EffectRecord, LocalEffectError>> {
    if (plan.operations.length === 0) return err({ code: 'nothing_to_apply' });
    const now = this.#clock().toISOString();
    const record: EffectRecord = {
      id: this.#createId(),
      campaignId: this.actor.campaignId,
      type: EFFECT_RECORD_TYPE,
      name: effectDisplayName(plan.action),
      tags: [],
      metadata: {},
      visibility: target.visibility,
      version: 1,
      createdAt: now,
      createdBy: this.actor.userId,
      updatedAt: now,
      updatedBy: this.actor.userId,
      actorUserId: this.actor.userId,
      targetClass: target.targetClass,
      targetId: target.targetId,
      ...(plan.action === undefined ? {} : { action: plan.action }),
      ...(plan.outcome === undefined ? {} : { outcome: plan.outcome }),
      ...(context.rollId === undefined ? {} : { rollId: context.rollId }),
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      operations: plan.operations,
      changes: [],
      edited: plan.edited,
      appliedAt: now,
    };
    const defect = checkEffectRecord(record);
    if (defect !== undefined) return err({ code: 'invalid_record', defect });
    const stored = await this.records.upsert(record, null);
    return stored.ok ? stored : err({ code: 'storage', failure: stored.error });
  }

  async get(id: string): Promise<EffectRecord | undefined> {
    const found = await this.records.get(id);
    return found.ok ? found.value : undefined;
  }

  /** What this replica holds, oldest first (the session log). Only what the device may read. */
  async list(filter: { readonly sessionId?: string } = {}): Promise<EffectRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return listed.value
      .filter((record) => filter.sessionId === undefined || record.sessionId === filter.sessionId)
      .sort(
        (left, right) =>
          left.appliedAt.localeCompare(right.appliedAt) || left.id.localeCompare(right.id),
      );
  }

  /**
   * The target as a person should see it: `base` from the owner's replica, plus what this device applied
   * and the authority has not accepted. A rejected record is passed in `excluded`, so it stops counting.
   */
  async displayedState(
    target: Pick<EffectTargetRef, 'targetClass' | 'targetId'>,
    base: TargetState,
    excluded: ReadonlySet<string> = new Set(),
  ): Promise<TargetState> {
    const records = await this.list();
    return projectTargetState(
      base,
      records.filter(
        (record) =>
          record.targetClass === target.targetClass &&
          record.targetId === target.targetId &&
          record.acceptedAt === undefined &&
          !excluded.has(record.id),
      ),
    );
  }
}
