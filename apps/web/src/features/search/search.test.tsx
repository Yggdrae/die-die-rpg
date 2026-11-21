import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SearchDoc, Visibility } from '@rpg/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchResultsView } from './SearchWorkspace.tsx';
import {
  createSearchService,
  type SearchActor,
  type SearchContribution,
} from './search-service.ts';

/** Feature 20 task 03: the device search service and screen (`_bdd.md` Visibility, Freshness, Composition). */

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const GM: SearchActor = { userId: '00000000-0000-4000-8000-0000000000a1', role: 'gm' };
const PLAYER: SearchActor = { userId: '00000000-0000-4000-8000-0000000000b2', role: 'player' };
const EVERYONE: Visibility = { mode: 'everyone' };
const HIDDEN: Visibility = { mode: 'gm_only' };

function doc(id: string, title: string, visibility: Visibility = EVERYONE, body = ''): SearchDoc {
  return { id, type: 'widget', title, body, campaignId: CAMPAIGN, visibility };
}

/** A contribution over a mutable list, with a change trigger like an owning source's `subscribe`. */
function fake(moduleId: string, initial: SearchDoc[]) {
  const state = {
    docs: initial,
    calls: 0,
    fail: false,
    gate: undefined as Promise<void> | undefined,
  };
  const listeners = new Set<() => void>();
  const contribution: SearchContribution = {
    indexer: {
      moduleId,
      async index() {
        state.calls += 1;
        await state.gate;
        if (state.fail) throw new Error('boom');
        return state.docs;
      },
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    typeLabel: (type) => `${moduleId}/${type}`,
    route: (item) => `#/${moduleId}/${item.id}`,
  };
  const change = () => {
    for (const listener of [...listeners]) listener();
  };
  return { state, contribution, change };
}

function service(
  contributions: SearchContribution[],
  actor: { current?: SearchActor } = { current: GM },
) {
  const created = createSearchService({
    campaignId: CAMPAIGN,
    contributions,
    actor: async () => actor.current,
    schedule: (task) => task(),
  });
  return created;
}

const titles = (answer: { results: readonly { title: string }[] }) =>
  answer.results.map((result) => result.title);

describe('search service', () => {
  test('builds from every contribution after start, labelled and routed by the owner', async () => {
    const alpha = fake('alpha', [doc('a1', 'Mirela Voss', HIDDEN)]);
    const beta = fake('beta', [doc('b1', 'Wareham Ford')]);
    const search = service([alpha.contribution, beta.contribution]);
    expect(search.status().ready).toBe(false);
    search.start();
    await search.settled();
    expect(search.status()).toEqual({ ready: true, failed: [], rejected: 0 });
    expect(search.query('mir').results).toEqual([
      {
        key: 'alpha:a1',
        id: 'a1',
        moduleId: 'alpha',
        title: 'Mirela Voss',
        typeLabel: 'alpha/widget',
        href: '#/alpha/a1',
      },
    ]);
    search.dispose();
  });

  test('a change re-runs only that module and replaces its documents (FR-005)', async () => {
    const alpha = fake('alpha', [doc('a1', 'Old Mill')]);
    const beta = fake('beta', [doc('b1', 'Bridge')]);
    const search = service([alpha.contribution, beta.contribution]);
    search.start();
    await search.settled();
    alpha.state.docs = [doc('a2', 'New Mill')];
    alpha.change();
    await search.settled();
    expect(titles(search.query('mill'))).toEqual(['New Mill']);
    expect([alpha.state.calls, beta.state.calls]).toEqual([2, 1]);
    search.dispose();
  });

  test('changes during a run coalesce into one more run', async () => {
    let release = () => {};
    const alpha = fake('alpha', [doc('a1', 'First')]);
    const search = service([alpha.contribution]);
    search.start();
    await search.settled();
    alpha.state.gate = new Promise((resolve) => {
      release = resolve;
    });
    alpha.change();
    alpha.change();
    alpha.change();
    alpha.state.docs = [doc('a1', 'Second')];
    release();
    await search.settled();
    expect(alpha.state.calls).toBe(3);
    expect(titles(search.query('second'))).toEqual(['Second']);
    search.dispose();
  });

  test('a reveal admits the document at the next query, with no rebuild (FR-004)', async () => {
    const alpha = fake('alpha', [doc('a1', 'Mirela Voss', HIDDEN), doc('a2', 'Wareham Ford')]);
    const search = service([alpha.contribution], { current: PLAYER });
    search.start();
    await search.settled();
    expect(search.query('mir')).toEqual({ results: [], total: 0 });
    expect(titles(search.query('ware'))).toEqual(['Wareham Ford']);
    alpha.state.docs = [doc('a1', 'Mirela Voss', { mode: 'players', playerIds: [PLAYER.userId] })];
    alpha.change();
    await search.settled();
    expect(titles(search.query('mir'))).toEqual(['Mirela Voss']);
    search.dispose();
  });

  test('no membership admits nothing; the actor is read again on change', async () => {
    const actor: { current?: SearchActor } = {};
    const alpha = fake('alpha', [doc('a1', 'Wareham Ford')]);
    const search = service([alpha.contribution], actor);
    search.start();
    await search.settled();
    expect(search.query('ware').total).toBe(0);
    actor.current = PLAYER;
    alpha.change();
    await search.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(search.query('ware').total).toBe(1);
    search.dispose();
  });

  test('a failing module is named and the others still answer; a later success clears it', async () => {
    const alpha = fake('alpha', [doc('a1', 'Alpha Thing')]);
    const beta = fake('beta', [doc('b1', 'Beta Thing')]);
    beta.state.fail = true;
    const search = service([alpha.contribution, beta.contribution]);
    search.start();
    await search.settled();
    expect(search.status()).toEqual({ ready: true, failed: ['beta'], rejected: 0 });
    expect(titles(search.query('thing'))).toEqual(['Alpha Thing']);
    beta.state.fail = false;
    beta.change();
    await search.settled();
    expect(search.status().failed).toEqual([]);
    expect(search.query('thing').total).toBe(2);
    search.dispose();
  });

  test('foreign-campaign and invalid documents are dropped and counted (D-06)', async () => {
    const alpha = fake('alpha', [
      doc('a1', 'Kept'),
      { ...doc('a2', 'Foreign'), campaignId: '00000000-0000-4000-8000-000000000009' },
    ]);
    const search = service([alpha.contribution]);
    search.start();
    await search.settled();
    expect(search.status().rejected).toBe(1);
    expect(search.query('foreign').total).toBe(0);
    search.dispose();
  });

  test('rebuild runs every contributor again and equals the incremental index (FR-009)', async () => {
    const alpha = fake('alpha', [doc('a1', 'Wareham Ford'), doc('a2', 'Ford Keeper')]);
    const beta = fake('beta', [doc('b1', 'Fording Point', EVERYONE, 'A ford.')]);
    const search = service([alpha.contribution, beta.contribution]);
    search.start();
    await search.settled();
    const before = search.query('ford');
    await search.rebuild();
    expect(search.query('ford')).toEqual(before);
    expect([alpha.state.calls, beta.state.calls]).toEqual([2, 2]);
    search.dispose();
  });

  test('the first build waits for the scheduler (D-08) and duplicate modules are refused', async () => {
    const alpha = fake('alpha', [doc('a1', 'Thing')]);
    const tasks: (() => void)[] = [];
    const search = createSearchService({
      campaignId: CAMPAIGN,
      contributions: [alpha.contribution],
      actor: async () => GM,
      schedule: (task) => tasks.push(task),
    });
    search.start();
    expect(alpha.state.calls).toBe(0);
    tasks[0]?.();
    await search.settled();
    expect(alpha.state.calls).toBe(1);
    search.dispose();
    expect(() =>
      createSearchService({
        campaignId: CAMPAIGN,
        contributions: [alpha.contribution, alpha.contribution],
        actor: async () => GM,
      }),
    ).toThrow('duplicate search module alpha');
  });
});

describe('search screen', () => {
  const answer = {
    total: 1,
    results: [
      {
        key: 'alpha:a1',
        id: 'a1',
        moduleId: 'alpha',
        title: 'Wareham Ford',
        typeLabel: 'Location',
        snippet: 'A shallow crossing.',
        href: '#/content/a1',
      },
    ],
  };

  test('lists links labelled by type with the count; states indexing and failures', () => {
    const html = renderToStaticMarkup(
      <SearchResultsView
        query="ware"
        status={{ ready: false, failed: ['beta'], rejected: 0 }}
        answer={answer}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('Indexing…');
    expect(html).toContain('Could not index: beta.');
    expect(html).toContain('1 result');
    expect(html).toContain('<a href="#/content/a1">Wareham Ford</a>');
    expect(html).toContain('<small>Location</small>');
    expect(html).toContain('A shallow crossing.');
  });

  test('an empty answer reads 0 results; no query shows no count', () => {
    const ready = { ready: true, failed: [], rejected: 0 };
    const empty = renderToStaticMarkup(
      <SearchResultsView
        query="mir"
        status={ready}
        answer={{ total: 0, results: [] }}
        onOpen={() => undefined}
      />,
    );
    expect(empty).toContain('0 results');
    expect(empty).toContain('No results.');
    const idle = renderToStaticMarkup(
      <SearchResultsView
        query=""
        status={ready}
        answer={{ total: 0, results: [] }}
        onOpen={() => undefined}
      />,
    );
    expect(idle).not.toContain('results</p>');
    expect(idle).not.toContain('Indexing');
  });
});

describe('architecture', () => {
  test('feature 20 imports no other web feature (FR-001)', () => {
    const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    for (const file of readdirSync(dir).filter(
      (name) => !name.includes('.test.') && name !== 'e2e-harness.tsx',
    )) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect({ file, imports: /from '\.\.\/[a-z-]+\//.test(text) }).toEqual({
        file,
        imports: false,
      });
    }
  });
});
