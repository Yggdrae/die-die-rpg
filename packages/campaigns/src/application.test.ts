import { describe, expect, test } from 'bun:test';
import { type ActorRef, type AuditRecorder, err, ok } from '@rpg/contracts';
import type { CampaignMembershipWriter } from '@rpg/identity';
import { Type } from '@sinclair/typebox';
import { CampaignService } from './application.ts';
import type { SystemCatalog } from './contracts.ts';
import { CAMPAIGN_INPUT, FIXTURE_SYSTEM } from './domain.test.ts';
import { CampaignSettingRegistry } from './domain.ts';
import { InMemoryCampaignRepository } from './memory.ts';

const userId = '22222222-2222-2222-2222-222222222222';

function harness() {
  const repository = new InMemoryCampaignRepository();
  const catalog: SystemCatalog = {
    list: async () => [FIXTURE_SYSTEM.summary],
    resolveLatest: async () => FIXTURE_SYSTEM,
    resolveExact: async (ref) =>
      ref.systemId === FIXTURE_SYSTEM.summary.ref.systemId &&
      (ref.version === '0.1.0' || ref.version === '0.2.0')
        ? {
            ...FIXTURE_SYSTEM,
            summary: { ...FIXTURE_SYSTEM.summary, ref },
          }
        : undefined,
  };
  const ownerWriter: CampaignMembershipWriter = {
    createOwner: (input, transaction) => {
      const handle = transaction.handle as {
        insertOwner(candidate: typeof input): ReturnType<CampaignMembershipWriter['createOwner']>;
      };
      return handle.insertOwner(input);
    },
  };
  const actor: ActorRef = { userId, campaignId: CAMPAIGN_INPUT.id, role: 'owner' };
  const audits: string[] = [];
  const audit: AuditRecorder = {
    record: async (event) => {
      audits.push(event.action);
    },
  };
  const settings = new CampaignSettingRegistry();
  settings.register({
    namespace: 'feature.weather',
    schema: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
    memberVisible: true,
    writableRoles: ['owner'],
  });
  const service = new CampaignService(
    repository,
    catalog,
    {
      resolve: async (candidateUserId, campaignId) =>
        candidateUserId === userId && campaignId === CAMPAIGN_INPUT.id
          ? ok(actor)
          : err('membership_not_found'),
      listCampaignIds: async (candidateUserId) =>
        candidateUserId === userId ? [CAMPAIGN_INPUT.id] : [],
    },
    ownerWriter,
    {
      decide: (candidate, capability) => candidate.role === 'owner' || capability === 'read',
    },
    settings,
    audit,
    { auditDegraded: () => undefined },
  );
  return { service, repository, audits };
}

describe('CampaignService', () => {
  test('creates one pinned campaign and owner idempotently', async () => {
    const { service, audits } = harness();
    const first = await service.create(userId, CAMPAIGN_INPUT);
    const retry = await service.create(userId, CAMPAIGN_INPUT);

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(first.value.system).toEqual({ systemId: 'fixture-system', version: '0.1.0' });
    expect(retry.value.id).toBe(first.value.id);
    expect(audits).toEqual(['campaign.created']);
  });

  test('detail and setting writes cannot alter pins or other namespaces', async () => {
    const { service } = harness();
    const created = await service.create(userId, CAMPAIGN_INPUT);
    if (!created.ok) throw new Error('fixture creation failed');
    const details = await service.updateDetails(userId, CAMPAIGN_INPUT.id, {
      name: 'Changed',
      description: 'Changed description',
      expectedVersion: created.value.version,
    });
    if (!details.ok) throw new Error('detail update failed');
    expect(details.value.system).toEqual(created.value.system);
    expect(details.value.modulePins).toEqual(created.value.modulePins);

    const setting = await service.updateSetting(userId, CAMPAIGN_INPUT.id, 'feature.weather', {
      value: { enabled: true },
      expectedVersion: null,
    });
    expect(setting.ok).toBe(true);
    if (!setting.ok) return;
    expect(setting.value.settings.system).toEqual({ tone: 'bright' });
  });

  test('only explicit expected-version update changes the exact pin', async () => {
    const { service } = harness();
    const created = await service.create(userId, CAMPAIGN_INPUT);
    if (!created.ok) throw new Error('fixture creation failed');
    expect(
      await service.updateSystem(userId, CAMPAIGN_INPUT.id, {
        targetVersion: '9.9.9',
        expectedVersion: created.value.version,
      }),
    ).toEqual({ ok: false, error: 'system_unavailable' });
    const results = await Promise.all([
      service.updateSystem(userId, CAMPAIGN_INPUT.id, {
        targetVersion: '0.2.0',
        expectedVersion: created.value.version,
      }),
      service.updateSystem(userId, CAMPAIGN_INPUT.id, {
        targetVersion: '0.2.0',
        expectedVersion: created.value.version,
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.error === 'version_conflict'),
    ).toHaveLength(1);
    expect((await service.get(userId, CAMPAIGN_INPUT.id)).ok).toBe(true);
    const current = await service.get(userId, CAMPAIGN_INPUT.id);
    if (!current.ok) return;
    expect(current.value.system.version).toBe('0.2.0');
  });

  test('tombstones remove list, read, and context', async () => {
    const { service } = harness();
    const created = await service.create(userId, CAMPAIGN_INPUT);
    if (!created.ok) throw new Error('fixture creation failed');
    expect(await service.resolve(userId, CAMPAIGN_INPUT.id)).toBeDefined();
    expect(await service.delete(userId, CAMPAIGN_INPUT.id, created.value.version)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await service.resolve(userId, CAMPAIGN_INPUT.id)).toBeUndefined();
    expect(await service.list(userId)).toEqual([]);
  });
});
