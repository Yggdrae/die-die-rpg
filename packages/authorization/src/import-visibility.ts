import { GM_ONLY, type ImportContext, type ImportWarning, type Visibility } from '@rpg/contracts';

/**
 * Feature 04 rule for restoring a stored Visibility inside a feature 07 import (contract note
 * 2026-10-27, `ImportContext.mapId`; `04/_db.md`; `07/_techspec.md`, Import Flow).
 *
 * Memberships are never imported, so a targeted audience only survives when every target has a
 * mapping: players through an approved `member` mapping, parties through the restored `party`
 * records. Otherwise the record becomes `gm_only` with an explicit warning. `everyone` and
 * `gm_only` restore as stored. The result is never wider than the source.
 */

export const VISIBILITY_NARROWED_ON_IMPORT = 'visibility_narrowed_to_gm_only';

export interface ImportedVisibility {
  readonly visibility: Visibility;
  /** Present exactly when the targeted audience could not be restored. */
  readonly warning?: ImportWarning;
}

export function visibilityForImport(
  stored: Visibility,
  mapId: ImportContext['mapId'],
  sourceId?: string,
): ImportedVisibility {
  const narrowed = (): ImportedVisibility => ({
    visibility: GM_ONLY,
    warning: {
      code: VISIBILITY_NARROWED_ON_IMPORT,
      ...(sourceId === undefined ? {} : { sourceId }),
    },
  });
  switch (stored.mode) {
    case 'gm_only':
      return { visibility: GM_ONLY };
    case 'everyone':
      return { visibility: { mode: 'everyone' } };
    case 'players': {
      const playerIds = remapAll(stored.playerIds, (id) => mapId('member', id));
      return playerIds === undefined ? narrowed() : { visibility: { mode: 'players', playerIds } };
    }
    case 'party': {
      const partyIds = remapAll(stored.partyIds, (id) => mapId('party', id));
      return partyIds === undefined ? narrowed() : { visibility: { mode: 'party', partyIds } };
    }
    default:
      // An unknown mode is never interpreted as an audience.
      return narrowed();
  }
}

function remapAll(
  ids: readonly string[],
  map: (id: string) => string | undefined,
): [string, ...string[]] | undefined {
  const mapped: string[] = [];
  for (const id of ids) {
    const target = map(id);
    if (target === undefined) return undefined;
    if (!mapped.includes(target)) mapped.push(target);
  }
  return mapped.length === 0 ? undefined : (mapped as [string, ...string[]]);
}
