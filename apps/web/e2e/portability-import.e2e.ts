import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * Feature 07 task 07, import half, against the real stack: the production `CampaignExport` and
 * `CampaignImport` in the browser (test-only host `features/portability/e2e-harness.tsx`), and the
 * real API composition root over PostgreSQL in a Bun helper (`fixtures/portability-api-server.ts`).
 * Export requests are forwarded with the GM's session and import requests with the importer's,
 * so the browser performs the whole round trip: export → download → upload → report.
 * Skipped when PostgreSQL is not reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/portability-api-server.ts';
const PACKAGES = 'apps/web/e2e/fixtures/rpgpack.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4187;
const API = `http://127.0.0.1:${PORT}`;
const API_ORIGIN = 'https://table.invalid';

// One helper server on a fixed port: run the file's tests in one worker.
test.describe.configure({ mode: 'serial' });

interface Fixture {
  readonly campaignId: string;
  readonly gm: { readonly cookie: string; readonly userId: string };
  readonly importer: { readonly cookie: string; readonly userId: string };
}

let server: ChildProcess | undefined;
let fixture: Fixture | undefined;

test.beforeAll(async () => {
  test.setTimeout(60_000);
  if ((process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL) === undefined) return;
  const child = spawn('bun', [HELPER, 'serve', String(PORT)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  fixture = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk
        .toString()
        .split('\n')
        .find((entry) => entry.includes('"ready"'));
      if (line === undefined) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
});

test.afterAll(() => {
  server?.kill();
  if (fixture !== undefined) {
    execFileSync('bun', [HELPER, 'cleanup', fixture.gm.userId, fixture.importer.userId], {
      env: process.env,
    });
  }
});

/** Forwards API calls to the helper; exports as the GM, imports as the importer. */
async function forward(page: Page, current: Fixture): Promise<string[]> {
  const seen: string[] = [];
  const relay = (cookie: string) => async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    const request = route.request();
    seen.push(`${request.method()} ${new URL(request.url()).pathname}`);
    const response = await route.fetch({
      url: request.url().replace(APP, API),
      headers: { ...request.headers(), origin: API_ORIGIN, cookie },
    });
    await route.fulfill({ response });
  };
  // Playwright does not always expose a Blob request body to routes (WebKit: never), so the relay
  // would forward nothing. The app sends the file itself; only this test copy buffers it.
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) =>
      init?.body instanceof Blob
        ? real(input, { ...init, body: await init.body.arrayBuffer() })
        : real(input, init);
  });
  await page.route(`${APP}/campaigns/*/exports`, relay(current.gm.cookie));
  await page.route(`${APP}/exports/**`, relay(current.gm.cookie));
  await page.route(`${APP}/imports/**`, relay(current.importer.cookie));
  return seen;
}

async function mount(page: Page, campaignId: string) {
  await page.goto('/');
  await page.evaluate(async (id) => {
    const harness = await import('/src/features/portability/e2e-harness.tsx');
    harness.mountRoundTripHarness({ campaignId: id });
  }, campaignId);
  await expect(page.getByRole('button', { name: 'Import campaign' })).toBeDisabled();
}

async function api(path: string, cookie: string) {
  const response = await fetch(`${API}${path}`, { headers: { cookie } });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

function packageFile(variant: string): string {
  const path = test.info().outputPath(`${variant}.rpgpack`);
  writeFileSync(
    path,
    Buffer.from(
      execFileSync('bun', [PACKAGES, 'importable', variant], { encoding: 'utf8' }),
      'base64',
    ),
  );
  return path;
}

test.describe('campaign import on the real stack', () => {
  test.beforeEach(() => {
    test.skip(fixture === undefined, 'PostgreSQL is not reachable');
  });

  test('round trip in the browser: export → download → import → a new campaign the importer owns', async ({
    page,
  }) => {
    if (fixture === undefined) return;
    const seen = await forward(page, fixture);
    await mount(page, fixture.campaignId);

    await page.getByLabel('I understand this file reveals GM secrets').check();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export campaign' }).click();
    const path = test.info().outputPath('round-trip.rpgpack');
    await (await download).saveAs(path);

    await page.getByLabel('Campaign file (.rpgpack)').setInputFiles(path);
    await page.getByRole('button', { name: 'Import campaign' }).click();
    const result = page.locator('[data-import-campaign]');
    await expect(result).toContainText('Imported as a new campaign. You are its owner.');
    await expect(result.locator('[data-module="campaign"]')).toHaveText('campaign: 1 restored');
    await expect(result.locator('[data-module="attachments"]')).toHaveText(
      'attachments: 0 restored',
    );
    const campaignId = (await result.getAttribute('data-import-campaign')) ?? '';
    expect(campaignId).not.toBe(fixture.campaignId);

    // Through the API: equivalent campaign, the importer is the sole owner, the GM sees nothing.
    const source = await api(`/campaigns/${fixture.campaignId}`, fixture.gm.cookie);
    const restored = await api(`/campaigns/${campaignId}`, fixture.importer.cookie);
    expect(restored.status).toBe(200);
    for (const field of ['name', 'description', 'system', 'gameMode', 'modulePins', 'settings']) {
      expect(restored.body[field]).toEqual(source.body[field]);
    }
    const members = await api(`/campaigns/${campaignId}/members`, fixture.importer.cookie);
    expect(
      members.body.items.map((item: { user: { id: string }; role: string }) => [
        item.user.id,
        item.role,
      ]),
    ).toEqual([[fixture.importer.userId, 'owner']]);
    expect((await api(`/campaigns/${campaignId}`, fixture.gm.cookie)).status).toBe(404);
    expect(seen.filter((entry) => entry.startsWith('POST /imports/'))).toHaveLength(1);
  });

  test('Scenario: Unknown chunks are reported and preserved (shown, never rendered as content)', async ({
    page,
  }) => {
    if (fixture === undefined) return;
    await forward(page, fixture);
    await mount(page, fixture.campaignId);
    let dialogs = 0;
    page.on('dialog', (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });
    await page.getByLabel('Campaign file (.rpgpack)').setInputFiles(packageFile('unknown_chunk'));
    await page.getByRole('button', { name: 'Import campaign' }).click();
    const kept = page.locator('[data-preserved="future-notes"]');
    await expect(kept).toHaveText(
      'future-notes (version 4) was kept unchanged for a later export but not restored: unknown to this installation.',
    );
    await expect(page.locator('img')).toHaveCount(0);
    expect(dialogs).toBe(0);
  });

  test('Scenario: An unavailable pinned system blocks before write', async ({ page }) => {
    if (fixture === undefined) return;
    await forward(page, fixture);
    await mount(page, fixture.campaignId);
    const before = await api('/campaigns', fixture.importer.cookie);
    await page
      .getByLabel('Campaign file (.rpgpack)')
      .setInputFiles(packageFile('unavailable_system'));
    await page.getByRole('button', { name: 'Import campaign' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toHaveText(
      'This file needs the game system fixture-system version 9.9.9, which this installation does not have. No other version is used instead. Nothing was imported.',
    );
    await expect(alert).toHaveAttribute('data-error-code', 'system_unavailable');
    expect(await api('/campaigns', fixture.importer.cookie)).toEqual(before);
  });

  test('Scenario: Invalid package input changes nothing (hostile file)', async ({ page }) => {
    if (fixture === undefined) return;
    await forward(page, fixture);
    await mount(page, fixture.campaignId);
    const before = await api('/campaigns', fixture.importer.cookie);
    const path = test.info().outputPath('hostile.rpgpack');
    writeFileSync(path, Buffer.from('PK\u0003\u0004<script>alert(1)</script>'.repeat(20)));
    await page.getByLabel('Campaign file (.rpgpack)').setInputFiles(path);
    await page.getByRole('button', { name: 'Import campaign' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('This is not a valid campaign file');
    await expect(alert).toContainText('Nothing was imported.');
    await expect(alert).not.toContainText('script');
    expect(await api('/campaigns', fixture.importer.cookie)).toEqual(before);
  });

  test('offline: import needs the server and sends nothing', async ({ page, context }) => {
    if (fixture === undefined) return;
    const seen = await forward(page, fixture);
    await mount(page, fixture.campaignId);
    await page.getByLabel('Campaign file (.rpgpack)').setInputFiles(packageFile('valid'));
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Import campaign' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Importing needs a connection to the server. Nothing was imported.',
    );
    expect(seen).toEqual([]);
    await context.setOffline(false);
  });
});
