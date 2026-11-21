import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SearchDoc, Visibility } from '@rpg/contracts';
import { type Admits, SearchIndex, snippetOf } from './search-index.ts';
import { normalizeText, words } from './text.ts';

/** Feature 20 task 01: `_bdd.md` Finding and Visibility scenarios over the pure index. */

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const PLAYER = '00000000-0000-4000-8000-0000000000aa';
const EVERYONE: Visibility = { mode: 'everyone' };
const GM_ONLY: Visibility = { mode: 'gm_only' };
const all: Admits = () => true;
const player: Admits = (visibility) =>
  visibility.mode === 'everyone' ||
  (visibility.mode === 'players' && visibility.playerIds.includes(PLAYER));

function doc(id: string, title: string, body = '', visibility: Visibility = EVERYONE): SearchDoc {
  return { id, type: 'widget', title, body, campaignId: CAMPAIGN, visibility };
}

function titles(index: SearchIndex, text: string, admits: Admits = all): string[] {
  return index.query(text, { admits }).hits.map((hit) => hit.doc.title);
}

describe('text', () => {
  test('lowercases and strips diacritics; words are letters and digits', () => {
    expect(normalizeText('Mérchant GUILD')).toBe('merchant guild');
    expect(words("Wareham-Ford, the miller's 2nd mill")).toEqual([
      'wareham',
      'ford',
      'the',
      'miller',
      's',
      '2nd',
      'mill',
    ]);
    expect(words('  ')).toEqual([]);
  });
});

describe('SearchIndex', () => {
  const index = new SearchIndex(CAMPAIGN);
  index.replaceModule('alpha', [
    doc('a', 'Mirela Voss', 'Herbalist at the ford crossing.', GM_ONLY),
    doc('b', 'Wareham Ford', 'A shallow crossing guarded by a toll house.'),
    doc('c', 'Mérchant Guild', 'Traders of the river towns.'),
    doc('d', 'Ford Keeper', 'Takes the toll.', { mode: 'players', playerIds: [PLAYER] }),
  ]);

  test('three letters of a name find it first (FR-007)', () => {
    expect(titles(index, 'mir')).toEqual(['Mirela Voss']);
    expect(titles(index, 'MIR')).toEqual(['Mirela Voss']);
  });

  test('every query word must prefix-match some word (AND), accents ignored', () => {
    expect(titles(index, 'ware fo')).toEqual(['Wareham Ford']);
    expect(titles(index, 'merch')).toEqual(['Mérchant Guild']);
    expect(titles(index, 'mérch guil')).toEqual(['Mérchant Guild']);
    expect(titles(index, 'ware zzz')).toEqual([]);
    expect(titles(index, '   ')).toEqual([]);
  });

  test('title matches rank before body matches, with no ranking by type', () => {
    // "Ford Keeper" starts with the query and is shorter than "Wareham Ford"; Mirela matches only her body.
    expect(titles(index, 'ford')).toEqual(['Ford Keeper', 'Wareham Ford', 'Mirela Voss']);
  });

  test('a refused document is dropped before ranking, counting, and limiting (FR-004)', () => {
    const results = index.query('ford', { admits: player, limit: 1 });
    expect(results.total).toBe(2);
    expect(results.hits.map((hit) => hit.doc.title)).toEqual(['Ford Keeper']);
    expect(index.query('mir', { admits: player })).toEqual({ hits: [], total: 0 });
    expect(index.query('herbalist', { admits: player }).total).toBe(0);
  });

  test('snippets come from the hit body around the first body match (D-14)', () => {
    const [hit] = index.query('toll', { admits: all }).hits;
    expect(hit?.doc.title).toBe('Ford Keeper');
    expect(hit?.snippet).toBe('Takes the toll.');
    const [title] = index.query('wareham', { admits: all }).hits;
    expect(title?.snippet).toBeUndefined();
    const long = `${'word '.repeat(30)}target ${'tail '.repeat(40)}`;
    const snippet = snippetOf(long, ['target']) ?? '';
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('target');
    expect(snippet.length).toBeLessThanOrEqual(122);
  });

  test('replace diffs by ID, keeps postings for unchanged text, and drops removed documents', () => {
    const local = new SearchIndex(CAMPAIGN);
    local.replaceModule('alpha', [doc('a', 'Old Mill', '', GM_ONLY), doc('b', 'Bridge')]);
    expect(titles(local, 'mill', player)).toEqual([]);
    // A reveal changes only the Visibility: the next query admits it with no rebuild.
    local.replaceModule('alpha', [doc('a', 'Old Mill'), doc('b', 'Bridge')]);
    expect(titles(local, 'mill', player)).toEqual(['Old Mill']);
    local.replaceModule('alpha', [doc('a', 'New Mill')]);
    expect(titles(local, 'old')).toEqual([]);
    expect(titles(local, 'bri')).toEqual([]);
    expect(titles(local, 'new')).toEqual(['New Mill']);
    expect(local.moduleSize('alpha')).toBe(1);
  });

  test('modules are independent; remove and clear', () => {
    const local = new SearchIndex(CAMPAIGN);
    local.replaceModule('alpha', [doc('same-id', 'Alpha Thing')]);
    local.replaceModule('beta', [doc('same-id', 'Beta Thing')]);
    // Equal scores: the shorter title first.
    expect(titles(local, 'thing')).toEqual(['Beta Thing', 'Alpha Thing']);
    expect(local.query('thing', { admits: all }).hits.map((hit) => hit.moduleId)).toEqual([
      'beta',
      'alpha',
    ]);
    local.removeModule('alpha');
    expect(titles(local, 'thing')).toEqual(['Beta Thing']);
    local.clear();
    expect(local.size).toBe(0);
    expect(titles(local, 'thing')).toEqual([]);
  });

  test('invalid documents and documents of another campaign are never indexed (D-06)', () => {
    const local = new SearchIndex(CAMPAIGN);
    const outcome = local.replaceModule('alpha', [
      doc('a', 'Kept'),
      { ...doc('b', 'Foreign'), campaignId: OTHER },
      { id: 'c', title: 'Broken' },
      { ...doc('d', 'Bad visibility'), visibility: { mode: 'nobody' } },
    ]);
    expect(outcome).toEqual({ indexed: 1, rejected: 3 });
    expect(titles(local, 'foreign')).toEqual([]);
    expect(titles(local, 'kept')).toEqual(['Kept']);
  });

  test('5000 documents index and answer a prefix query fast', () => {
    const local = new SearchIndex(CAMPAIGN);
    const docs = Array.from({ length: 5000 }, (_, n) =>
      doc(`id-${n}`, `Name ${n} Wanderer${n % 97}`, `Body text number ${n} about places.`),
    );
    const started = performance.now();
    local.replaceModule('alpha', docs);
    const results = local.query('wander', { admits: all });
    const elapsed = performance.now() - started;
    expect(results.total).toBe(5000);
    expect(results.hits).toHaveLength(20);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('architecture', () => {
  test('the package imports @rpg/contracts only and names no feature type (FR-001)', () => {
    const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    for (const file of readdirSync(dir).filter((name) => !name.endsWith('.test.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      const imports = [...text.matchAll(/from '(@rpg\/[^']+)'/g)].map((match) => match[1]);
      expect({ file, imports: imports.filter((name) => name !== '@rpg/contracts') }).toEqual({
        file,
        imports: [],
      });
      expect({
        file,
        types: /\b(character|entity|handout|encounter|session)\b/i.test(text),
      }).toEqual({ file, types: false });
    }
  });
});
