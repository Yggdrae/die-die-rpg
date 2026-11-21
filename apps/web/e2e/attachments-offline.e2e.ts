import { execFileSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';

/**
 * Feature 05 task 05 (and the offline part of task 07): campaign pinning in a real browser. The
 * page is the production `OfflineAttachments` panel over the production IndexedDB store and HTTP
 * source (`features/attachments/offline-e2e-harness.tsx`). The API is a route mock with the wire
 * contract of `GET .../attachments/offline-estimate` and `GET .../read` (their authorization is
 * proved against Fastify in `apps/api/src/modules/attachments/*.test.ts`); the read URLs are real
 * five-minute grants from the production S3 adapter, so every byte comes from the real provider.
 * Skipped when the provider is unreachable.
 */

const USER = '00000000-0000-4000-8000-0000000000b1';
const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-000000001001';
const HELPER = 'apps/web/e2e/fixtures/attachment-objects.ts';
const APP = 'http://127.0.0.1:4173';
const IDS = {
  png: '00000000-0000-4000-8000-000000009101',
  pdf: '00000000-0000-4000-8000-000000009102',
  large: '00000000-0000-4000-8000-000000009103',
  broken: '00000000-0000-4000-8000-000000009104',
} as const;

interface StoredObject {
  key: string;
  url: string;
  size: number;
  checksum: string;
}
type Objects = Record<'png' | 'pdf' | 'large', StoredObject>;

let objects: Objects | undefined;

test.beforeAll(() => {
  try {
    objects = JSON.parse(
      execFileSync('bun', [HELPER, 'offline'], { encoding: 'utf8', timeout: 30_000 }),
    ) as Objects;
  } catch {
    objects = undefined;
  }
});

test.afterAll(() => {
  if (objects !== undefined) {
    execFileSync('bun', [HELPER, 'delete', ...Object.values(objects).map((entry) => entry.key)]);
  }
});

function metadata(id: string, mime: string, filename: string, size: number, checksum: string) {
  return {
    attachmentId: id,
    campaignId: CAMPAIGN,
    owner: { resourceClass: 'fixture_note', resourceId: OWNER },
    filename,
    mime,
    size,
    checksum,
    status: 'ready',
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: '2026-10-27T12:00:00.000Z',
    createdBy: USER,
    updatedAt: '2026-10-27T12:00:00.000Z',
    updatedBy: USER,
    finalizedAt: '2026-10-27T12:00:00.000Z',
  };
}

type Item = ReturnType<typeof metadata>;

/** Route-mocked API; `state` changes what the authority answers (visibility, revocation). */
interface Api {
  items: Item[];
  /** Attachment IDs whose read grant is denied (404). */
  denied: Set<string>;
  /** Attachment IDs whose read grant fails (503). */
  failing: Set<string>;
  revoked: boolean;
  offline: boolean;
  apiRequests: string[];
  storageRequests: string[];
}

function catalog(fixtures: Objects): Item[] {
  return [
    metadata(IDS.png, 'image/png', 'harbor-map.png', fixtures.png.size, fixtures.png.checksum),
    metadata(IDS.pdf, 'application/pdf', 'letter.pdf', fixtures.pdf.size, fixtures.pdf.checksum),
    metadata(IDS.large, 'image/png', 'atlas.png', fixtures.large.size, fixtures.large.checksum),
  ];
}

async function mount(page: Page, fixtures: Objects, api: Api) {
  const urls: Record<string, string> = {
    [IDS.png]: fixtures.png.url,
    [IDS.pdf]: fixtures.pdf.url,
    [IDS.large]: fixtures.large.url,
  };
  const storageOrigin = new URL(fixtures.png.url).origin;
  page.on('request', (request) => {
    if (request.url().startsWith(storageOrigin)) api.storageRequests.push(request.url());
  });
  await page.route(`${APP}/campaigns/**`, async (route) => {
    if (api.offline) return route.abort('internetdisconnected');
    const url = new URL(route.request().url());
    api.apiRequests.push(url.pathname);
    const notFound = () =>
      route.fulfill({
        status: 404,
        json: { code: 'not_found_or_forbidden', message: 'Not found.' },
      });
    if (url.pathname === `/campaigns/${CAMPAIGN}/attachments/offline-estimate`) {
      if (api.revoked) return notFound();
      return route.fulfill({
        json: {
          items: api.items,
          totalBytes: api.items.reduce((sum, item) => sum + item.size, 0),
        },
        headers: { 'cache-control': 'no-store' },
      });
    }
    const match = /^\/campaigns\/[^/]+\/attachments\/([^/]+)\/read$/.exec(url.pathname);
    const id = match?.[1] ?? '';
    if (api.revoked || api.denied.has(id) || !api.items.some((item) => item.attachmentId === id)) {
      return notFound();
    }
    if (api.failing.has(id) || urls[id] === undefined) {
      return route.fulfill({ status: 503, json: { code: 'storage_unavailable', message: 'x' } });
    }
    return route.fulfill({
      json: {
        attachmentId: id,
        method: 'GET',
        url: urls[id],
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        mime: api.items.find((item) => item.attachmentId === id)?.mime,
        disposition: 'inline',
      },
      headers: { 'cache-control': 'no-store' },
    });
  });
  await page.goto('/');
  await page.evaluate(
    async (input) => {
      const harness = await import('/src/features/attachments/offline-e2e-harness.tsx');
      await harness.mountOfflineHarness(input);
    },
    { userId: USER, campaignId: CAMPAIGN },
  );
  await expect(page.getByTestId('app-shell')).toBeVisible();
}

/** What this device holds: records and byte lengths straight from IndexedDB. */
function device(page: Page) {
  return page.evaluate(async () => {
    const handle = window.__offlineAttachments;
    if (handle === undefined) throw new Error('harness not mounted');
    const records = await handle.db.all();
    const bytes: Record<string, number> = {};
    for (const record of records) {
      const stored = await handle.db.bytes(record.attachmentId);
      if (stored !== undefined) bytes[record.attachmentId] = stored.byteLength;
    }
    return {
      records: Object.fromEntries(records.map((record) => [record.attachmentId, record.state])),
      filenames: records.map((record) => record.filename),
      bytes,
    };
  });
}

function freshApi(fixtures: Objects): Api {
  return {
    items: catalog(fixtures),
    denied: new Set(),
    failing: new Set(),
    revoked: false,
    offline: false,
    apiRequests: [],
    storageRequests: [],
  };
}

async function pinAll(page: Page) {
  await page.getByRole('button', { name: 'Make available offline' }).click();
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByText(/downloaded\./)).toBeVisible({ timeout: 20_000 });
}

test.describe('campaign offline availability against the storage provider', () => {
  test.beforeEach(() => {
    test.skip(objects === undefined, 'object storage is not reachable');
  });

  // Scenarios: Campaign pinning requires an explicit confirmation; Dismissing the estimate
  // downloads nothing.
  test('the size estimate comes before any download, and dismissing it downloads nothing', async ({
    page,
  }) => {
    if (objects === undefined) return;
    const api = freshApi(objects);
    await mount(page, objects, api);
    await page.getByRole('button', { name: 'Make available offline' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm offline download' });
    await expect(dialog).toContainText('Download 3 attachments (1.5 MB)');
    const estimate = Number(
      await dialog.locator('[data-estimated-bytes]').getAttribute('data-estimated-bytes'),
    );
    expect(estimate).toBe(objects.png.size + objects.pdf.size + objects.large.size);
    expect(api.storageRequests).toEqual([]);
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.storageRequests).toEqual([]);
    expect(await device(page)).toEqual({ records: {}, filenames: [], bytes: {} });
  });

  // Scenarios: Confirming campaign pinning reports progress; The offline estimate stays within
  // its declared tolerance; Repeating campaign pinning does not duplicate local content.
  test('confirming downloads verified bytes with progress; the estimate is exact; repeating costs nothing', async ({
    page,
  }) => {
    if (objects === undefined) return;
    const api = freshApi(objects);
    await mount(page, objects, api);
    await page.getByRole('button', { name: 'Make available offline' }).click();
    const estimate = Number(
      await page.locator('[data-estimated-bytes]').getAttribute('data-estimated-bytes'),
    );
    await page.getByRole('button', { name: 'Download' }).click();
    await expect(page.getByText('3 of 3 downloaded.')).toBeVisible({ timeout: 20_000 });
    for (const id of Object.values(IDS).slice(0, 3)) {
      await expect(page.locator(`li[data-attachment-id="${id}"]`)).toHaveAttribute(
        'data-availability',
        'pinned',
      );
    }
    const held = await device(page);
    const actual = Object.values(held.bytes).reduce((sum, value) => sum + value, 0);
    expect(Math.abs(actual - estimate)).toBeLessThanOrEqual(
      Math.max(1_048_576, Math.ceil(estimate * 0.01)),
    );
    expect(actual).toBe(estimate);
    expect(
      Number(await page.locator('[data-stored-bytes]').getAttribute('data-stored-bytes')),
    ).toBe(actual);

    const storage = api.storageRequests.length;
    await page.getByRole('button', { name: 'Make available offline' }).click();
    await expect(page.getByText('All 3 attachments are already available offline.')).toBeVisible();
    expect(api.storageRequests.length).toBe(storage);
    expect(await device(page)).toEqual(held);
  });

  // Scenarios: A pinned attachment opens without a network; A pinned campaign survives network
  // loss; Uploaded content cannot execute in the application origin (local copies).
  test('after a restart with the network down, every pinned attachment opens from local content', async ({
    page,
    context,
    browserName,
  }) => {
    if (objects === undefined) return;
    const api = freshApi(objects);
    await mount(page, objects, api);
    await pinAll(page);
    // Restart: a new page load and a new store over the same device data.
    await page.reload();
    await page.evaluate(
      async (input) => {
        const harness = await import('/src/features/attachments/offline-e2e-harness.tsx');
        await harness.mountOfflineHarness(input);
      },
      { userId: USER, campaignId: CAMPAIGN },
    );
    api.offline = true;
    // Playwright WebKit's offline mode also fails `blob:` loads, which use no network at all. The
    // routes above still refuse every API and storage request there, and the counts below prove it.
    if (browserName !== 'webkit') await context.setOffline(true);
    const before = { api: api.apiRequests.length, storage: api.storageRequests.length };
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    await page.getByRole('button', { name: 'Open harbor-map.png' }).click();
    const image = page.getByRole('img', { name: 'harbor-map.png' });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(2);
    expect(await image.evaluate((node: HTMLImageElement) => node.src)).toMatch(/^blob:/);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Open letter.pdf' }).click();
    expect((await download).suggestedFilename()).toBe('letter.pdf');
    await page.getByRole('button', { name: 'Open atlas.png' }).click();
    await expect(page.locator(`li[data-attachment-id="${IDS.large}"] img`)).toBeVisible();

    expect({ api: api.apiRequests.length, storage: api.storageRequests.length }).toEqual(before);
    expect(await page.locator('iframe, embed, object').count()).toBe(0);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(dialogs).toEqual([]);
    await context.setOffline(false);
  });

  // Scenarios: Missing local content degrades clearly; Availability state reflects the observed
  // condition (unavailable).
  test('an attachment that could not be downloaded reports unavailable offline; the page stays usable', async ({
    page,
    context,
  }) => {
    if (objects === undefined) return;
    const api = freshApi(objects);
    api.failing.add(IDS.large);
    await mount(page, objects, api);
    await pinAll(page);
    await expect(page.getByText('2 of 3 downloaded. 1 could not be downloaded.')).toBeVisible();
    expect((await device(page)).bytes[IDS.large]).toBeUndefined();
    api.offline = true;
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    const row = page.locator(`li[data-attachment-id="${IDS.large}"]`);
    await expect(row).toHaveAttribute('data-availability', 'unavailable');
    await expect(row).toContainText('Unavailable offline');
    await row.getByRole('button', { name: 'Open atlas.png' }).click();
    await expect(row.getByText('Preview unavailable.')).toBeVisible();
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.getByRole('button', { name: 'Open harbor-map.png' }).click();
    await expect(page.getByRole('img', { name: 'harbor-map.png' })).toBeVisible();
    await context.setOffline(false);
  });

  // Scenario: Only currently visible attachments are pinned; feature 04 narrowing and feature
  // 01 revocation remove local metadata and bytes on observed synchronization.
  test('narrowing, a denied read and revocation remove metadata and bytes from the device', async ({
    page,
  }) => {
    if (objects === undefined) return;
    const api = freshApi(objects);
    await mount(page, objects, api);
    await pinAll(page);
    expect(Object.keys((await device(page)).bytes)).toHaveLength(3);

    // Visibility narrowed: the authority no longer lists the PDF.
    api.items = api.items.filter((item) => item.attachmentId !== IDS.pdf);
    await page.evaluate(() => window.__offlineAttachments?.store.reconcileAll());
    let held = await device(page);
    expect(held.records[IDS.pdf]).toBeUndefined();
    expect(held.bytes[IDS.pdf]).toBeUndefined();
    expect(held.filenames).not.toContain('letter.pdf');
    await expect(page.locator(`li[data-attachment-id="${IDS.pdf}"]`)).toHaveCount(0);

    // A read check denied while online: the copy is removed instead of opened.
    api.denied.add(IDS.large);
    await page.getByRole('button', { name: 'Open atlas.png' }).click();
    await expect(page.locator(`li[data-attachment-id="${IDS.large}"]`)).toHaveCount(0);
    held = await device(page);
    expect(held.bytes[IDS.large]).toBeUndefined();

    // Membership revoked: the next observed sync gets 404 and the campaign leaves the device.
    api.revoked = true;
    await page.evaluate(() => window.__offlineAttachments?.store.reconcileAll());
    expect(await device(page)).toEqual({ records: {}, filenames: [], bytes: {} });
  });

  test('the feature 03 replica purge (revocation, sign-out) removes bytes and aborts downloads', async ({
    page,
  }) => {
    if (objects === undefined) return;
    const api = freshApi(objects);
    await mount(page, objects, api);
    // Hold the large download until the purge has run.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`${new URL(objects.large.url).origin}/**`, async (route) => {
      if (
        route
          .request()
          .url()
          .includes(objects?.large.key ?? '-')
      )
        await held;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Make available offline' }).click();
    await page.getByRole('button', { name: 'Download' }).click();
    await expect(page.locator(`li[data-attachment-id="${IDS.large}"]`)).toHaveAttribute(
      'data-availability',
      'downloading',
    );
    await page.evaluate(
      (campaignId) =>
        window.__offlineAttachments?.store.replicaPurged({
          campaignId,
          replicaId: '00000000-0000-4000-8000-00000000f001',
          reason: 'access_revoked',
          purgedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        }),
      CAMPAIGN,
    );
    release();
    await expect(page.getByText(/downloaded\./)).toBeVisible({ timeout: 20_000 });
    expect(await device(page)).toEqual({ records: {}, filenames: [], bytes: {} });
  });
});
