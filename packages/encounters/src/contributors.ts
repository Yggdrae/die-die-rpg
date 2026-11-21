import type { TargetState } from '@rpg/actions/engine';
import { isStateShape } from '@rpg/characters';
import {
  check,
  type ExportableModule,
  type ExportChunk,
  err,
  Id,
  type Id as IdValue,
  type ImportableModule,
  type ImportContext,
  type ImportPlanContribution,
  type ImportResult,
  type ImportTransaction,
  type ImportWarning,
  ok,
  type Result,
  type SearchDoc,
  type SearchIndexer,
  Timestamp,
} from '@rpg/contracts';
import { type Static, Type } from '@sinclair/typebox';
import { ENCOUNTER_CLASS, PARTICIPANT_CLASS } from './policies.ts';
import {
  ENCOUNTER_RECORD_TYPE,
  ENCOUNTER_STATUSES,
  type EncounterNoteRecord,
  type EncounterRecord,
  MAX_ENCOUNTER_NOTES,
  MAX_ENVIRONMENT_LENGTH,
  MAX_NAME_LENGTH,
  type ParticipantRecord,
  type ParticipantStateRecord,
  SOURCE_KINDS,
} from './records.ts';

/**
 * Feature 19 export contributor (FR-015, D-15). Encounters with their GM notes (export roles are GM roles),
 * participants, and instance states, ordered for a stable chunk. Restored to the importer with every cross-feature
 * link mapped: a cleared session or location, or a dropped participant, carries a warning.
 */

export const ENCOUNTER_MODULE_ID = 'encounters';
export const ENCOUNTER_CHUNK_VERSION = '1';
export const ENCOUNTER_CHUNK_INVALID = 'encounter_chunk_invalid';
export const ENCOUNTER_ID_UNMAPPED = 'encounter_id_unmapped';
export const ENCOUNTER_IMPORT_UNAVAILABLE = 'encounter_import_unavailable';
export const ENCOUNTER_IMPORT_UNSUPPORTED = 'encounter_import_unsupported';
export const ENCOUNTER_LINK_CLEARED = 'encounter_link_cleared';
export const PARTICIPANT_DROPPED = 'encounter_participant_dropped';

/** The ID kinds other features define in the same package (features 15, 16, 18). */
const SOURCE_ID_KIND = { character: 'character', entity: 'campaign_entity' } as const;
const SESSION_KIND = 'campaign_session';
const LOCATION_KIND = 'campaign_entity';

const EncounterEntry = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH }),
    sessionId: Type.Optional(Id),
    status: Type.Union(ENCOUNTER_STATUSES.map((status) => Type.Literal(status))),
    startedAt: Timestamp,
    endedAt: Type.Optional(Timestamp),
    environment: Type.String({ maxLength: MAX_ENVIRONMENT_LENGTH }),
    locationId: Type.Optional(Id),
    notes: Type.Optional(Type.String({ maxLength: MAX_ENCOUNTER_NOTES })),
  },
  { additionalProperties: false },
);

const ParticipantEntry = Type.Object(
  {
    id: Id,
    encounterId: Id,
    label: Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH }),
    sourceKind: Type.Union(SOURCE_KINDS.map((kind) => Type.Literal(kind))),
    sourceId: Id,
    position: Type.Integer({ minimum: 0 }),
    conditions: Type.Record(Type.String({ maxLength: 64 }), Type.Number()),
    hidden: Type.Boolean(),
    state: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const EncounterChunk = Type.Object(
  {
    campaignId: Id,
    encounters: Type.Array(EncounterEntry),
    participants: Type.Array(ParticipantEntry),
  },
  { additionalProperties: false },
);
export type EncounterChunk = Static<typeof EncounterChunk>;
export type EncounterChunkEncounter = Static<typeof EncounterEntry>;
export type EncounterChunkParticipant = Omit<Static<typeof ParticipantEntry>, 'state'> & {
  readonly state?: TargetState;
};

export interface EncounterExportSource {
  listEncounters(campaignId: string): Promise<readonly EncounterRecord[]>;
  listNotes(campaignId: string): Promise<readonly EncounterNoteRecord[]>;
  listParticipants(campaignId: string): Promise<readonly ParticipantRecord[]>;
  listStates(campaignId: string): Promise<readonly ParticipantStateRecord[]>;
}

export interface EncounterRestorePlan {
  readonly campaignId: IdValue;
  readonly actorUserId: IdValue;
  readonly encounters: readonly EncounterChunkEncounter[];
  readonly participants: readonly EncounterChunkParticipant[];
}

export interface EncounterImportDependencies {
  readonly writer: {
    restoreWithin(handle: unknown, plan: EncounterRestorePlan): Promise<Result<void, string>>;
  };
  readonly unwrap: (transaction: ImportTransaction) => unknown;
}

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function parseChunk(chunk: ExportChunk): Result<EncounterChunk, string> {
  if (
    chunk.moduleId !== ENCOUNTER_MODULE_ID ||
    chunk.chunkVersion !== ENCOUNTER_CHUNK_VERSION ||
    !check(EncounterChunk, chunk.payload)
  ) {
    return err(ENCOUNTER_CHUNK_INVALID);
  }
  const payload = chunk.payload as EncounterChunk;
  const ids = new Set(payload.encounters.map((encounter) => encounter.id));
  const valid =
    payload.encounters.every(
      (encounter) => (encounter.status === 'ended') === (encounter.endedAt !== undefined),
    ) &&
    payload.participants.every(
      (participant) =>
        ids.has(participant.encounterId) &&
        (participant.sourceKind === 'entity'
          ? isStateShape(participant.state)
          : participant.state === undefined && Object.keys(participant.conditions).length === 0),
    );
  return valid ? ok(payload) : err(ENCOUNTER_CHUNK_INVALID);
}

export function countEncounterRecords(payload: unknown): number {
  const chunk = payload as EncounterChunk;
  return chunk.encounters.length + chunk.participants.length;
}

export class EncounterExporter implements ExportableModule, ImportableModule {
  readonly moduleId = ENCOUNTER_MODULE_ID;
  readonly importChunkVersions = [ENCOUNTER_CHUNK_VERSION] as const;

  constructor(
    private readonly source: EncounterExportSource,
    private readonly importer?: EncounterImportDependencies,
  ) {}

  async export(campaignId: IdValue): Promise<ExportChunk> {
    const [encounters, notes, participants, states] = await Promise.all([
      this.source.listEncounters(campaignId),
      this.source.listNotes(campaignId),
      this.source.listParticipants(campaignId),
      this.source.listStates(campaignId),
    ]);
    const notesOf = new Map(notes.map((note) => [note.id, note.body]));
    const stateOf = new Map(
      states.filter((row) => row.deletedAt === undefined).map((row) => [row.id, row.state]),
    );
    const live = encounters.filter((encounter) => encounter.deletedAt === undefined);
    const exported = new Set(live.map((encounter) => encounter.id));
    const payload: EncounterChunk = {
      campaignId,
      encounters: live
        .map((encounter) => {
          const body = notesOf.get(encounter.id);
          return {
            id: encounter.id,
            name: encounter.name,
            ...(encounter.sessionId === undefined ? {} : { sessionId: encounter.sessionId }),
            status: encounter.status,
            startedAt: encounter.startedAt,
            ...(encounter.endedAt === undefined ? {} : { endedAt: encounter.endedAt }),
            environment: encounter.environment,
            ...(encounter.locationId === undefined ? {} : { locationId: encounter.locationId }),
            ...(body === undefined ? {} : { notes: body }),
          };
        })
        .sort(byId),
      participants: participants
        .filter(
          (participant) =>
            participant.deletedAt === undefined &&
            exported.has(participant.encounterId) &&
            (participant.sourceKind === 'character' || stateOf.has(participant.id)),
        )
        .map((participant) => {
          const state = stateOf.get(participant.id);
          return {
            id: participant.id,
            encounterId: participant.encounterId,
            label: participant.name,
            sourceKind: participant.sourceKind,
            sourceId: participant.sourceId,
            position: participant.position,
            conditions: { ...participant.conditions },
            hidden: participant.visibility.mode !== 'everyone',
            ...(participant.sourceKind === 'entity' && state !== undefined ? { state } : {}),
          };
        })
        .sort(byId),
    };
    return { moduleId: this.moduleId, chunkVersion: ENCOUNTER_CHUNK_VERSION, payload };
  }

  async validate(chunk: ExportChunk): Promise<Result<ImportPlanContribution, string>> {
    const parsed = parseChunk(chunk);
    if (!parsed.ok) return parsed;
    return ok({
      defines: [
        ...parsed.value.encounters.map((row) => ({ kind: ENCOUNTER_CLASS, sourceId: row.id })),
        ...parsed.value.participants.map((row) => ({ kind: PARTICIPANT_CLASS, sourceId: row.id })),
      ],
      warnings: [],
    });
  }

  async restore(chunk: ExportChunk, context: ImportContext): Promise<Result<ImportResult, string>> {
    if (this.importer === undefined) return err(ENCOUNTER_IMPORT_UNAVAILABLE);
    const parsed = parseChunk(chunk);
    if (!parsed.ok) return parsed;
    const warnings: ImportWarning[] = [];
    const encounters: EncounterChunkEncounter[] = [];
    const encounterIds = new Map<string, string>();
    for (const row of parsed.value.encounters) {
      const id = context.mapId(ENCOUNTER_CLASS, row.id);
      if (id === undefined) return err(ENCOUNTER_ID_UNMAPPED);
      encounterIds.set(row.id, id);
      const { sessionId: oldSession, locationId: oldLocation, ...rest } = row;
      const sessionId =
        oldSession === undefined ? undefined : context.mapId(SESSION_KIND, oldSession);
      const locationId =
        oldLocation === undefined ? undefined : context.mapId(LOCATION_KIND, oldLocation);
      if (
        (oldSession !== undefined && sessionId === undefined) ||
        (oldLocation !== undefined && locationId === undefined)
      ) {
        warnings.push({ code: ENCOUNTER_LINK_CLEARED, sourceId: row.id });
      }
      encounters.push({
        ...rest,
        id,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(locationId === undefined ? {} : { locationId }),
      });
    }
    const participants: EncounterChunkParticipant[] = [];
    for (const row of parsed.value.participants) {
      const id = context.mapId(PARTICIPANT_CLASS, row.id);
      const encounterId = encounterIds.get(row.encounterId);
      if (id === undefined || encounterId === undefined) return err(ENCOUNTER_ID_UNMAPPED);
      const sourceId = context.mapId(SOURCE_ID_KIND[row.sourceKind], row.sourceId);
      if (sourceId === undefined) {
        warnings.push({ code: PARTICIPANT_DROPPED, sourceId: row.id });
        continue;
      }
      const { state, ...rest } = row;
      participants.push({
        ...rest,
        id,
        encounterId,
        sourceId,
        ...(row.sourceKind === 'entity' ? { state: state as TargetState } : {}),
      });
    }
    const written = await this.importer.writer.restoreWithin(
      this.importer.unwrap(context.transaction),
      {
        campaignId: context.campaignId,
        actorUserId: context.importerUserId,
        encounters,
        participants,
      },
    );
    if (!written.ok) return written;
    return ok({ restoredCount: encounters.length + participants.length, warnings });
  }

  async import(_campaignId: IdValue, chunk: ExportChunk): Promise<Result<void, string>> {
    const parsed = parseChunk(chunk);
    return parsed.ok ? err(ENCOUNTER_IMPORT_UNSUPPORTED) : parsed;
  }
}

/**
 * Feature 20 D-09: one search document per live encounter, its name and environment, both stored with the
 * encounter's own Visibility. Participants, GM notes, and instance states are never read: their Visibility differs.
 */
export class EncounterSearchIndexer implements SearchIndexer {
  readonly moduleId = ENCOUNTER_MODULE_ID;

  constructor(private readonly source: Pick<EncounterExportSource, 'listEncounters'>) {}

  async index(campaignId: IdValue): Promise<SearchDoc[]> {
    const encounters = await this.source.listEncounters(campaignId);
    return encounters
      .filter((record) => record.deletedAt === undefined)
      .map((record) => ({
        id: record.id,
        type: ENCOUNTER_RECORD_TYPE,
        title: record.name,
        body: record.environment,
        campaignId: record.campaignId,
        visibility: record.visibility,
      }))
      .sort(byId);
  }
}
