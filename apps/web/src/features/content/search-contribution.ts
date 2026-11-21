import { ContentSearchIndexer } from '@rpg/content';
import type { SearchDoc } from '@rpg/contracts';
import { routeHref } from '../../routes.ts';
import { typeLabel } from './content-model.ts';
import type { ContentSource } from './content-source.ts';

/**
 * Feature 20 D-09/D-10: feature 16's search contribution over the device replica: its `ContentSearchIndexer` (every
 * live entity, handouts and scenes included), refreshed by the content source's changes, labelled by the configured
 * type, opened in the content view. The app shell lists it; this feature never imports search.
 */

export const CONTENT_ROUTE = 'content';

export function contentSearchContribution(
  source: Pick<ContentSource, 'entityRecords' | 'subscribe'>,
) {
  return {
    indexer: new ContentSearchIndexer({
      entities: {
        async list(campaignId: string) {
          const listed = await source.entityRecords.list(campaignId);
          if (!listed.ok) throw new Error('content_list_failed');
          return listed.value;
        },
      },
    }),
    subscribe: (listener: () => void) => source.subscribe(listener),
    typeLabel: (type: string) => typeLabel(type),
    route: (doc: SearchDoc) => routeHref(CONTENT_ROUTE, doc.id),
  };
}
