import { describe, expect, test } from 'bun:test';
import { InMemoryRepository } from '@rpg/contracts/testing';
import { CAMPAIGN_INPUT, FIXTURE_SYSTEM } from './domain.test.ts';
import { type CampaignReplica, OfflineCampaignRepository } from './offline.ts';

describe('offline campaign adapter', () => {
  test('stores one stable aggregate and reads it after service restart', async () => {
    const repository = new InMemoryRepository<CampaignReplica>();
    const queued: unknown[] = [];
    const invitations = { queue: async (input: unknown) => void queued.push(input) };
    const first = new OfflineCampaignRepository(repository, invitations);
    const created = await first.create(
      '22222222-2222-2222-2222-222222222222',
      CAMPAIGN_INPUT,
      FIXTURE_SYSTEM,
      ['player'],
    );
    expect(created.ok).toBe(true);

    const restarted = new OfflineCampaignRepository(repository, invitations);
    expect(await restarted.getContext(CAMPAIGN_INPUT.id)).toMatchObject({
      campaignId: CAMPAIGN_INPUT.id,
      system: CAMPAIGN_INPUT.system,
    });
    expect(repository.size).toBe(1);
  });

  test('does not report invitations queued before authority accepts campaign', async () => {
    const repository = new InMemoryRepository<CampaignReplica>();
    const queued: unknown[] = [];
    const service = new OfflineCampaignRepository(repository, {
      queue: async (input) => void queued.push(input),
    });
    await service.create('22222222-2222-2222-2222-222222222222', CAMPAIGN_INPUT, FIXTURE_SYSTEM, [
      'player',
    ]);
    expect(queued).toEqual([]);
    const restarted = new OfflineCampaignRepository(repository, {
      queue: async (input) => void queued.push(input),
    });
    await restarted.authorityAccepted(CAMPAIGN_INPUT.id);
    expect(queued).toEqual([
      expect.objectContaining({ campaignId: CAMPAIGN_INPUT.id, role: 'player' }),
    ]);
  });
});
