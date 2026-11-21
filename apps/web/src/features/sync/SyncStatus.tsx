import type { MutationConflict, SyncStatus } from '@rpg/sync';

/** Never "Synchronized" while work is pending, failed, unresolved, or the first sync is running. */
export function syncStatusLabel(status: SyncStatus): string {
  if (status.state === 'error') {
    const unresolved = status.unresolvedConflicts ?? 0;
    return `Sync error — ${status.pendingCount} pending${unresolved > 0 ? `, ${unresolved} unresolved` : ''}`;
  }
  if (status.state === 'offline') return `Offline — ${status.pendingCount} pending`;
  if (status.state === 'pending') return `${status.pendingCount} pending`;
  if (status.state === 'synchronizing') {
    return `Synchronizing — ${Math.round((status.initialSyncProgress ?? 0) * 100)}%`;
  }
  return 'Synchronized';
}

export function SyncStatusIndicator(props: { readonly status: SyncStatus }) {
  return (
    <output
      aria-live="polite"
      data-sync-state={props.status.state}
      data-pending-count={props.status.pendingCount}
    >
      {syncStatusLabel(props.status)}
      {props.status.initialSyncProgress !== undefined && (
        <progress value={props.status.initialSyncProgress} max={1}>
          {Math.round(props.status.initialSyncProgress * 100)}%
        </progress>
      )}
    </output>
  );
}

export function ConflictSurface(props: {
  readonly conflicts: readonly MutationConflict[];
  readonly onDefer: (conflictId: string) => void;
  readonly onKeepAuthority: (conflictId: string) => void;
  readonly onResubmitMine: (conflictId: string) => void;
  readonly onManualMerge?: (conflictId: string) => void;
}) {
  if (props.conflicts.length === 0) return null;
  return (
    <section aria-labelledby="sync-conflicts-title">
      <h2 id="sync-conflicts-title">Unresolved changes</h2>
      {props.conflicts.map((conflict) => (
        <article key={conflict.conflictId}>
          <h3>{conflict.table}</h3>
          <p>
            Your version {conflict.expectedVersion} conflicts with authority version{' '}
            {conflict.actualVersion}.
          </p>
          <details>
            <summary>Compare values</summary>
            <pre>{JSON.stringify(conflict.submittedValue, null, 2)}</pre>
            <pre>{JSON.stringify(conflict.currentValue, null, 2)}</pre>
          </details>
          <button type="button" onClick={() => props.onDefer(conflict.conflictId)}>
            Decide later
          </button>
          <button type="button" onClick={() => props.onKeepAuthority(conflict.conflictId)}>
            Keep authority
          </button>
          <button type="button" onClick={() => props.onResubmitMine(conflict.conflictId)}>
            Resubmit mine
          </button>
          {props.onManualMerge !== undefined && (
            <button type="button" onClick={() => props.onManualMerge?.(conflict.conflictId)}>
              Merge manually
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
