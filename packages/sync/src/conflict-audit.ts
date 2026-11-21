/**
 * Feature 03's audit contribution: a conflict resolved by a user choice (`resubmit` or `manual`)
 * is recorded with its resolution mutation (`SqliteReplicaStore.resolveConflict`). Structural
 * shape of feature 06's `AuditEventDeclaration` (this package does not depend on `@rpg/audit`).
 */
export const SYNC_AUDIT_ACTIONS = { conflictResolved: 'sync.conflict_resolved' } as const;

const CHOICES: Readonly<Record<string, string>> = {
  resubmit: 'resubmitted the offline value',
  manual: 'entered a new value',
};

export const SYNC_AUDIT_DECLARATIONS = [
  {
    action: SYNC_AUDIT_ACTIONS.conflictResolved,
    version: 1,
    render: (event: { readonly after?: Record<string, unknown> }): { readonly text: string } => {
      const choice =
        typeof event.after?.choice === 'string' ? CHOICES[event.after.choice] : undefined;
      return {
        text:
          choice === undefined
            ? 'Resolved a synchronization conflict.'
            : `Resolved a synchronization conflict: ${choice}.`,
      };
    },
  },
] as const;
