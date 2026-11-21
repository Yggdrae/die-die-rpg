import { describe, expect, test } from 'bun:test';
import { SyncStatusStore } from '@rpg/sync';
import { syncStatusLabel } from './SyncStatus.tsx';

// Feature 03 BDD "The user can tell what state synchronization is in" and "Pending work is
// visible before a session ends".
describe('sync status', () => {
  test('never calls pending or failed work synchronized', () => {
    expect(syncStatusLabel({ state: 'pending', connected: true, pendingCount: 2 })).toBe(
      '2 pending',
    );
    expect(syncStatusLabel({ state: 'offline', connected: false, pendingCount: 2 })).toBe(
      'Offline — 2 pending',
    );
    expect(
      syncStatusLabel({
        state: 'error',
        connected: true,
        pendingCount: 2,
        errorCode: 'upload_rejected',
      }),
    ).toBe('Sync error — 2 pending');
    expect(
      syncStatusLabel({
        state: 'error',
        connected: true,
        pendingCount: 1,
        unresolvedConflicts: 1,
        errorCode: 'unresolved_conflicts',
      }),
    ).toBe('Sync error — 1 pending, 1 unresolved');
  });

  test('reports initial synchronization progress instead of synchronized', () => {
    expect(
      syncStatusLabel({
        state: 'synchronizing',
        connected: true,
        pendingCount: 0,
        initialSyncProgress: 0.4,
      }),
    ).toBe('Synchronizing — 40%');
  });

  test('uses synchronized only for a connected empty healthy queue', () => {
    expect(syncStatusLabel({ state: 'synchronized', connected: true, pendingCount: 0 })).toBe(
      'Synchronized',
    );
  });

  test('the status store reports synchronized only when nothing else applies', () => {
    const store = new SyncStatusStore();
    store.setInitialSyncProgress(0.5);
    expect(store.snapshot().state).toBe('synchronizing');
    store.synchronized('2026-10-26T00:00:00Z');
    expect(store.snapshot().state).toBe('synchronized');
    store.setPendingCount(1);
    expect(store.snapshot().state).toBe('pending');
    store.setConnected(false);
    expect(store.snapshot()).toMatchObject({ state: 'offline', pendingCount: 1 });
    store.setConnected(true);
    store.fail('upload_failed');
    expect(store.snapshot()).toMatchObject({ state: 'error', pendingCount: 1 });
    store.clearError();
    store.setPendingCount(0);
    store.setUnresolvedConflicts(1);
    expect(store.snapshot()).toMatchObject({
      state: 'error',
      errorCode: 'unresolved_conflicts',
      unresolvedConflicts: 1,
    });
    store.setUnresolvedConflicts(0);
    expect(store.snapshot().state).toBe('synchronized');
  });
});
