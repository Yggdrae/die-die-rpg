import { describe, expect, test } from 'bun:test';
import { type ExportableModule, err } from '@rpg/contracts';
import { replicaConsistency, unreplicatedContributor } from './offline.ts';
import { ExportOrchestrator, type RulesContextSource } from './orchestrator.ts';
import { ExportRegistry } from './registry.ts';
import { CAMPAIGN_ID } from './test-fixtures.ts';
import { concatParts } from './zip.ts';

/**
 * Feature 07 task 05 — `_bdd.md` "A synchronized campaign can be exported offline" and `_db.md`
 * "Offline export rejects an incomplete replica". The local contributors here stand in for replica
 * reads; the browser composition and its refusal are exercised in `apps/web`.
 */

const RULES: RulesContextSource = {
  pins: async () => ({ system: { systemId: 'fixture-system', version: '0.1.0' }, modules: [] }),
};
const NOW = () => new Date('2026-10-27T12:00:00.000Z');
const EXPORTER = { exportedBy: { displayName: 'Rowan' } };

function local(moduleId: string, payload: unknown, reads: string[] = []): ExportableModule {
  return {
    moduleId,
    export: async () => {
      reads.push(moduleId);
      return { moduleId, chunkVersion: '1', payload };
    },
    import: async () => err('x'),
  };
}

function registry(reads: string[] = []) {
  return new ExportRegistry()
    .register(local('campaign', { name: 'Ashen Road', settings: {} }, reads), {
      placement: 'campaign',
    })
    .register(
      local(
        'attachments',
        { binaries: 'excluded', entries: [{ attachmentId: 'x', visibility: { mode: 'gm_only' } }] },
        reads,
      ),
      { placement: 'attachments-manifest' },
    );
}

describe('Scenario: A synchronized campaign can be exported offline', () => {
  test('a complete replica at one cursor yields the same package as the online export', async () => {
    const offlineRegistry = registry();
    const offline = await new ExportOrchestrator({
      registry: offlineRegistry,
      rules: RULES,
      applicationVersion: 'test',
      now: NOW,
      consistency: replicaConsistency(offlineRegistry, {
        coverage: async () => ({ cursor: 'cp-42', modules: { campaign: true, attachments: true } }),
      }),
    }).export(CAMPAIGN_ID, EXPORTER);
    const online = await new ExportOrchestrator({
      registry: registry(),
      rules: RULES,
      applicationVersion: 'test',
      now: NOW,
    }).export(CAMPAIGN_ID, EXPORTER);
    expect(offline.ok && online.ok).toBe(true);
    if (!offline.ok || !online.ok) return;
    // Parity: equal logical content gives equal entry checksums and identical archive bytes.
    expect(offline.value.manifest.entries).toEqual(online.value.manifest.entries);
    expect(concatParts(offline.value.parts)).toEqual(concatParts(online.value.parts));
    expect(offline.value.manifest.content.attachmentBinaries).toBe('excluded');
  });
});

describe('Incomplete local data never becomes a silent partial backup', () => {
  test('a module not complete at the cursor refuses the export before any read', async () => {
    const reads: string[] = [];
    const modules = registry(reads);
    const result = await new ExportOrchestrator({
      registry: modules,
      rules: RULES,
      applicationVersion: 'test',
      consistency: replicaConsistency(modules, {
        coverage: async () => ({
          cursor: 'cp-1',
          modules: { campaign: true, attachments: 'attachment_metadata_not_replicated' },
        }),
      }),
    }).export(CAMPAIGN_ID, EXPORTER);
    expect(result).toEqual({
      ok: false,
      error: { code: 'incomplete_replica', incompleteModules: ['attachments'] },
    });
    expect(reads).toEqual([]);
  });

  test('a replica before its first checkpoint, or a module it does not know, is incomplete', async () => {
    const modules = registry();
    const coverages: { cursor: string | undefined; modules: Record<string, true | string> }[] = [
      { cursor: undefined, modules: { campaign: true, attachments: true } },
      { cursor: 'cp-1', modules: { campaign: true } },
    ];
    for (const coverage of coverages) {
      const result = await new ExportOrchestrator({
        registry: modules,
        rules: RULES,
        applicationVersion: 'test',
        consistency: replicaConsistency(modules, { coverage: async () => coverage }),
      }).export(CAMPAIGN_ID, EXPORTER);
      expect(result.ok ? undefined : result.error.code).toBe('incomplete_replica');
    }
  });

  test('a replica that advances during the reads is re-read, never mixed', async () => {
    const cursors = ['cp-1', 'cp-2', 'cp-2', 'cp-2'];
    const reads: string[] = [];
    const modules = registry(reads);
    const result = await new ExportOrchestrator({
      registry: modules,
      rules: RULES,
      applicationVersion: 'test',
      consistency: replicaConsistency(modules, {
        coverage: async () => ({
          cursor: cursors.shift(),
          modules: { campaign: true, attachments: true },
        }),
      }),
    }).export(CAMPAIGN_ID, EXPORTER);
    expect(result.ok).toBe(true);
    expect(reads).toEqual(['attachments', 'campaign', 'attachments', 'campaign']);
  });

  test('an unreplicated P0 contributor is named and never read', async () => {
    const modules = new ExportRegistry()
      .register(local('campaign', {}), { placement: 'campaign' })
      .register(unreplicatedContributor('attachments', 'attachments-manifest').module, {
        placement: 'attachments-manifest',
      });
    const result = await new ExportOrchestrator({
      registry: modules,
      rules: RULES,
      applicationVersion: 'test',
      consistency: replicaConsistency(modules, {
        coverage: async () => ({
          cursor: 'cp-1',
          modules: { campaign: true, attachments: 'attachment_metadata_not_replicated' },
        }),
      }),
    }).export(CAMPAIGN_ID, EXPORTER);
    expect(result).toEqual({
      ok: false,
      error: { code: 'incomplete_replica', incompleteModules: ['attachments'] },
    });
  });

  test('offline packages obey the same forbidden-data rules', async () => {
    const modules = registry().register(local('notes', { items: [{ email: 'a@b.c' }] }), {
      placement: 'documents',
    });
    const result = await new ExportOrchestrator({
      registry: modules,
      rules: RULES,
      applicationVersion: 'test',
      consistency: replicaConsistency(modules, {
        coverage: async () => ({
          cursor: 'cp-1',
          modules: { campaign: true, attachments: true, notes: true },
        }),
      }),
    }).export(CAMPAIGN_ID, EXPORTER);
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_content', moduleId: 'notes', pointer: '/items/0/email' },
    });
  });
});
