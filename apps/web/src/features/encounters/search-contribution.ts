import type { SearchDoc } from '@rpg/contracts';
import { EncounterSearchIndexer } from '@rpg/encounters';
import { routeHref } from '../../routes.ts';
import type { EncounterSource } from './encounter-source.ts';

/**
 * Feature 20 D-09/D-10: feature 19's search contribution over the device replica: `EncounterSearchIndexer` (name and
 * environment), opened in the encounter view. Listed by the app shell.
 */

export const ENCOUNTER_ROUTE = 'encounters';

export function encounterSearchContribution(
  source: Pick<EncounterSource, 'encounters' | 'subscribe'>,
) {
  return {
    indexer: new EncounterSearchIndexer({ listEncounters: () => source.encounters.list() }),
    subscribe: (listener: () => void) => source.subscribe(listener),
    typeLabel: () => 'Encounter',
    route: (doc: SearchDoc) => routeHref(ENCOUNTER_ROUTE, doc.id),
  };
}
