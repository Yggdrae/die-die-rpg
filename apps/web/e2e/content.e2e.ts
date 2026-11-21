import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * Feature 16 tasks 11–13 on the real stack: the production content screens in the browser
 * (test-only host `features/content/e2e-harness.tsx` = the dashboard's content composition), the
 * browser replica through the PowerSync web SDK and the running PowerSync service, and the real
 * API composition root (sync authority + feature 16 appliers, holds, feature 04 Visibility,
 * feature 05 attachments over MinIO) in a Bun helper (`fixtures/content-api-server.ts`). Each
 * browser context forwards API calls with its own user's session. Nothing is mocked.
 *
 * Skipped unless PostgreSQL and the PowerSync service are reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/content-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4188;
const API = `http://127.0.0.1:${PORT}`;
const API_ORIGIN = 'https://table.invalid';
const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SYNC = Number(process.env.E2E_SYNC_TIMEOUT_MS ?? 30_000);

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

interface User {
  readonly cookie: string;
  readonly userId: string;
  readonly username: string;
}
interface Fixture {
  readonly campaignId: string;
  readonly gm: User;
  readonly assistant: User;
  readonly casey: User;
  readonly dana: User;
}

let server: ChildProcess | undefined;
let fixture: Fixture | undefined;

test.beforeAll(async () => {
  test.setTimeout(90_000);
  if ((process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL) === undefined) return;
  try {
    const probe = await fetch(`${ENDPOINT}/probes/liveness`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!probe.ok) return;
  } catch {
    return;
  }
  const child = spawn('bun', [HELPER, 'serve', String(PORT)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  fixture = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 60_000);
    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = buffered.split('\n').find((entry) => entry.includes('"ready"'));
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
    execFileSync('bun', [HELPER, 'cleanup', fixture.campaignId], { env: process.env });
  }
});

interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly user: User;
  /** Sync services unreachable for this device (API stand-in aborts, provider aborts). */
  network: { down: boolean };
}

/** One browser per user; API calls are forwarded to the helper with that user's session. */
async function device(browser: Browser, user: User): Promise<Device> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const network = { down: false };
  await context.route(`${ENDPOINT}/**`, (route) =>
    network.down ? route.abort('internetdisconnected') : route.continue(),
  );
  const relay = async (route: Parameters<Parameters<BrowserContext['route']>[1]>[0]) => {
    if (network.down) return route.abort('internetdisconnected');
    const request = route.request();
    try {
      const response = await route.fetch({
        url: request.url().replace(APP, API),
        headers: { ...request.headers(), origin: API_ORIGIN, cookie: user.cookie },
      });
      await route.fulfill({ response });
    } catch {
      await route.abort('failed').catch(() => undefined);
    }
  };
  await context.route(`${APP}/campaigns/**`, relay);
  await context.route(`${APP}/sync/**`, relay);
  const page = await context.newPage();
  return { context, page, user, network };
}

async function mount(target: Device): Promise<void> {
  if (fixture === undefined) throw new Error('no fixture');
  await target.page.goto('/');
  await target.page.evaluate(
    async (input) => {
      const harness = await import('/src/features/content/e2e-harness.tsx');
      harness.mountContent(input);
    },
    { userId: target.user.userId, campaignId: fixture.campaignId },
  );
  await expect(target.page.getByRole('heading', { name: 'Campaign content' })).toBeVisible();
}

function harness<T>(target: Device, name: string, arg?: unknown): Promise<T> {
  return target.page.evaluate(
    async (input) => {
      const module = (await import('/src/features/content/e2e-harness.tsx')) as unknown as Record<
        string,
        (value?: unknown) => unknown
      >;
      const fn = module[input.name];
      if (fn === undefined) throw new Error(`unknown harness function ${input.name}`);
      return fn(input.arg);
    },
    { name, arg },
  ) as Promise<T>;
}

/** Nothing pending and a consistent checkpoint ("Synchronized" never shows before both). */
async function synced(target: Device): Promise<void> {
  const status = target.page.locator('[data-sync-state]');
  await expect(status).toHaveAttribute('data-sync-state', 'synchronized', { timeout: SYNC });
  await expect(status).toHaveAttribute('data-pending-count', '0', { timeout: SYNC });
}

async function asGmReady(target: Device): Promise<void> {
  await expect(target.page.getByRole('button', { name: 'Add NPC' })).toBeVisible({
    timeout: SYNC,
  });
}

function entityButton(target: Device, name: string) {
  return target.page
    .getByRole('region', { name: 'Entities', exact: true })
    .getByRole('button', { name, exact: true });
}

function detail(target: Device, name: string) {
  return target.page.getByRole('article', { name: `${name} details` });
}

async function quickCreate(target: Device, entry: string, name: string, summary?: string) {
  await target.page.getByRole('button', { name: entry, exact: true }).click();
  await target.page.keyboard.type(name);
  if (summary !== undefined) {
    await target.page.getByLabel('Summary (optional)').fill(summary);
  }
  await target.page.keyboard.press('Enter');
  await expect(entityButton(target, name)).toBeVisible();
}

async function open(target: Device, name: string) {
  await entityButton(target, name).click();
  await expect(detail(target, name)).toBeVisible();
}

async function api<T>(user: User, path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${API}${path}`, { headers: { cookie: user.cookie } });
  return { status: response.status, body: (await response.json()) as T };
}

interface ServerEntity {
  id: string;
  type: string;
  name: string;
  summary: string;
  description: string;
  visibility: { mode: string };
  version: number;
  fields: Record<string, string>;
}

async function serverEntity(user: User, name: string): Promise<ServerEntity | undefined> {
  if (fixture === undefined) return undefined;
  const listed = await api<{ items: ServerEntity[] }>(
    user,
    `/campaigns/${fixture.campaignId}/entities?q=${encodeURIComponent(name)}`,
  );
  return listed.body.items?.find((item) => item.name === name);
}

const PNG = (() => {
  const bytes = Buffer.alloc(96);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  for (let index = 16; index < bytes.length; index += 1) bytes[index] = index;
  return bytes;
})();

test.describe('campaign content on the real stack', () => {
  test.beforeEach(() => {
    test.skip(fixture === undefined, 'PostgreSQL or the PowerSync service is unreachable');
  });

  test('quick create saves from a name only (Add NPC → npc, generic → note), offline too; timed', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const gm = await device(browser, fixture.gm);
    await mount(gm);
    await asGmReady(gm);
    await synced(gm);

    const started = Date.now();
    await gm.page.getByRole('button', { name: 'Add NPC', exact: true }).click();
    await gm.page.keyboard.type('Ferryman');
    await gm.page.keyboard.press('Enter');
    await expect(entityButton(gm, 'Ferryman')).toBeVisible();
    const localMs = Date.now() - started;
    await synced(gm);
    const syncedMs = Date.now() - started;
    test.info().annotations.push({
      type: 'quick-create',
      description: `scripted Add NPC → typed name → Enter → listed locally in ${localMs} ms; accepted by the authority and synchronized in ${syncedMs} ms`,
    });
    expect(localMs).toBeLessThan(30_000);
    const ferryman = await serverEntity(fixture.gm, 'Ferryman');
    expect(ferryman).toMatchObject({ type: 'npc', summary: '', visibility: { mode: 'gm_only' } });
    expect(ferryman?.version).toBe(1);

    await quickCreate(gm, 'New entity', 'Odd rumor');
    await synced(gm);
    expect((await serverEntity(fixture.gm, 'Odd rumor'))?.type).toBe('note');

    // Offline: the local write is visible at once and queued with a pending indicator.
    gm.network.down = true;
    await gm.context.setOffline(true);
    await quickCreate(gm, 'Add location', 'Ford', 'Knee-deep in summer');
    await expect(gm.page.locator('[data-sync-state]')).not.toHaveAttribute(
      'data-pending-count',
      '0',
      { timeout: SYNC },
    );
    expect(await serverEntity(fixture.gm, 'Ford')).toBeUndefined();
    gm.network.down = false;
    await gm.context.setOffline(false);
    await synced(gm);
    expect(await serverEntity(fixture.gm, 'Ford')).toMatchObject({
      type: 'location',
      summary: 'Knee-deep in summer',
    });
    await gm.context.close();
  });

  test('reveal to one player through the mounted VisibilityControls', async ({ browser }) => {
    if (fixture === undefined) return;
    const gm = await device(browser, fixture.gm);
    const casey = await device(browser, fixture.casey);
    const dana = await device(browser, fixture.dana);
    await Promise.all([mount(gm), mount(casey), mount(dana)]);
    await asGmReady(gm);
    await quickCreate(gm, 'Add note', 'Weathered Letter');
    await synced(gm);
    await synced(casey);
    await expect(entityButton(casey, 'Weathered Letter')).toHaveCount(0);
    // Players get no create entry points (hint from the declarations).
    await expect(casey.page.getByRole('button', { name: 'Add NPC' })).toHaveCount(0);

    await open(gm, 'Weathered Letter');
    const controls = detail(gm, 'Weathered Letter')
      .locator('section[data-visibility-mode]')
      .first();
    await controls.getByLabel(fixture.casey.username).check();
    await controls.getByRole('button', { name: 'Reveal to selected players' }).click();
    await expect(controls.getByTestId('visibility-current')).toContainText('Selected players');

    await expect(entityButton(casey, 'Weathered Letter')).toBeVisible({ timeout: SYNC });
    await open(casey, 'Weathered Letter');
    // No Visibility controls for a player.
    await expect(
      detail(casey, 'Weathered Letter').locator('section[data-visibility-mode]'),
    ).toHaveCount(0);
    await synced(dana);
    await expect(entityButton(dana, 'Weathered Letter')).toHaveCount(0);
    for (const target of [gm, casey, dana]) await target.context.close();
  });

  test('a stale edit raises the conflict surface; resubmit, then keep authority', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const avery = await device(browser, fixture.gm);
    const blake = await device(browser, fixture.assistant);
    await Promise.all([mount(avery), mount(blake)]);
    await asGmReady(avery);
    await asGmReady(blake);
    await quickCreate(avery, 'Add note', 'Ferry Toll');
    await synced(avery);
    await expect(entityButton(blake, 'Ferry Toll')).toBeVisible({ timeout: SYNC });

    const editSummary = async (target: Device, value: string) => {
      await open(target, 'Ferry Toll');
      await detail(target, 'Ferry Toll').getByRole('button', { name: 'Edit details' }).click();
      const form = target.page.getByRole('form', { name: 'Edit Ferry Toll' });
      await form.getByLabel('Summary').fill(value);
      await form.getByRole('button', { name: 'Save changes' }).click();
      await expect(detail(target, 'Ferry Toll').getByTestId('entity-summary')).toHaveText(value);
    };

    // Round 1: Avery edits while paused, Blake's edit wins the race, Avery resubmits.
    await harness(avery, 'pauseSync');
    await editSummary(avery, 'Two coppers');
    await editSummary(blake, 'One silver');
    await synced(blake);
    await harness(avery, 'resumeSync');
    const surface = avery.page.getByRole('region', { name: 'Unresolved changes' });
    await expect(surface).toBeVisible({ timeout: SYNC });
    await surface.getByText('Compare values').click();
    await expect(surface).toContainText('Two coppers');
    await expect(surface).toContainText('One silver');
    expect((await serverEntity(fixture.gm, 'Ferry Toll'))?.summary).toBe('One silver');
    await surface.getByRole('button', { name: 'Resubmit mine' }).click();
    await expect(surface).toHaveCount(0);
    await synced(avery);
    await expect
      .poll(async () => (await serverEntity(fixture.gm, 'Ferry Toll'))?.summary, { timeout: SYNC })
      .toBe('Two coppers');

    // Round 2: same race, Avery keeps the authority's value; nothing of Avery's is applied.
    await expect(detail(blake, 'Ferry Toll').getByTestId('entity-summary')).toHaveText(
      'Two coppers',
      { timeout: SYNC },
    );
    await harness(avery, 'pauseSync');
    await editSummary(avery, 'Free passage');
    await editSummary(blake, 'Three silver');
    await synced(blake);
    await harness(avery, 'resumeSync');
    await expect(surface).toBeVisible({ timeout: SYNC });
    await surface.getByRole('button', { name: 'Keep authority' }).click();
    await expect(surface).toHaveCount(0);
    await synced(avery);
    await expect(detail(avery, 'Ferry Toll').getByTestId('entity-summary')).toHaveText(
      'Three silver',
      { timeout: SYNC },
    );
    expect((await serverEntity(fixture.gm, 'Ferry Toll'))?.summary).toBe('Three silver');
    for (const target of [avery, blake]) await target.context.close();
  });

  test('a GM adds a free-form custom field; a second label differing only in case is refused (D-01)', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const gm = await device(browser, fixture.gm);
    await mount(gm);
    await asGmReady(gm);
    await quickCreate(gm, 'Add NPC', 'River Ferryman');
    await synced(gm);
    await open(gm, 'River Ferryman');
    const card = detail(gm, 'River Ferryman');
    await card.getByRole('button', { name: 'Edit details' }).click();
    const form = gm.page.getByRole('form', { name: 'Edit River Ferryman' });
    await form.getByRole('button', { name: 'Add field' }).click();
    await form.getByLabel('Field label 1').fill('Price');
    await form.getByLabel('Field value 1').fill('one silver');
    await form.getByRole('button', { name: 'Save changes' }).click();
    const fields = card.getByRole('definition');
    await expect(card.getByRole('term')).toHaveText(['Price']);
    await expect(fields).toHaveText(['one silver']);
    await synced(gm);
    expect(await serverEntity(fixture.gm, 'River Ferryman')).toMatchObject({
      type: 'npc',
      version: 2,
      fields: { Price: 'one silver' },
    });

    await card.getByRole('button', { name: 'Edit details' }).click();
    await form.getByRole('button', { name: 'Add field' }).click();
    await form.getByLabel('Field label 2').fill('price');
    await form.getByLabel('Field value 2').fill('two');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(form.getByRole('alert')).toHaveText(
      'Two custom fields have the same label (labels ignore case).',
    );
    await form.getByRole('button', { name: 'Remove field 2' }).click();
    await form.getByRole('button', { name: 'Add field' }).click();
    await form.getByLabel('Field label 2').fill('Allegiance');
    await form.getByLabel('Field value 2').fill('Boatmen');
    await form.getByRole('button', { name: 'Save changes' }).click();
    await expect(card.getByRole('term')).toHaveText(['Allegiance', 'Price']);
    await synced(gm);
    expect((await serverEntity(fixture.gm, 'River Ferryman'))?.fields).toEqual({
      Price: 'one silver',
      Allegiance: 'Boatmen',
    });
    await gm.context.close();
  });

  test('takeover notifies the previous holder and keeps that holder’s unsaved text', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const avery = await device(browser, fixture.gm);
    const blake = await device(browser, fixture.assistant);
    await Promise.all([mount(avery), mount(blake)]);
    await asGmReady(avery);
    await quickCreate(avery, 'Add note', 'Ledger');
    await synced(avery);
    await expect(entityButton(blake, 'Ledger')).toBeVisible({ timeout: SYNC });

    await open(avery, 'Ledger');
    await avery.page.getByRole('button', { name: 'Edit description' }).click();
    const averyLock = avery.page.getByTestId('lock-status');
    await expect(averyLock).toContainText('You are editing');
    await avery.page.getByLabel(/Description \(Markdown/).fill('Avery: the ledger is forged');

    await open(blake, 'Ledger');
    await blake.page.getByRole('button', { name: 'Edit description' }).click();
    const blakeLock = blake.page.getByTestId('lock-status');
    await expect(blakeLock).toContainText('Someone else is editing');
    await expect(blake.page.getByRole('button', { name: 'Save description' })).toBeDisabled();
    await blake.page.getByRole('button', { name: 'Take over editing' }).click();
    await expect(blakeLock).toContainText('You are editing');

    // Avery learns of the takeover (replicated hold, or at the latest on save) and keeps the text.
    const save = avery.page.getByRole('button', { name: 'Save description' });
    await expect(averyLock)
      .toContainText('Another editor took over', { timeout: 10_000 })
      .catch(async () => save.click());
    await expect(averyLock).toContainText('Another editor took over');
    await expect(save).toBeDisabled();
    await expect(avery.page.getByLabel(/Description \(Markdown/)).toHaveValue(
      'Avery: the ledger is forged',
    );
    // The unsaved text survives a reload on Avery's device (device-only draft).
    await avery.page.reload();
    await mount(avery);
    await open(avery, 'Ledger');
    await expect(avery.page.getByText('You have an unsaved draft on this device.')).toBeVisible();

    await blake.page.getByLabel(/Description \(Markdown/).fill('Blake: entries match the toll');
    await blake.page.getByRole('button', { name: 'Save description' }).click();
    await expect(detail(blake, 'Ledger').getByTestId('entity-description')).toHaveText(
      'Blake: entries match the toll',
    );
    await synced(blake);
    expect((await serverEntity(fixture.gm, 'Ledger'))?.description).toBe(
      'Blake: entries match the toll',
    );
    for (const target of [avery, blake]) await target.context.close();
  });

  test('an offline description draft survives reload, is never queued, and saves under a hold after reconnect; sign-out removes drafts', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const gm = await device(browser, fixture.gm);
    await mount(gm);
    await asGmReady(gm);
    await quickCreate(gm, 'Add location', 'Harbor');
    await synced(gm);

    gm.network.down = true;
    await open(gm, 'Harbor');
    await gm.page.getByRole('button', { name: 'Edit description' }).click();
    await expect(gm.page.getByTestId('lock-status')).toContainText('Offline');
    await gm.page.getByLabel(/Description \(Markdown/).fill('# Harbor\nSmugglers <meet> at dusk');
    await expect(gm.page.getByRole('button', { name: 'Save description' })).toBeDisabled();
    expect(await harness<string[]>(gm, 'queuedTables')).toEqual([]);

    await gm.page.reload();
    await mount(gm);
    await open(gm, 'Harbor');
    await expect(gm.page.getByText('You have an unsaved draft on this device.')).toBeVisible();
    await gm.page.getByRole('button', { name: 'Edit description' }).click();
    await expect(gm.page.getByTestId('draft-restored')).toBeVisible();
    await expect(gm.page.getByLabel(/Description \(Markdown/)).toHaveValue(
      '# Harbor\nSmugglers <meet> at dusk',
    );
    await expect(gm.page.getByTestId('lock-status')).toContainText('Offline');

    gm.network.down = false;
    await gm.page.getByRole('button', { name: 'Get editing lock' }).click();
    await expect(gm.page.getByTestId('lock-status')).toContainText('You are editing');
    await gm.page.getByRole('button', { name: 'Save description' }).click();
    // Escaped plain text with its line break (D-10).
    await expect(detail(gm, 'Harbor').getByTestId('entity-description')).toHaveText(
      '# Harbor\nSmugglers <meet> at dusk',
    );
    await expect(detail(gm, 'Harbor').locator('meet')).toHaveCount(0);
    await synced(gm);
    expect((await serverEntity(fixture.gm, 'Harbor'))?.description).toBe(
      '# Harbor\nSmugglers <meet> at dusk',
    );
    await expect(gm.page.getByText('You have an unsaved draft on this device.')).toHaveCount(0);

    // Sign-out removes every draft from the device.
    await gm.page.getByRole('button', { name: 'Edit description' }).click();
    await gm.page.getByLabel(/Description \(Markdown/).fill('left behind');
    const drafts = () =>
      gm.page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('rpg-content-draft:')),
      );
    expect(await drafts()).toHaveLength(1);
    await gm.page.getByRole('button', { name: 'Sign out of this device' }).click();
    await expect.poll(drafts).toEqual([]);
    await gm.context.close();
  });

  test('at phone width the content screens fit with no horizontal page scroll', async ({
    browser,
    isMobile,
  }) => {
    test.skip(!isMobile, 'phone projects of the browser matrix only');
    if (fixture === undefined) return;
    const gm = await device(browser, fixture.gm);
    await gm.page.setViewportSize({ width: 390, height: 844 });
    await mount(gm);
    await asGmReady(gm);
    await quickCreate(gm, 'Add NPC', 'Narrow Screen Merchant');
    await open(gm, 'Narrow Screen Merchant');
    // Not `clientWidth`: a phone's layout viewport grows to fit whatever overflows.
    const fits = () =>
      gm.page.evaluate(
        (width) => ({
          scrollWidth: document.documentElement.scrollWidth,
          wide: [...document.querySelectorAll('body *')]
            .filter((node) => node.getBoundingClientRect().right > width + 1)
            .map((node) => `${node.tagName} ${node.textContent?.slice(0, 40)}`)
            .slice(-8),
        }),
        390,
      );
    expect(await fits()).toEqual({ scrollWidth: 390, wide: [] });
    await gm.page.getByRole('button', { name: 'Edit description' }).click();
    await expect(gm.page.getByLabel(/Description \(Markdown/)).toBeVisible();
    expect(await fits()).toEqual({ scrollWidth: 390, wide: [] });
    await detail(gm, 'Narrow Screen Merchant')
      .getByRole('button', { name: 'Edit details' })
      .click();
    expect(await fits()).toEqual({ scrollWidth: 390, wide: [] });
    await gm.context.close();
  });

  test('links show on all three details, inverse labels, bound refusal, broken link after delete', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const gm = await device(browser, fixture.gm);
    await mount(gm);
    await asGmReady(gm);
    await quickCreate(gm, 'Add NPC', 'Smuggler');
    await quickCreate(gm, 'New entity', 'River Guild');
    await quickCreate(gm, 'Add location', 'Abandoned Warehouse');
    // The generic entry point made a note; the type changes afterwards (D-09).
    await open(gm, 'River Guild');
    await detail(gm, 'River Guild').getByRole('button', { name: 'Edit details' }).click();
    await gm.page
      .getByRole('form', { name: 'Edit River Guild' })
      .getByLabel('Type')
      .selectOption('faction');
    await gm.page.getByRole('button', { name: 'Save changes' }).click();
    await expect(detail(gm, 'River Guild').getByTestId('entity-type')).toHaveText('Faction');

    await open(gm, 'Smuggler');
    const linkForm = gm.page.getByRole('form', { name: 'Link entity' });
    await linkForm.getByLabel('Relationship').selectOption({ label: 'member of' });
    await linkForm.getByLabel('Entity').selectOption({ label: 'River Guild' });
    await linkForm.getByRole('button', { name: 'Link' }).click();
    await linkForm.getByLabel('Relationship').selectOption({ label: 'lives at' });
    await linkForm.getByLabel('Entity').selectOption({ label: 'Abandoned Warehouse' });
    await linkForm.getByRole('button', { name: 'Link' }).click();
    const smugglerLinks = detail(gm, 'Smuggler').getByRole('list', { name: 'Links' });
    await expect(smugglerLinks.getByRole('listitem')).toHaveCount(2);
    await expect(smugglerLinks).toContainText('member of');
    await expect(smugglerLinks).toContainText('lives at');
    await synced(gm);

    await smugglerLinks.getByRole('button', { name: 'River Guild' }).click();
    const guildLinks = detail(gm, 'River Guild').getByRole('list', { name: 'Links' });
    await expect(guildLinks).toContainText('has member');
    await expect(guildLinks.getByRole('button', { name: 'Smuggler' })).toBeVisible();
    await open(gm, 'Abandoned Warehouse');
    const warehouseLinks = detail(gm, 'Abandoned Warehouse').getByRole('list', { name: 'Links' });
    await expect(warehouseLinks).toContainText('has resident');
    await expect(warehouseLinks.getByRole('button', { name: 'Smuggler' })).toBeVisible();

    // A reveal wider than its endpoints is refused (B-1) and changes nothing.
    await open(gm, 'River Guild');
    const linkControls = guildLinks
      .getByRole('listitem')
      .first()
      .locator('section[data-visibility-mode]');
    await linkControls.getByRole('button', { name: 'Reveal to everyone' }).click();
    await expect(linkControls.getByRole('alert')).toContainText(
      'does not fit how the record is currently shared',
    );
    await expect(linkControls.getByTestId('visibility-current')).toContainText('GM only');

    // Deleting an endpoint keeps the link, rendered as a link to a deleted entity.
    await open(gm, 'Smuggler');
    await detail(gm, 'Smuggler').getByRole('button', { name: 'Delete entity' }).click();
    await expect(entityButton(gm, 'Smuggler')).toHaveCount(0);
    await open(gm, 'River Guild');
    await expect(guildLinks.getByTestId('broken-link')).toHaveText('Deleted entity');
    await synced(gm);
    await expect(guildLinks.getByTestId('broken-link')).toHaveText('Deleted entity');
    const guild = await serverEntity(fixture.gm, 'River Guild');
    const links = await api<{ items: { kind: string; other: { deleted: boolean } }[] }>(
      fixture.gm,
      `/campaigns/${fixture.campaignId}/entities/${guild?.id}/relationships`,
    );
    expect(links.body.items.map((item) => [item.kind, item.other.deleted])).toEqual([
      ['member_of', true],
    ]);
    await gm.context.close();
  });

  test('a PNG attached to an NPC is listed on it; a player cannot list or read it', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const gm = await device(browser, fixture.gm);
    await mount(gm);
    await asGmReady(gm);
    await quickCreate(gm, 'Add NPC', 'Portrait Sitter');
    await synced(gm);
    await open(gm, 'Portrait Sitter');
    const section = detail(gm, 'Portrait Sitter').getByRole('region', {
      name: 'Entity attachments',
    });
    await section.getByLabel('File', { exact: true }).setInputFiles({
      name: 'portrait.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await section.getByRole('button', { name: 'Attach' }).click();
    await expect(section.getByRole('status').last()).toHaveText('Attached portrait.png.', {
      timeout: SYNC,
    });
    await expect(section.locator('figcaption')).toContainText('portrait.png');

    const sitter = await serverEntity(fixture.gm, 'Portrait Sitter');
    const path = `/campaigns/${fixture.campaignId}/resources/campaign_entity/${sitter?.id}/attachments`;
    const listed = await api<{ items: { attachmentId: string }[] }>(fixture.gm, path);
    expect(listed.body.items).toHaveLength(1);
    const attachmentId = listed.body.items[0]?.attachmentId ?? '';
    const hidden = await api(fixture.casey, path);
    const read = await api(
      fixture.casey,
      `/campaigns/${fixture.campaignId}/attachments/${attachmentId}/read`,
    );
    const missing = await api(
      fixture.casey,
      `/campaigns/${fixture.campaignId}/attachments/${crypto.randomUUID()}/read`,
    );
    for (const response of [hidden, read]) {
      expect([response.status, response.body]).toEqual([missing.status, missing.body]);
    }
    expect(missing.status).toBe(404);
    await gm.context.close();
  });

  test('session quick action content.add_npc opens the overlay and resolves on save and cancel', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const gm = await device(browser, fixture.gm);
    await mount(gm);
    await asGmReady(gm);
    const actor = { userId: fixture.gm.userId, campaignId: fixture.campaignId, role: 'gm' };
    await harness(gm, 'invokeQuickAction', {
      id: 'content.add_npc',
      actor,
      sessionId: crypto.randomUUID(),
      ticket: 'save',
    });
    const overlay = gm.page.getByRole('dialog', { name: 'Quick create' });
    await expect(overlay.getByRole('form', { name: 'Add NPC' })).toBeVisible();
    expect(await harness(gm, 'quickActionOutcome', 'save')).toBe('pending');
    await gm.page.keyboard.type('Toll Keeper');
    await gm.page.keyboard.press('Enter');
    await expect(overlay).toHaveCount(0);
    await expect.poll(() => harness(gm, 'quickActionOutcome', 'save')).toBe('resolved');
    await expect(entityButton(gm, 'Toll Keeper')).toBeVisible();

    await harness(gm, 'invokeQuickAction', {
      id: 'content.add_note',
      actor,
      sessionId: crypto.randomUUID(),
      ticket: 'cancel',
    });
    await expect(overlay.getByRole('form', { name: 'Add note' })).toBeVisible();
    await overlay.getByRole('button', { name: 'Cancel' }).click();
    await expect(overlay).toHaveCount(0);
    await expect.poll(() => harness(gm, 'quickActionOutcome', 'cancel')).toBe('resolved');
    await synced(gm);
    expect((await serverEntity(fixture.gm, 'Toll Keeper'))?.type).toBe('npc');
    await gm.context.close();
  });

  test('a player keeps a private note: no Visibility controls, attachments, or links', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const casey = await device(browser, fixture.casey);
    await mount(casey);
    const notes = casey.page.getByRole('region', { name: 'My notes' });
    await expect(notes).toBeVisible({ timeout: SYNC });
    await notes.getByLabel('Note title').fill('Suspicions');
    await notes.getByRole('button', { name: 'Add my note' }).click();
    const note = casey.page.getByRole('article', { name: 'Suspicions note' });
    await expect(note).toBeVisible();
    // A hold names a record the authority knows: the created note is uploaded first.
    await synced(casey);
    await note.getByRole('button', { name: 'Edit body' }).click();
    await expect(note.getByTestId('lock-status')).toContainText('You are editing', {
      timeout: SYNC,
    });
    await note.getByLabel(/Body \(Markdown/).fill('The ferryman is not who he says');
    await note.getByRole('button', { name: 'Save body' }).click();
    await expect(note.getByTestId('note-body')).toHaveText('The ferryman is not who he says');
    for (const absent of ['Who can see this', 'Attach', 'Link entity']) {
      await expect(note.getByText(absent)).toHaveCount(0);
    }
    await synced(casey);
    const listed = await api<{ items: { name: string; body: string }[] }>(
      fixture.casey,
      `/campaigns/${fixture.campaignId}/personal-notes`,
    );
    expect(listed.body.items.map((item) => [item.name, item.body])).toEqual([
      ['Suspicions', 'The ferryman is not who he says'],
    ]);
    // The GM never reads it.
    const gmView = await api<{ items: unknown[] }>(
      fixture.gm,
      `/campaigns/${fixture.campaignId}/personal-notes`,
    );
    expect(gmView.status === 404 || gmView.body.items?.length === 0).toBe(true);
    await casey.context.close();
  });
  test('PRD s.88 acceptance: NPC, location, link, attachment, notes; the player sees only revealed content and own notes', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    const gm = await device(browser, fixture.gm);
    const casey = await device(browser, fixture.casey);
    const dana = await device(browser, fixture.dana);
    await Promise.all([mount(gm), mount(casey), mount(dana)]);
    await asGmReady(gm);
    await synced(gm);

    // The GM creates an NPC and a location, links them, attaches a file, and writes a note.
    const started = Date.now();
    await quickCreate(gm, 'Add NPC', 'Harbor Master', 'Counts every crate');
    await quickCreate(gm, 'Add location', 'Salt Docks');
    await quickCreate(gm, 'Add note', 'Tide tables');
    await open(gm, 'Harbor Master');
    const linkForm = gm.page.getByRole('form', { name: 'Link entity' });
    await linkForm.getByLabel('Relationship').selectOption({ label: 'located at' });
    await linkForm.getByLabel('Entity').selectOption({ label: 'Salt Docks' });
    await linkForm.getByRole('button', { name: 'Link' }).click();
    const links = detail(gm, 'Harbor Master').getByRole('list', { name: 'Links' });
    await expect(links.getByRole('listitem')).toHaveCount(1);
    await expect(links).toContainText('located at');
    const createdMs = Date.now() - started;
    // An attachment names a record the authority knows: the NPC is uploaded first.
    await synced(gm);
    const section = detail(gm, 'Harbor Master').getByRole('region', {
      name: 'Entity attachments',
    });
    await section.getByLabel('File', { exact: true }).setInputFiles({
      name: 'harbor-master.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await section.getByRole('button', { name: 'Attach' }).click();
    await expect(section.getByRole('status').last()).toHaveText('Attached harbor-master.png.', {
      timeout: SYNC,
    });
    await expect(section.locator('figcaption')).toContainText('harbor-master.png');
    const flowMs = Date.now() - started;
    test.info().annotations.push({
      type: 's.88',
      description: `GM flow (scripted): NPC + location + note + link in ${createdMs} ms; with the attachment ${flowMs} ms`,
    });

    // Only the location is revealed; the NPC, the GM's note, and the link stay GM-only.
    await open(gm, 'Salt Docks');
    const controls = detail(gm, 'Salt Docks').locator('section[data-visibility-mode]').first();
    await controls.getByRole('button', { name: 'Reveal to everyone' }).click();
    await expect(controls.getByTestId('visibility-current')).toContainText('Everyone', {
      timeout: SYNC,
    });
    await synced(gm);

    // Each player writes a personal note.
    for (const [player, title] of [
      [casey, 'Docks smell of fish'],
      [dana, 'Dana suspects the master'],
    ] as const) {
      const notes = player.page.getByRole('region', { name: 'My notes' });
      await expect(notes).toBeVisible({ timeout: SYNC });
      await notes.getByLabel('Note title').fill(title);
      await notes.getByRole('button', { name: 'Add my note' }).click();
      await expect(player.page.getByRole('article', { name: `${title} note` })).toBeVisible();
      await synced(player);
    }

    // Casey's device: the revealed location and Casey's own note only.
    await expect(entityButton(casey, 'Salt Docks')).toBeVisible({ timeout: SYNC });
    await synced(casey);
    for (const hidden of ['Harbor Master', 'Tide tables']) {
      await expect(entityButton(casey, hidden)).toHaveCount(0);
    }
    await expect(
      casey.page.getByRole('article', { name: 'Docks smell of fish note' }),
    ).toBeVisible();
    await expect(
      casey.page.getByRole('article', { name: 'Dana suspects the master note' }),
    ).toHaveCount(0);
    await open(casey, 'Salt Docks');
    await expect(detail(casey, 'Salt Docks').getByRole('list', { name: 'Links' })).toHaveCount(0);
    const caseyPage = await casey.page.content();
    expect(caseyPage).not.toContain('Harbor Master');
    expect(caseyPage).not.toContain('harbor-master.png');

    // The authority agrees: Casey lists one entity and one note; the GM never reads notes.
    const listed = await api<{ items: { name: string }[] }>(
      fixture.casey,
      `/campaigns/${fixture.campaignId}/entities?q=${encodeURIComponent('a')}&limit=200`,
    );
    expect(listed.body.items.map((item) => item.name)).toContain('Salt Docks');
    expect(listed.body.items.map((item) => item.name)).not.toContain('Harbor Master');
    expect(listed.body.items.map((item) => item.name)).not.toContain('Tide tables');
    const caseyNotes = await api<{ items: { name: string }[] }>(
      fixture.casey,
      `/campaigns/${fixture.campaignId}/personal-notes`,
    );
    expect(caseyNotes.body.items.map((item) => item.name)).toContain('Docks smell of fish');
    expect(caseyNotes.body.items.map((item) => item.name)).not.toContain(
      'Dana suspects the master',
    );
    const master = await serverEntity(fixture.gm, 'Harbor Master');
    expect(master).toMatchObject({ type: 'npc', visibility: { mode: 'gm_only' } });
    expect((await serverEntity(fixture.gm, 'Tide tables'))?.type).toBe('note');
    for (const target of [gm, casey, dana]) await target.context.close();
  });

  // Last in this serial file: it leaves dozens of records in the shared campaign.
  test('PRD s.78: quick create stays under 30 s at human pace, at a busy table, online and offline', async ({
    browser,
  }) => {
    if (fixture === undefined) return;
    test.setTimeout(240_000);
    const gm = await device(browser, fixture.gm);
    const blake = await device(browser, fixture.assistant);
    await Promise.all([mount(gm), mount(blake)]);
    await asGmReady(gm);
    await asGmReady(blake);
    await synced(gm);
    for (let index = 0; index < 30; index += 1) {
      await quickCreate(gm, 'Add note', `Session log ${index}`);
    }
    await synced(gm);

    // Mid-session: another GM keeps writing, and those records reach this device meanwhile.
    let busy = true;
    const table = (async () => {
      for (let index = 0; busy; index += 1) {
        await quickCreate(blake, 'Add note', `Table note ${index}`);
        await blake.page.waitForTimeout(500);
      }
    })();

    const KEY_DELAY_MS = 120;
    const samples: { type: string; network: string; totalMs: number; appMs: number }[] = [];
    const measure = async (entry: string, name: string, network: string) => {
      const started = Date.now();
      await gm.page.getByRole('button', { name: entry, exact: true }).click();
      await gm.page.keyboard.type(name, { delay: KEY_DELAY_MS });
      await gm.page.keyboard.press('Enter');
      await expect(entityButton(gm, name)).toBeVisible({ timeout: SYNC });
      const totalMs = Date.now() - started;
      samples.push({
        type: entry,
        network,
        totalMs,
        appMs: totalMs - name.length * KEY_DELAY_MS,
      });
    };
    const ENTRIES = ['Add NPC', 'Add location', 'Add note'];
    for (const round of [1, 2, 3]) {
      for (const entry of ENTRIES) await measure(entry, `${entry} sample ${round}`, 'online');
    }
    gm.network.down = true;
    await gm.context.setOffline(true);
    for (const entry of ENTRIES) await measure(entry, `${entry} offline`, 'offline');
    gm.network.down = false;
    await gm.context.setOffline(false);
    busy = false;
    await table;
    await synced(gm);

    test.info().annotations.push({
      type: 's.78',
      description: samples
        .map((sample) => `${sample.type} ${sample.network}: ${sample.totalMs} ms`)
        .join('; '),
    });
    console.info(`quick create samples: ${JSON.stringify(samples)}`);
    for (const sample of samples) {
      expect(sample.totalMs).toBeLessThan(30_000);
      // Everything but the typing: catches a regression long before it reaches 30 s.
      expect(sample.appMs).toBeLessThan(5_000);
    }
    expect((await serverEntity(fixture.gm, 'Add NPC offline'))?.type).toBe('npc');
    for (const target of [gm, blake]) await target.context.close();
  });
});
