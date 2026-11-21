import { execFileSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';

/**
 * Feature 05 tasks 01 and 04: safe rendering against the real storage provider. The page is the
 * production `AttachmentList` mounted by a test-only host (`features/attachments/e2e-harness.tsx`);
 * the API is a route mock with the wire contract of the read/list routes (their authorization is
 * proved against Fastify, PostgreSQL and MinIO in `apps/api/src/modules/attachments/*.test.ts`).
 * The read URLs are real five-minute grants from the production S3 adapter, signed by a Bun helper
 * because Playwright runs under Node. Skipped when the provider is unreachable.
 */

const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-000000001001';
const CLASS = 'fixture_note';
const IMAGE_ID = '00000000-0000-4000-8000-000000009001';
const PDF_ID = '00000000-0000-4000-8000-000000009002';
const HELPER = 'apps/web/e2e/fixtures/attachment-objects.ts';

interface Fixtures {
  keys: string[];
  png: string;
  pdf: string;
  pdfDownload: string;
  hostile: string;
  expiring: string;
  storageOrigin: string;
}

let fixtures: Fixtures | undefined;

test.beforeAll(() => {
  try {
    fixtures = JSON.parse(
      execFileSync('bun', [HELPER, 'upload'], { encoding: 'utf8', timeout: 30_000 }),
    ) as Fixtures;
  } catch {
    fixtures = undefined;
  }
});

test.afterAll(() => {
  if (fixtures !== undefined) execFileSync('bun', [HELPER, 'delete', ...fixtures.keys]);
});

function metadata(id: string, mime: string, filename: string) {
  return {
    attachmentId: id,
    campaignId: CAMPAIGN,
    owner: { resourceClass: CLASS, resourceId: OWNER },
    filename,
    mime,
    size: 2048,
    checksum: 'a'.repeat(64),
    status: 'ready',
    visibility: { mode: 'everyone' },
    version: 1,
    createdAt: '2026-10-27T12:00:00.000Z',
    createdBy: OWNER,
    updatedAt: '2026-10-27T12:00:00.000Z',
    updatedBy: OWNER,
    finalizedAt: '2026-10-27T12:00:00.000Z',
  };
}

/** Same wire contract as the API; `reads` maps attachment + disposition to a URL or a status. */
async function mount(
  page: Page,
  items: ReturnType<typeof metadata>[],
  reads: Record<string, string | number>,
) {
  const appOrigin = 'http://127.0.0.1:4173';
  // Only the application origin: storage paths also contain `/campaigns/`.
  await page.route(`${appOrigin}/campaigns/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/campaigns/${CAMPAIGN}/resources/${CLASS}/${OWNER}/attachments`) {
      return route.fulfill({ json: { items } });
    }
    const match = /^\/campaigns\/[^/]+\/attachments\/([^/]+)\/read$/.exec(url.pathname);
    const disposition = url.searchParams.get('disposition') ?? 'inline';
    const answer = match === null ? undefined : reads[`${match[1]}:${disposition}`];
    if (typeof answer === 'string') {
      return route.fulfill({
        json: {
          attachmentId: match?.[1],
          method: 'GET',
          url: answer,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          mime: items.find((item) => item.attachmentId === match?.[1])?.mime,
          disposition,
        },
        headers: { 'cache-control': 'no-store' },
      });
    }
    return route.fulfill({
      status: typeof answer === 'number' ? answer : 404,
      json: { code: 'not_found_or_forbidden', message: 'Not found.' },
    });
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('rpg-e2e-marker', 'app-secret'));
  await page.evaluate(
    async (input) => {
      const harness = await import('/src/features/attachments/e2e-harness.tsx');
      harness.mountAttachmentHarness(input);
    },
    { campaignId: CAMPAIGN, resourceClass: CLASS, resourceId: OWNER },
  );
}

test.describe('attachment rendering against the storage provider', () => {
  test.beforeEach(() => {
    test.skip(fixtures === undefined, 'object storage is not reachable');
  });

  test('an image renders inert from the storage origin while the app stays cross-origin isolated', async ({
    page,
  }) => {
    if (fixtures === undefined) return;
    await mount(page, [metadata(IMAGE_ID, 'image/png', 'harbor-map.png')], {
      [`${IMAGE_ID}:inline`]: fixtures.png,
    });
    const image = page.getByRole('img', { name: 'harbor-map.png' });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(2);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const source = new URL(await image.evaluate((node: HTMLImageElement) => node.currentSrc));
    expect(source.origin).toBe(fixtures.storageOrigin);
    expect(source.origin).not.toBe(new URL(page.url()).origin);
    // Evidence for the `crossorigin` attribute: without CORS, COEP require-corp blocks the image.
    const blocked = await page.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve('loaded');
          probe.onerror = () => resolve('blocked');
          probe.src = url;
        }),
      fixtures.png,
    );
    expect(blocked).toBe('blocked');
  });

  test('active content served under an image type never executes and degrades to unavailable', async ({
    page,
  }) => {
    if (fixtures === undefined) return;
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await mount(page, [metadata(IMAGE_ID, 'image/png', 'trap.png')], {
      [`${IMAGE_ID}:inline`]: fixtures.hostile,
    });
    await expect(page.getByText('Preview unavailable.')).toBeVisible();
    await expect(page.getByTestId('app-shell')).toBeVisible();
    expect(
      await page.evaluate(() => (window as { __attachmentPwned?: boolean }).__attachmentPwned),
    ).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(await page.locator('iframe, embed, object').count()).toBe(0);
  });

  test('a PDF opens only in a separate storage-origin context with no opener', async ({
    page,
    context,
    browserName,
    isMobile,
  }) => {
    test.skip(
      browserName !== 'chromium' || isMobile,
      'no built-in PDF viewer here: the new tab downloads the file and never reaches a URL',
    );
    if (fixtures === undefined) return;
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await mount(page, [metadata(PDF_ID, 'application/pdf', 'letter.pdf')], {
      [`${PDF_ID}:inline`]: fixtures.pdf,
      [`${PDF_ID}:attachment`]: fixtures.pdfDownload,
    });
    expect(await page.locator('iframe, embed, object').count()).toBe(0);
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Open letter.pdf' }).click();
    const popup = await opened;
    await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
    expect(new URL(popup.url()).origin).toBe(fixtures.storageOrigin);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    const marker = await popup.evaluate(() => {
      try {
        return localStorage.getItem('rpg-e2e-marker');
      } catch {
        return 'storage-blocked';
      }
    });
    expect(marker).not.toBe('app-secret');
    expect(dialogs).toEqual([]);
    expect(
      await page.evaluate(() => (window as { __attachmentPwned?: boolean }).__attachmentPwned),
    ).toBeUndefined();
    await popup.close();
  });

  test('an expired read URL degrades to unavailable without breaking the page', async ({
    page,
  }) => {
    if (fixtures === undefined) return;
    await page.waitForTimeout(2_500);
    await mount(page, [metadata(IMAGE_ID, 'image/png', 'old-map.png')], {
      [`${IMAGE_ID}:inline`]: fixtures.expiring,
    });
    await expect(page.getByText('Preview unavailable.')).toBeVisible();
    await expect(page.getByTestId('app-shell')).toBeVisible();
  });

  test('a denied read shows unavailable and never contacts storage', async ({ page }) => {
    if (fixtures === undefined) return;
    const storageRequests: string[] = [];
    page.on('request', (request) => {
      if (fixtures !== undefined && request.url().startsWith(fixtures.storageOrigin)) {
        storageRequests.push(request.url());
      }
    });
    await mount(page, [metadata(IMAGE_ID, 'image/png', 'secret.png')], {});
    await expect(page.getByText('Preview unavailable.')).toBeVisible();
    expect(storageRequests).toEqual([]);
  });
});
