import type { Id, SearchDoc, SearchIndexer, Visibility } from '@rpg/contracts';
import { SearchIndex } from '@rpg/search';
import type { RulesLibraryModel, RulesSection } from './library.ts';

/**
 * Feature 14 search (`_techspec.md` D-06, D-15). The library's own search runs over the pinned package's sections in
 * memory, on the device, so it is the same online and offline. Feature 20 receives one document per section through
 * `RulesSearchIndexer`. Rules are the package's, the same for every member (D-12), so every document is `everyone`.
 */

export const RULES_SEARCH_MODULE = 'rules';
export const RULES_SECTION_TYPE = 'rules_section';
const EVERYONE: Visibility = { mode: 'everyone' };
const LIBRARY_SCOPE = 'rules-library';

function searchBody(section: RulesSection): string {
  const text = [section.summary, section.body].filter((part) => part !== undefined).join('\n');
  return text === '' ? section.categoryLabel : text;
}

/** One feature 20 document per section of the pinned package. */
export function rulesSearchDocs(library: RulesLibraryModel, campaignId: Id): SearchDoc[] {
  return library.sections.map((section) => ({
    id: section.id,
    type: RULES_SECTION_TYPE,
    title: section.title,
    body: searchBody(section),
    campaignId,
    visibility: EVERYONE,
  }));
}

/** Feature 20's `SearchIndexer` for the campaign's pinned rules (FR-012). */
export class RulesSearchIndexer implements SearchIndexer {
  readonly moduleId = RULES_SEARCH_MODULE;

  constructor(private readonly source: { library(): Promise<RulesLibraryModel | undefined> }) {}

  async index(campaignId: Id): Promise<SearchDoc[]> {
    const library = await this.source.library();
    return library === undefined ? [] : rulesSearchDocs(library, campaignId);
  }
}

export interface RulesSearchResult {
  readonly section: RulesSection;
  /** The quick rule when the section declares one (FR-007), else a snippet of its own text. */
  readonly quick?: string;
  readonly snippet?: string;
}

export interface RulesSearchAnswer {
  readonly results: readonly RulesSearchResult[];
  readonly total: number;
}

/** The library's own search (FR-002): quick rules first, then by score; the scope is stated. */
export class RulesSearch {
  readonly #index = new SearchIndex(LIBRARY_SCOPE);

  constructor(private readonly library: RulesLibraryModel) {
    this.#index.replaceModule(
      RULES_SEARCH_MODULE,
      library.sections.map((section) => ({
        id: section.id,
        type: RULES_SECTION_TYPE,
        title: section.title,
        body: searchBody(section),
        campaignId: LIBRARY_SCOPE,
        visibility: EVERYONE,
      })),
    );
  }

  /** "7 sections of Name 1.0.0, on this device" (D-06): offline never silently narrows. */
  scope(): string {
    const count = this.library.sections.length;
    return `${count} ${count === 1 ? 'section' : 'sections'} of ${this.library.name} ${this.library.ref.version}, on this device`;
  }

  query(text: string, options: { readonly limit?: number } = {}): RulesSearchAnswer {
    const found = this.#index.query(text, {
      admits: () => true,
      limit: this.library.sections.length,
    });
    const results = found.hits.flatMap(
      (hit, rank): { rank: number; result: RulesSearchResult }[] => {
        const section = this.library.section(hit.doc.id);
        if (section === undefined) return [];
        return [
          {
            rank,
            result: {
              section,
              ...(section.summary === undefined
                ? hit.snippet === undefined || section.body === undefined
                  ? {}
                  : { snippet: hit.snippet }
                : { quick: section.summary }),
            },
          },
        ];
      },
    );
    results.sort(
      (left, right) =>
        Number(right.result.quick !== undefined) - Number(left.result.quick !== undefined) ||
        left.rank - right.rank,
    );
    return {
      results: results.slice(0, options.limit ?? 20).map((entry) => entry.result),
      total: results.length,
    };
  }
}
