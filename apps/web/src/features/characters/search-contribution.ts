import { CharacterSearchIndexer } from '@rpg/characters';
import type { SearchDoc } from '@rpg/contracts';
import { routeHref } from '../../routes.ts';
import { type CharacterSource, installedRegistry } from './character-source.ts';

/**
 * Feature 20 D-09/D-10: feature 15's search contribution over the device replica: `CharacterSearchIndexer` (name and
 * public summary text, never GM-only values), opened in the character view. Listed by the app shell.
 */

export const CHARACTER_ROUTE = 'characters';

export function characterSearchContribution(
  source: Pick<CharacterSource, 'characters' | 'subscribe'>,
) {
  return {
    indexer: new CharacterSearchIndexer({ list: () => source.characters.list() }, (ref) =>
      installedRegistry().resolve(ref),
    ),
    subscribe: (listener: () => void) => source.subscribe(listener),
    typeLabel: () => 'Character',
    route: (doc: SearchDoc) => routeHref(CHARACTER_ROUTE, doc.id),
  };
}
