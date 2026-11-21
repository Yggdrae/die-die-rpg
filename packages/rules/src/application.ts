import type { Capability, Decision, ResourceFacts } from '@rpg/authorization';
import type { ActorRef } from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';
import type { PostgresRulesMarkRepository, RulesTransaction } from './infra/postgres/repository.ts';
import { rulesMarkFacts } from './policies.ts';
import {
  isValidRulesMark,
  type MarkFacts,
  mergeMarks,
  type RulesMarkRecord,
  rulesMarkId,
} from './records.ts';

/**
 * Feature 14 authority (`_techspec.md` "Authority"). A mark is the actor's own (Ownership Rule, re-decided through
 * feature 04), at its derived ID, for a section the campaign's pinned package declares. An insert of an existing row
 * and an update at any version merge (D-09), so the answer is never a conflict. Marks are not audited (D-10).
 */

export interface RulesMarkDecider {
  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): Decision;
}

/** The campaign's pinned package, validated (feature 02's pin through the registry). */
export type RulesPinnedSystem = (campaignId: string) => Promise<SystemPackage | undefined>;

export interface RulesMarkWriteOptions {
  /** The platform's access fence, inside the write transaction. */
  readonly fence?: (transaction: RulesTransaction) => Promise<void>;
}

export type RulesMarkWriteResult =
  | { readonly ok: true; readonly record: RulesMarkRecord }
  | { readonly ok: false; readonly code: 'invalid_rules_mark' | 'not_found_or_forbidden' };

const HIDDEN = { ok: false, code: 'not_found_or_forbidden' } as const;
const INVALID = { ok: false, code: 'invalid_rules_mark' } as const;
const CLOCK_SKEW_MS = 5 * 60_000;

function notFuture(at: string | undefined): boolean {
  return at === undefined || Date.parse(at) <= Date.now() + CLOCK_SKEW_MS;
}

function factsOf(record: MarkFacts): MarkFacts {
  return {
    bookmarked: record.bookmarked,
    ...(record.bookmarkChangedAt === undefined
      ? {}
      : { bookmarkChangedAt: record.bookmarkChangedAt }),
    ...(record.viewedAt === undefined ? {} : { viewedAt: record.viewedAt }),
  };
}

function sameFacts(left: MarkFacts, right: MarkFacts): boolean {
  return (
    left.bookmarked === right.bookmarked &&
    left.bookmarkChangedAt === right.bookmarkChangedAt &&
    left.viewedAt === right.viewedAt
  );
}

export class RulesMarkService {
  constructor(
    private readonly deps: {
      readonly marks: PostgresRulesMarkRepository;
      readonly decider: RulesMarkDecider;
      readonly system: RulesPinnedSystem;
    },
  ) {}

  /** Insert or merge one mark (FR-005, FR-006). */
  async save(
    actor: ActorRef,
    candidate: unknown,
    options: RulesMarkWriteOptions = {},
  ): Promise<RulesMarkWriteResult> {
    if (!isValidRulesMark(candidate)) return INVALID;
    const mark = candidate;
    if (
      mark.campaignId !== actor.campaignId ||
      mark.deletedAt !== undefined ||
      !notFuture(mark.bookmarkChangedAt) ||
      !notFuture(mark.viewedAt)
    ) {
      return INVALID;
    }
    if (mark.userId !== actor.userId) return HIDDEN;
    if (mark.id !== (await rulesMarkId(mark.campaignId, mark.userId, mark.sectionId))) {
      return INVALID;
    }
    const system = await this.deps.system(mark.campaignId);
    if (system?.rules.sections.some((section) => section.id === mark.sectionId) !== true) {
      return INVALID;
    }
    const { marks, decider } = this.deps;
    return marks.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const read = { executor: transaction, lock: true };
      let stored = await marks.getMark(mark.campaignId, mark.id, read);
      const capability = stored === undefined ? 'create' : 'update';
      if (!decider.decide(actor, capability, rulesMarkFacts(stored ?? mark)).allowed) return HIDDEN;
      if (stored === undefined) {
        const inserted = await marks.insertMark(transaction, {
          id: mark.id,
          campaignId: mark.campaignId,
          userId: mark.userId,
          sectionId: mark.sectionId,
          facts: factsOf(mark),
        });
        if (inserted !== undefined) return { ok: true as const, record: inserted };
        // A concurrent first write of the same row: merge into it.
        stored = await marks.getMark(mark.campaignId, mark.id, read);
      }
      if (stored === undefined || stored.userId !== actor.userId) return HIDDEN;
      const merged = mergeMarks(factsOf(stored), factsOf(mark));
      if (sameFacts(merged, factsOf(stored))) return { ok: true as const, record: stored };
      const updated = await marks.updateMark(transaction, {
        campaignId: stored.campaignId,
        id: stored.id,
        facts: merged,
        actorUserId: actor.userId,
      });
      return updated === undefined ? HIDDEN : { ok: true as const, record: updated };
    });
  }
}
