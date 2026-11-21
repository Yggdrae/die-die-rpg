import { err, ok, type Result } from '@rpg/contracts';
import type { DiceImportWriter, DiceRestorePlan } from '../../contributors.ts';
import { ROLL_RECORD_TYPE, rollDisplayName } from '../../records.ts';
import type { DiceTransaction, PostgresRollRepository } from './repository.ts';

/** A restored id already exists (never overwritten). */
export const DICE_RESTORE_CONFLICT = 'dice_restore_conflict';

/**
 * Writes a validated, remapped roll chunk on the caller's executor (the feature 07 import transaction).
 * The rows belong to the importer. A failure returns a safe code, and the caller's coordinator rolls
 * the whole import back.
 */
export class PostgresDiceImportWriter implements DiceImportWriter {
  constructor(private readonly rolls: PostgresRollRepository) {}

  async restoreWithin(handle: unknown, plan: DiceRestorePlan): Promise<Result<void, string>> {
    const { campaignId, actorUserId } = plan;
    for (const roll of plan.rolls) {
      const inserted = await this.rolls.insert(handle as DiceTransaction, {
        id: roll.id,
        campaignId,
        type: ROLL_RECORD_TYPE,
        name: rollDisplayName(roll.action, roll.expression),
        tags: [],
        metadata: {},
        visibility: roll.visibility,
        version: 1,
        createdAt: roll.rolledAt,
        createdBy: actorUserId,
        updatedAt: roll.rolledAt,
        updatedBy: actorUserId,
        actorUserId,
        ...(roll.action === undefined ? {} : { action: roll.action }),
        expression: roll.expression,
        inputs: roll.inputs,
        result: roll.result,
        rollVisibility: roll.rollVisibility,
        rolledAt: roll.rolledAt,
      });
      if (!inserted.ok) return err(DICE_RESTORE_CONFLICT);
    }
    return ok(undefined);
  }
}
