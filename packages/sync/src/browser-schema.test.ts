import { describe, expect, test } from 'bun:test';
import { replicaSchema } from './browser.ts';

/** Feature 16 task 04: feature-owned replica tables join the browser schema through `tables`. */
describe('replica schema with feature tables', () => {
  const tables = {
    fixture_records: {
      columns: { campaign_id: 'text', name: 'text', version: 'integer' },
      indexes: { campaign: ['campaign_id'] },
    },
  } as const;

  const names = (schema: ReturnType<typeof replicaSchema>) =>
    schema.tables.map((table) => table.name);

  test('feature tables are added beside the platform tables, in every audit variant', () => {
    for (const privateAudit of [false, true]) {
      const schema = replicaSchema({ privateAudit, tables });
      expect(names(schema)).toContain('fixture_records');
      expect(names(schema)).toContain('campaigns');
      expect(names(schema).includes('audit_private_events')).toBe(privateAudit);
      const table = schema.tables.find((item) => item.name === 'fixture_records');
      expect(table?.columns.map((column) => [column.name, column.type])).toEqual([
        ['campaign_id', 'TEXT'],
        ['name', 'TEXT'],
        ['version', 'INTEGER'],
      ]);
      expect(table?.indexes.map((index) => index.name)).toEqual(['campaign']);
    }
    expect(names(replicaSchema({ privateAudit: false }))).not.toContain('fixture_records');
  });

  test('a feature table cannot replace a platform table', () => {
    for (const name of ['campaigns', 'sync_pending_mutations', 'audit_private_events']) {
      let message = '';
      try {
        replicaSchema({ privateAudit: false, tables: { [name]: { columns: { a: 'text' } } } });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(`replica table name reserved: ${name}`);
    }
  });
});
