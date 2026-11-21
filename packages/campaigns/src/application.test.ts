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

function harness(
  overrides: {
    audit?: AuditRecorder;
    log?: { auditDegraded(action: string, campaignId: string): void };
  } = {},
) {
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
  let actor: ActorRef = { userId, campaignId: CAMPAIGN_INPUT.id, role: 'owner' };
  const audits: string[] = [];
  const audit: AuditRecorder = overrides.audit ?? {
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
  settings.register({
    namespace: 'feature.secret',
    schema: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
    memberVisible: false,
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
      decide: (candidate, capability, _namespace, visibility) =>
        (candidate.role === 'owner' || capability === 'read') &&
        (visibility?.mode !== 'gm_only' || candidate.role === 'owner'),
    },
    settings,
    audit,
    overrides.log ?? { auditDegraded: () => undefined },
  );
  const actAs = (role: ActorRef['role']) => {
    actor = { ...actor, role };
  };
  return { service, repository, audits, actAs };
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

  test('setting writes are versioned per namespace, not per campaign', async () => {
    const { service } = harness();
    const created = await service.create(userId, CAMPAIGN_INPUT);
    if (!created.ok) throw new Error('fixture creation failed');
    const write = (value: boolean, expectedVersion: number | null) =>
      service.updateSetting(userId, CAMPAIGN_INPUT.id, 'feature.weather', {
        value: { enabled: value },
        expectedVersion,
      });
    expect(await write(true, 1)).toEqual({ ok: false, error: 'not_found_or_forbidden' });
    expect((await write(true, null)).ok).toBe(true);
    expect(await write(false, null)).toEqual({ ok: false, error: 'version_conflict' });
    expect((await write(false, 1)).ok).toBe(true);
    expect(await write(true, 1)).toEqual({ ok: false, error: 'version_conflict' });
    expect(await service.getSetting(userId, CAMPAIGN_INPUT.id, 'feature.weather')).toEqual({
      ok: true,
      value: { value: { enabled: false }, version: 2 },
    });
    expect(await service.getSetting(userId, CAMPAIGN_INPUT.id, 'system')).toEqual({
      ok: true,
      value: { value: { tone: 'bright' }, version: 1 },
    });
  });

  test('a setting that is not member-visible reads like a GM-only record', async () => {
    const { service, actAs } = harness();
    const created = await service.create(userId, CAMPAIGN_INPUT);
    if (!created.ok) throw new Error('fixture creation failed');
    for (const namespace of ['feature.secret', 'feature.weather']) {
      const written = await service.updateSetting(userId, CAMPAIGN_INPUT.id, namespace, {
        value: { enabled: true },
        expectedVersion: null,
      });
      expect(written.ok).toBe(true);
    }
    const hidden = { ok: true as const, value: { value: { enabled: true }, version: 1 } };
    expect(await service.getSetting(userId, CAMPAIGN_INPUT.id, 'feature.secret')).toEqual(hidden);
    actAs('player');
    expect(await service.getSetting(userId, CAMPAIGN_INPUT.id, 'feature.secret')).toEqual({
      ok: false,
      error: 'not_found_or_forbidden',
    });
    // Indistinguishable from a namespace that was never written.
    expect(await service.getSetting(userId, CAMPAIGN_INPUT.id, 'feature.never')).toEqual({
      ok: false,
      error: 'not_found_or_forbidden',
    });
    expect(await service.getSetting(userId, CAMPAIGN_INPUT.id, 'feature.weather')).toEqual(hidden);
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

  test('audit records actor, previous and new pin, deletion; failure never blocks state', async () => {
    const events: Array<{ action: string; actor: ActorRef; before?: unknown; after?: unknown }> =
      [];
    const degraded: string[] = [];
    const { service } = harness({
      audit: {
        record: async (event) => {
          events.push(event);
          if (event.action === 'campaign.deleted') throw new Error('audit store down');
        },
      },
      log: { auditDegraded: (action) => degraded.push(action) },
    });
    const created = await service.create(userId, CAMPAIGN_INPUT);
    if (!created.ok) throw new Error('fixture creation failed');
    // Keep current is the absence of a call: no event, pin unchanged.
    expect(events.map((event) => event.action)).toEqual(['campaign.created']);
    const updated = await service.updateSystem(userId, CAMPAIGN_INPUT.id, {
      targetVersion: '0.2.0',
      expectedVersion: created.value.version,
    });
    if (!updated.ok) throw new Error('update failed');
    expect(events.at(-1)).toMatchObject({
      action: 'campaign.system_updated',
      actor: { userId, role: 'owner' },
    });
    expect(JSON.stringify(events.at(-1))).toContain('0.1.0');
    expect(JSON.stringify(events.at(-1))).toContain('0.2.0');
    expect(await service.delete(userId, CAMPAIGN_INPUT.id, updated.value.version)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(degraded).toEqual(['campaign.deleted']);
    expect(await service.list(userId)).toEqual([]);
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
