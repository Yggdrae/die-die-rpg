import type { SearchDoc } from '@rpg/contracts';
import { RulesSearchIndexer } from '@rpg/rules';
import { routeHref } from '../../routes.ts';
import type { RulesSource } from './rules-source.ts';

/**
 * Feature 14 D-15: the rules' search contribution to feature 20 (structurally a `SearchContribution`): one document
 * per section of the pinned package, labelled "Rule", opened in the library. The app shell lists it; Session Mode's
 * palette reaches it through the shell's search provider. This feature never imports search.
 */

export const RULES_ROUTE = 'rules';

export function rulesSearchContribution(source: Pick<RulesSource, 'pinned' | 'subscribe'>) {
  return {
    indexer: new RulesSearchIndexer({
      async library() {
        const pinned = await source.pinned();
        return pinned.status === 'ready' ? pinned.library : undefined;
      },
    }),
    subscribe: (listener: () => void) => source.subscribe(listener),
    typeLabel: () => 'Rule',
    route: (doc: SearchDoc) => routeHref(RULES_ROUTE, doc.id),
  };
}
