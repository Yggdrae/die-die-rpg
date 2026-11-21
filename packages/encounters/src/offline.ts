import { type EffectLocalRepository, projectTargetState, type TargetState } from '@rpg/actions';
import {
  CHARACTER_CLASS,
  type CharacterLocalRepository,
  type CharacterRecord,
  editPlan,
  type SheetEdit,
  type SheetEditFailure,
} from '@rpg/characters';
import {
  err,
  ok,
  type RepositoryError,
  type Result,
  type SyncedRepository,
  type Visibility,
} from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';
import {
  changeEncounter,
  type EncounterChange,
  type EncounterChangeError,
  initialInstance,
  instanceLabels,
  isPublicConditionPath,
  mergeInstanceState,
  orderEncounters,
  orderParticipants,
} from './domain.ts';
import { PARTICIPANT_CLASS } from './policies.ts';
import {
  ENCOUNTER_NOTE_RECORD_TYPE,
  ENCOUNTER_NOTES_VISIBILITY,
  ENCOUNTER_RECORD_TYPE,
  ENCOUNTER_VISIBILITY,
  type EncounterNoteRecord,
  type EncounterRecord,
  isValidEncounter,
  MAX_ENCOUNTER_NOTES,
  PARTICIPANT_RECORD_TYPE,
  type ParticipantRecord,
  type ParticipantStateRecord,
  type SourceKind,
} from './records.ts';

/**
 * Feature 19 published device API (`_techspec.md` "Device"). Every change is local first through feature 03
 * repositories and waits in the queue offline (FR-012). State changes are feature 11 applications (D-08): on the
 * character itself for a character participant (write-through), on the instance for an entity participant. The
 * authority records the audit events itself, so these repositories queue no envelope.
 */

export type LocalEncounterError =
  | { readonly code: 'not_found' }
  | { readonly code: 'ended' }
  | { readonly code: 'invalid_text' }
  | { readonly code: 'invalid_label' }
  | { readonly code: 'invalid_count' }
  | { readonly code: 'change'; readonly failure: EncounterChangeError }
  | { readonly code: 'edit'; readonly failure: SheetEditFailure }
  | { readonly code: 'apply'; readonly failure: string }
  | { readonly code: 'storage'; readonly failure: RepositoryError };

interface Actor {
  readonly userId: string;
  readonly campaignId: string;
}

interface Options {
  readonly clock?: () => Date;
  readonly createId?: () => string;
}

function storage<T>(result: Result<T, RepositoryError>): Result<T, LocalEncounterError> {
  return result.ok ? ok(result.value) : err({ code: 'storage', failure: result.error });
}

function envelope(actor: Actor, now: string, id: string, visibility: Visibility) {
  return {
    id,
    campaignId: actor.campaignId,
    tags: [],
    metadata: {},
    visibility,
    version: 1,
    createdAt: now,
    createdBy: actor.userId,
    updatedAt: now,
    updatedBy: actor.userId,
  };
}

export class EncounterLocalRepository {
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    private readonly records: SyncedRepository<EncounterRecord>,
    private readonly actor: Actor,
    options: Options = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** Open encounters first, newest first. */
  async list(): Promise<EncounterRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return orderEncounters(listed.value.filter((record) => record.deletedAt === undefined));
  }

  async get(id: string): Promise<EncounterRecord | undefined> {
    const found = await this.records.get(id);
    return found.ok && found.value.deletedAt === undefined ? found.value : undefined;
  }

  /** FR-005: a new active encounter, optionally from a session (D-11). */
  async start(input: {
    readonly name: string;
    readonly sessionId?: string;
    readonly environment?: string;
    readonly locationId?: string;
  }): Promise<Result<EncounterRecord, LocalEncounterError>> {
    const now = this.#clock().toISOString();
    const record: EncounterRecord = {
      ...envelope(this.actor, now, this.#createId(), ENCOUNTER_VISIBILITY),
      type: ENCOUNTER_RECORD_TYPE,
      name: input.name.trim(),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      status: 'active',
      startedAt: now,
      environment: input.environment ?? '',
      ...(input.locationId === undefined ? {} : { locationId: input.locationId }),
    };
    if (!isValidEncounter(record)) return err({ code: 'invalid_text' });
    return storage(await this.records.upsert(record, null));
  }

  /** FR-009, FR-011: environment, location, or the end, versioned (D-10). */
  async change(
    id: string,
    change: EncounterChange,
  ): Promise<Result<EncounterRecord, LocalEncounterError>> {
    const current = await this.get(id);
    if (current === undefined) return err({ code: 'not_found' });
    const now = this.#clock().toISOString();
    const changed = changeEncounter(current, change, now);
    if (!changed.ok) return err({ code: 'change', failure: changed.error });
    return storage(
      await this.records.upsert(
        { ...changed.value, updatedAt: now, updatedBy: this.actor.userId },
        current.version,
      ),
    );
  }

  end(id: string) {
    return this.change(id, { kind: 'end' });
  }
}

export class EncounterNotesLocalRepository {
  readonly #clock: () => Date;

  constructor(
    private readonly records: SyncedRepository<EncounterNoteRecord>,
    private readonly actor: Actor,
    options: Pick<Options, 'clock'> = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(encounterId: string): Promise<EncounterNoteRecord | undefined> {
    const found = await this.records.get(encounterId);
    return found.ok && found.value.deletedAt === undefined ? found.value : undefined;
  }

  /** A save names the version it edited (`null` first), so a concurrent edit is an explicit conflict. */
  async save(
    encounterId: string,
    body: string,
    expectedVersion: number | null,
  ): Promise<Result<EncounterNoteRecord, LocalEncounterError>> {
    if (body.length > MAX_ENCOUNTER_NOTES) return err({ code: 'invalid_text' });
    const now = this.#clock().toISOString();
    const current = expectedVersion === null ? undefined : await this.get(encounterId);
    if (expectedVersion !== null && current === undefined) return err({ code: 'not_found' });
    const record: EncounterNoteRecord = {
      ...envelope(this.actor, now, encounterId, ENCOUNTER_NOTES_VISIBILITY),
      type: ENCOUNTER_NOTE_RECORD_TYPE,
      name: 'GM notes',
      version: expectedVersion ?? 1,
      createdAt: current?.createdAt ?? now,
      createdBy: current?.createdBy ?? this.actor.userId,
      body,
    };
    return storage(await this.records.upsert(record, expectedVersion));
  }
}

/** One group to add: a source, its label, how many instances, and whether players see them (D-04, D-05). */
export interface ParticipantDraft {
  readonly sourceKind: SourceKind;
  readonly sourceId: string;
  readonly label: string;
  readonly count?: number;
  readonly hidden?: boolean;
}

export class ParticipantLocalRepository {
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    private readonly records: SyncedRepository<ParticipantRecord>,
    private readonly states: {
      list(campaignId: string): Promise<readonly ParticipantStateRecord[]>;
    },
    private readonly effects: EffectLocalRepository,
    private readonly actor: Actor,
    options: Options = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** The live participants of an encounter (or of the campaign), in display order. */
  async list(encounterId?: string): Promise<ParticipantRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return orderParticipants(
      listed.value.filter(
        (record) =>
          record.deletedAt === undefined &&
          (encounterId === undefined || record.encounterId === encounterId),
      ),
    );
  }

  /** FR-002, FR-003, FR-010: one or more participants, numbered, after the ones present. */
  async add(
    system: SystemPackage,
    encounter: EncounterRecord,
    drafts: readonly ParticipantDraft[],
  ): Promise<Result<ParticipantRecord[], LocalEncounterError>> {
    if (encounter.status === 'ended') return err({ code: 'ended' });
    const present = await this.list(encounter.id);
    const labels = present.map((record) => record.name);
    let position = present.reduce((highest, record) => Math.max(highest, record.position + 1), 0);
    const planned: ParticipantRecord[] = [];
    for (const draft of drafts) {
      const named = instanceLabels(labels, draft.label, draft.count ?? 1);
      if (!named.ok) return err({ code: named.error });
      for (const label of named.value) {
        labels.push(label);
        const now = this.#clock().toISOString();
        planned.push({
          ...envelope(this.actor, now, this.#createId(), {
            mode: draft.hidden === true ? 'gm_only' : 'everyone',
          }),
          type: PARTICIPANT_RECORD_TYPE,
          name: label,
          encounterId: encounter.id,
          sourceKind: draft.sourceKind,
          sourceId: draft.sourceId,
          position,
          conditions:
            draft.sourceKind === 'entity' ? { ...initialInstance(system, label).conditions } : {},
        });
        position += 1;
      }
    }
    const stored: ParticipantRecord[] = [];
    for (const record of planned) {
      const written = await this.records.upsert(record, null);
      if (!written.ok) return err({ code: 'storage', failure: written.error });
      stored.push(written.value);
    }
    return ok(stored);
  }

  /** D-05: a hidden participant shown to the table; one way in P0. */
  async reveal(
    participant: ParticipantRecord,
  ): Promise<Result<ParticipantRecord, LocalEncounterError>> {
    if (participant.visibility.mode === 'everyone') return ok(participant);
    const now = this.#clock().toISOString();
    return storage(
      await this.records.upsert(
        {
          ...participant,
          visibility: { mode: 'everyone' },
          updatedAt: now,
          updatedBy: this.actor.userId,
        },
        participant.version,
      ),
    );
  }

  /** FR-010: the participant leaves; its character or entity is untouched. */
  async remove(participant: ParticipantRecord): Promise<Result<void, LocalEncounterError>> {
    const removed = await this.records.softDelete(participant.id, participant.version);
    return removed.ok ? ok(undefined) : err({ code: 'storage', failure: removed.error });
  }

  /**
   * An entity participant's state as this device shows it: the public conditions, the instance row when the device
   * holds it (else the initial instance the authority writes), and every application not accepted yet.
   */
  async displayed(
    system: SystemPackage,
    participant: ParticipantRecord,
    excluded: ReadonlySet<string> = new Set(),
  ): Promise<TargetState> {
    const row = (await this.states.list(this.actor.campaignId)).find(
      (item) => item.id === participant.id && item.deletedAt === undefined,
    );
    const base = mergeInstanceState(
      participant.conditions,
      row?.state ?? initialInstance(system, participant.name).secret,
    );
    const pending = (await this.effects.list()).filter(
      (record) =>
        record.targetClass === PARTICIPANT_CLASS &&
        record.targetId === participant.id &&
        record.acceptedAt === undefined &&
        !excluded.has(record.id),
    );
    return projectTargetState(base, pending);
  }

  /** FR-006: one control on an entity participant, as one feature 11 application (D-08). */
  async edit(
    system: SystemPackage,
    encounter: EncounterRecord,
    participant: ParticipantRecord,
    edit: SheetEdit,
  ): Promise<Result<string, LocalEncounterError>> {
    if (encounter.status === 'ended') return err({ code: 'ended' });
    if (participant.sourceKind !== 'entity') return err({ code: 'not_found' });
    const state = await this.displayed(system, participant);
    const plan = editPlan(system, state, edit, true);
    if (!plan.ok) return err({ code: 'edit', failure: plan.error });
    const visible = plan.value.operations.every(({ operation }) =>
      isPublicConditionPath(system, operation.path),
    );
    const applied = await this.effects.apply(
      {
        targetClass: PARTICIPANT_CLASS,
        targetId: participant.id,
        visibility: visible ? participant.visibility : { mode: 'gm_only' },
      },
      plan.value,
      encounter.sessionId === undefined ? {} : { sessionId: encounter.sessionId },
    );
    return applied.ok ? ok(applied.value.id) : err({ code: 'apply', failure: applied.error.code });
  }

  /** FR-006 write-through: one control on a character participant targets the character itself (D-02). */
  async editCharacter(
    system: SystemPackage,
    encounter: EncounterRecord,
    characters: Pick<CharacterLocalRepository, 'displayed'>,
    character: CharacterRecord,
    edit: SheetEdit,
    mayEditGmOnly: boolean,
  ): Promise<Result<string, LocalEncounterError>> {
    if (encounter.status === 'ended') return err({ code: 'ended' });
    const state = await characters.displayed(character);
    const plan = editPlan(system, state, edit, mayEditGmOnly);
    if (!plan.ok) return err({ code: 'edit', failure: plan.error });
    const applied = await this.effects.apply(
      { targetClass: CHARACTER_CLASS, targetId: character.id, visibility: character.visibility },
      plan.value,
      encounter.sessionId === undefined ? {} : { sessionId: encounter.sessionId },
    );
    return applied.ok ? ok(applied.value.id) : err({ code: 'apply', failure: applied.error.code });
  }
}
