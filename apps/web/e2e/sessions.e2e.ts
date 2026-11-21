import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * Feature 18 on the real stack (`PRD.md` s.44, s.45, s.76, s.78, s.79): the production Session Mode over the browser
 * replica (test-only host `features/sessions/e2e-harness.tsx`, composed like the app shell), the running PowerSync
 * service, and the real API composition root (`fixtures/content-api-server.ts`). A GM runs a whole session from one
 * screen, quick actions and the palette never leave it, a reveal from Session Mode reaches the player in under 5
 * seconds, a player's device holds different data, a session runs entirely offline, and ten cold offline opens stay
 * under 2 seconds at the 95th percentile.
 *
 * Skipped unless PostgreSQL and the PowerSync service are reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/content-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4193;
const API = `http://127.0.0.1:${PORT}`;
const API_ORIGIN = 'https://table.invalid';
const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SYNC = Number(process.env.E2E_SYNC_TIMEOUT_MS ?? 30_000);
const REVEAL_BUDGET_MS = 5_000;
const NPC_BUDGET_MS = 30_000;
const COLD_OPEN_BUDGET_MS = 2_000;

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
interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly user: User;
  network: { down: boolean };
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

function harness<T>(page: Page, name: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async (input) => {
      const module = (await import('/src/features/sessions/e2e-harness.tsx')) as unknown as Record<
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

async function mount(page: Page, user: User): Promise<void> {
  await page.evaluate(
    async (input) => {
      const module = await import('/src/features/sessions/e2e-harness.tsx');
      module.mountSessions(input);
    },
    { userId: user.userId, campaignId: fixture?.campaignId ?? '' },
  );
}

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
  await page.goto('/');
  await mount(page, user);
  await expect(page.locator('[data-session-loaded="true"]')).toBeVisible({ timeout: SYNC });
  return { context, page, user, network };
}

async function offline(target: Device): Promise<void> {
  target.network.down = true;
  await harness(target.page, 'pauseSync');
}

async function online(target: Device): Promise<void> {
  target.network.down = false;
  await harness(target.page, 'resumeSync');
}

async function settled(target: Device): Promise<void> {
  await expect.poll(() => harness<number>(target.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
}

const mode = (page: Page) => page.getByRole('region', { name: 'Session Mode' });

async function startSession(gm: Device): Promise<void> {
  const start = mode(gm.page).getByRole('button', { name: /^Start session \d+$/ });
  await expect(start).toBeVisible({ timeout: SYNC });
  await start.click();
  await expect(mode(gm.page).getByRole('region', { name: 'Party' })).toBeVisible();
}

async function endSession(gm: Device): Promise<void> {
  await mode(gm.page).getByRole('button', { name: 'End session' }).click();
  await mode(gm.page)
    .getByRole('button', { name: /^Confirm end of Session \d+$/ })
    .click();
  await expect(mode(gm.page).getByRole('button', { name: /^Start session \d+$/ })).toBeVisible();
}

test('a GM runs a session from one screen: party, scene, quick actions, palette, notes, log', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(180_000);
  const current = fixture as Fixture;
  const casey = await device(browser, current.casey);
  const gm = await device(browser, current.gm);
  try {
    await harness(casey.page, 'createCharacter', 'Bryn');
    await settled(casey);
    await harness(gm.page, 'seedScene', {
      scene: 'Old Warehouse',
      location: 'Lower District',
      npc: 'Merchant',
    });
    await settled(gm);
    await startSession(gm);
    const screen = mode(gm.page);
    await expect(screen.getByRole('heading', { name: 'Session 1' })).toBeVisible();

    // Party status at a glance, from the package's declared summary fields.
    const party = screen.getByRole('region', { name: 'Party' });
    await expect(party).toContainText('Bryn', { timeout: SYNC });
    await expect(party).toContainText(/Focus \d+\/\d+/);

    // The current scene with its location and NPCs.
    await screen.getByRole('combobox', { name: 'Scene' }).selectOption({ label: 'Old Warehouse' });
    const scene = screen.getByRole('region', { name: 'Current scene' });
    await expect(scene).toContainText('Lower District');
    await expect(scene.getByRole('list', { name: 'NPCs in the scene' })).toContainText('Merchant');

    // Quick action: an NPC from Session Mode, timed, and the screen is still there afterwards.
    const npcStarted = Date.now();
    await screen.getByRole('button', { name: 'Add NPC', exact: true }).click();
    const overlay = gm.page.getByRole('dialog', { name: 'Quick create' });
    await expect(overlay.getByRole('form', { name: 'Add NPC' })).toBeVisible();
    await gm.page.keyboard.type('Smuggler');
    await gm.page.keyboard.press('Enter');
    await expect(overlay).toHaveCount(0);
    await expect
      .poll(() => harness<readonly string[]>(gm.page, 'storedEntityNames'))
      .toContain('Smuggler');
    const npcMs = Date.now() - npcStarted;
    console.info(`session mode: Add NPC -> typed name -> stored locally in ${npcMs} ms`);
    expect(npcMs).toBeLessThan(NPC_BUDGET_MS);
    await expect(screen.getByRole('region', { name: 'Party' })).toBeVisible();

    // The palette executes operations without leaving the screen.
    await gm.page.keyboard.press('Control+K');
    const palette = gm.page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('textbox', { name: 'Command' }).fill('pause');
    await gm.page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(screen.getByRole('status').first()).toContainText('Paused');
    await gm.page.keyboard.press('Control+K');
    await palette.getByRole('textbox', { name: 'Command' }).fill('resume');
    await gm.page.keyboard.press('Enter');
    await expect(screen.getByRole('status').first()).toContainText('Active');
    await gm.page.keyboard.press('Control+K');
    await palette.getByRole('textbox', { name: 'Command' }).fill('merch');
    await gm.page.keyboard.press('Enter');
    await expect(screen.getByRole('region', { name: 'Lookup' })).toContainText('Merchant');
    await gm.page.keyboard.press('Control+K');
    await palette.getByRole('textbox', { name: 'Command' }).fill('The bell tolls');
    await gm.page.keyboard.press('ArrowDown');
    await palette.getByRole('button', { name: 'Add to log: The bell tolls' }).click();

    // GM notes and a public log note.
    await screen.getByLabel('GM notes text').fill('Crates hide a second entrance.');
    await screen.getByRole('button', { name: 'Save notes' }).click();
    await expect(screen.getByRole('region', { name: 'GM notes' })).toContainText('Saved');
    await screen.getByLabel('Log note').fill('The guards change shift.');
    await screen.getByLabel('Show to players').check();
    await screen.getByRole('button', { name: 'Add to log' }).click();
    const log = screen.getByTestId('session-log');
    for (const text of [
      'Session started',
      'Scene: Old Warehouse',
      'Session paused',
      'Session resumed',
      'The bell tolls',
      'The guards change shift.',
    ]) {
      await expect(log).toContainText(text);
    }
    await settled(gm);

    // The player's device: the session and the public entries, never the notes or a GM-only entry.
    const player = mode(casey.page);
    await expect(player.getByRole('heading', { name: 'Session 1' })).toBeVisible({
      timeout: SYNC,
    });
    await expect(player.getByTestId('session-log')).toContainText('The guards change shift.', {
      timeout: SYNC,
    });
    await expect(player.getByRole('region', { name: 'Your character' })).toContainText('Bryn');
    await expect(player.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    const held = (
      await harness<readonly string[]>(casey.page, 'storedRows', 'session_log_entries')
    ).join('\n');
    expect(held).toContain('The guards change shift.');
    expect(held).not.toContain('The bell tolls');
    expect(await harness(casey.page, 'storedRows', 'session_gm_notes')).toEqual([]);
    // The hidden scene stays unnamed on the player's screen and device.
    await expect(player).not.toContainText('Old Warehouse');

    await endSession(gm);
    await settled(gm);
    await expect(screen.getByRole('region', { name: 'Past sessions' })).toContainText(
      'Session 1, ended',
    );
  } finally {
    await gm.context.close();
    await casey.context.close();
  }
});

test('a reveal from Session Mode reaches the player in under 5 seconds and is logged', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(150_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  const casey = await device(browser, current.casey);
  try {
    await harness(gm.page, 'createHandout', { title: 'Sealed letter', text: 'Meet at the ford.' });
    await settled(gm);
    await startSession(gm);
    const screen = mode(gm.page);
    await screen.getByRole('button', { name: 'Reveal handout' }).click();
    const overlay = gm.page.getByRole('dialog', { name: 'Reveal handout' });
    await overlay.getByRole('button', { name: 'Sealed letter' }).click();
    const reveal = overlay.getByRole('region', { name: 'Reveal' });
    await reveal.getByLabel(current.casey.username).check({ timeout: SYNC });
    const started = Date.now();
    await reveal.getByRole('button', { name: `Reveal to ${current.casey.username}` }).click();
    await expect(mode(casey.page).getByRole('region', { name: 'Revealed handouts' })).toContainText(
      'Sealed letter',
      { timeout: REVEAL_BUDGET_MS },
    );
    const elapsed = Date.now() - started;
    console.info(`session mode: reveal confirm -> player screen ${elapsed} ms`);
    expect(elapsed).toBeLessThan(REVEAL_BUDGET_MS);
    await overlay.getByRole('button', { name: 'Close' }).click();
    await expect(screen.getByTestId('session-log')).toContainText('Revealed Sealed letter');
    await settled(gm);
    // The reveal entry is the GM's record: the player sees the handout, not the entry.
    const held = await harness<readonly string[]>(casey.page, 'storedRows', 'session_log_entries');
    expect(held.some((row) => row.includes('"reveal"'))).toBe(false);
    await endSession(gm);
    await settled(gm);
  } finally {
    await gm.context.close();
    await casey.context.close();
  }
});

test('a whole session runs offline and is accepted once on reconnect', async ({ browser }) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(150_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  const assistant = await device(browser, current.assistant);
  try {
    await expect(mode(gm.page).getByRole('button', { name: /^Start session \d+$/ })).toBeVisible({
      timeout: SYNC,
    });
    await offline(gm);
    await startSession(gm);
    const screen = mode(gm.page);
    const name = (await screen.getByRole('heading', { level: 2 }).textContent()) ?? '';
    await screen.getByRole('combobox', { name: 'Scene' }).selectOption({ label: 'Old Warehouse' });
    await screen.getByLabel('GM notes text').fill('Offline notes survive.');
    await screen.getByRole('button', { name: 'Save notes' }).click();
    await screen.getByLabel('Log note').fill('Written in a dead spot.');
    await screen.getByRole('button', { name: 'Add to log' }).click();
    await expect(screen.getByTestId('session-log')).toContainText('Written in a dead spot.');
    await endSession(gm);
    expect(await harness<number>(gm.page, 'pendingCount')).toBeGreaterThanOrEqual(6);
    await assistant.page.waitForTimeout(1_500);
    await expect(mode(assistant.page)).not.toContainText(name);

    await online(gm);
    await settled(gm);
    const past = mode(assistant.page).getByRole('region', { name: 'Past sessions' });
    await expect(past).toContainText(`${name}, ended`, { timeout: SYNC });
    // Accepted once: one row per session on the assistant's replica, with the offline notes.
    const sessions = await harness<readonly string[]>(
      assistant.page,
      'storedRows',
      'campaign_sessions',
    );
    expect(sessions.filter((row) => row.includes('"status":"ended"')).length).toBe(sessions.length);
    const notes = await harness<readonly string[]>(
      assistant.page,
      'storedRows',
      'session_gm_notes',
    );
    expect(notes.some((row) => row.includes('Offline notes survive.'))).toBe(true);
  } finally {
    await gm.context.close();
    await assistant.context.close();
  }
});

test('ten cold offline opens of Session Mode stay under 2 seconds at p95', async ({ browser }) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(180_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  try {
    await startSession(gm);
    await settled(gm);
    gm.network.down = true;
    const samples: number[] = [];
    for (let run = 0; run < 10; run += 1) {
      const started = Date.now();
      await gm.page.reload();
      await mount(gm.page, gm.user);
      await expect(mode(gm.page).getByRole('region', { name: 'Party' })).toBeVisible({
        timeout: SYNC,
      });
      samples.push(Date.now() - started);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    console.info(`session mode cold offline open: ${samples.join(', ')} ms; p95 ${p95} ms`);
    expect(p95).toBeLessThan(COLD_OPEN_BUDGET_MS);
    gm.network.down = false;
    await harness(gm.page, 'resumeSync');
    await endSession(gm);
    await settled(gm);
  } finally {
    await gm.context.close();
  }
});
