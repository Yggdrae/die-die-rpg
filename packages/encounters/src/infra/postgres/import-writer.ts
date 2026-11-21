import { err, ok, type Result } from '@rpg/contracts';
import type { EncounterRestorePlan } from '../../contributors.ts';
import type { EncountersTransaction, PostgresEncounterRepository } from './repository.ts';

export const ENCOUNTER_RESTORE_CONFLICT = 'encounter_restore_conflict';

/** Restores a remapped chunk on the import transaction; every row belongs to the importer. */
export class PostgresEncounterImportWriter {
  constructor(private readonly encounters: PostgresEncounterRepository) {}

  async restoreWithin(handle: unknown, plan: EncounterRestorePlan): Promise<Result<void, string>> {
    const transaction = handle as EncountersTransaction;
    for (const row of plan.encounters) {
      const inserted = await this.encounters.insertEncounter(transaction, {
        id: row.id,
        campaignId: plan.campaignId,
        ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
        name: row.name,
        status: row.status,
        startedAt: row.startedAt,
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
        environment: row.environment,
        ...(row.locationId === undefined ? {} : { locationId: row.locationId }),
        actorUserId: plan.actorUserId,
      });
      if (inserted === undefined) return err(ENCOUNTER_RESTORE_CONFLICT);
      if (row.notes !== undefined) {
        const note = await this.encounters.insertNote(transaction, {
          id: row.id,
          campaignId: plan.campaignId,
          body: row.notes,
          actorUserId: plan.actorUserId,
        });
        if (note === undefined) return err(ENCOUNTER_RESTORE_CONFLICT);
      }
    }
    for (const row of plan.participants) {
      const inserted = await this.encounters.insertParticipant(transaction, {
        id: row.id,
        campaignId: plan.campaignId,
        encounterId: row.encounterId,
        label: row.label,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        position: row.position,
        conditions: row.conditions,
        visibilityMode: row.hidden ? 'gm_only' : 'everyone',
        ...(row.state === undefined ? {} : { state: row.state }),
        actorUserId: plan.actorUserId,
      });
      if (inserted === undefined) return err(ENCOUNTER_RESTORE_CONFLICT);
    }
    return ok(undefined);
  }
}
