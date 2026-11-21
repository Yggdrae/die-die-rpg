import { describe, expect, test } from 'bun:test';
import { InMemoryRepository } from '@rpg/contracts/testing';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { CAMPAIGN_INPUT, FIXTURE_SYSTEM } from './domain.test.ts';
import { CampaignSettingRegistry } from './domain.ts';
import {
  type CampaignReplica,
  CampaignReplicaSchema,
  type CampaignSettingReplica,
  campaignCreateInputFromReplica,
  OfflineCampaignRepository,
  type OfflineInvitationQueue,
} from './offline.ts';
import { type CampaignDrainedOutcome, CampaignReplicaSync } from './offline-sync.ts';

const USER = '22222222-2222-2222-2222-222222222222';

function harness() {
  const campaigns = new InMemoryRepository<CampaignReplica>();
  const settings = new InMemoryRepository<CampaignSettingReplica>();
  const queued = new Map<string, Parameters<OfflineInvitationQueue['queue']>[0]>();
  const invitations: OfflineInvitationQueue = {
    queue: async (input) => void queued.set(input.intentId, input),
  };
  const registry = new CampaignSettingRegistry();
  registry.register({
    namespace: 'feature.weather',
    schema: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
    memberVisible: true,
    writableRoles: ['owner'],
  });
  const service = () => new OfflineCampaignRepository(campaigns, settings, invitations, registry);
  return { campaigns, settings, queued, service };
}

describe('offline campaign adapter', () => {
  test('stores one schema-valid aggregate with the client ID and exact pins', async () => {
    const { campaigns, service } = harness();
    const created = await service().create(USER, CAMPAIGN_INPUT, FIXTURE_SYSTEM, ['player']);
    expect(created.ok).toBe(true);
    expect(campaigns.size).toBe(1);
    const stored = await campaigns.get(CAMPAIGN_INPUT.id);
    if (!stored.ok) throw new Error('missing replica');
    expect(Value.Check(CampaignReplicaSchema, stored.value)).toBe(true);
    expect(stored.value).toMatchObject({
      id: CAMPAIGN_INPUT.id,
      campaignId: CAMPAIGN_INPUT.id,
      system: CAMPAIGN_INPUT.system,
      modulePins: [{ moduleId: 'weather', version: '1.0.0' }],
      settings: { system: { tone: 'bright' } },
      invitationIntents: [expect.objectContaining({ role: 'player' })],
    });
    expect(campaignCreateInputFromReplica(stored.value)).toEqual(CAMPAIGN_INPUT);
  });

  test('rejects invalid aggregate without any local write', async () => {
    const { campaigns, service } = harness();
    const created = await service().create(
      USER,
      { ...CAMPAIGN_INPUT, moduleIds: ['unknown'] },
      FIXTURE_SYSTEM,
    );
    expect(created).toEqual({ ok: false, error: 'invalid_module' });
    expect(campaigns.size).toBe(0);
  });

  test('context is readable after restart and merges namespaced settings', async () => {
    const { service } = harness();
    await service().create(USER, CAMPAIGN_INPUT, FIXTURE_SYSTEM);
    const restarted = service();
    expect(
      (
        await restarted.writeSetting(
          USER,
          CAMPAIGN_INPUT.id,
          'feature.weather',
          {
            enabled: true,
          },
          null,
        )
      ).ok,
    ).toBe(true);
    expect(
      await restarted.writeSetting(USER, CAMPAIGN_INPUT.id, 'feature.unknown', {}, null),
    ).toEqual({ ok: false, error: 'unregistered_setting_namespace' });
    expect(
      await restarted.writeSetting(USER, CAMPAIGN_INPUT.id, 'feature.weather', { enabled: 1 }, 1),
    ).toEqual({ ok: false, error: 'invalid_setting' });
    expect(await restarted.getContext(CAMPAIGN_INPUT.id)).toEqual({
      campaignId: CAMPAIGN_INPUT.id,
      system: CAMPAIGN_INPUT.system,
      gameMode: 'standard',
      modulePins: [{ moduleId: 'weather', version: '1.0.0' }],
      settings: { system: { tone: 'bright' }, 'feature.weather': { enabled: true } },
    });
  });

  test('stale setting write is an explicit version conflict', async () => {
    const { service } = harness();
    const offline = service();
    await offline.create(USER, CAMPAIGN_INPUT, FIXTURE_SYSTEM);
    await offline.writeSetting(USER, CAMPAIGN_INPUT.id, 'feature.weather', { enabled: true }, null);
    await offline.writeSetting(USER, CAMPAIGN_INPUT.id, 'feature.weather', { enabled: false }, 1);
    const stale = await offline.writeSetting(
      USER,
      CAMPAIGN_INPUT.id,
      'feature.weather',
      { enabled: true },
      1,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatchObject({ kind: 'version_conflict' });
  });

  test('queues invitations only after authority acceptance, idempotently', async () => {
    const { queued, service } = harness();
    await service().create(USER, CAMPAIGN_INPUT, FIXTURE_SYSTEM, ['player', 'gm']);
    expect(queued.size).toBe(0);
    const restarted = service();
    await restarted.authorityAccepted(CAMPAIGN_INPUT.id);
    await restarted.authorityAccepted(CAMPAIGN_INPUT.id);
    expect([...queued.values()].map((intent) => intent.role).sort()).toEqual(['gm', 'player']);
    expect(new Set([...queued.values()].map((intent) => intent.causalGroupId)).size).toBe(1);
  });

  test('soft delete keeps the tombstone and removes local context', async () => {
    const { campaigns, queued, service } = harness();
    const offline = service();
    await offline.create(USER, CAMPAIGN_INPUT, FIXTURE_SYSTEM, ['player']);
    expect((await offline.delete(CAMPAIGN_INPUT.id, 1)).ok).toBe(true);
    expect(await offline.getContext(CAMPAIGN_INPUT.id)).toBeUndefined();
    const tombstone = await campaigns.get(CAMPAIGN_INPUT.id);
    expect(tombstone.ok && tombstone.value.deletedAt !== undefined).toBe(true);
    await offline.authorityAccepted(CAMPAIGN_INPUT.id);
    expect(queued.size).toBe(0);
  });
});

describe('campaign replica sync dispatch', () => {
  const item = (overrides: Partial<CampaignDrainedOutcome>): CampaignDrainedOutcome => ({
    campaignId: CAMPAIGN_INPUT.id,
    featureId: 'campaigns',
    tableName: 'campaigns',
    recordId: CAMPAIGN_INPUT.id,
    operation: 'insert',
    result: 'accepted',
    ...overrides,
  });
  function harness() {
    const accepted: string[] = [];
    const deleted: string[] = [];
    const failing = new Set<string>();
    const sync = new CampaignReplicaSync(
      {
        authorityAccepted: async (id) => {
          if (failing.has(id)) throw new Error('queue down');
          accepted.push(id);
        },
      },
      { campaignDeleted: async (id) => void deleted.push(id), accessDenied: async () => undefined },
    );
    return { sync, accepted, deleted, failing };
  }

  test('only accepted campaign insert/tombstone outcomes act, in causal order', async () => {
    const { sync, accepted, deleted } = harness();
    const result = await sync.afterDrain({
      outcomes: [
        item({ result: 'rejected' }),
        item({ result: 'conflict' }),
        item({ result: 'retry' }),
        item({ operation: 'update' }),
        item({ tableName: 'campaign_settings' }),
        item({ featureId: 'other' }),
        item({ recordId: crypto.randomUUID() }),
        item({}),
        item({ operation: 'tombstone' }),
      ],
    });
    expect(result.errors).toEqual([]);
    expect(accepted).toEqual([CAMPAIGN_INPUT.id]);
    expect(deleted).toEqual([CAMPAIGN_INPUT.id]);
  });

  test('a failing handler is reported and does not stop later outcomes', async () => {
    const { sync, accepted, deleted, failing } = harness();
    failing.add(CAMPAIGN_INPUT.id);
    const other = crypto.randomUUID();
    const result = await sync.afterDrain({
      outcomes: [item({}), item({ campaignId: other, recordId: other, operation: 'tombstone' })],
    });
    expect(result.errors).toHaveLength(1);
    expect(accepted).toEqual([]);
    expect(deleted).toEqual([other]);
  });

  test('resume acts only for an accepted creation; server rows act only when tombstoned', async () => {
    const { sync, accepted, deleted } = harness();
    await sync.resumeAccepted(CAMPAIGN_INPUT.id, () => false);
    expect(accepted).toEqual([]);
    await sync.resumeAccepted(CAMPAIGN_INPUT.id, () => true);
    expect(accepted).toEqual([CAMPAIGN_INPUT.id]);
    await sync.serverCampaigns([
      { id: 'live', deletedAt: null },
      { id: 'gone', deletedAt: '2026-10-24T12:00:00Z' },
    ]);
    expect(deleted).toEqual(['gone']);
  });
});
