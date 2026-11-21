import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';

/**
 * Feature 19 on the real stack (`PRD.md` s.46, s.47, s.76, s.78): the production tracker over the browser replica
 * (test-only host `features/encounters/e2e-harness.tsx`, composed like the app shell), the running PowerSync
 * service, and the real API composition root (`fixtures/encounters-api-server.ts`). A GM starts an encounter from
 * Session Mode in under 15 seconds, applies damage and a condition in one interaction each (on an instance and,
 * write-through, on a character), the player's device holds labels and public conditions but no statistics, and a
 * whole encounter runs offline. Names come from the pinned package's declarations, never from its identity.
 *
 * Skipped unless PostgreSQL and the PowerSync service are reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/encounters-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4194;
const API = `http://127.0.0.1:${PORT}`;
const API_ORIGIN = 'https://table.invalid';
const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SYNC = Number(process.env.E2E_SYNC_TIMEOUT_MS ?? 30_000);
const START_BUDGET_MS = 15_000;

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
  readonly casey: User;
}
interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
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
      const module = (await import(
        '/src/features/encounters/e2e-harness.tsx'
      )) as unknown as Record<string, (value?: unknown) => unknown>;
      const fn = module[input.name];
      if (fn === undefined) throw new Error(`unknown harness function ${input.name}`);
      return fn(input.arg);
    },
    { name, arg },
  ) as Promise<T>;
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
  await page.evaluate(
    async (input) => {
      const module = await import('/src/features/encounters/e2e-harness.tsx');
      module.mountEncounters(input);
    },
    { userId: user.userId, campaignId: fixture?.campaignId ?? '' },
  );
  await expect(page.locator('[data-encounters-loaded="true"]').first()).toBeVisible({
    timeout: SYNC,
  });
  return { context, page, network };
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

const card = (scope: Locator, label: string) => scope.getByRole('article', { name: label });

/** The first `-1` control of a participant: whatever the package's first summary value is. */
async function damage(scope: Locator, label: string): Promise<void> {
  const participant = card(scope, label);
  const before = await participant.getByTestId('participant-summary').innerText();
  await participant
    .getByRole('group', { name: `Controls for ${label}` })
    .getByRole('button', { name: / -1$/ })
    .first()
    .click();
  await expect(participant.getByTestId('participant-summary')).not.toHaveText(before);
}

/** The first declared condition a participant can take: the one the tracker lists first. */
async function condition(scope: Locator, label: string): Promise<string> {
  const add = card(scope, label)
    .getByRole('group', { name: `Controls for ${label}` })
    .getByRole('button', { name: /^Add / })
    .first();
  const name = ((await add.getAttribute('aria-label')) ?? '').replace(/^Add /, '');
  await add.click();
  await expect(card(scope, label)).toContainText(`Conditions: ${name}`);
  return name;
}

test('a GM starts an encounter from Session Mode in under 15 seconds and runs it; the player holds no statistics', async ({
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
    await harness(gm.page, 'createCreature', 'Bandit');
    await settled(gm);
    const mode = gm.page.getByRole('region', { name: 'Session Mode' });
    const start = mode.getByRole('button', { name: /^Start session \d+$/ });
    await expect(start).toBeVisible({ timeout: SYNC });
    await start.click();
    await expect(mode.getByRole('region', { name: 'Party' })).toContainText('Bryn', {
      timeout: SYNC,
    });

    // PRD s.78: from the quick action to a running encounter with the party and three bandits.
    const begun = Date.now();
    await mode.getByRole('button', { name: 'Add encounter', exact: true }).click();
    const overlay = gm.page.getByRole('dialog', { name: 'Encounter tracker' });
    const form = overlay.getByRole('form', { name: 'Start encounter' });
    await expect(form.getByLabel('Bryn')).toBeChecked();
    await form.getByRole('combobox', { name: /^Creature/ }).selectOption({ label: 'Bandit' });
    await form.getByLabel('Creature count').fill('3');
    // The creature is GM-only, so its instances start hidden; this group is shown to the table.
    await expect(form.getByLabel('Hide from players')).toBeChecked();
    await form.getByLabel('Hide from players').uncheck();
    await form.getByRole('button', { name: 'Start encounter' }).click();
    const tracker = overlay.getByRole('region', { name: 'Tracker' });
    for (const label of ['Bryn', 'Bandit 1', 'Bandit 2', 'Bandit 3']) {
      await expect(card(tracker, label)).toBeVisible();
    }
    const elapsed = Date.now() - begun;
    console.info(`encounter: Add encounter -> party and three bandits running in ${elapsed} ms`);
    expect(elapsed).toBeLessThan(START_BUDGET_MS);
    // No turn order is imposed (D-09).
    await expect(tracker).not.toContainText(/initiative|round|turn order/i);

    // FR-006: one interaction each, on an instance and (write-through) on the character.
    const untouched = await card(tracker, 'Bandit 2')
      .getByTestId('participant-summary')
      .innerText();
    await damage(tracker, 'Bandit 1');
    await expect(card(tracker, 'Bandit 2').getByTestId('participant-summary')).toHaveText(
      untouched,
    );
    const shown = await condition(tracker, 'Bandit 1');
    await damage(tracker, 'Bryn');
    // FR-010: an improvised enemy mid-encounter, a real (GM-only) entity, hidden until revealed.
    const add = tracker.getByRole('form', { name: 'Add participants' });
    await add.getByLabel('Improvised enemy').fill('Ogre');
    await add.getByRole('button', { name: 'Add to encounter' }).click();
    await expect(card(tracker, 'Ogre')).toBeVisible();
    await card(tracker, 'Bandit 3').getByRole('button', { name: 'Remove Bandit 3' }).click();
    await expect(card(tracker, 'Bandit 3')).toHaveCount(0);
    await settled(gm);

    // The player's device: labels and the public condition; their own character; no statistics.
    const view = casey.page.getByRole('region', { name: 'Encounter', exact: true });
    await expect(view).toContainText('Bandit 1', { timeout: SYNC });
    await expect(view).toContainText(shown);
    await expect(view).toContainText('Ogre');
    await expect(view.getByRole('button')).toHaveCount(0);
    await expect(view.getByTestId('participant-summary')).toHaveCount(1);
    expect(await harness(casey.page, 'storedRows', 'encounter_participant_states')).toEqual([]);
    expect(await harness(casey.page, 'storedRows', 'encounter_gm_notes')).toEqual([]);

    await overlay.getByRole('button', { name: 'End encounter' }).click();
    await expect(overlay.getByRole('region', { name: 'Tracker' })).toContainText('Ended');
    await overlay.getByRole('button', { name: 'Close tracker' }).click();
    await expect(overlay).toHaveCount(0);
    await expect(mode.getByRole('region', { name: 'Party' })).toBeVisible();
    await settled(gm);
    await expect(casey.page.getByRole('region', { name: 'Encounters' })).toContainText(
      'No encounter is running.',
      { timeout: SYNC },
    );
    await mode.getByRole('button', { name: 'End session' }).click();
    await mode.getByRole('button', { name: /^Confirm end of Session \d+$/ }).click();
    await settled(gm);
  } finally {
    await gm.context.close();
    await casey.context.close();
  }
});

test('a whole encounter runs offline and is accepted once on reconnect (PRD s.76)', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(150_000);
  const current = fixture as Fixture;
  const gm = await device(browser, current.gm);
  try {
    const encounters = gm.page.getByRole('region', { name: 'Encounters', exact: true });
    // No encounter is running, so the tracker opens on the start form.
    const form = encounters.getByRole('form', { name: 'Start encounter' });
    await expect(form.getByLabel('Bryn')).toBeChecked({ timeout: SYNC });
    await offline(gm);
    await form.getByLabel('Encounter name').fill('Wolves in the dark');
    await form.getByLabel('Bryn').uncheck();
    await form.getByLabel('Improvised enemy').fill('Wolf');
    await form.getByLabel('Improvised count').fill('2');
    await form.getByRole('button', { name: 'Start encounter' }).click();
    const tracker = encounters.getByRole('region', { name: 'Tracker' });
    await expect(card(tracker, 'Wolf 2')).toBeVisible();
    await damage(tracker, 'Wolf 1');
    await condition(tracker, 'Wolf 2');
    await tracker.getByRole('textbox', { name: 'Environment' }).fill('Moonless, wet ground');
    await tracker.getByRole('button', { name: 'Save environment' }).click();
    await tracker.getByRole('button', { name: 'End encounter' }).click();
    await expect(tracker).toContainText('Ended');
    expect(await harness<number>(gm.page, 'pendingCount')).toBeGreaterThan(0);
    await online(gm);
    await settled(gm);
    const stored = (await harness<readonly string[]>(gm.page, 'storedRows', 'encounters')).join(
      '\n',
    );
    expect(stored).toContain('Wolves in the dark');
    expect(stored).toContain('Moonless, wet ground');
    expect(stored).toContain('"status":"ended"');
    expect(
      await harness<readonly string[]>(gm.page, 'storedRows', 'encounter_participant_states'),
    ).not.toHaveLength(0);
  } finally {
    await gm.context.close();
  }
});
