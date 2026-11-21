import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { type ExportableModule, type ExportChunk, err } from '@rpg/contracts';
import { canonicalJson } from './canonical.ts';
import { inspectPackage } from './inspector.ts';
import {
  ExportOrchestrator,
  type ExportOrchestratorOptions,
  type RulesContextSource,
  type SnapshotCursor,
} from './orchestrator.ts';
import { ExportRegistrationError, ExportRegistry } from './registry.ts';
import { isForbiddenKey, scanForbiddenData } from './scanner.ts';
import { CAMPAIGN_ID } from './test-fixtures.ts';
import { exportContributorProblems } from './testing.ts';
import { concatParts } from './zip.ts';

/**
 * Feature 07 task 03 — `_bdd.md` Export: "Export uses contributor boundaries", "Export preserves
 * the pinned rules context", "P0 attachment export is manifest only", "Secrets are excluded", and
 * `_db.md` Export Consistency (one authority state, no partial file).
 */

class FakeModule implements ExportableModule {
  calls = 0;
  constructor(
    readonly moduleId: string,
    public payload: unknown,
    readonly chunkVersion = '1',
    private readonly onExport?: (calls: number) => void,
  ) {}

  async export(): Promise<ExportChunk> {
    this.calls += 1;
    const chunk = {
      moduleId: this.moduleId,
      chunkVersion: this.chunkVersion,
      payload: this.payload,
    };
    // Runs after this read observed its state: models a write committing right after it.
    this.onExport?.(this.calls);
    return chunk;
  }

  async import() {
    return err('unsupported');
  }
}

const RULES: RulesContextSource = {
  pins: async (campaignId) =>
    campaignId === CAMPAIGN_ID
      ? {
          system: { systemId: 'fixture-system', version: '1.2.3' },
          modules: [
            { moduleId: 'z-module', version: '2.0.0' },
            { moduleId: 'a-module', version: '1.0.0' },
          ],
        }
      : undefined,
};

function baseRegistry() {
  const campaign = new FakeModule('campaign', { name: 'Ashen Road', settings: {} });
  const attachments = new FakeModule('attachments', {
    binaries: 'excluded',
    entries: [{ attachmentId: 'a1', checksum: 'f'.repeat(64), visibility: { mode: 'gm_only' } }],
  });
  const registry = new ExportRegistry()
    .register(campaign, { placement: 'campaign', countRecords: () => 1 })
    .register(attachments, {
      placement: 'attachments-manifest',
      countRecords: (payload) => (payload as { entries: unknown[] }).entries.length,
    });
  return { registry, campaign, attachments };
}

function orchestrator(overrides: Partial<ExportOrchestratorOptions> = {}) {
  const { registry } = baseRegistry();
  return new ExportOrchestrator({
    registry,
    rules: RULES,
    applicationVersion: '0.0.0-test',
    now: () => new Date('2026-10-27T12:00:00.000Z'),
    ...overrides,
  });
}

const EXPORTER = { exportedBy: { displayName: 'Rowan' } };

describe('Scenario: Export uses contributor boundaries', () => {
  test('a newly registered contributor appears with no orchestrator change', async () => {
    const { registry } = baseRegistry();
    const options = { rules: RULES, applicationVersion: '0', registry };
    const before = await new ExportOrchestrator(options).export(CAMPAIGN_ID, EXPORTER);
    registry.register(new FakeModule('handouts', { items: [1, 2] }, '3'), {
      placement: 'documents',
      countRecords: (payload) => (payload as { items: unknown[] }).items.length,
    });
    const after = await new ExportOrchestrator(options).export(CAMPAIGN_ID, EXPORTER);
    expect(
      before.ok && before.value.manifest.contributors.map((record) => record.moduleId),
    ).toEqual(['attachments', 'campaign']);
    expect(after.ok && after.value.manifest.contributors).toContainEqual(
      expect.objectContaining({
        moduleId: 'handouts',
        chunkVersion: '3',
        path: 'documents/handouts.json',
      }),
    );
    expect(after.ok && after.value.summary).toContainEqual({
      moduleId: 'handouts',
      chunkVersion: '3',
      records: 2,
      bytes: expect.any(Number),
    });
  });

  test('the registry refuses unsafe, duplicate or ambiguous registrations', () => {
    const registry = new ExportRegistry().register(new FakeModule('campaign', {}), {
      placement: 'campaign',
    });
    const attempts: [() => unknown, string][] = [
      [
        () => registry.register(new FakeModule('../x', {}), { placement: 'entities' }),
        'invalid_module_id',
      ],
      [
        () => registry.register(new FakeModule('Campaign', {}), { placement: 'entities' }),
        'invalid_module_id',
      ],
      [
        () => registry.register(new FakeModule('campaign', {}), { placement: 'entities' }),
        'duplicate_module',
      ],
      [
        () => registry.register(new FakeModule('root2', {}), { placement: 'campaign' }),
        'duplicate_campaign_root',
      ],
      [
        () => registry.register(new FakeModule('x', {}), { placement: 'binaries' as 'entities' }),
        'invalid_placement',
      ],
    ];
    for (const [attempt, code] of attempts) {
      expect(attempt).toThrow(ExportRegistrationError);
      try {
        attempt();
      } catch (error) {
        expect((error as ExportRegistrationError).code).toBe(
          code as ExportRegistrationError['code'],
        );
      }
    }
    expect(registry.isComplete()).toBe(false);
  });

  test('without the campaign root and an attachment manifest no package is produced', async () => {
    const registry = new ExportRegistry().register(new FakeModule('campaign', {}), {
      placement: 'campaign',
    });
    const result = await orchestrator({ registry }).export(CAMPAIGN_ID, EXPORTER);
    expect(result).toEqual({ ok: false, error: { code: 'registry_incomplete' } });
  });

  test('the portability package imports no content feature', async () => {
    const root = new URL('./', import.meta.url);
    const offenders: string[] = [];
    for (const name of await readdir(root)) {
      if (!name.endsWith('.ts')) continue;
      const text = await Bun.file(new URL(name, root)).text();
      for (const match of text.matchAll(/from\s+['"](@rpg\/[^'"]+)['"]/g)) {
        if (match[1] !== '@rpg/contracts') offenders.push(`${name}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Scenario: A GM exports one campaign as one file', () => {
  test('one package with manifest, campaign, locks, attachment manifest and every chunk', async () => {
    const result = await orchestrator().export(CAMPAIGN_ID, EXPORTER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inspected = await inspectPackage(concatParts(result.value.parts));
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.manifest.entries.map((entry) => entry.path)).toEqual([
      'attachments-manifest/attachments.json',
      'campaign.json',
      'modules.lock',
      'system.lock',
    ]);
    expect(inspected.value.manifest).toMatchObject({
      format: 'rpgpack',
      formatVersion: 1,
      applicationVersion: '0.0.0-test',
      exportedAt: '2026-10-27T12:00:00.000Z',
      exportedBy: { displayName: 'Rowan' },
      source: { campaignId: CAMPAIGN_ID },
    });
  });
});

describe('Scenario: Export preserves the pinned rules context', () => {
  test('system.lock and modules.lock carry the exact pins, sorted', async () => {
    const result = await orchestrator().export(CAMPAIGN_ID, EXPORTER);
    if (!result.ok) throw new Error(result.error.code);
    const inspected = await inspectPackage(concatParts(result.value.parts));
    if (!inspected.ok) throw new Error(inspected.error.code);
    expect(inspected.value.systemLock).toEqual({ systemId: 'fixture-system', version: '1.2.3' });
    expect(inspected.value.modulesLock).toEqual({
      modules: [
        { moduleId: 'a-module', version: '1.0.0' },
        { moduleId: 'z-module', version: '2.0.0' },
      ],
    });
  });

  test('a missing or deleted campaign produces nothing', async () => {
    const result = await orchestrator().export('0b5e7a9e-6a43-4c55-9d0e-3c0b2b0c1a02', EXPORTER);
    expect(result).toEqual({ ok: false, error: { code: 'campaign_unavailable' } });
  });
});

describe('Scenario: P0 attachment export is manifest only / Secrets are excluded', () => {
  test('a contributor leaking a credential, email, key or signed URL fails the whole export', async () => {
    const leaks: [unknown, string][] = [
      [{ members: [{ name: 'R', passwordHash: '$argon2id$v=19$m=1' }] }, '/members/0/passwordHash'],
      [{ members: [{ name: 'R', email: 'r@example.com' }] }, '/members/0/email'],
      [{ entries: [{ object_key: 'campaigns/x' }] }, '/entries/0/object_key'],
      [{ entries: [{ href: 'https://minio/x?X-Amz-Signature=abc' }] }, '/entries/0/href'],
      [{ auditEvents: [] }, '/auditEvents'],
      [{ pending_mutations: [] }, '/pending_mutations'],
    ];
    for (const [payload, pointer] of leaks) {
      const { registry } = baseRegistry();
      registry.register(new FakeModule('leaky', payload), { placement: 'entities' });
      const result = await orchestrator({ registry }).export(CAMPAIGN_ID, EXPORTER);
      expect(result).toEqual({
        ok: false,
        error: { code: 'forbidden_content', moduleId: 'leaky', pointer },
      });
    }
  });

  test('ordinary game words are not mistaken for secrets', () => {
    for (const key of [
      'secret',
      'token',
      'tokens',
      'sessionId',
      'session',
      'content',
      'gmSecret',
    ]) {
      expect(isForbiddenKey(key)).toBe(false);
    }
    expect(
      scanForbiddenData({
        secret: true,
        tokens: [{ x: 1 }],
        notes: 'Email me at a@b.c',
        url: 'https://x',
      }),
    ).toBeUndefined();
  });
});

describe('Export cannot mix authority states or offer a partial file', () => {
  test('a contributor that throws fails the export with its module id only', async () => {
    const { registry } = baseRegistry();
    registry.register(
      {
        moduleId: 'broken',
        export: async () => {
          throw new Error('connection refused at 10.0.0.1 with password hunter2');
        },
        import: async () => err('x'),
      },
      { placement: 'entities' },
    );
    const result = await orchestrator({ registry }).export(CAMPAIGN_ID, EXPORTER);
    expect(result).toEqual({
      ok: false,
      error: { code: 'contributor_failed', moduleId: 'broken' },
    });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  test('a chunk claiming another module or an unsafe version is refused', async () => {
    for (const chunk of [
      { moduleId: 'other', chunkVersion: '1', payload: {} },
      { moduleId: 'liar', chunkVersion: '../1', payload: {} },
    ]) {
      const { registry } = baseRegistry();
      registry.register(
        { moduleId: 'liar', export: async () => chunk, import: async () => err('x') },
        { placement: 'entities' },
      );
      const result = await orchestrator({ registry }).export(CAMPAIGN_ID, EXPORTER);
      expect(result.ok ? undefined : result.error).toEqual({
        code: 'contributor_mismatch',
        moduleId: 'liar',
      });
    }
  });

  test('unserializable or unbounded payloads fail before a package exists', async () => {
    let deep: unknown = 1;
    for (let index = 0; index < 100; index += 1) deep = [deep];
    for (const payload of [{ at: new Date() }, { n: Number.NaN }, deep]) {
      const { registry } = baseRegistry();
      registry.register(new FakeModule('odd', payload), { placement: 'entities' });
      const result = await orchestrator({ registry }).export(CAMPAIGN_ID, EXPORTER);
      expect(result.ok ? undefined : result.error).toEqual({
        code: 'contributor_failed',
        moduleId: 'odd',
      });
    }
  });

  test('a write landing between two contributor reads is detected and the read retried', async () => {
    // "attachments" is read before "campaign". One write that renames the campaign and adds an
    // attachment commits right after the first attachments read, so pass 1 mixes the two states
    // (old attachments, new campaign); pass 2 differs from it, pass 3 agrees with pass 2.
    const { campaign } = baseRegistry();
    const onAttachments = new FakeModule(
      'attachments',
      { binaries: 'excluded', entries: [] },
      '1',
      (calls) => {
        if (calls === 1) {
          campaign.payload = { name: 'Renamed', settings: {} };
          onAttachments.payload = { binaries: 'excluded', entries: [{ attachmentId: 'new' }] };
        }
      },
    );
    const fresh = new ExportRegistry()
      .register(campaign, { placement: 'campaign' })
      .register(onAttachments, { placement: 'attachments-manifest' });
    const result = await orchestrator({ registry: fresh }).export(CAMPAIGN_ID, EXPORTER);
    expect(result.ok).toBe(true);
    expect(onAttachments.calls).toBe(3);
    if (!result.ok) return;
    const inspected = await inspectPackage(concatParts(result.value.parts));
    expect(
      inspected.ok &&
        inspected.value.chunks.find((chunk) => chunk.moduleId === 'campaign')?.payload,
    ).toEqual({ name: 'Renamed', settings: {} });
  });

  test('state that never settles fails as snapshot_unstable, never a mixed package', async () => {
    const { campaign } = baseRegistry();
    let version = 0;
    const churning = new FakeModule('attachments', {}, '1', () => {
      version += 1;
      campaign.payload = { name: `v${version}` };
    });
    const fresh = new ExportRegistry()
      .register(campaign, { placement: 'campaign' })
      .register(churning, { placement: 'attachments-manifest' });
    const result = await orchestrator({ registry: fresh, maxAttempts: 2 }).export(
      CAMPAIGN_ID,
      EXPORTER,
    );
    expect(result).toEqual({ ok: false, error: { code: 'snapshot_unstable' } });
  });

  test('cursor consistency: an incomplete replica is refused, a moving cursor retried', async () => {
    const incomplete: SnapshotCursor = { complete: false, incompleteModules: ['attachments'] };
    const refused = await orchestrator({
      consistency: { kind: 'cursor', read: async () => incomplete },
    }).export(CAMPAIGN_ID, EXPORTER);
    expect(refused).toEqual({
      ok: false,
      error: { code: 'incomplete_replica', incompleteModules: ['attachments'] },
    });

    const cursors = ['1', '2', '2', '2'];
    const moving = await orchestrator({
      consistency: {
        kind: 'cursor',
        read: async () => ({ complete: true, cursor: cursors.shift() ?? 'x' }),
      },
    }).export(CAMPAIGN_ID, EXPORTER);
    expect(moving.ok).toBe(true);
    expect(cursors).toEqual([]);
  });

  test('preserved unknown chunks are re-emitted byte-for-byte under unknown/', async () => {
    const payload = { opaque: { z: [3, 2, 1], a: 'kept' } };
    const result = await orchestrator({
      preserved: { list: async () => [{ moduleId: 'future', chunkVersion: '9', payload }] },
    }).export(CAMPAIGN_ID, EXPORTER);
    if (!result.ok) throw new Error(result.error.code);
    const inspected = await inspectPackage(concatParts(result.value.parts));
    if (!inspected.ok) throw new Error(inspected.error.code);
    expect(inspected.value.preserved).toEqual([
      expect.objectContaining({
        moduleId: 'future',
        chunkVersion: '9',
        path: 'unknown/future/9.json',
      }),
    ]);
    expect(canonicalJson(inspected.value.preserved[0]?.payload)).toBe(canonicalJson(payload));
  });
});

describe('contributor conformance kit', () => {
  test('passes a well-behaved contributor and reports each defect of a bad one', async () => {
    const { registry } = baseRegistry();
    for (const registration of registry.list()) {
      expect(await exportContributorProblems(registration, CAMPAIGN_ID)).toEqual([]);
    }
    let flip = 0;
    const bad: ExportableModule = {
      moduleId: 'bad',
      export: async () => {
        flip += 1;
        return { moduleId: 'other', chunkVersion: '..', payload: { email: 'x@y.z', n: flip } };
      },
      import: async () => ({ ok: true, value: undefined }),
    };
    const problems = await exportContributorProblems(
      { module: bad, placement: 'entities', countRecords: () => -1 },
      CAMPAIGN_ID,
    );
    expect(problems).toEqual([
      'chunk moduleId differs from the registration',
      'chunk version is not a safe version',
      'forbidden data at /email (forbidden_key)',
      'export is not deterministic for unchanged data',
      'record count is not a natural number',
      'import accepted a payload of the wrong shape',
    ]);
  });
});
