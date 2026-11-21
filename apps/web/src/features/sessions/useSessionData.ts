import type { Role } from '@rpg/contracts';
import {
  type ContextEntity,
  type ContextRelationship,
  type LogEffect,
  type LogRoll,
  openSessionOf,
  type SessionLogEntryRecord,
  type SessionNoteRecord,
  type SessionRecord,
} from '@rpg/sessions';
import type { MutationConflict } from '@rpg/sync';
import { useEffect, useState } from 'react';
import type { PartyMember, SessionSource } from './session-source.ts';

/** Everything Session Mode shows, read from the device in one pass and refreshed on every replica change. */
export interface SessionData {
  readonly loaded: boolean;
  readonly role?: Role;
  readonly mayRun: boolean;
  readonly sessions: readonly SessionRecord[];
  readonly open?: SessionRecord;
  readonly notes?: SessionNoteRecord;
  readonly entries: readonly SessionLogEntryRecord[];
  readonly entities: readonly ContextEntity[];
  readonly relationships: readonly ContextRelationship[];
  readonly party: readonly PartyMember[];
  readonly rolls: readonly LogRoll[];
  readonly effects: readonly LogEffect[];
  readonly capabilities: readonly string[];
  readonly conflicts: readonly MutationConflict[];
}

const EMPTY: SessionData = {
  loaded: false,
  mayRun: false,
  sessions: [],
  entries: [],
  entities: [],
  relationships: [],
  party: [],
  rolls: [],
  effects: [],
  capabilities: [],
  conflicts: [],
};

export async function readSessionData(source: SessionSource): Promise<SessionData> {
  const [role, mayRun, sessions, content, party, rolls, effects, capabilities, conflicts] =
    await Promise.all([
      source.role(),
      source.mayRun(),
      source.sessions.list(),
      source.content(),
      source.party(),
      source.rolls(),
      source.effects(),
      source.capabilities(),
      source.conflicts(),
    ]);
  const open = openSessionOf(sessions);
  const shown = open ?? sessions[0];
  const [notes, entries] = await Promise.all([
    open === undefined || !mayRun ? undefined : source.notes.get(open.id),
    shown === undefined ? [] : source.log.list(shown.id),
  ]);
  return {
    loaded: true,
    ...(role === undefined ? {} : { role }),
    mayRun,
    sessions,
    ...(open === undefined ? {} : { open }),
    ...(notes === undefined ? {} : { notes }),
    entries,
    entities: content.entities,
    relationships: content.relationships,
    party,
    rolls,
    effects,
    capabilities,
    conflicts,
  };
}

export function useSessionData(source: SessionSource): SessionData {
  const [data, setData] = useState<SessionData>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let again = false;
    const refresh = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const next = await readSessionData(source);
          if (!cancelled) setData(next);
        } while (again && !cancelled);
      } finally {
        running = false;
      }
    };
    void refresh();
    const dispose = source.subscribe(() => void refresh());
    return () => {
      cancelled = true;
      dispose();
    };
  }, [source]);
  return data;
}
