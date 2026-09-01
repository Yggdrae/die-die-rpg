import { describe, expect, test } from 'bun:test';
import { syncStatusLabel } from './SyncStatus.tsx';

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
  });

  test('uses synchronized only for a connected empty healthy queue', () => {
    expect(syncStatusLabel({ state: 'synchronized', connected: true, pendingCount: 0 })).toBe(
      'Synchronized',
    );
  });
});
