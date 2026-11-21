import type { TargetState } from '@rpg/actions';
import { type CharacterRecord, characterSummary, type SummaryValue } from '@rpg/characters';
import { ENCOUNTER_SOURCE_TYPES, LOCATION_ENTITY_TYPE } from '@rpg/content';
import {
  activeConditions,
  type EncounterNoteRecord,
  type EncounterRecord,
  type ParticipantRecord,
} from '@rpg/encounters';
import type { SystemPackage } from '@rpg/systems';
import { useEffect, useState } from 'react';
import type { EncounterSource } from './encounter-source.ts';

/**
 * Feature 19 view data: everything the tracker shows, read from the device replica plus pending applications, so it
 * renders at once offline. A participant's statistics are present only where this device holds them: the GM's
 * instance states, and a player's own character (D-12).
 */

export interface ParticipantView {
  readonly record: ParticipantRecord;
  readonly character?: CharacterRecord;
  /** The live state this device holds for the participant; absent for a player's view of others. */
  readonly state?: TargetState;
  readonly summary: readonly SummaryValue[];
  readonly conditions: readonly string[];
}

export interface EntityChoice {
  readonly id: string;
  readonly name: string;
  readonly hidden: boolean;
}

export interface EncounterData {
  readonly loaded: boolean;
  readonly gm: boolean;
  readonly mayEditGmOnly: boolean;
  readonly system?: SystemPackage;
  readonly encounters: readonly EncounterRecord[];
  readonly participants: ReadonlyMap<string, readonly ParticipantView[]>;
  readonly party: readonly CharacterRecord[];
  readonly sources: readonly EntityChoice[];
  readonly locations: readonly EntityChoice[];
  readonly notes: ReadonlyMap<string, EncounterNoteRecord>;
}

export const EMPTY_ENCOUNTER_DATA: EncounterData = {
  loaded: false,
  gm: false,
  mayEditGmOnly: false,
  encounters: [],
  participants: new Map(),
  party: [],
  sources: [],
  locations: [],
  notes: new Map(),
};

export async function readEncounterData(source: EncounterSource): Promise<EncounterData> {
  const [system, gm, mayEditGmOnly, encounters, all, party, entities, refused] = await Promise.all([
    source.system(),
    source.mayRun(),
    source.mayEditGmOnly(),
    source.encounters.list(),
    source.participants.list(),
    source.characters.list(),
    source.entities.list(),
    source.refused(),
  ]);
  const byCharacter = new Map(party.map((character) => [character.id, character]));
  const participants = new Map<string, ParticipantView[]>();
  for (const record of all) {
    const character =
      record.sourceKind === 'character' ? byCharacter.get(record.sourceId) : undefined;
    let state: TargetState | undefined;
    if (character !== undefined) state = await source.characters.displayed(character, refused);
    else if (record.sourceKind === 'entity' && gm && system !== undefined) {
      state = await source.participants.displayed(system, record, refused);
    }
    const view: ParticipantView = {
      record,
      ...(character === undefined ? {} : { character }),
      ...(state === undefined ? {} : { state }),
      summary: state === undefined || system === undefined ? [] : characterSummary(system, state),
      conditions:
        system === undefined
          ? []
          : activeConditions(system, state?.conditions ?? record.conditions),
    };
    participants.set(record.encounterId, [...(participants.get(record.encounterId) ?? []), view]);
  }
  const notes = new Map<string, EncounterNoteRecord>();
  if (gm) {
    for (const encounter of encounters) {
      const note = await source.notes.get(encounter.id);
      if (note !== undefined) notes.set(encounter.id, note);
    }
  }
  const choice = (entity: (typeof entities)[number]): EntityChoice => ({
    id: entity.id,
    name: entity.name,
    hidden: entity.visibility.mode !== 'everyone',
  });
  return {
    loaded: true,
    gm,
    mayEditGmOnly,
    ...(system === undefined ? {} : { system }),
    encounters,
    participants,
    party,
    sources: entities
      .filter((entity) => ENCOUNTER_SOURCE_TYPES.includes(entity.type))
      .map(choice)
      .sort((left, right) => left.name.localeCompare(right.name)),
    locations: entities
      .filter((entity) => entity.type === LOCATION_ENTITY_TYPE)
      .map(choice)
      .sort((left, right) => left.name.localeCompare(right.name)),
    notes,
  };
}

/** Reloads on every change of a watched table; a failed read keeps the last good view. */
export function useEncounterData(source: EncounterSource): EncounterData {
  const [data, setData] = useState<EncounterData>(EMPTY_ENCOUNTER_DATA);
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
          const next = await readEncounterData(source);
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
