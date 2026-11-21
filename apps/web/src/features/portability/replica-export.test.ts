import { describe, expect, test } from 'bun:test';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import { exportOffline } from './export-client.ts';
import { browserReplicaExportSource } from './replica-export.ts';

/**
 * Feature 07 task 05: what makes a device copy incomplete, and who may export it. The full path over
 * a real replica, real sync, and the production bundle is `apps/web/e2e/pwa.e2e.ts`.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000b1';

interface Replica {
  readonly hasSynced?: boolean;
  readonly cursor?: number | null;
  readonly campaign?: Record<string, unknown> | null;
  readonly pins?: readonly Record<string, unknown>[];
  readonly preserved?: readonly Record<string, unknown>[];
  readonly pending?: number;
  readonly role?: string;
  readonly removedAt?: string | null;
  readonly attachments?: readonly Record<string, unknown>[];
}

function session(replica: Replica = {}): BrowserSyncSession {
  const pins = replica.pins ?? [
    { campaign_id: CAMPAIGN, system_id: 'fixture-system', system_version: '0.1.0' },
  ];
  const rows: Record<string, readonly Record<string, unknown>[]> = {
    import_preserved_chunks: replica.preserved ?? [],
    attachments: replica.attachments ?? [],
    content_entities: [],
    content_entity_relationships: [],
    dice_rolls: [],
    characters: [],
    character_secrets: [],
    campaign_sessions: [],
    session_gm_notes: [],
    session_log_entries: [],
  };
  const campaign =
    replica.campaign === undefined
      ? { name: 'Ashen Road', description: '', game_mode: 'standard', deleted_at: null }
      : replica.campaign;
  return {
    database: {
      currentStatus: { hasSynced: replica.hasSynced ?? true },
      getOptional: async (query: string) =>
        query.includes('ps_buckets')
          ? { cursor: replica.cursor === undefined ? 7 : replica.cursor }
          : query.includes('system_pins')
            ? (pins[0] ?? null)
            : campaign,
      getAll: async () => [],
    },
    store: {
      featureRows: async (table: string) => rows[table] ?? [],
      campaignPendingCount: async () => replica.pending ?? 0,
      cachedMembership: async () =>
        replica.role === undefined
          ? undefined
          : {
              campaignId: CAMPAIGN,
              userId: USER,
              role: replica.role,
              version: 1,
              updatedAt: '2026-10-31T00:00:00.000Z',
              removedAt: replica.removedAt ?? null,
            },
    },
    repository: () => ({
      list: async () => ({ ok: true, value: [] }),
    }),
  } as unknown as BrowserSyncSession;
}

function run(replica: Replica) {
  return exportOffline(
    CAMPAIGN,
    browserReplicaExportSource({
      session: session({ role: 'owner', ...replica }),
      displayName: 'gm',
      applicationVersion: 'test',
    }),
  );
}

describe('offline export of a device replica', () => {
  test('a complete copy produces a file with every module', async () => {
    const outcome = await run({});
    expect(outcome.kind).toBe('ready');
    expect(outcome.kind === 'ready' && outcome.summary.map((entry) => entry.moduleId)).toEqual([
      'attachments',
      'campaign',
      'characters',
      'content',
      'dice_rolls',
      'encounters',
      'sessions',
    ]);
  });

  test('only the roles holding export pass, decided by the shared policy', async () => {
    const allowed: string[] = [];
    for (const role of ['owner', 'gm', 'assistant_gm', 'player', 'observer']) {
      if ((await run({ role })).kind !== 'denied') allowed.push(role);
    }
    expect(allowed).toEqual(['owner', 'gm']);
    expect((await run({ removedAt: '2026-10-30T00:00:00.000Z' })).kind).toBe('denied');
    expect(
      (
        await exportOffline(
          CAMPAIGN,
          browserReplicaExportSource({
            session: session(),
            displayName: 'gm',
            applicationVersion: 'test',
          }),
        )
      ).kind,
    ).toBe('denied');
  });

  const INCOMPLETE: readonly [string, Replica, readonly string[]][] = [
    [
      'no checkpoint has ever applied',
      { hasSynced: false },
      ['attachments', 'campaign', 'characters', 'content', 'dice_rolls', 'encounters', 'sessions'],
    ],
    [
      'the provider has no bucket state',
      { cursor: null },
      ['attachments', 'campaign', 'characters', 'content', 'dice_rolls', 'encounters', 'sessions'],
    ],
    ['the exact pin is missing', { pins: [] }, ['campaign']],
    ['the campaign is not on the device', { campaign: null }, ['campaign']],
    [
      'the campaign is deleted',
      { campaign: { name: 'x', game_mode: 'standard', deleted_at: '2026-10-30' } },
      ['campaign'],
    ],
    [
      'an import preserved a chunk only the authority holds',
      { preserved: [{ campaign_id: CAMPAIGN, module_id: 'future-notes', chunk_version: '4' }] },
      ['campaign'],
    ],
    [
      'a local write awaits upload',
      { pending: 1 },
      ['campaign', 'characters', 'content', 'dice_rolls', 'encounters', 'sessions'],
    ],
  ];
  for (const [name, replica, modules] of INCOMPLETE) {
    test(`refuses when ${name}, naming what is missing`, async () => {
      expect(await run(replica)).toEqual({ kind: 'incomplete_replica', modules });
    });
  }

  test('a malformed attachment row fails the export, never a shorter manifest', async () => {
    const outcome = await run({
      attachments: [{ id: 'x', campaign_id: CAMPAIGN, visibility_mode: 'not-a-mode' }],
    });
    expect(outcome.kind).toBe('failed');
  });

  test('checksums and provider timestamps normalize to the online forms', async () => {
    const outcome = await run({
      attachments: [
        {
          id: '00000000-0000-4000-8000-0000000000c1',
          campaign_id: CAMPAIGN,
          owner_resource_class: 'campaign_entity',
          owner_resource_id: '00000000-0000-4000-8000-0000000000c2',
          filename: 'map.png',
          mime_type: 'image/png',
          declared_size: 3,
          verified_size: 3,
          declared_checksum: 'AB'.repeat(32),
          verified_checksum: 'CD'.repeat(32),
          visibility_mode: 'gm_only',
          visibility_targets: '[]',
          version: 2,
          created_at: '2026-10-31 12:00:00.123Z',
          finalized_at: '2026-10-31T12:00:01.000Z',
        },
      ],
    });
    expect(outcome.kind).toBe('ready');
    const summary = outcome.kind === 'ready' ? outcome.summary : [];
    expect(summary.find((entry) => entry.moduleId === 'attachments')?.records).toBe(1);
  });
});
