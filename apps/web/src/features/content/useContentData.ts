import type { EntityRecord, PersonalNoteRecord, RelationshipRecord } from '@rpg/content';
import type { MutationConflict } from '@rpg/sync';
import { useEffect, useState } from 'react';
import type { ContentSource } from './content-source.ts';

/** What the content screens render, re-read from the local replica on every change. */
export interface ContentData {
  readonly loaded: boolean;
  /** Live entities, sorted by name. */
  readonly entities: readonly EntityRecord[];
  /** Every entity row on the device (tombstones included), for broken links. */
  readonly allEntities: ReadonlyMap<string, EntityRecord>;
  readonly links: readonly RelationshipRecord[];
  readonly notes: readonly PersonalNoteRecord[];
  readonly role?: string;
  readonly conflicts: readonly MutationConflict[];
}

const EMPTY: ContentData = {
  loaded: false,
  entities: [],
  allEntities: new Map(),
  links: [],
  notes: [],
  conflicts: [],
};

export async function readContent(source: ContentSource): Promise<ContentData> {
  const [entities, raw, links, notes, role, conflicts] = await Promise.all([
    source.entities.list(),
    source.entityRecords.list(source.campaignId, { includeDeleted: true }),
    source.relationships.listAll(),
    source.notes.list(),
    source.role(),
    source.conflicts(),
  ]);
  return {
    loaded: true,
    entities,
    allEntities: new Map((raw.ok ? raw.value : []).map((record) => [record.id, record])),
    links,
    notes,
    ...(role === undefined ? {} : { role }),
    conflicts,
  };
}

export function useContentData(source: ContentSource): ContentData {
  const [data, setData] = useState<ContentData>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let again = false;
    const load = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const next = await readContent(source);
          if (!cancelled) setData(next);
        } while (again && !cancelled);
      } catch {
        // A replica read failure keeps the last good view.
      } finally {
        running = false;
      }
    };
    void load();
    const unsubscribe = source.subscribe(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);
  return data;
}
