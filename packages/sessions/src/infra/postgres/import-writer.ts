import { err, ok, type Result } from '@rpg/contracts';
import type { SessionRestorePlan } from '../../contributors.ts';
import type { PostgresSessionRepository, SessionsTransaction } from './repository.ts';

export const SESSION_RESTORE_CONFLICT = 'session_restore_conflict';

/** Restores a remapped chunk on the import transaction; every row belongs to the importer. */
export class PostgresSessionImportWriter {
  constructor(private readonly sessions: PostgresSessionRepository) {}

  async restoreWithin(handle: unknown, plan: SessionRestorePlan): Promise<Result<void, string>> {
    const transaction = handle as SessionsTransaction;
    for (const row of plan.sessions) {
      const inserted = await this.sessions.insertSession(transaction, {
        id: row.id,
        campaignId: plan.campaignId,
        number: row.number,
        status: row.status,
        startedAt: row.startedAt,
        ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
        ...(row.currentSceneId === undefined ? {} : { currentSceneId: row.currentSceneId }),
        participantUserIds: row.participantUserIds,
        actorUserId: plan.actorUserId,
      });
      if (inserted === undefined) return err(SESSION_RESTORE_CONFLICT);
      if (row.notes !== undefined) {
        const note = await this.sessions.insertNote(transaction, {
          id: row.id,
          campaignId: plan.campaignId,
          body: row.notes,
          actorUserId: plan.actorUserId,
        });
        if (note === undefined) return err(SESSION_RESTORE_CONFLICT);
      }
    }
    for (const row of plan.entries) {
      const inserted = await this.sessions.insertEntry(transaction, {
        id: row.id,
        campaignId: plan.campaignId,
        sessionId: row.sessionId,
        kind: row.kind,
        text: row.text,
        ...(row.subjectId === undefined ? {} : { subjectId: row.subjectId }),
        visibilityMode: row.shown ? 'everyone' : 'gm_only',
        createdAt: row.createdAt,
        actorUserId: plan.actorUserId,
      });
      if (inserted === undefined) return err(SESSION_RESTORE_CONFLICT);
    }
    return ok(undefined);
  }
}
