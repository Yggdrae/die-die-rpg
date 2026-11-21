import { err, ok, type Result } from '@rpg/contracts';
import type { ContentImportWriter, ContentRestorePlan } from '../../contributors.ts';
import type {
  ContentSqlExecutor,
  PostgresEntityRepository,
  PostgresRelationshipRepository,
} from './repository.ts';

/** A restored id already exists, or a live link duplicates another (never overwritten). */
export const CONTENT_RESTORE_CONFLICT = 'content_restore_conflict';

/**
 * Feature 16 task 17: writes a validated, remapped content chunk on the caller's executor (the
 * feature 07 import transaction). Entities first, then tombstones, then relationships, so every
 * composite foreign key resolves and a broken link keeps its deleted endpoint. Rows are created by
 * the importer; versions start at 1 (a restored tombstone is version 2, as a live delete). A
 * failure returns a safe code; the caller's coordinator rolls the whole import back.
 */
export async function restoreContentWithin(
  executor: ContentSqlExecutor,
  repositories: {
    readonly entities: PostgresEntityRepository;
    readonly relationships: PostgresRelationshipRepository;
  },
  plan: ContentRestorePlan,
): Promise<Result<void, string>> {
  const { campaignId, actorUserId } = plan;
  for (const entity of plan.entities) {
    const inserted = await repositories.entities.insert(executor, {
      id: entity.id,
      campaignId,
      type: entity.type,
      name: entity.name,
      summary: entity.summary,
      description: entity.description,
      tags: entity.tags,
      fields: entity.fields,
      metadata: entity.metadata,
      visibility: entity.visibility,
      actorUserId,
    });
    if (!inserted.ok) return err(CONTENT_RESTORE_CONFLICT);
  }
  for (const entity of plan.entities.filter((row) => row.deleted)) {
    const deleted = await repositories.entities.tombstone(executor, {
      campaignId,
      id: entity.id,
      expectedVersion: 1,
      actorUserId,
    });
    if (!deleted.ok) return err(CONTENT_RESTORE_CONFLICT);
  }
  for (const link of plan.relationships) {
    const inserted = await repositories.relationships.insert(executor, {
      id: link.id,
      campaignId,
      sourceEntityId: link.sourceEntityId,
      targetEntityId: link.targetEntityId,
      kind: link.kind,
      visibility: link.visibility,
      actorUserId,
    });
    if (!inserted.ok) return err(CONTENT_RESTORE_CONFLICT);
  }
  return ok(undefined);
}

/** The `ContentImportWriter` the composition root hands to `ContentExporter`. */
export class PostgresContentImportWriter implements ContentImportWriter {
  constructor(
    private readonly repositories: {
      readonly entities: PostgresEntityRepository;
      readonly relationships: PostgresRelationshipRepository;
    },
  ) {}

  restoreWithin(handle: unknown, plan: ContentRestorePlan): Promise<Result<void, string>> {
    return restoreContentWithin(handle as ContentSqlExecutor, this.repositories, plan);
  }
}
