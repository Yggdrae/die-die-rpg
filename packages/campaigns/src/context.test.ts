import { describe, expect, test } from 'bun:test';
import { type ActorRef, err, ok } from '@rpg/contracts';
import type { CampaignMembershipWriter } from '@rpg/identity';
import { CampaignService } from './application.ts';
import { StaticSystemCatalog } from './catalog.ts';
import type { SystemCatalog, SystemDefinition } from './contracts.ts';
import { CAMPAIGN_INPUT, FIXTURE_SYSTEM } from './domain.test.ts';
import { CampaignSettingRegistry } from './domain.ts';
import { InMemoryCampaignRepository } from './memory.ts';

const OWNER = '22222222-2222-2222-2222-222222222222';
const OUTSIDER = '33333333-3333-3333-3333-333333333333';
const withVersion = (version: string): SystemDefinition => ({
  ...FIXTURE_SYSTEM,
  summary: { ...FIXTURE_SYSTEM.summary, ref: { ...FIXTURE_SYSTEM.summary.ref, version } },
});
const OTHER_SYSTEM: SystemDefinition = {
  ...FIXTURE_SYSTEM,
  summary: {
    ...FIXTURE_SYSTEM.summary,
    ref: { systemId: 'second-fixture', version: '1.0.0' },
    name: 'Lantern Hearth',
    shortDescription: 'Cooperative storytelling.',
  },
};

function service(catalog: SystemCatalog) {
  const ownerWriter: CampaignMembershipWriter = {
    createOwner: (input, transaction) => {
      const handle = transaction.handle as {
        insertOwner(candidate: typeof input): ReturnType<CampaignMembershipWriter['createOwner']>;
      };
      return handle.insertOwner(input);
    },
  };
  const actor: ActorRef = { userId: OWNER, campaignId: CAMPAIGN_INPUT.id, role: 'owner' };
  return new CampaignService(
    new InMemoryCampaignRepository(),
    catalog,
    {
      resolve: async (userId, campaignId) =>
        userId === OWNER && campaignId === CAMPAIGN_INPUT.id
          ? ok(actor)
          : err('membership_not_found'),
      listCampaignIds: async (userId) => (userId === OWNER ? [CAMPAIGN_INPUT.id] : []),
    },
    ownerWriter,
    { decide: () => true },
    new CampaignSettingRegistry(),
    { record: async () => undefined },
    { auditDegraded: () => undefined },
  );
}

describe('system catalog selection', () => {
  const catalog = new StaticSystemCatalog([
    withVersion('0.1.0'),
    withVersion('0.2.0'),
    OTHER_SYSTEM,
  ]);

  test('lists each installed system once and narrows by declared name or description', async () => {
    expect((await catalog.list()).map((summary) => summary.ref.systemId)).toEqual([
      'fixture-system',
      'second-fixture',
    ]);
    expect((await catalog.list('lantern')).map((summary) => summary.name)).toEqual([
      'Lantern Hearth',
    ]);
    expect((await catalog.list('storytelling')).map((summary) => summary.ref.systemId)).toEqual([
      'second-fixture',
    ]);
    expect(await catalog.list('no such declared text')).toEqual([]);
    expect(await catalog.list('')).toHaveLength(2);
  });

  test('exact and latest resolution never substitute one version for another', async () => {
    expect(
      (await catalog.resolveExact({ systemId: 'fixture-system', version: '0.1.0' }))?.summary.ref
        .version,
    ).toBe('0.1.0');
    expect(
      await catalog.resolveExact({ systemId: 'fixture-system', version: '0.9.0' }),
    ).toBeUndefined();
    expect((await catalog.resolveLatest('fixture-system'))?.summary.ref.version).toBe('0.2.0');
  });
});

describe('published campaign context', () => {
  test('returns the full shape at the pinned version even when a newer one is installed', async () => {
    const campaigns = service(
      new StaticSystemCatalog([withVersion('0.1.0'), withVersion('0.2.0')]),
    );
    expect((await campaigns.create(OWNER, CAMPAIGN_INPUT)).ok).toBe(true);
    expect(await campaigns.resolve(OWNER, CAMPAIGN_INPUT.id)).toEqual({
      campaignId: CAMPAIGN_INPUT.id,
      system: { systemId: 'fixture-system', version: '0.1.0' },
      gameMode: 'standard',
      modulePins: [{ moduleId: 'weather', version: '1.0.0' }],
      settings: { system: { tone: 'bright' } },
    });
  });

  test('denies a non-member and an unresolvable pin without substituting another version', async () => {
    const campaigns = service(
      new StaticSystemCatalog([withVersion('0.1.0'), withVersion('0.2.0')]),
    );
    await campaigns.create(OWNER, CAMPAIGN_INPUT);
    expect(await campaigns.resolve(OUTSIDER, CAMPAIGN_INPUT.id)).toBeUndefined();

    // The registry later loses the pinned version: fail closed, never fall back to 0.2.0.
    let installed = [withVersion('0.1.0'), withVersion('0.2.0')];
    const shrinking: SystemCatalog = {
      list: async (query) => new StaticSystemCatalog(installed).list(query),
      resolveExact: async (ref) => new StaticSystemCatalog(installed).resolveExact(ref),
      resolveLatest: async (id) => new StaticSystemCatalog(installed).resolveLatest(id),
    };
    const degraded = service(shrinking);
    await degraded.create(OWNER, CAMPAIGN_INPUT);
    expect(await degraded.resolve(OWNER, CAMPAIGN_INPUT.id)).toBeDefined();
    installed = [withVersion('0.2.0')];
    expect(await degraded.resolve(OWNER, CAMPAIGN_INPUT.id)).toBeUndefined();
  });
});
