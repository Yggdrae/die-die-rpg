import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import { SearchDoc } from '@rpg/contracts';
import { InMemoryRepository } from '@rpg/contracts/testing';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import type { SystemPackage } from '@rpg/systems';
import { Value } from '@sinclair/typebox/value';
import { categoryLabel, REFERENCE_REASON_TEXT, rulesLibrary, rulesTextBytes } from './library.ts';
import { RECENT_LIMIT, RulesMarkLocalRepository, VIEW_INTERVAL_MS } from './offline.ts';
import { RULES_MARK_CLASS, RULES_MARK_POLICY, rulesMarkFacts } from './policies.ts';
import {
  isValidRulesMark,
  markVisibility,
  mergeMarks,
  RULES_MARK_ROW_CODEC,
  type RulesMarkRecord,
  rulesMarkId,
} from './records.ts';
import { RulesSearch, RulesSearchIndexer, rulesSearchDocs } from './search.ts';

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const INSTALLED = INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[];

/** The first package that claims integrated rules, whichever it is (no system named). */
const integrated = [FIXTURE_SYSTEM_PACKAGE, ...INSTALLED].find((system) =>
  system.capabilities.includes('integrated_rules'),
) as SystemPackage;

function withLicence(permission: 'allowed' | 'forbidden' | 'review-required', base = integrated) {
  const copy = structuredClone(base) as SystemPackage & {
    manifest: { license: { assets: { rulesText: string } } };
  };
  copy.manifest.license.assets.rulesText = permission;
  return copy as SystemPackage;
}

function withoutText(base = integrated): SystemPackage {
  const copy = structuredClone(base);
  return {
    ...copy,
    rules: {
      sections: copy.rules.sections.map(({ body: _body, summary: _summary, ...rest }) => rest),
    },
  };
}

describe('library model', () => {
  test('groups by declared category in first-appearance order, sections in declared order (D-03)', () => {
    const library = rulesLibrary(integrated);
    const declared = integrated.rules.sections;
    const categories = [...new Set(declared.map((section) => section.category))];
    expect(library.groups.map((group) => group.category)).toEqual(categories);
    for (const group of library.groups) {
      expect(group.sections.map((section) => section.id)).toEqual(
        declared.filter((section) => section.category === group.category).map((s) => s.id),
      );
      expect(group.label).toBe(categoryLabel(group.category));
    }
    expect(categoryLabel('core_mechanics')).toBe('Core mechanics');
    expect(categoryLabel('gmProcedures')).toBe('Gm procedures');
  });

  test('integrated text, quick rules, resolved references, attribution (FR-004, FR-007, FR-013)', () => {
    const library = rulesLibrary(integrated);
    expect(library.state).toBe('integrated');
    expect(library.reason).toBeUndefined();
    expect(library.attribution.attribution).toBe(integrated.manifest.license.attribution);
    expect(library.attribution.license).toBe(integrated.manifest.license.license);
    const withQuick = library.sections.find((section) => section.summary !== undefined);
    expect(withQuick?.body).toBeDefined();
    for (const section of library.sections) {
      const declared = integrated.rules.sections.find((item) => item.id === section.id);
      expect(section.references.map((reference) => reference.id)).toEqual(
        declared?.references ?? [],
      );
      for (const reference of section.references) {
        expect(library.section(reference.id)?.title).toBe(reference.title);
      }
    }
  });

  test('text is never displayed unless the licence allows it exactly, even when present (D-04)', () => {
    for (const [permission, reason] of [
      ['forbidden', 'forbidden'],
      ['review-required', 'review_required'],
    ] as const) {
      const library = rulesLibrary(withLicence(permission));
      expect(library.state).toBe('reference');
      expect(library.reason).toBe(reason);
      expect(library.sections.length).toBe(integrated.rules.sections.length);
      expect(library.sections.every((s) => s.body === undefined && s.summary === undefined)).toBe(
        true,
      );
      expect(REFERENCE_REASON_TEXT[reason]).toContain('licence');
    }
  });

  test('every shipped package without text renders as an honest reference (FR-010)', () => {
    for (const system of INSTALLED.filter((s) => !s.capabilities.includes('integrated_rules'))) {
      const library = rulesLibrary(system);
      expect(library.state).toBe(system.rules.sections.length === 0 ? 'empty' : 'reference');
      if (library.state === 'reference') {
        expect(library.reason).toBe(
          system.manifest.license.assets.rulesText === 'allowed'
            ? 'not_integrated'
            : library.reason,
        );
        expect(library.externalDocumentation).toBe(
          system.manifest.integration.externalDocumentation,
        );
      }
    }
    expect(rulesLibrary(withoutText()).reason).toBe('not_integrated');
    const empty = rulesLibrary({ ...integrated, rules: { sections: [] } });
    expect(empty.state).toBe('empty');
    expect(empty.groups).toEqual([]);
  });

  test('installed rules text stays well inside the offline budget (D-02)', () => {
    const total = [FIXTURE_SYSTEM_PACKAGE, ...INSTALLED].reduce(
      (sum, system) => sum + rulesTextBytes(system),
      0,
    );
    expect(total).toBeLessThan(256 * 1024);
  });
});

describe('library search', () => {
  test('prefix, accent-insensitive; quick rules first, showing the quick rule (D-05, D-06)', () => {
    const library = rulesLibrary(integrated);
    const search = new RulesSearch(library);
    const quick = library.sections.find((section) => section.summary !== undefined);
    if (quick === undefined) throw new Error('the integrated package declares a quick rule');
    const word = (quick.title.split(/\s+/)[0] ?? '').slice(0, 4).toLowerCase();
    const answer = search.query(word.toUpperCase());
    expect(answer.results[0]?.section.id).toBe(quick.id);
    expect(answer.results[0]?.quick).toBe(quick.summary);
    const ranks = answer.results.map((result) => result.quick !== undefined);
    expect(ranks).toEqual([...ranks].sort((a, b) => Number(b) - Number(a)));
    for (const result of answer.results.filter((item) => item.quick === undefined)) {
      expect(result.snippet === undefined || result.section.body !== undefined).toBe(true);
    }
    expect(search.query('').results).toEqual([]);
    expect(search.query('zzzzqqq').total).toBe(0);
  });

  test('the scope is stated; a reference-only package is searched by title', () => {
    const library = rulesLibrary(integrated);
    expect(new RulesSearch(library).scope()).toBe(
      `${library.sections.length} sections of ${library.name} ${library.ref.version}, on this device`,
    );
    const reference = rulesLibrary(withLicence('forbidden'));
    const first = reference.sections[0];
    if (first === undefined) throw new Error('sections');
    const found = new RulesSearch(reference).query(first.title);
    expect(found.results[0]?.section.id).toBe(first.id);
    expect(found.results[0]?.snippet).toBeUndefined();
    expect(found.results[0]?.quick).toBeUndefined();
  });

  test('feature 20 receives one valid, everyone-visible document per section (D-15)', async () => {
    const library = rulesLibrary(integrated);
    const docs = rulesSearchDocs(library, CAMPAIGN);
    expect(docs.map((doc) => doc.id)).toEqual(library.sections.map((section) => section.id));
    for (const doc of docs) {
      expect(Value.Check(SearchDoc, doc)).toBe(true);
      expect(doc.visibility).toEqual({ mode: 'everyone' });
    }
    const forbidden = rulesSearchDocs(rulesLibrary(withLicence('forbidden')), CAMPAIGN);
    const forbiddenText = integrated.rules.sections.flatMap((s) => [s.body, s.summary]);
    for (const doc of forbidden) expect(forbiddenText).not.toContain(doc.body);
    const indexer = new RulesSearchIndexer({ library: async () => library });
    expect(indexer.moduleId).toBe('rules');
    expect(await indexer.index(CAMPAIGN)).toEqual(docs);
    expect(
      await new RulesSearchIndexer({ library: async () => undefined }).index(CAMPAIGN),
    ).toEqual([]);
  });
});

describe('marks', () => {
  test('the derived ID is a stable UUID per (campaign, user, section) (D-08)', async () => {
    const id = await rulesMarkId(CAMPAIGN, USER, 'checks');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await rulesMarkId(CAMPAIGN, USER, 'checks')).toBe(id);
    expect(await rulesMarkId(CAMPAIGN, OTHER, 'checks')).not.toBe(id);
    expect(await rulesMarkId(CAMPAIGN, USER, 'harm')).not.toBe(id);
  });

  test('the merge is commutative and never loses the later change (D-09)', () => {
    const a = { bookmarked: true, bookmarkChangedAt: '2026-11-06T10:00:00.000Z' };
    const b = {
      bookmarked: false,
      bookmarkChangedAt: '2026-11-06T11:00:00.000Z',
      viewedAt: '2026-11-06T09:00:00.000Z',
    };
    const c = { bookmarked: false, viewedAt: '2026-11-06T12:00:00.000Z' };
    expect(mergeMarks(a, b)).toEqual(mergeMarks(b, a));
    expect(mergeMarks(a, b).bookmarked).toBe(false);
    expect(mergeMarks(mergeMarks(a, b), c)).toEqual(mergeMarks(c, mergeMarks(b, a)));
    expect(mergeMarks(a, c)).toEqual({ ...a, viewedAt: c.viewedAt });
    const tie = { bookmarked: false, bookmarkChangedAt: a.bookmarkChangedAt };
    expect(mergeMarks(a, tie)).toEqual(mergeMarks(tie, a));
    expect(mergeMarks(a, tie).bookmarked).toBe(true);
  });

  test('the policy keeps every mark to its owner, GM roles included (D-10)', () => {
    const registry = new ResourcePolicyRegistry();
    registry.register(RULES_MARK_POLICY);
    const authorization = new AuthorizationService(registry);
    const facts = rulesMarkFacts({
      campaignId: CAMPAIGN,
      id: '00000000-0000-4000-8000-000000000009',
      version: 1,
      visibility: markVisibility(USER),
      userId: USER,
    });
    expect(facts.resourceClass).toBe(RULES_MARK_CLASS);
    for (const role of ['owner', 'gm', 'assistant_gm', 'player'] as const) {
      for (const capability of ['read', 'create', 'update'] as const) {
        const own = authorization.decide(
          { userId: USER, campaignId: CAMPAIGN, role },
          capability,
          facts,
        );
        const other = authorization.decide(
          { userId: OTHER, campaignId: CAMPAIGN, role },
          capability,
          facts,
        );
        expect([role, capability, own.allowed]).toEqual([role, capability, true]);
        expect([role, capability, other.allowed]).toEqual([role, capability, false]);
      }
    }
    expect(
      authorization.decide({ userId: USER, campaignId: CAMPAIGN, role: 'observer' }, 'read', facts)
        .allowed,
    ).toBe(false);
  });

  test('the codec round-trips and refuses a mark that is not its owner’s', async () => {
    const id = await rulesMarkId(CAMPAIGN, USER, 'checks');
    const record: RulesMarkRecord = {
      id,
      campaignId: CAMPAIGN,
      type: 'rules_section_mark',
      name: 'checks',
      tags: [],
      metadata: {},
      visibility: markVisibility(USER),
      version: 2,
      createdAt: '2026-11-06T10:00:00.000Z',
      createdBy: USER,
      updatedAt: '2026-11-06T10:00:00.000Z',
      updatedBy: USER,
      userId: USER,
      sectionId: 'checks',
      bookmarked: true,
      bookmarkChangedAt: '2026-11-06T10:00:00.000Z',
    };
    expect(RULES_MARK_ROW_CODEC.fromRow({ id, ...RULES_MARK_ROW_CODEC.toRow(record) })).toEqual(
      record,
    );
    expect(isValidRulesMark({ ...record, visibility: markVisibility(OTHER) })).toBe(false);
    expect(isValidRulesMark({ ...record, bookmarkChangedAt: undefined })).toBe(false);
    expect(isValidRulesMark({ ...record, name: 'harm' })).toBe(false);
    expect(isValidRulesMark({ ...record, visibility: { mode: 'everyone' } })).toBe(false);
  });
});

describe('device repository', () => {
  function repository(start = Date.parse('2026-11-06T10:00:00.000Z')) {
    let now = start;
    const rows = new InMemoryRepository<RulesMarkRecord>();
    const marks = new RulesMarkLocalRepository(
      rows,
      { userId: USER, campaignId: CAMPAIGN },
      { clock: () => new Date(now) },
    );
    return { marks, rows, advance: (ms: number) => (now += ms) };
  }

  test('bookmarks toggle; the list is newest first (FR-005)', async () => {
    const { marks, advance } = repository();
    expect((await marks.bookmark('checks', true)).ok).toBe(true);
    advance(1_000);
    await marks.bookmark('harm', true);
    expect((await marks.bookmarks()).map((mark) => mark.sectionId)).toEqual(['harm', 'checks']);
    advance(1_000);
    await marks.bookmark('checks', false);
    expect((await marks.bookmarks()).map((mark) => mark.sectionId)).toEqual(['harm']);
    const unchanged = await marks.bookmark('harm', true);
    expect(unchanged.ok && unchanged.value?.version).toBe(1);
    const nothing = await marks.bookmark('healing', false);
    expect(nothing.ok && nothing.value).toBeUndefined();
  });

  test('views are recorded once per interval; recent is newest first and bounded (FR-006, D-11)', async () => {
    const { marks, advance } = repository();
    await marks.viewed('checks');
    advance(1_000);
    await marks.viewed('harm');
    advance(1_000);
    const repeat = await marks.viewed('checks');
    expect(repeat.ok && repeat.value?.version).toBe(1);
    expect((await marks.recent()).map((mark) => mark.sectionId)).toEqual(['harm', 'checks']);
    advance(VIEW_INTERVAL_MS);
    await marks.viewed('checks');
    expect((await marks.recent()).map((mark) => mark.sectionId)).toEqual(['checks', 'harm']);
    for (let index = 0; index < RECENT_LIMIT + 2; index += 1) {
      advance(1_000);
      await marks.viewed(`section_${index}`);
    }
    expect((await marks.recent()).length).toBe(RECENT_LIMIT);
  });

  test('a view and a bookmark of one section in parallel both land (serialized writes)', async () => {
    const { marks } = repository();
    const [viewed, bookmarked] = await Promise.all([
      marks.viewed('checks'),
      marks.bookmark('checks', true),
    ]);
    expect(viewed.ok && bookmarked.ok).toBe(true);
    const [mark] = await marks.list();
    expect(mark?.bookmarked).toBe(true);
    expect(mark?.viewedAt).toBeDefined();
  });

  test('a later local toggle always wins, even behind a clock (D-09)', async () => {
    const { marks, advance } = repository();
    await marks.bookmark('checks', true);
    advance(-60_000);
    await marks.bookmark('checks', false);
    expect(await marks.bookmarks()).toEqual([]);
  });
});

describe('architecture', () => {
  test('no source file names a system (PRD.md s.89)', () => {
    const dir = join(import.meta.dir);
    const files = readdirSync(dir, { recursive: true }).filter(
      (name) => typeof name === 'string' && name.endsWith('.ts') && !name.endsWith('.test.ts'),
    ) as string[];
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8').toLowerCase();
      expect([file, /cairn|fate/.test(text)]).toEqual([file, false]);
    }
  });
});
