import { describe, expect, test } from 'bun:test';
import {
  type ExportableModule,
  type ExportChunk,
  err,
  type ImportableModule,
  type ImportContext,
  type ImportTransaction,
  ok,
} from '@rpg/contracts';
import { canonicalBytes, sha256Hex } from './canonical.ts';
import { ImportService, MemoryImportStore } from './import-jobs.ts';
import {
  deriveImportId,
  ImportCoordinator,
  type ImportPlan,
  importableOf,
  planImport,
  type RulesAvailability,
} from './importer.ts';
import { type InspectedPackage, inspectPackage } from './inspector.ts';
import { ExportRegistry } from './registry.ts';
import { CAMPAIGN_ID, validPackage } from './test-fixtures.ts';

/**
 * Feature 07 task 06: the write-free planner and the atomic coordinator over an in-memory
 * transaction (`_bdd.md` Validation Before Import, Atomic Import; `_db.md` Atomic Import).
 * PostgreSQL atomicity is proved in `apps/api/src/campaign-import.integration.test.ts`.
 */

const JOB = '00000000-0000-4000-8000-00000000a001';
const USER = '00000000-0000-4000-8000-00000000b001';
const OTHER_USER = '00000000-0000-4000-8000-00000000b002';
const NPC = '00000000-0000-4000-8000-00000000c001';

const ALL_AVAILABLE: RulesAvailability = { unavailable: async () => ({ modules: [] }) };

interface Recorder {
  readonly writes: string[];
  readonly validated: string[];
}

/** A transaction-aware contributor that records writes through the memory transaction. */
function contributor(
  store: MemoryImportStore,
  recorder: Recorder,
  moduleId: string,
  options: {
    readonly versions?: readonly string[];
    readonly validate?: ImportableModule['validate'];
    readonly restore?: (chunk: ExportChunk, context: ImportContext) => unknown;
    readonly defines?: readonly { kind: string; sourceId: string }[];
  } = {},
): ExportableModule & ImportableModule {
  return {
    moduleId,
    importChunkVersions: options.versions ?? ['1', '2'],
    export: async () => ({ moduleId, chunkVersion: '1', payload: {} }),
    import: async () => err('legacy_import_never_called'),
    validate:
      options.validate ??
      (async () => {
        recorder.validated.push(moduleId);
        return ok({ defines: [...(options.defines ?? [])], warnings: [] });
      }),
    restore: async (chunk, context) => {
      if (options.restore !== undefined) {
        return options.restore(chunk, context) as ReturnType<ImportableModule['restore']>;
      }
      store.later(context.transaction, () => recorder.writes.push(moduleId));
      return ok({ restoredCount: 1, warnings: [] });
    },
  };
}

/** The frozen surface only: never restored, always preserved. */
function frozenOnly(moduleId: string): ExportableModule {
  return {
    moduleId,
    export: async () => ({ moduleId, chunkVersion: '1', payload: {} }),
    import: async () => {
      throw new Error('the coordinator must never call the frozen import');
    },
  };
}

async function fixturePackage(): Promise<InspectedPackage> {
  const { bytes } = await validPackage();
  const result = await inspectPackage(bytes);
  if (!result.ok) throw new Error('fixture invalid');
  return result.value;
}

function setup(
  extra: (store: MemoryImportStore, recorder: Recorder, registry: ExportRegistry) => void = (
    store,
    recorder,
    registry,
  ) => {
    registry.register(
      contributor(store, recorder, 'npcs', { defines: [{ kind: 'npc', sourceId: NPC }] }),
      { placement: 'entities' },
    );
  },
) {
  const store = new MemoryImportStore();
  const recorder: Recorder = { writes: [], validated: [] };
  const registry = new ExportRegistry()
    .register(contributor(store, recorder, 'campaign'), { placement: 'campaign' })
    .register(contributor(store, recorder, 'attachments'), { placement: 'attachments-manifest' });
  extra(store, recorder, registry);
  const coordinator = new ImportCoordinator({ transactions: store, store });
  return { store, recorder, registry, coordinator };
}

async function plan(
  registry: ExportRegistry,
  overrides: Partial<Parameters<typeof planImport>[0]> = {},
) {
  return planImport({
    jobId: JOB,
    importerUserId: USER,
    inspected: await fixturePackage(),
    registry,
    rules: ALL_AVAILABLE,
    ...overrides,
  });
}

describe('planImport (write-free)', () => {
  test('plans the root first, contributors in module order, and preserved chunks', async () => {
    const { registry, recorder } = setup();
    const planned = await plan(registry);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.root.chunk.moduleId).toBe('campaign');
    expect(planned.value.restores.map((step) => step.chunk.moduleId)).toEqual([
      'attachments',
      'npcs',
    ]);
    expect(
      planned.value.preserved.map(({ moduleId, chunkVersion, reason }) => [
        moduleId,
        chunkVersion,
        reason,
      ]),
    ).toEqual([['future-thing', '7', 'preserved_from_package']]);
    expect(planned.value.preserved[0]?.checksum).toBe(
      await sha256Hex(canonicalBytes({ opaque: [1, 2, 3] })),
    );
    expect(recorder.validated.sort()).toEqual(['attachments', 'campaign', 'npcs']);
    expect(recorder.writes).toEqual([]);
  });

  test('the id map is deterministic per job, distinct across jobs, and total over defines', async () => {
    const { registry } = setup();
    const first = await plan(registry);
    const again = await plan(registry);
    const otherJob = await plan(registry, { jobId: '00000000-0000-4000-8000-00000000a002' });
    if (!first.ok || !again.ok || !otherJob.ok) throw new Error('plan failed');
    expect(first.value.campaignId).toBe(again.value.campaignId);
    expect(first.value.mapId('npc', NPC)).toBe(again.value.mapId('npc', NPC) as string);
    expect(otherJob.value.campaignId).not.toBe(first.value.campaignId);
    expect(first.value.mapId('campaign', CAMPAIGN_ID)).toBe(first.value.campaignId);
    expect(first.value.campaignId).not.toBe(CAMPAIGN_ID);
    expect(first.value.mapId('npc', OTHER_USER)).toBeUndefined();
    // Members are never imported: no mapping without an approved one.
    expect(first.value.mapId('member', OTHER_USER)).toBeUndefined();
    expect(await deriveImportId(JOB, 'npc', NPC)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test('an approved member mapping may only target the importer', async () => {
    const { registry } = setup();
    const approved = await plan(registry, { memberMapping: new Map([[OTHER_USER, USER]]) });
    expect(approved.ok && approved.value.mapId('member', OTHER_USER)).toBe(USER);
    const widened = await plan(registry, { memberMapping: new Map([[USER, OTHER_USER]]) });
    expect(widened).toEqual({ ok: false, error: { code: 'member_mapping_invalid' } });
  });

  test('Scenario: An unavailable pinned system blocks before write', async () => {
    const { registry, recorder } = setup();
    const system = await plan(registry, {
      rules: { unavailable: async (lock) => ({ system: lock, modules: [] }) },
    });
    expect(system).toEqual({
      ok: false,
      error: {
        code: 'system_unavailable',
        unavailable: { system: { systemId: 'fixture-system', version: '1.0.0' } },
      },
    });
    const modules = await plan(registry, {
      rules: { unavailable: async (_system, lock) => ({ modules: lock.modules }) },
    });
    expect(modules).toEqual({
      ok: false,
      error: {
        code: 'module_unavailable',
        unavailable: { modules: [{ moduleId: 'fixture-module', version: '1.0.0' }] },
      },
    });
    // Rejected before any contributor validated, let alone wrote.
    expect(recorder.validated).toEqual([]);
  });

  test('chunks without a transaction-aware contributor are preserved and reported, never restored', async () => {
    const { registry } = setup((store, recorder, registry) => {
      registry.register(frozenOnly('npcs'), { placement: 'entities' });
      void store;
      void recorder;
    });
    const planned = await plan(registry);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.restores.map((step) => step.chunk.moduleId)).toEqual(['attachments']);
    expect(planned.value.preserved.map((chunk) => [chunk.moduleId, chunk.reason])).toEqual([
      ['future-thing', 'preserved_from_package'],
      ['npcs', 'contributor_not_transactional'],
    ]);

    const unknown = setup(() => undefined);
    const unknownPlan = await plan(unknown.registry);
    expect(unknownPlan.ok && unknownPlan.value.preserved.map((chunk) => chunk.reason)).toEqual([
      'preserved_from_package',
      'unknown_module',
    ]);

    const versioned = setup((store, recorder, registry) => {
      registry.register(contributor(store, recorder, 'npcs', { versions: ['1'] }), {
        placement: 'entities',
      });
    });
    const versionPlan = await plan(versioned.registry);
    expect(versionPlan.ok && versionPlan.value.preserved.map((chunk) => chunk.reason)).toEqual([
      'preserved_from_package',
      'chunk_version_unsupported',
    ]);
    // A separate `importer` registration is used in place of the module itself.
    const separate = setup((store, recorder, registry) => {
      registry.register(frozenOnly('npcs'), {
        placement: 'entities',
        importer: contributor(store, recorder, 'npcs'),
      });
    });
    const separatePlan = await plan(separate.registry);
    expect(separatePlan.ok && separatePlan.value.restores.length).toBe(2);
    expect(importableOf({ module: frozenOnly('x'), placement: 'entities' })).toBeUndefined();
  });

  test('the campaign root must be transaction-aware', async () => {
    const registry = new ExportRegistry()
      .register(frozenOnly('campaign'), { placement: 'campaign' })
      .register(frozenOnly('attachments'), { placement: 'attachments-manifest' });
    expect(await plan(registry)).toEqual({
      ok: false,
      error: { code: 'campaign_root_not_importable', moduleId: 'campaign' },
    });
    expect(await plan(new ExportRegistry())).toEqual({
      ok: false,
      error: { code: 'registry_incomplete' },
    });
  });

  test('Scenario: Invalid package input changes nothing — a rejected chunk stops the plan', async () => {
    const hostileCodes: [unknown, string | undefined][] = [
      ['npcs_chunk_invalid', 'npcs_chunk_invalid'],
      ['<img src=x onerror=alert(1)>', undefined],
      ['Password: hunter2', undefined],
      [{ nested: 'object' }, undefined],
    ];
    for (const [error, detail] of hostileCodes) {
      const { registry, recorder } = setup((store, recorder, registry) => {
        registry.register(
          contributor(store, recorder, 'npcs', {
            validate: async () => ({ ok: false, error }) as never,
          }),
          { placement: 'entities' },
        );
      });
      expect(await plan(registry)).toEqual({
        ok: false,
        error: { code: 'chunk_rejected', moduleId: 'npcs', ...(detail ? { detail } : {}) },
      });
      expect(recorder.writes).toEqual([]);
    }
    const throwing = setup((store, recorder, registry) => {
      registry.register(
        contributor(store, recorder, 'npcs', {
          validate: async () => {
            throw new Error('boom with secret');
          },
        }),
        { placement: 'entities' },
      );
    });
    expect(await plan(throwing.registry)).toEqual({
      ok: false,
      error: { code: 'chunk_rejected', moduleId: 'npcs' },
    });
  });

  test('malformed contributions and colliding source ids are refused', async () => {
    const cases: [ImportableModule['validate'], string][] = [
      [async () => ok({ defines: [], warnings: [{ code: 'Bad Code' }] }), 'contributor_mismatch'],
      [
        async () => ok({ defines: [{ kind: 'npc', sourceId: 'not-an-id' }], warnings: [] }),
        'contributor_mismatch',
      ],
      // `campaign` and `member` are reserved kinds.
      [
        async () => ok({ defines: [{ kind: 'member', sourceId: NPC }], warnings: [] }),
        'contributor_mismatch',
      ],
      [
        async () => ok({ defines: [{ kind: 'campaign', sourceId: NPC }], warnings: [] }),
        'contributor_mismatch',
      ],
      [
        async () =>
          ok({
            defines: [
              { kind: 'npc', sourceId: NPC },
              { kind: 'npc', sourceId: NPC },
            ],
            warnings: [],
          }),
        'duplicate_source_id',
      ],
      [async () => ({ value: 'not a result' }) as never, 'chunk_rejected'],
    ];
    for (const [validate, code] of cases) {
      const { registry } = setup((store, recorder, registry) => {
        registry.register(contributor(store, recorder, 'npcs', { validate }), {
          placement: 'entities',
        });
      });
      const planned = await plan(registry);
      expect(planned.ok ? 'ok' : planned.error.code).toBe(code);
    }
  });

  test('a chunk under another placement than its registration is rejected', async () => {
    const { registry } = setup((store, recorder, registry) => {
      registry.register(contributor(store, recorder, 'npcs'), { placement: 'documents' });
    });
    expect(await plan(registry)).toEqual({
      ok: false,
      error: {
        code: 'chunk_rejected',
        moduleId: 'npcs',
        path: 'entities/npcs.json',
        detail: 'placement_mismatch',
      },
    });
  });
});

describe('ImportCoordinator (one transaction)', () => {
  async function planned(registry: ExportRegistry): Promise<ImportPlan> {
    const result = await plan(registry);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }

  test('commits root, contributors and preserved chunks together with the job', async () => {
    const { registry, store, recorder, coordinator } = setup();
    await store.create({ id: JOB, requestedBy: USER });
    const committed = await coordinator.commit(await planned(registry));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(recorder.writes).toEqual(['campaign', 'attachments', 'npcs']);
    expect(
      committed.value.report.modules.map((module) => [module.moduleId, module.outcome]),
    ).toEqual([
      ['campaign', 'restored'],
      ['attachments', 'restored'],
      ['npcs', 'restored'],
      ['future-thing', 'preserved'],
    ]);
    expect(store.preserved.get(committed.value.campaignId)?.map((chunk) => chunk.moduleId)).toEqual(
      ['future-thing'],
    );
    expect(store.jobs.get(JOB)).toMatchObject({
      state: 'completed',
      campaignId: committed.value.campaignId,
    });
  });

  test('Scenario: A contributor failure rolls back the whole import (err, throw, malformed)', async () => {
    const failures: [(chunk: ExportChunk, context: ImportContext) => unknown, string, string?][] = [
      [() => err('npcs_reference_missing'), 'contributor_failed', 'npcs_reference_missing'],
      [() => err('Internal: column "x" violates'), 'contributor_failed'],
      [
        () => {
          throw new Error('connection reset with secret');
        },
        'contributor_failed',
      ],
      [() => ok({ restoredCount: -1, warnings: [] }), 'contributor_mismatch'],
      [() => ok({ restoredCount: 1, warnings: [{ code: '<b>' }] }), 'contributor_mismatch'],
    ];
    for (const [restore, code, detail] of failures) {
      const { registry, store, recorder, coordinator } = setup((store, recorder, registry) => {
        registry.register(
          contributor(store, recorder, 'npcs', {
            restore: (chunk, context) => {
              store.later(context.transaction, () => recorder.writes.push('npcs-partial'));
              return restore(chunk, context);
            },
          }),
          { placement: 'entities' },
        );
      });
      await store.create({ id: JOB, requestedBy: USER });
      const result = await coordinator.commit(await planned(registry));
      expect(result).toEqual({
        ok: false,
        error: { code, moduleId: 'npcs', ...(detail === undefined ? {} : { detail }) },
      } as never);
      // Nothing of the campaign root, the earlier contributor or the failing one remains.
      expect(recorder.writes).toEqual([]);
      expect(store.preserved.size).toBe(0);
      expect(store.jobs.get(JOB)?.state).toBe('running');
    }
  });

  test('restore receives one frozen context with the plan id map and the transaction', async () => {
    let seen: ImportContext | undefined;
    const { registry, store, coordinator } = setup((store, recorder, registry) => {
      registry.register(
        contributor(store, recorder, 'npcs', {
          defines: [{ kind: 'npc', sourceId: NPC }],
          restore: (_chunk, context) => {
            seen = context;
            return ok({ restoredCount: 1, warnings: [] });
          },
        }),
        { placement: 'entities' },
      );
    });
    await store.create({ id: JOB, requestedBy: USER });
    const plan = await planned(registry);
    await coordinator.commit(plan);
    expect(seen?.campaignId).toBe(plan.campaignId);
    expect(seen?.importerUserId).toBe(USER);
    expect(seen?.mapId('npc', NPC)).toBe(plan.mapId('npc', NPC) as string);
    expect(Object.isFrozen(seen)).toBe(true);
    expect((seen?.transaction as ImportTransaction | undefined)?.brand).toBe('ImportTransaction');
  });
});

describe('ImportService (jobs)', () => {
  function service(input: ReturnType<typeof setup>, committed: string[] = []) {
    return new ImportService({
      jobs: input.store,
      coordinator: input.coordinator,
      registry: input.registry,
      rules: ALL_AVAILABLE,
      committed: async ({ campaignId }) => {
        committed.push(campaignId);
        throw new Error('audit unavailable');
      },
    });
  }

  test('retry is idempotent per job id and scoped to its user', async () => {
    const context = setup();
    const committed: string[] = [];
    const imports = service(context, committed);
    const { bytes } = await validPackage();
    const first = await imports.start({ jobId: JOB, userId: USER, bytes });
    expect(first.ok && first.value.state).toBe('completed');
    const again = await imports.start({ jobId: JOB, userId: USER, bytes });
    expect(again).toEqual(first);
    expect(context.recorder.writes).toEqual(['campaign', 'attachments', 'npcs']);
    // A failing post-commit hook never fails the import.
    expect(committed).toHaveLength(1);
    expect(await imports.start({ jobId: JOB, userId: OTHER_USER, bytes })).toEqual({
      ok: false,
      error: 'job_conflict',
    });
    expect(await imports.status(JOB, OTHER_USER)).toBeUndefined();
    expect(await imports.status(JOB, USER)).toEqual(first.ok ? first.value : undefined);
  });

  test('an invalid package fails its job with the inspector code and writes nothing', async () => {
    const context = setup();
    const imports = service(context);
    const { bytes } = await validPackage();
    const corrupted = bytes.slice(0, bytes.length - 10);
    const result = await imports.start({ jobId: JOB, userId: USER, bytes: corrupted });
    expect(result.ok && result.value).toMatchObject({
      state: 'failed',
      errorCode: 'malformed_container',
      report: { modules: [] },
    });
    expect(context.recorder.writes).toEqual([]);
    expect(context.recorder.validated).toEqual([]);
    expect(context.store.jobs.get(JOB)?.sourceManifestChecksum).toBeUndefined();
  });

  test('a contributor failure fails the job with safe details only', async () => {
    const context = setup((store, recorder, registry) => {
      registry.register(
        contributor(store, recorder, 'npcs', { restore: () => err('npcs_reference_missing') }),
        { placement: 'entities' },
      );
    });
    const imports = service(context);
    const { bytes } = await validPackage();
    const result = await imports.start({ jobId: JOB, userId: USER, bytes });
    expect(result.ok && result.value).toMatchObject({
      state: 'failed',
      errorCode: 'contributor_failed',
      failure: { moduleId: 'npcs', detail: 'npcs_reference_missing' },
    });
    expect(result.ok && result.value.campaignId).toBeUndefined();
    expect(context.recorder.writes).toEqual([]);
  });

  test('malformed ids are refused before anything runs', async () => {
    const imports = service(setup());
    const { bytes } = await validPackage();
    expect(await imports.start({ jobId: 'job-1', userId: USER, bytes })).toEqual({
      ok: false,
      error: 'job_conflict',
    });
  });
});
