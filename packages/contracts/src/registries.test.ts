import { describe, expect, test } from 'bun:test';
import {
  type ExportableModule,
  type ExportChunk,
  type ImportableModule,
  ImportCode,
  type ImportContext,
  type ImportPlanContribution,
  type ImportResult,
  type ImportTransaction,
  ImportWarning,
} from './registries.ts';
import { err, ok, type Result } from './result.ts';
import { check } from './validate.ts';

/**
 * Ratified 2026-10-28: `00-platform-foundation/2026-10-27-transaction-aware-import-contract-change.md`.
 * Compile-time conformance (the object literals below must type-check) plus runtime validation of
 * the one serializable shape, `ImportWarning`.
 */

const sourceId = '11111111-1111-4111-8111-111111111111';
const campaignId = '22222222-2222-4222-8222-222222222222';

describe('transaction-aware import contract', () => {
  test('an object literal implements ImportableModule without any persistence type', async () => {
    const restored: unknown[] = [];
    const module: ImportableModule = {
      moduleId: 'notes',
      importChunkVersions: ['1'],
      validate: async (chunk): Promise<Result<ImportPlanContribution, string>> =>
        chunk.chunkVersion === '1'
          ? ok({ defines: [{ kind: 'note', sourceId }], warnings: [] })
          : err('notes_chunk_invalid'),
      restore: async (chunk, context): Promise<Result<ImportResult, string>> => {
        restored.push([chunk.payload, context.mapId('note', sourceId), context.transaction]);
        return ok({
          restoredCount: 1,
          warnings: [{ code: 'visibility_narrowed_to_gm_only', sourceId }],
        });
      },
    };
    const transaction: ImportTransaction = { brand: 'ImportTransaction' };
    const context: ImportContext = {
      campaignId,
      importerUserId: sourceId,
      mapId: (kind) => (kind === 'note' ? campaignId : undefined),
      transaction,
    };
    const chunk: ExportChunk = { moduleId: 'notes', chunkVersion: '1', payload: {} };
    expect((await module.validate(chunk)).ok).toBe(true);
    expect(await module.restore(chunk, context)).toEqual({
      ok: true,
      value: { restoredCount: 1, warnings: [{ code: 'visibility_narrowed_to_gm_only', sourceId }] },
    });
    expect(restored).toEqual([[{}, campaignId, transaction]]);
  });

  test('the frozen ExportableModule is unchanged and may implement both surfaces', () => {
    const frozen: ExportableModule = {
      moduleId: 'legacy',
      export: async () => ({ moduleId: 'legacy', chunkVersion: '1', payload: null }),
      import: async () => err('legacy_import_unsupported'),
    };
    const both: ExportableModule & ImportableModule = {
      ...frozen,
      importChunkVersions: ['1'],
      validate: async () => ok({ defines: [], warnings: [] }),
      restore: async () => ok({ restoredCount: 0, warnings: [] }),
    };
    expect(Object.keys(frozen).sort()).toEqual(['export', 'import', 'moduleId']);
    expect(both.moduleId).toBe('legacy');
  });

  test('ImportWarning accepts safe codes and rejects hostile ones', () => {
    for (const valid of [
      { code: 'visibility_narrowed_to_gm_only', sourceId },
      { code: 'attachment_binary_not_restored', count: 3 },
      { code: 'a' },
    ]) {
      expect(check(ImportWarning, valid)).toBe(true);
    }
    for (const hostile of [
      { code: '<script>alert(1)</script>' },
      { code: 'Visibility' },
      { code: '1_starts_with_digit' },
      { code: 'has space' },
      { code: 'x'.repeat(65) },
      { code: '' },
      { code: 'ok', sourceId: 'not-an-id' },
      { code: 'ok', count: 0 },
      { code: 'ok', count: 1.5 },
      { code: 'ok', payload: 'secret' },
    ]) {
      expect(check(ImportWarning, hostile)).toBe(false);
    }
    expect(check(ImportCode, 'contributor_not_transactional')).toBe(true);
    expect(check(ImportCode, 'drop table')).toBe(false);
  });
});
