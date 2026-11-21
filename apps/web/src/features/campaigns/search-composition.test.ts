import { describe, expect, test } from 'bun:test';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { rulesLibrary } from '@rpg/rules';
import { rulesSearchContribution } from '../rules/index.ts';
import { createSearchService, type SearchContribution } from '../search/index.ts';
import { PALETTE_SEARCH_LIMIT, searchPaletteProvider } from './search-composition.ts';

/** Feature 20 D-12: the shell adapts the search service into Session Mode's palette provider. */

const CAMPAIGN = '00000000-0000-4000-8000-000000000001';

describe('searchPaletteProvider', () => {
  test('offers the same results as the search screen, labelled by type, naming the record', async () => {
    const service = createSearchService({
      campaignId: CAMPAIGN,
      actor: async () => ({ userId: '00000000-0000-4000-8000-0000000000a1', role: 'gm' }),
      schedule: (task) => task(),
      contributions: [
        {
          indexer: {
            moduleId: 'alpha',
            index: async () =>
              Array.from({ length: 12 }, (_, n) => ({
                id: `a${n}`,
                type: 'widget',
                title: `Ware ${n}`,
                body: '',
                campaignId: CAMPAIGN,
                visibility: { mode: 'everyone' as const },
              })),
          },
          subscribe: () => () => undefined,
          typeLabel: () => 'Widget',
          route: (doc) => (doc.id === 'a0' ? `#/alpha/${doc.id}` : undefined),
        },
      ],
    });
    service.start();
    await service.settled();
    const provider = searchPaletteProvider(service);
    const entries = provider.entries('ware');
    expect(entries).toHaveLength(PALETTE_SEARCH_LIMIT);
    expect(entries[0]).toMatchObject({
      id: 'alpha:a0',
      label: 'Ware 0',
      group: 'Widget',
      subjectId: 'a0',
    });
    expect(typeof entries[0]?.open).toBe('function');
    expect(entries[1]?.open).toBeUndefined();
    expect(entries.map((entry) => entry.label)).toEqual(
      service.query('ware', { limit: PALETTE_SEARCH_LIMIT }).results.map((result) => result.title),
    );
    service.dispose();
  });

  test('feature 14: rules reach search and the palette through the shell, labelled Rule (D-15)', async () => {
    const library = rulesLibrary(FIXTURE_SYSTEM_PACKAGE);
    // Structurally a feature 20 contribution: the shell lists it, neither feature imports the other.
    const rules: SearchContribution = rulesSearchContribution({
      pinned: async () => ({ status: 'ready', library }),
      subscribe: () => () => undefined,
    });
    const service = createSearchService({
      campaignId: CAMPAIGN,
      actor: async () => ({ userId: '00000000-0000-4000-8000-0000000000a2', role: 'player' }),
      schedule: (task) => task(),
      contributions: [rules],
    });
    service.start();
    await service.settled();
    const section = library.sections.find((item) => item.summary !== undefined);
    if (section === undefined) throw new Error('quick rule');
    const [result] = service.query(section.title).results;
    expect(result).toMatchObject({
      title: section.title,
      typeLabel: 'Rule',
      href: `#/rules/${section.id}`,
    });
    const [entry] = searchPaletteProvider(service).entries(section.title);
    expect(entry).toMatchObject({ label: section.title, group: 'Rule', subjectId: section.id });
    expect(typeof entry?.open).toBe('function');
    service.dispose();
  });
});
