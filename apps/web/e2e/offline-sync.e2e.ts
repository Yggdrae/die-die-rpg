import { expect, test } from '@playwright/test';

const CAMPAIGN = '00000000-0000-4000-8000-000000000099';

test.use({ serviceWorkers: 'block' });

test('serves an isolated worker context and pinned SQLite worker assets', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const worker = await page.request.get('/sync-assets/powersync-1.39.1/WASQLiteDB.umd.js');
  expect(worker.ok()).toBe(true);
});

for (const backend of ['opfs', 'indexeddb'] as const) {
  test(`${backend} SQLite replica survives restart and opens below two seconds`, async ({
    page,
  }) => {
    await page.goto('/');
    const filename = `sync-e2e-${backend}-${crypto.randomUUID()}.sqlite`;
    const result = await page.evaluate(
      async ({ backend, filename, campaignId }) => {
        const harness = await import('/src/features/sync/e2e-harness.ts');
        await harness.persistCampaignState({ backend, filename, campaignId });
        const samples: number[] = [];
        let state: string | undefined;
        for (let sample = 0; sample < 20; sample += 1) {
          const reopened = await harness.reopenCampaignState({ backend, filename, campaignId });
          state = reopened.state;
          samples.push(reopened.openMs);
        }
        samples.sort((left, right) => left - right);
        return { state, p95Ms: samples[18] };
      },
      { backend, filename, campaignId: CAMPAIGN },
    );
    console.info(`${backend} cold-open p95: ${result.p95Ms.toFixed(1)} ms`);
    expect(result.state).toBe('available');
    expect(result.p95Ms).toBeLessThan(2_000);
  });
}
