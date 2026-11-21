import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from './infra/postgres/schema.ts';

/**
 * Feature 06 boundary (tasks 01 and 04). Only the two event stores replicate, each through its own
 * stream: `campaign_audit` reads only `audit_campaign_events`, `gm_private_audit` only
 * `audit_private_events`, and neither is subscribed by default (a device subscribes to the private
 * stream only while it holds a GM role). The account store, the sequence allocators, and the repair
 * outbox never reach a stream or the provider publication.
 */

const ROOT = new URL('../../../', import.meta.url);
const auditTables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table).name);

const STREAM_OF: Readonly<Record<string, string>> = {
  audit_campaign_events: 'campaign_audit',
  audit_private_events: 'gm_private_audit',
};

describe('audit sync boundary', () => {
  test('schema exposes every audit table to the check', () => {
    expect(auditTables.sort()).toEqual([
      'audit_account_events',
      'audit_campaign_events',
      'audit_campaign_sequences',
      'audit_private_events',
      'audit_private_sequences',
      'audit_repair_outbox',
    ]);
  });

  test('each event store is read by its own stream only; other audit tables by none', async () => {
    const config = await Bun.file(new URL('infra/powersync/sync-config.yaml', ROOT)).text();
    const streams = (
      Bun.YAML.parse(config) as {
        readonly streams: Record<
          string,
          {
            readonly auto_subscribe?: boolean;
            readonly query?: string;
            readonly queries?: string[];
          }
        >;
      }
    ).streams;
    for (const [name, stream] of Object.entries(streams)) {
      const text = [stream.query ?? '', ...(stream.queries ?? [])].join('\n');
      for (const table of auditTables) {
        const named = new RegExp(`\\b${table}\\b`).test(text);
        expect({ stream: name, table, named }).toEqual({
          stream: name,
          table,
          named: named && STREAM_OF[table] === name,
        });
      }
    }
    for (const stream of Object.values(STREAM_OF)) {
      expect(streams[stream]?.auto_subscribe).toBe(false);
    }
  });

  test('only the two event stores are ever published', async () => {
    const directory = new URL('packages/identity/drizzle/', ROOT);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const statements = (await Bun.file(new URL(file, directory)).text())
        .split('--> statement-breakpoint')
        .map((statement) => statement.replace(/--[^\n]*/g, ''))
        .filter((statement) => /\bPUBLICATION\b/i.test(statement));
      for (const statement of statements) {
        expect(statement).not.toMatch(/FOR\s+ALL\s+TABLES/i);
        for (const table of auditTables.filter((name) => STREAM_OF[name] === undefined)) {
          expect(statement).not.toContain(table);
        }
      }
    }
  });
});
