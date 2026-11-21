import { describe, expect, test } from 'bun:test';
import type { AuditRetentionReport, AuditRetentionRunOptions } from '@rpg/audit';
import { auditRetentionDeleteFromEnv, startAuditRetention } from './retention.ts';

/** Feature 06 retention: deletion is OFF unless an operator explicitly enables it. */
describe('audit retention switch', () => {
  test('only AUDIT_RETENTION_DELETE=true enables deletion', () => {
    expect(auditRetentionDeleteFromEnv({})).toBe(false);
    for (const value of ['', 'false', '0', '1', 'TRUE', 'yes', ' true']) {
      expect(auditRetentionDeleteFromEnv({ AUDIT_RETENTION_DELETE: value })).toBe(false);
    }
    expect(auditRetentionDeleteFromEnv({ AUDIT_RETENTION_DELETE: 'true' })).toBe(true);
  });

  test('the API loop never starts unless delete is true, then runs with delete', async () => {
    const runs: AuditRetentionRunOptions[] = [];
    const executor = {
      run: async (options: AuditRetentionRunOptions = {}) => {
        runs.push(options);
        return { deleted: 0, truncated: false } as unknown as AuditRetentionReport;
      },
    };
    const outcomes: unknown[] = [];
    for (const options of [{}, { delete: false }, { delete: undefined }]) {
      const stop = startAuditRetention(executor, { ...options, intervalMs: 5 }, (outcome) =>
        outcomes.push(outcome),
      );
      await Bun.sleep(30);
      stop();
    }
    expect(runs).toEqual([]);
    const stop = startAuditRetention(
      executor,
      { delete: true, intervalMs: 5, batchSize: 10 },
      (outcome) => outcomes.push(outcome),
    );
    await Bun.sleep(40);
    stop();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toEqual({ delete: true, batchSize: 10 });
    expect(outcomes.length).toBe(runs.length);
  });

  test('a failed pass is reported and does not stop the loop', async () => {
    let calls = 0;
    const outcomes: unknown[] = [];
    const stop = startAuditRetention(
      {
        run: async () => {
          calls += 1;
          throw new Error('database down');
        },
      },
      { delete: true, intervalMs: 5 },
      (outcome) => outcomes.push(outcome),
    );
    await Bun.sleep(40);
    stop();
    expect(calls).toBeGreaterThan(1);
    expect(outcomes.every((outcome) => outcome === 'failed')).toBe(true);
  });
});
