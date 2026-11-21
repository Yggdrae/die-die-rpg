/**
 * Feature 16 audit actions, all under the feature 06 contributor prefix `entity` (row `16` of
 * `AUDIT_CONTRIBUTORS`). The declarations (payload schemas and renderers) are in
 * `audit-declarations.ts`; the application services record these actions.
 */
export const CONTENT_AUDIT_ACTIONS = {
  created: 'entity.created',
  updated: 'entity.updated',
  deleted: 'entity.deleted',
  relationshipCreated: 'entity.relationship_created',
  relationshipDeleted: 'entity.relationship_deleted',
  personalNoteCreated: 'entity.personal_note_created',
  personalNoteUpdated: 'entity.personal_note_updated',
  personalNoteDeleted: 'entity.personal_note_deleted',
} as const;
