import { execFileSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';

/**
 * Feature 07 tasks 04–05 in the browser. The page is the production `CampaignExport` mounted by a
 * test-only host (`features/portability/e2e-harness.tsx`). Online, the API is a route mock with the
 * wire contract of the export routes (their owner/gm authorization, job scoping and streaming are
 * proved against Fastify and PostgreSQL in `apps/api/src/campaign-export.integration.test.ts`);
 * the file it streams is a real package from the production writer. Offline, the export runs over
 * local data only: the production browser-replica composition must refuse explicitly, and a
 * complete local source must produce a valid package with the network down.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const JOB = '00000000-0000-4000-8000-0000000000e1';
const HELPER = 'apps/web/e2e/fixtures/rpgpack.ts';

function inspect(path: string): Record<string, unknown> {
  return JSON.parse(execFileSync('bun', [HELPER, 'inspect', path], { encoding: 'utf8' }));
}

async function mount(page: Page, replica: 'browser' | 'complete') {
  await page.goto('/');
  await page.evaluate(
    async (input) => {
      const harness = await import('/src/features/portability/e2e-harness.tsx');
      harness.mountPortabilityHarness(
        input as Parameters<typeof harness.mountPortabilityHarness>[0],
      );
    },
    { campaignId: CAMPAIGN, replica },
  );
  await expect(page.getByRole('button', { name: 'Export campaign' })).toBeVisible();
}

async function mockExportApi(page: Page, serverDecision: 'allow' | 'deny') {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const pkg = Buffer.from(
    execFileSync('bun', [HELPER, 'build', CAMPAIGN], { encoding: 'utf8' }),
    'base64',
  );
  await page.route('**/campaigns/*/exports', async (route) => {
    const request = route.request();
    requests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postDataJSON(),
    });
    if (serverDecision === 'deny') {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'not_found_or_forbidden', message: 'Not found.' }),
      });
    }
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId: JOB,
        campaignId: CAMPAIGN,
        state: 'completed',
        summary: [
          { moduleId: 'attachments', chunkVersion: '1', records: 0, bytes: 80 },
          { moduleId: 'campaign', chunkVersion: '1', records: 1, bytes: 90 },
        ],
        createdAt: '2026-10-27T12:00:00.000Z',
        completedAt: '2026-10-27T12:00:01.000Z',
        fileAvailableUntil: '2026-10-27T12:10:01.000Z',
      }),
    });
  });
  await page.route('**/exports/*/file', async (route) => {
    requests.push({ method: 'GET', path: new URL(route.request().url()).pathname, body: null });
    return route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="campaign-${JOB}.rpgpack"`,
        'cache-control': 'no-store',
      },
      body: pkg,
    });
  });
  return requests;
}

test('Scenario: A GM exports one campaign as one file (warning first, valid package)', async ({
  page,
}) => {
  const requests = await mockExportApi(page, 'allow');
  await mount(page, 'browser');
  await expect(page.getByRole('note')).toContainText('including GM-only secrets');
  await expect(page.getByRole('note')).toContainText('no access control once downloaded');
  const button = page.getByRole('button', { name: 'Export campaign' });
  await expect(button).toBeDisabled();
  await page.getByLabel('I understand this file reveals GM secrets').check();
  const download = page.waitForEvent('download');
  await button.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`campaign-${JOB}.rpgpack`);
  const path = test.info().outputPath('online.rpgpack');
  await file.saveAs(path);
  expect(inspect(path)).toEqual({
    ok: true,
    exportedBy: 'gm_ana',
    content: { attachmentBinaries: 'excluded', audit: 'excluded' },
    systemLock: { systemId: 'fixture-system', version: '0.1.0' },
    modules: ['attachments', 'campaign'],
  });
  await expect(page.locator('[data-export-source="online"]')).toContainText('campaign 1');
  expect(requests).toEqual([
    {
      method: 'POST',
      path: `/campaigns/${CAMPAIGN}/exports`,
      body: { jobId: expect.any(String), acknowledgeGmSecrets: true },
    },
    { method: 'GET', path: `/exports/${JOB}/file`, body: null },
  ]);
});

test('Scenario: A player cannot export a campaign (server denial, no file)', async ({ page }) => {
  const requests = await mockExportApi(page, 'deny');
  await mount(page, 'browser');
  let downloads = 0;
  page.on('download', () => {
    downloads += 1;
  });
  await page.getByLabel('I understand this file reveals GM secrets').check();
  await page.getByRole('button', { name: 'Export campaign' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Only the campaign owner or a game master can export this campaign.',
  );
  expect(downloads).toBe(0);
  expect(requests.map((request) => request.path)).toEqual([`/campaigns/${CAMPAIGN}/exports`]);
});

test('offline over the browser replica: explicit refusal, never a partial backup', async ({
  page,
  context,
}) => {
  await mount(page, 'browser');
  const network: string[] = [];
  page.on('request', (request) => network.push(request.url()));
  let downloads = 0;
  page.on('download', () => {
    downloads += 1;
  });
  await context.setOffline(true);
  await page.getByLabel('I understand this file reveals GM secrets').check();
  await page.getByRole('button', { name: 'Export campaign' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Cannot export offline');
  await expect(alert).toContainText('No partial file was created');
  await expect(alert).toHaveAttribute(
    'data-incomplete-modules',
    'attachments,campaign,characters,content,dice_rolls,encounters,sessions',
  );
  expect(downloads).toBe(0);
  expect(network.filter((url) => url.includes('/exports'))).toEqual([]);
  await context.setOffline(false);
});

test('Scenario: A synchronized campaign can be exported offline (complete local data)', async ({
  page,
  context,
}) => {
  await mount(page, 'complete');
  const network: string[] = [];
  page.on('request', (request) => network.push(request.url()));
  await context.setOffline(true);
  await page.getByLabel('I understand this file reveals GM secrets').check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export campaign' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`campaign-${CAMPAIGN}-offline.rpgpack`);
  const path = test.info().outputPath('offline.rpgpack');
  await file.saveAs(path);
  expect(inspect(path)).toEqual({
    ok: true,
    exportedBy: 'gm_ana',
    content: { attachmentBinaries: 'excluded', audit: 'excluded' },
    systemLock: { systemId: 'fixture-system', version: '0.1.0' },
    modules: ['attachments', 'campaign'],
  });
  await expect(page.locator('[data-export-source="offline"]')).toBeVisible();
  expect(network.filter((url) => !url.startsWith('blob:'))).toEqual([]);
  await context.setOffline(false);
});
