import type { Role } from '@rpg/contracts';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import { followRoute } from '../../routes.ts';
import type { SearchActor, SearchService } from '../search/index.ts';
import type { PaletteProvider } from '../sessions/index.ts';

/**
 * App-shell composition for feature 20 (D-05, D-12): the device actor search filters with, and Session Mode's
 * palette provider over the same search service, so the palette and the search screen agree. Features 18 and 20
 * never import each other; only the shell knows both.
 */

export const PALETTE_SEARCH_LIMIT = 8;

/** The device's cached membership as a search actor; none (or removed) admits nothing. */
export function deviceSearchActor(
  session: BrowserSyncSession,
  input: { readonly userId: string; readonly campaignId: string },
): () => Promise<SearchActor | undefined> {
  return async () => {
    const cached = await session.store.cachedMembership(input.campaignId);
    if (cached === undefined || cached.removedAt !== null) return undefined;
    return { userId: input.userId, role: cached.role as Role };
  };
}

export function searchPaletteProvider(service: SearchService): PaletteProvider {
  return {
    id: 'search',
    entries: (query) =>
      service.query(query, { limit: PALETTE_SEARCH_LIMIT }).results.map((result) => ({
        id: result.key,
        label: result.title,
        group: result.typeLabel,
        subjectId: result.id,
        ...(result.href === undefined ? {} : { open: () => followRoute(result.href as string) }),
      })),
  };
}
