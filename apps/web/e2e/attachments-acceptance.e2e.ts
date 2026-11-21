import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';

/**
 * Feature 05 task 07 acceptance against the real stack: the production upload client and viewer
 * in the browser, the real attachment routes (Fastify) over PostgreSQL and MinIO in a Bun helper
 * (`fixtures/attachment-api-server.ts`), with the feature 04 fixture owner classes because no
 * production owner class exists. The page's `/campaigns/**` requests are forwarded to that server
 * with a fixture session; bytes go straight between the browser and MinIO.
 *
 * Normal-connection reference profile (`_bdd.md`, A normal map upload reaches preview within the
 * target): Chromium network emulation at 10 Mbit/s down, 5 Mbit/s up, 40 ms latency, applied to
 * the browser's direct storage traffic; the map is a 1024 × 1024 PNG of noise (about 4 MiB).
 * Skipped when PostgreSQL or the provider is unreachable.
 */

const HELPER = 'apps/web/e2e/fixtures/attachment-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4186;
const API = `http://127.0.0.1:${PORT}`;
// `apps/api/src/modules/authorization/test-fixture.ts`: GM credential and allowed origin.
const GM_SESSION = `rpg_session=${'G'.repeat(43)}`;
const API_ORIGIN = 'https://table.invalid';
const PROFILE = {
  offline: false,
  latency: 40,
  downloadThroughput: (10 * 1024 * 1024) / 8,
  uploadThroughput: (5 * 1024 * 1024) / 8,
};

// One helper server on a fixed port: run the file's tests in one worker.
test.describe.configure({ mode: 'serial' });

let server: ChildProcess | undefined;
let fixture: { campaignId: string; ownerId: string } | undefined;

test.beforeAll(async () => {
  test.setTimeout(60_000);
  if ((process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL) === undefined) return;
  const child = spawn('bun', [HELPER, 'serve', String(PORT)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  fixture = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 20_000);
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
  if (fixture !== undefined) execFileSync('bun', [HELPER, 'cleanup'], { env: process.env });
});

async function forward(page: Page) {
  await page.route(`${APP}/campaigns/**`, async (route) => {
    const request = route.request();
    const response = await route.fetch({
      url: request.url().replace(APP, API),
      headers: { ...request.headers(), origin: API_ORIGIN, cookie: GM_SESSION },
    });
    await route.fulfill({ response });
  });
}

test.describe('attachment acceptance on the real stack', () => {
  test.beforeEach(() => {
    test.skip(fixture === undefined, 'PostgreSQL or object storage is not reachable');
  });

  // Scenario: A normal map upload reaches preview within the target.
  test('a map upload reaches a working preview within 30 seconds on the reference profile', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'the network profile is a Chromium protocol call');
    if (fixture === undefined) return;
    await forward(page);
    await page.goto('/');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', PROFILE);
    const storageRequests: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(APP)) storageRequests.push(request.method());
    });

    const outcome = await page.evaluate(async (input) => {
      const canvas = new OffscreenCanvas(1024, 1024);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no canvas');
      const image = context.createImageData(1024, 1024);
      for (let index = 0; index < image.data.length; index += 4) {
        image.data[index] = Math.floor(Math.random() * 256);
        image.data[index + 1] = Math.floor(Math.random() * 256);
        image.data[index + 2] = Math.floor(Math.random() * 256);
        image.data[index + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const file = new File([blob], 'harbor-map.png', { type: 'image/png' });
      (window as { __startedAt?: number }).__startedAt = performance.now();
      const api = await import('/src/features/attachments/attachments-api.ts');
      const result = await api.uploadAttachment({
        campaignId: input.campaignId,
        owner: { resourceClass: 'fixture_note', resourceId: input.ownerId },
        file,
        visibility: { mode: 'everyone' },
      });
      const harness = await import('/src/features/attachments/e2e-harness.tsx');
      harness.mountAttachmentHarness({
        campaignId: input.campaignId,
        resourceClass: 'fixture_note',
        resourceId: input.ownerId,
      });
      return { kind: result.kind, size: file.size };
    }, fixture);
    expect(outcome.kind).toBe('attached');
    expect(outcome.size).toBeGreaterThan(3_000_000);

    const preview = page.getByRole('img', { name: 'harbor-map.png' });
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => preview.evaluate((node: HTMLImageElement) => node.naturalWidth), {
        timeout: 30_000,
      })
      .toBe(1024);
    const elapsed = await page.evaluate(
      () => performance.now() - ((window as { __startedAt?: number }).__startedAt ?? 0),
    );
    console.log(`upload-to-preview: ${Math.round(elapsed)} ms for ${outcome.size} bytes`);
    test.info().annotations.push({
      type: 'upload-to-preview',
      description: `${Math.round(elapsed)} ms for ${outcome.size} bytes at 5/10 Mbit/s, 40 ms`,
    });
    expect(elapsed).toBeLessThan(30_000);
    // Bytes went directly to storage (PUT) and came back from it (GET); never through the API.
    expect(storageRequests).toEqual(expect.arrayContaining(['PUT', 'GET']));
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  });

  // Scenario: Uploaded content cannot execute in the application origin (MIME spoofing).
  test('HTML disguised as a PNG is refused at finalization and never listed or rendered', async ({
    page,
  }) => {
    if (fixture === undefined) return;
    await forward(page);
    await page.goto('/');
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const outcome = await page.evaluate(async (input) => {
      const file = new File(
        [
          '<html><body><script>window.parent.__attachmentPwned = true; alert(1)</script></body></html>',
        ],
        'innocent.png',
        { type: 'image/png' },
      );
      const api = await import('/src/features/attachments/attachments-api.ts');
      const svg = await api.uploadAttachment({
        campaignId: input.campaignId,
        owner: { resourceClass: 'fixture_note', resourceId: input.ownerId },
        file: new File(['<svg onload="alert(1)"/>'], 'icon.svg', { type: 'image/svg+xml' }),
        visibility: { mode: 'everyone' },
      });
      const html = await api.uploadAttachment({
        campaignId: input.campaignId,
        owner: { resourceClass: 'fixture_note', resourceId: input.ownerId },
        file,
        visibility: { mode: 'everyone' },
      });
      const listed = await api.listAttachments(input.campaignId, {
        resourceClass: 'fixture_note',
        resourceId: input.ownerId,
      });
      return {
        svg,
        html,
        names: listed.kind === 'ok' ? listed.items.map((item) => item.filename) : [],
      };
    }, fixture);
    expect(outcome.svg).toEqual({ kind: 'rejected', reason: 'unsupported_file_type' });
    expect(outcome.html).toEqual({ kind: 'rejected', reason: 'signature_mismatch' });
    expect(outcome.names).not.toContain('innocent.png');
    expect(
      await page.evaluate(() => (window as { __attachmentPwned?: boolean }).__attachmentPwned),
    ).toBeUndefined();
    expect(dialogs).toEqual([]);
  });
});
