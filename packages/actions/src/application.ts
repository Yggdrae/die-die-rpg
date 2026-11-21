import type { ResourceFacts } from '@rpg/authorization';
import type { ActorRef, Visibility } from '@rpg/contracts';
import { applyPlannedOperations, type StateChange, type TargetState } from './engine/state.ts';
import type { ActionsTransaction, PostgresEffectRepository } from './infra/postgres/repository.ts';
import {
  EFFECT_APPLICATION_CLASS,
  EFFECT_OVERRIDE_CAPABILITY,
  type EffectDecider,
  effectFacts,
} from './policies.ts';
import { checkEffectRecord, type EffectRecord, type EffectRecordDefect } from './records.ts';

/**
 * Feature 11 authority service (`_techspec.md` "Mutation Applier"). One transaction: the access fence, the
 * identity claim, the target's locked row, the operations, the target's save, the record's authority
 * half, and the audit event. Any refusal after the claim rolls all of it back (FR-007), and a resend of
 * the same identity finds the record and changes nothing (FR-012).
 */

/**
 * What a target's owner supplies (D-12). Feature 11 owns what operations mean; an adapter only reads and
 * writes its own row, on the transaction it is handed. All features share one database, as the long-text
 * hold check already relies on.
 */
export interface EffectTargetAdapter {
  readonly targetClass: string;
  /** Locks the row (`FOR UPDATE`). `undefined` for missing, foreign, or tombstoned. */
  load(
    transaction: ActionsTransaction,
    target: { readonly campaignId: string; readonly targetId: string },
  ): Promise<{ readonly state: TargetState; readonly facts: ResourceFacts } | undefined>;
  save(
    transaction: ActionsTransaction,
    target: {
      readonly campaignId: string;
      readonly targetId: string;
      readonly state: TargetState;
      readonly actorUserId: string;
    },
  ): Promise<void>;
  /** Paths this actor may not touch, such as a field the schema locks (the owner's rule). */
  deniedPaths?(actor: ActorRef, paths: readonly string[], facts: ResourceFacts): readonly string[];
  /** Paths whose values are GM-only, which narrows the record to `gm_only` (D-16). */
  hiddenPaths?(paths: readonly string[], facts: ResourceFacts): readonly string[];
  /** The owner re-applies declared bounds (`clampTargetState`) after any device's operations. */
  constrain?(state: TargetState, facts: ResourceFacts): TargetState;
}

/**
 * Feature 06 `DurableAuditRecorder.recordWithin`, structurally. The origin is the application's own id,
 * not the mutation's, so a resend under a new mutation can never record a second event (FR-012).
 */
export interface EffectAuditRecorder {
  recordWithin(
    executor: ActionsTransaction,
    submission: {
      readonly event: {
        readonly campaignId: string;
        readonly actor: ActorRef;
        readonly action: string;
        readonly targetType: string;
        readonly targetId: string;
        readonly before: Record<string, unknown>;
        readonly after: Record<string, unknown>;
        readonly at: string;
        readonly private: boolean;
        readonly sessionId?: string;
      };
      readonly originMutationId: string;
      readonly targetVisibility: { readonly visibility: Visibility };
    },
  ): Promise<unknown>;
}

/** The feature 03 access fence: a role lost during the upload aborts the write. */
export type EffectFence = (transaction: ActionsTransaction) => Promise<void>;

export const EFFECT_APPLIED_ACTION = 'effect.applied';

export type EffectWriteFailureCode =
  | 'invalid_effect'
  | 'unknown_target'
  | 'target_changed'
  | 'not_found_or_forbidden';

export type EffectWriteResult =
  | { readonly ok: true; readonly record: EffectRecord }
  | {
      readonly ok: false;
      readonly code: EffectWriteFailureCode;
      readonly defect?: EffectRecordDefect | 'invalid_path' | 'invalid_value';
    };

/** Unwinds the transaction, so the claim and any partial write go with it. */
class Refusal extends Error {
  constructor(readonly result: Extract<EffectWriteResult, { ok: false }>) {
    super('effect refused');
  }
}

const HIDDEN: Extract<EffectWriteResult, { ok: false }> = {
  ok: false,
  code: 'not_found_or_forbidden',
};

/** The fields a resend must repeat exactly; what the authority added is not one of them. */
function sameApplication(left: EffectRecord, right: EffectRecord): boolean {
  const comparable = (record: EffectRecord) =>
    JSON.stringify([
      record.campaignId,
      record.actorUserId,
      record.targetClass,
      record.targetId,
      record.action,
      record.outcome,
      record.rollId,
      record.sessionId,
      record.edited,
      record.operations.map(({ operation, requires }) => [
        operation.op,
        operation.path,
        operation.op === 'clamp' ? [operation.min, operation.max] : operation.value,
        requires === undefined
          ? null
          : [
              'atLeast' in requires
                ? ['atLeast', requires.path, requires.atLeast]
                : ['equals', requires.path, requires.equals],
            ],
      ]),
      new Date(record.appliedAt).getTime(),
    ]);
  return comparable(left) === comparable(right);
}

function auditValues(changes: readonly StateChange[], side: 'before' | 'after') {
  return { changes: changes.map((change) => ({ path: change.path, value: change[side] })) };
}

export class EffectApplicationService {
  readonly #adapters: ReadonlyMap<string, EffectTargetAdapter>;

  constructor(
    private readonly deps: {
      readonly applications: PostgresEffectRepository;
      readonly decider: EffectDecider;
      readonly targets: readonly EffectTargetAdapter[];
      readonly audit?: EffectAuditRecorder;
    },
  ) {
    this.#adapters = new Map(deps.targets.map((adapter) => [adapter.targetClass, adapter]));
  }

  async record(
    actor: ActorRef,
    candidate: unknown,
    options: { readonly fence?: EffectFence } = {},
  ): Promise<EffectWriteResult> {
    const defect = checkEffectRecord(candidate);
    if (defect !== undefined) return { ok: false, code: 'invalid_effect', defect };
    const record = candidate as EffectRecord;
    if (record.campaignId !== actor.campaignId || record.actorUserId !== actor.userId) {
      return { ok: false, code: 'invalid_effect', defect: 'actor_mismatch' };
    }
    const own = effectFacts({
      campaignId: record.campaignId,
      id: record.id,
      visibility: { mode: 'everyone' },
    });
    const { decider, applications } = this.deps;
    if (!decider.decide(actor, 'create', own).allowed) return HIDDEN;
    if (record.edited && !decider.decide(actor, EFFECT_OVERRIDE_CAPABILITY, own).allowed) {
      return HIDDEN;
    }
    const adapter = this.#adapters.get(record.targetClass);
    if (adapter === undefined) return { ok: false, code: 'unknown_target' };
    try {
      return await applications.transaction(async (transaction) => {
        await options.fence?.(transaction);
        if (!(await applications.claim(transaction, record))) {
          const existing = await applications.get(record.campaignId, record.id, {
            executor: transaction,
          });
          // Same identity, same content: the same application, accepted again with no second effect.
          return existing !== undefined && sameApplication(existing, record)
            ? { ok: true as const, record: existing }
            : HIDDEN;
        }
        const target = await adapter.load(transaction, {
          campaignId: record.campaignId,
          targetId: record.targetId,
        });
        if (target === undefined || !decider.decide(actor, 'update', target.facts).allowed) {
          throw new Refusal(HIDDEN);
        }
        const paths = record.operations.map(({ operation }) => operation.path);
        if ((adapter.deniedPaths?.(actor, paths, target.facts) ?? []).length > 0) {
          throw new Refusal(HIDDEN);
        }
        const applied = applyPlannedOperations(target.state, record.operations);
        if (!applied.ok) {
          throw new Refusal(
            applied.error.code === 'target_changed'
              ? { ok: false, code: 'target_changed' }
              : { ok: false, code: 'invalid_effect', defect: applied.error.code },
          );
        }
        const state = adapter.constrain?.(applied.value.state, target.facts) ?? applied.value.state;
        await adapter.save(transaction, {
          campaignId: record.campaignId,
          targetId: record.targetId,
          state,
          actorUserId: actor.userId,
        });
        const visibility: Visibility =
          (adapter.hiddenPaths?.(paths, target.facts) ?? []).length > 0
            ? { mode: 'gm_only' }
            : target.facts.visibility;
        await applications.complete(transaction, record.id, {
          changes: applied.value.changes,
          visibility,
        });
        await this.deps.audit?.recordWithin(transaction, {
          event: {
            campaignId: record.campaignId,
            actor,
            action: EFFECT_APPLIED_ACTION,
            targetType: EFFECT_APPLICATION_CLASS,
            targetId: record.id,
            before: auditValues(applied.value.changes, 'before'),
            after: auditValues(applied.value.changes, 'after'),
            at: record.appliedAt,
            private: false,
            ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
          },
          originMutationId: record.id,
          targetVisibility: { visibility },
        });
        const stored = await applications.get(record.campaignId, record.id, {
          executor: transaction,
        });
        return stored === undefined ? HIDDEN : { ok: true as const, record: stored };
      });
    } catch (error) {
      if (error instanceof Refusal) return error.result;
      throw error;
    }
  }
}
