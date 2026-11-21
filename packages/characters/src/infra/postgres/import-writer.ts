import type { TargetState } from '@rpg/actions/engine';
import { err, ok, type Result } from '@rpg/contracts';
import type { CharacterRestorePlan } from '../../contributors.ts';
import type { CharactersTransaction, PostgresCharacterRepository } from './repository.ts';

export const CHARACTER_RESTORE_CONFLICT = 'character_restore_conflict';

/** Restores a remapped chunk on the import transaction; every character belongs to the importer. */
export class PostgresCharacterImportWriter {
  constructor(private readonly characters: PostgresCharacterRepository) {}

  async restoreWithin(handle: unknown, plan: CharacterRestorePlan): Promise<Result<void, string>> {
    for (const row of plan.characters) {
      const inserted = await this.characters.insert(handle as CharactersTransaction, {
        id: row.id,
        campaignId: plan.campaignId,
        ownerUserId: plan.actorUserId,
        system: row.system,
        state: row.state as TargetState,
        secretState: row.secretState as TargetState,
        actorUserId: plan.actorUserId,
      });
      if (inserted === undefined) return err(CHARACTER_RESTORE_CONFLICT);
    }
    return ok(undefined);
  }
}
