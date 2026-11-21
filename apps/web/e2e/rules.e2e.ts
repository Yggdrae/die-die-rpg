import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * Feature 14 on the real stack (`PRD.md` s.78, s.87 Test 8, s.88): the production rules library over the browser
 * replica (test-only host `features/rules/e2e-harness.tsx`, composed like the app shell), the running PowerSync
 * service, and the real API composition root (`fixtures/rules-api-server.ts`: a GM and a player in a campaign pinned to
 * the first catalog package that integrates rules text). A rule is found in under 10 seconds from focusing the search,
 * online and offline (D-16); cross-references, bookmarks, and recently viewed work; the campaign search and the
 * Session Mode palette reach the same section; marks stay private to their owner; an offline bookmark reaches the
 * authority.
 *
 * Skipped unless PostgreSQL and the PowerSync service are reachable.
 */

const HELPER = 'apps/web/e2e/fixtures/rules-api-server.ts';
const APP = 'http://127.0.0.1:4173';
const PORT = 4196;
const API = `http://127.0.0.1:${PORT}`;
const API_ORIGIN = 'https://table.invalid';
const ENDPOINT = process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080';
const SYNC = Number(process.env.E2E_SYNC_TIMEOUT_MS ?? 30_000);
const FIND_BUDGET_MS = 10_000;

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

interface User {
  readonly cookie: string;
  readonly userId: string;
  readonly username: string;
}
interface Section {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly body?: string;
  readonly references: readonly string[];
}
interface Fixture {
  readonly campaignId: string;
  readonly gm: User;
  readonly casey: User;
  readonly sections: readonly Section[];
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
      const module = (await import('/src/features/rules/e2e-harness.tsx')) as unknown as Record<
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

function authorityMarks(campaignId: string, userId: string) {
  const output = execFileSync('bun', [HELPER, 'marks', campaignId, userId], {
    env: process.env,
  }).toString();
  return JSON.parse(output.trim().split('\n').pop() ?? '[]') as {
    section_id: string;
    bookmarked: boolean;
  }[];
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
      const module = await import('/src/features/rules/e2e-harness.tsx');
      module.mountRules(input);
    },
    { userId: user.userId, campaignId: fixture?.campaignId ?? '' },
  );
  await expect(library(page)).toHaveAttribute('data-rules-state', 'integrated', {
    timeout: SYNC,
  });
  return { context, page, network };
}

async function settled(target: Device): Promise<void> {
  await expect.poll(() => harness<number>(target.page, 'pendingCount'), { timeout: SYNC }).toBe(0);
}

const library = (page: Page) => page.getByRole('region', { name: 'Rules library' });
const rulesBox = (page: Page) => library(page).getByRole('searchbox', { name: 'Search rules' });
const article = (page: Page, section: Section) =>
  library(page).getByRole('article', { name: `Rule: ${section.title}` });

function sections(current: Fixture) {
  const quick = current.sections.find(
    (section) => section.summary !== undefined && section.references.length > 0,
  );
  const plain = current.sections.find(
    (section) => section.summary === undefined && section.body !== undefined,
  );
  if (quick === undefined || plain === undefined) throw new Error('fixture rules tree');
  return { quick, plain };
}

/** The start of a section title's first word: what a person says out loud. */
const spoken = (section: Section) =>
  (section.title.split(/\s+/)[0] ?? '').slice(0, 4).toLowerCase();

/** D-16: from focusing the rules search to the section's text on screen. */
async function findRule(page: Page, section: Section): Promise<number> {
  const begun = Date.now();
  await rulesBox(page).focus();
  await rulesBox(page).fill(spoken(section));
  await library(page)
    .getByRole('list', { name: 'Rules results' })
    .getByRole('button', { name: section.title, exact: true })
    .click();
  await expect(article(page, section).getByTestId('rule-text')).toContainText(
    (section.body ?? '').slice(0, 40),
  );
  return Date.now() - begun;
}

test('a rule is found in under 10 seconds; references, bookmarks, search, palette; marks stay private (PRD s.78, s.88)', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(180_000);
  const current = fixture as Fixture;
  const { quick } = sections(current);
  const gm = await device(browser, current.gm);
  const casey = await device(browser, current.casey);
  try {
    // FR-002, D-16: the spoken word, the result, the text, under 10 seconds.
    const elapsed = await findRule(gm.page, quick);
    console.info(`rules: "${spoken(quick)}" -> ${quick.title} in ${elapsed} ms (online)`);
    expect(elapsed).toBeLessThan(FIND_BUDGET_MS);
    // FR-007: the quick rule leads the result and the section; the scope is stated.
    const results = library(gm.page).getByRole('list', { name: 'Rules results' });
    await expect(results.getByRole('listitem').first()).toContainText(
      `Quick rule: ${quick.summary}`,
    );
    await expect(
      article(gm.page, quick).getByRole('complementary', { name: 'Quick rule' }),
    ).toContainText(quick.summary as string);
    await expect(library(gm.page).getByTestId('rules-scope')).toContainText('on this device');

    // FR-004: a cross-reference is one tap away.
    const [referenceId] = quick.references;
    const reference = current.sections.find((section) => section.id === referenceId) as Section;
    await article(gm.page, quick)
      .getByRole('navigation', { name: 'See also' })
      .getByRole('button', { name: reference.title, exact: true })
      .click();
    await expect(article(gm.page, reference)).toBeVisible();

    // FR-005, FR-006: bookmark the quick section; recently viewed lists the newest first.
    await library(gm.page)
      .getByRole('navigation', { name: 'Rules contents' })
      .getByRole('button', { name: quick.title, exact: true })
      .click();
    await article(gm.page, quick).getByRole('button', { name: 'Bookmark' }).click();
    const bookmarks = library(gm.page).getByRole('navigation', { name: 'Bookmarks' });
    await expect(bookmarks.getByRole('button', { name: quick.title, exact: true })).toBeVisible();
    const recent = library(gm.page).getByRole('navigation', { name: 'Recently viewed' });
    await expect(recent.getByRole('listitem')).toHaveText([reference.title, quick.title]);

    // FR-012: the campaign search finds the rule, labelled Rule, and opens it in the library.
    await gm.page
      .getByRole('region', { name: 'Campaign search' })
      .getByRole('searchbox')
      .fill(quick.title);
    const searchResults = gm.page
      .getByRole('region', { name: 'Campaign search' })
      .getByRole('list', { name: 'Search results' });
    const link = searchResults.getByRole('link', { name: quick.title, exact: true });
    await expect(link).toBeVisible({ timeout: SYNC });
    await expect(searchResults.getByRole('listitem').first()).toContainText('Rule');
    await library(gm.page)
      .getByRole('navigation', { name: 'Rules contents' })
      .getByRole('button', { name: reference.title, exact: true })
      .click();
    await link.click();
    await expect(article(gm.page, quick)).toBeVisible();

    // The Session Mode palette reaches the rule through the shell's search provider.
    const mode = gm.page.getByRole('region', { name: 'Session Mode' });
    const start = mode.getByRole('button', { name: /^Start session \d+$/ });
    await expect(start).toBeVisible({ timeout: SYNC });
    await start.click();
    await expect(mode.getByRole('button', { name: 'End session' })).toBeVisible({ timeout: SYNC });
    await library(gm.page)
      .getByRole('navigation', { name: 'Rules contents' })
      .getByRole('button', { name: reference.title, exact: true })
      .click();
    await gm.page.keyboard.press('Control+K');
    const palette = gm.page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('textbox', { name: 'Command' }).fill(quick.title);
    await expect(palette.getByRole('list', { name: 'Results' })).toContainText('Rule');
    await palette.getByRole('button', { name: quick.title, exact: true }).click();
    await expect(palette).toHaveCount(0);
    await expect(article(gm.page, quick)).toBeVisible();
    await mode.getByRole('button', { name: 'End session' }).click();
    await mode.getByRole('button', { name: /^Confirm end of Session \d+$/ }).click();
    await settled(gm);
    expect(authorityMarks(current.campaignId, current.gm.userId)).toContainEqual({
      section_id: quick.id,
      bookmarked: true,
    });

    // Privacy (D-10): the player's device never holds the GM's marks, and the reverse.
    await expect(library(casey.page).getByRole('navigation', { name: 'Bookmarks' })).toContainText(
      'No bookmarks yet.',
    );
    await library(casey.page)
      .getByRole('navigation', { name: 'Rules contents' })
      .getByRole('button', { name: reference.title, exact: true })
      .click();
    await article(casey.page, reference).getByRole('button', { name: 'Bookmark' }).click();
    await settled(casey);
    expect(authorityMarks(current.campaignId, current.casey.userId)).toContainEqual({
      section_id: reference.id,
      bookmarked: true,
    });
    for (const [who, owner] of [
      [gm, current.gm.userId],
      [casey, current.casey.userId],
    ] as const) {
      const owners = await harness<string[]>(who.page, 'markOwners');
      expect(owners.length).toBeGreaterThan(0);
      expect(new Set(owners)).toEqual(new Set([owner]));
    }
    await expect(
      library(gm.page)
        .getByRole('navigation', { name: 'Bookmarks' })
        .getByRole('button', { name: reference.title, exact: true }),
    ).toHaveCount(0);
  } finally {
    await gm.context.close();
    await casey.context.close();
  }
});

test('offline: a rule is found in under 10 seconds and a bookmark reaches the authority later (PRD s.87 Test 8)', async ({
  browser,
}) => {
  test.skip(fixture === undefined, 'PostgreSQL and the PowerSync service are required');
  test.setTimeout(120_000);
  const current = fixture as Fixture;
  const { plain } = sections(current);
  const gm = await device(browser, current.gm);
  try {
    gm.network.down = true;
    await harness(gm.page, 'pauseSync');
    const elapsed = await findRule(gm.page, plain);
    console.info(`rules: "${spoken(plain)}" -> ${plain.title} in ${elapsed} ms (offline)`);
    expect(elapsed).toBeLessThan(FIND_BUDGET_MS);
    await article(gm.page, plain).getByRole('button', { name: 'Bookmark' }).click();
    await expect(
      library(gm.page)
        .getByRole('navigation', { name: 'Bookmarks' })
        .getByRole('button', { name: plain.title, exact: true }),
    ).toBeVisible();
    expect(await harness<number>(gm.page, 'pendingCount')).toBeGreaterThan(0);
    expect(authorityMarks(current.campaignId, current.gm.userId)).not.toContainEqual({
      section_id: plain.id,
      bookmarked: true,
    });
    gm.network.down = false;
    await harness(gm.page, 'resumeSync');
    await settled(gm);
    expect(authorityMarks(current.campaignId, current.gm.userId)).toContainEqual({
      section_id: plain.id,
      bookmarked: true,
    });
  } finally {
    await gm.context.close();
  }
});
