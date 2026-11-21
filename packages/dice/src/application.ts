import type { ActorRef } from '@rpg/contracts';
import type { DiceTransaction, PostgresRollRepository } from './infra/postgres/repository.ts';
import { mayCreateRoll, type RollDecider } from './policies.ts';
import { checkRollRecord, type RollRecord, type RollRecordDefect } from './records.ts';

/**
 * Feature 09 authority service (`_techspec.md` "Mutation Applier"). It validates the uploaded record,
 * decides through feature 04, and inserts inside one transaction. The hook runs in that transaction
 * after the checks and before the write: it carries the feature 03 access fence, and no audit event,
 * since a roll is not an audit event (D-08).
 */

export type RollFence = (transaction: DiceTransaction) => Promise<void>;

export type RollWriteResult =
  | { readonly ok: true; readonly record: RollRecord }
  | { readonly ok: false; readonly code: 'invalid_roll'; readonly defect: RollRecordDefect }
  /** Denied, or an identity already taken by something else: one indistinguishable answer. */
  | { readonly ok: false; readonly code: 'not_found_or_forbidden' };

const HIDDEN: RollWriteResult = { ok: false, code: 'not_found_or_forbidden' };

/** The fields a resend must repeat exactly; authority time is not one of them. */
function sameRoll(left: RollRecord, right: RollRecord): boolean {
  const comparable = (record: RollRecord) =>
    JSON.stringify([
      record.campaignId,
      record.actorUserId,
      record.actorRef,
      record.targetRef,
      record.action,
      record.sessionId,
      record.expression,
      Object.entries(record.inputs).sort(([a], [b]) => (a < b ? -1 : 1)),
      record.result.natural,
      record.result.modified,
      record.result.terms.map((term) =>
        term.kind === 'dice'
          ? [term.die, term.sign, term.faces.map((face) => [face.value, face.kept])]
          : [term.kind, term.sign, term.value],
      ),
      record.rollVisibility,
      record.visibility,
      new Date(record.rolledAt).getTime(),
    ]);
  return comparable(left) === comparable(right);
}

export class RollService {
  constructor(
    private readonly deps: {
      readonly rolls: PostgresRollRepository;
      readonly decider: RollDecider;
    },
  ) {}

  /**
   * D-10: an existing identity with identical content is the same roll, accepted again without a second
   * row; anything else is refused and changes nothing. The actor comes from the session, never from
   * the record: a record naming someone else is refused.
   */
  async record(
    actor: ActorRef,
    candidate: unknown,
    options: { readonly fence?: RollFence } = {},
  ): Promise<RollWriteResult> {
    const defect = checkRollRecord(candidate);
    if (defect !== undefined) return { ok: false, code: 'invalid_roll', defect };
    const record = candidate as RollRecord;
    if (record.campaignId !== actor.campaignId || record.actorUserId !== actor.userId) {
      return { ok: false, code: 'invalid_roll', defect: 'actor_mismatch' };
    }
    if (!mayCreateRoll(this.deps.decider, actor, record)) return HIDDEN;
    return this.deps.rolls.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const inserted = await this.deps.rolls.insert(transaction, record);
      if (inserted.ok) return { ok: true, record: inserted.record };
      const existing = await this.deps.rolls.get(record.campaignId, record.id, {
        executor: transaction,
      });
      return existing !== undefined && sameRoll(existing, record)
        ? { ok: true, record: existing }
        : HIDDEN;
    });
  }
}
