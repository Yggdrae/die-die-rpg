import { clampTargetState } from '@rpg/actions/engine';
import type { EffectTargetAdapter } from '@rpg/actions/postgres';
import type { Capability, Decision, ResourceFacts } from '@rpg/authorization';
import { isDeclaredPath } from '@rpg/characters';
import type { ActorRef, Visibility } from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';
import { ENCOUNTER_AUDIT_ACTIONS } from './audit-declarations.ts';
import {
  classifyEncounterUpdate,
  initialInstance,
  isPublicConditionPath,
  mergeInstanceState,
  splitInstanceState,
} from './domain.ts';
import type {
  EncountersTransaction,
  PostgresEncounterRepository,
} from './infra/postgres/repository.ts';
import {
  ENCOUNTER_CLASS,
  ENCOUNTER_NOTE_CLASS,
  encounterFacts,
  PARTICIPANT_CLASS,
} from './policies.ts';
import {
  ENCOUNTER_NOTES_VISIBILITY,
  ENCOUNTER_VISIBILITY,
  type EncounterNoteRecord,
  type EncounterRecord,
  isValidEncounter,
  isValidEncounterNote,
  isValidParticipant,
  type ParticipantRecord,
} from './records.ts';

/**
 * Feature 19 authority (`_techspec.md` "Authority"). Every write is re-decided through feature 04, versioned, and
 * audited in its own transaction with the mutation ID as origin (D-14). An entity participant's instance state is
 * written by the authority from the pinned package at the insert (D-02) and afterwards only through feature 11, via
 * the target adapter below.
 */

export interface EncounterDecider {
  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): Decision;
}

/** The campaign's pinned package, validated (feature 02's pin through the registry). */
export type PinnedSystem = (campaignId: string) => Promise<SystemPackage | undefined>;

export interface EncounterAuditRecorder {
  recordWithin(
    executor: EncountersTransaction,
    submission: {
      readonly event: {
        readonly campaignId: string;
        readonly actor: ActorRef;
        readonly action: string;
        readonly targetType: string;
        readonly targetId: string;
        readonly before?: Record<string, unknown>;
        readonly after?: Record<string, unknown>;
        readonly at: string;
        readonly private: boolean;
      };
      readonly originMutationId: string;
      readonly targetVisibility: { readonly visibility: Visibility };
    },
  ): Promise<unknown>;
}

export type EncounterFence = (transaction: EncountersTransaction) => Promise<void>;

export interface EncounterWriteOptions {
  readonly fence?: EncounterFence;
  readonly originId: string;
}

export type EncounterWriteResult<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly code: 'invalid_encounter' | 'not_found_or_forbidden' }
  | { readonly ok: false; readonly code: 'version_conflict'; readonly current: T };

const HIDDEN = { ok: false, code: 'not_found_or_forbidden' } as const;
const INVALID = { ok: false, code: 'invalid_encounter' } as const;
const CLOCK_SKEW_MS = 5 * 60_000;

function notFuture(at: string): boolean {
  return Date.parse(at) <= Date.now() + CLOCK_SKEW_MS;
}

function owned(actor: ActorRef, record: { campaignId: string; createdBy: string }): boolean {
  return record.campaignId === actor.campaignId && record.createdBy === actor.userId;
}

function sorted(value: Readonly<Record<string, number>>): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function mode(visibility: Visibility): 'gm_only' | 'everyone' {
  return visibility.mode === 'everyone' ? 'everyone' : 'gm_only';
}

export class EncounterService {
  constructor(
    private readonly deps: {
      readonly encounters: PostgresEncounterRepository;
      readonly decider: EncounterDecider;
      readonly system: PinnedSystem;
      readonly audit?: EncounterAuditRecorder;
    },
  ) {}

  #allowed(actor: ActorRef, capability: Capability, facts: ResourceFacts): boolean {
    return this.deps.decider.decide(actor, capability, facts).allowed;
  }

  async #record(
    transaction: EncountersTransaction,
    actor: ActorRef,
    input: {
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string;
      readonly visibility: Visibility;
      readonly before?: Record<string, unknown>;
      readonly after?: Record<string, unknown>;
    },
    originId: string,
  ): Promise<void> {
    await this.deps.audit?.recordWithin(transaction, {
      event: {
        campaignId: actor.campaignId,
        actor,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.after === undefined ? {} : { after: input.after }),
        at: new Date().toISOString(),
        private: false,
      },
      originMutationId: originId,
      targetVisibility: { visibility: input.visibility },
    });
  }

  /** FR-005: a new active encounter (D-10). */
  async start(
    actor: ActorRef,
    candidate: unknown,
    options: EncounterWriteOptions,
  ): Promise<EncounterWriteResult<EncounterRecord>> {
    if (!isValidEncounter(candidate)) return INVALID;
    const record = candidate;
    if (
      !owned(actor, record) ||
      record.version !== 1 ||
      record.status !== 'active' ||
      record.deletedAt !== undefined ||
      !notFuture(record.startedAt)
    ) {
      return INVALID;
    }
    if (!this.#allowed(actor, 'create', encounterFacts(ENCOUNTER_CLASS, record))) return HIDDEN;
    const { encounters } = this.deps;
    return encounters.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const inserted = await encounters.insertEncounter(transaction, {
        id: record.id,
        campaignId: record.campaignId,
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
        name: record.name.trim(),
        status: 'active',
        startedAt: record.startedAt,
        environment: record.environment,
        ...(record.locationId === undefined ? {} : { locationId: record.locationId }),
        actorUserId: actor.userId,
      });
      if (inserted === undefined) {
        const existing = await encounters.getEncounter(record.campaignId, record.id, {
          executor: transaction,
        });
        return existing !== undefined && existing.createdBy === actor.userId
          ? { ok: true as const, record: existing }
          : HIDDEN;
      }
      await this.#record(
        transaction,
        actor,
        {
          action: ENCOUNTER_AUDIT_ACTIONS.started,
          targetType: ENCOUNTER_CLASS,
          targetId: inserted.id,
          visibility: ENCOUNTER_VISIBILITY,
          after: { name: inserted.name },
        },
        options.originId,
      );
      return { ok: true as const, record: inserted };
    });
  }

  /** FR-009, FR-011: environment, location, or the end, against the stored version (D-10). */
  async update(
    actor: ActorRef,
    candidate: unknown,
    expectedVersion: number,
    options: EncounterWriteOptions,
  ): Promise<EncounterWriteResult<EncounterRecord>> {
    if (!isValidEncounter(candidate)) return INVALID;
    const next = candidate;
    if (next.campaignId !== actor.campaignId) return INVALID;
    const { encounters } = this.deps;
    return encounters.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const current = await encounters.getEncounter(next.campaignId, next.id, {
        executor: transaction,
        lock: true,
      });
      if (current === undefined || current.deletedAt !== undefined) return HIDDEN;
      if (!this.#allowed(actor, 'update', encounterFacts(ENCOUNTER_CLASS, current))) return HIDDEN;
      if (current.version !== expectedVersion) {
        return { ok: false as const, code: 'version_conflict' as const, current };
      }
      const kind = classifyEncounterUpdate(current, next);
      if (!kind.ok) return INVALID;
      if (next.endedAt !== undefined && !notFuture(next.endedAt)) return INVALID;
      const updated = await encounters.updateEncounter(transaction, {
        campaignId: current.campaignId,
        id: current.id,
        expectedVersion,
        status: next.status,
        ...(next.endedAt === undefined ? {} : { endedAt: next.endedAt }),
        environment: next.environment,
        ...(next.locationId === undefined ? {} : { locationId: next.locationId }),
        actorUserId: actor.userId,
      });
      if (updated === undefined) return HIDDEN;
      if (kind.value === 'ended') {
        await this.#record(
          transaction,
          actor,
          {
            action: ENCOUNTER_AUDIT_ACTIONS.ended,
            targetType: ENCOUNTER_CLASS,
            targetId: updated.id,
            visibility: ENCOUNTER_VISIBILITY,
            after: { name: updated.name },
          },
          options.originId,
        );
      }
      return { ok: true as const, record: updated };
    });
  }

  /** The first save inserts, later saves compare the version. Only GM roles; the encounter must exist. */
  async saveNote(
    actor: ActorRef,
    candidate: unknown,
    expectedVersion: number | null,
    options: EncounterWriteOptions,
  ): Promise<EncounterWriteResult<EncounterNoteRecord>> {
    if (!isValidEncounterNote(candidate)) return INVALID;
    const note = candidate;
    if (note.campaignId !== actor.campaignId) return INVALID;
    const facts = encounterFacts(ENCOUNTER_NOTE_CLASS, {
      ...note,
      visibility: ENCOUNTER_NOTES_VISIBILITY,
    });
    if (!this.#allowed(actor, expectedVersion === null ? 'create' : 'update', facts)) {
      return HIDDEN;
    }
    const { encounters } = this.deps;
    return encounters.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const encounter = await encounters.getEncounter(note.campaignId, note.id, {
        executor: transaction,
      });
      if (encounter === undefined) return HIDDEN;
      if (expectedVersion === null) {
        const inserted = await encounters.insertNote(transaction, {
          id: note.id,
          campaignId: note.campaignId,
          body: note.body,
          actorUserId: actor.userId,
        });
        if (inserted !== undefined) return { ok: true as const, record: inserted };
        const existing = await encounters.getNote(note.campaignId, note.id, {
          executor: transaction,
        });
        if (existing === undefined) return HIDDEN;
        return existing.body === note.body && existing.version === 1
          ? { ok: true as const, record: existing }
          : { ok: false as const, code: 'version_conflict' as const, current: existing };
      }
      const current = await encounters.getNote(note.campaignId, note.id, {
        executor: transaction,
        lock: true,
      });
      if (current === undefined) return HIDDEN;
      if (current.version !== expectedVersion) {
        return { ok: false as const, code: 'version_conflict' as const, current };
      }
      const updated = await encounters.updateNote(transaction, {
        campaignId: note.campaignId,
        id: note.id,
        expectedVersion,
        body: note.body,
        actorUserId: actor.userId,
      });
      return updated === undefined
        ? { ok: false as const, code: 'version_conflict' as const, current }
        : { ok: true as const, record: updated };
    });
  }

  /**
   * FR-002, FR-003, FR-010: a participant of an active encounter. An entity participant's public conditions must be
   * the initial instance's, and the authority writes its state row from that same initial instance (D-02).
   */
  async addParticipant(
    actor: ActorRef,
    candidate: unknown,
    options: EncounterWriteOptions,
  ): Promise<EncounterWriteResult<ParticipantRecord>> {
    if (!isValidParticipant(candidate)) return INVALID;
    const record = candidate;
    if (
      !owned(actor, record) ||
      record.version !== 1 ||
      record.deletedAt !== undefined ||
      !notFuture(record.createdAt)
    ) {
      return INVALID;
    }
    if (!this.#allowed(actor, 'create', encounterFacts(PARTICIPANT_CLASS, record))) return HIDDEN;
    let state: ReturnType<typeof initialInstance> | undefined;
    if (record.sourceKind === 'entity') {
      const system = await this.deps.system(record.campaignId);
      if (system === undefined) return INVALID;
      state = initialInstance(system, record.name);
      if (sorted(state.conditions) !== sorted(record.conditions)) return INVALID;
    }
    const { encounters } = this.deps;
    return encounters.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const encounter = await encounters.getEncounter(record.campaignId, record.encounterId, {
        executor: transaction,
        lock: true,
      });
      if (encounter === undefined || encounter.deletedAt !== undefined) return HIDDEN;
      const inserted =
        encounter.status === 'ended'
          ? undefined
          : await encounters.insertParticipant(transaction, {
              id: record.id,
              campaignId: record.campaignId,
              encounterId: record.encounterId,
              label: record.name.trim(),
              sourceKind: record.sourceKind,
              sourceId: record.sourceId,
              position: record.position,
              conditions: state?.conditions ?? {},
              visibilityMode: mode(record.visibility),
              ...(state === undefined ? {} : { state: state.secret }),
              actorUserId: actor.userId,
            });
      if (inserted === undefined) {
        const existing = await encounters.getParticipant(record.campaignId, record.id, {
          executor: transaction,
        });
        if (existing === undefined) return encounter.status === 'ended' ? INVALID : HIDDEN;
        return existing.createdBy === actor.userId &&
          existing.encounterId === record.encounterId &&
          existing.name === record.name.trim()
          ? { ok: true as const, record: existing }
          : HIDDEN;
      }
      await this.#record(
        transaction,
        actor,
        {
          action: ENCOUNTER_AUDIT_ACTIONS.participantAdded,
          targetType: PARTICIPANT_CLASS,
          targetId: inserted.id,
          visibility: inserted.visibility,
          after: { name: inserted.name, encounterId: inserted.encounterId },
        },
        options.originId,
      );
      return { ok: true as const, record: inserted };
    });
  }

  /** D-05: the only participant update in P0 is the one-way reveal. */
  async updateParticipant(
    actor: ActorRef,
    candidate: unknown,
    expectedVersion: number,
    options: EncounterWriteOptions,
  ): Promise<EncounterWriteResult<ParticipantRecord>> {
    if (!isValidParticipant(candidate)) return INVALID;
    const next = candidate;
    if (next.campaignId !== actor.campaignId) return INVALID;
    const { encounters } = this.deps;
    return encounters.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const current = await encounters.getParticipant(next.campaignId, next.id, {
        executor: transaction,
        lock: true,
      });
      if (current === undefined || current.deletedAt !== undefined) return HIDDEN;
      if (!this.#allowed(actor, 'update', encounterFacts(PARTICIPANT_CLASS, current))) {
        return HIDDEN;
      }
      if (current.version !== expectedVersion) {
        return { ok: false as const, code: 'version_conflict' as const, current };
      }
      const fixed = (['name', 'encounterId', 'sourceKind', 'sourceId', 'position'] as const).every(
        (key) => current[key] === next[key],
      );
      if (!fixed) return INVALID;
      const encounter = await encounters.getEncounter(current.campaignId, current.encounterId, {
        executor: transaction,
      });
      if (encounter === undefined || encounter.status === 'ended') return INVALID;
      if (mode(next.visibility) === mode(current.visibility)) {
        return { ok: true as const, record: current };
      }
      if (mode(next.visibility) !== 'everyone') return INVALID;
      const updated = await encounters.updateParticipant(transaction, {
        campaignId: current.campaignId,
        id: current.id,
        expectedVersion,
        visibilityMode: 'everyone',
        actorUserId: actor.userId,
      });
      if (updated === undefined) return HIDDEN;
      await this.#record(
        transaction,
        actor,
        {
          action: ENCOUNTER_AUDIT_ACTIONS.participantRevealed,
          targetType: PARTICIPANT_CLASS,
          targetId: updated.id,
          visibility: updated.visibility,
          after: { name: updated.name, encounterId: updated.encounterId },
        },
        options.originId,
      );
      return { ok: true as const, record: updated };
    });
  }

  /** FR-010: a removal, versioned; the character or entity is untouched. */
  async removeParticipant(
    actor: ActorRef,
    input: { readonly campaignId: string; readonly id: string; readonly expectedVersion: number },
    options: EncounterWriteOptions,
  ): Promise<EncounterWriteResult<ParticipantRecord>> {
    if (input.campaignId !== actor.campaignId) return INVALID;
    const { encounters } = this.deps;
    return encounters.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const current = await encounters.getParticipant(input.campaignId, input.id, {
        executor: transaction,
        lock: true,
      });
      if (current === undefined || current.deletedAt !== undefined) return HIDDEN;
      if (!this.#allowed(actor, 'delete', encounterFacts(PARTICIPANT_CLASS, current))) {
        return HIDDEN;
      }
      if (current.version !== input.expectedVersion) {
        return { ok: false as const, code: 'version_conflict' as const, current };
      }
      const encounter = await encounters.getEncounter(current.campaignId, current.encounterId, {
        executor: transaction,
      });
      if (encounter === undefined || encounter.status === 'ended') return INVALID;
      const removed = await encounters.updateParticipant(transaction, {
        campaignId: current.campaignId,
        id: current.id,
        expectedVersion: input.expectedVersion,
        deleted: true,
        actorUserId: actor.userId,
      });
      if (removed === undefined) return HIDDEN;
      await this.#record(
        transaction,
        actor,
        {
          action: ENCOUNTER_AUDIT_ACTIONS.participantRemoved,
          targetType: PARTICIPANT_CLASS,
          targetId: removed.id,
          visibility: current.visibility,
          before: { name: current.name, encounterId: current.encounterId },
        },
        options.originId,
      );
      return { ok: true as const, record: removed };
    });
  }
}

/**
 * The feature 11 adapter for class `encounter_participant` (feature 11 D-12). Only a live entity participant of an
 * active encounter has an instance; both rows are locked and read as one state, and a save splits the public
 * conditions back out, so a player replica never receives anything else (D-05).
 */
export function encounterParticipantTargetAdapter(deps: {
  readonly encounters: PostgresEncounterRepository;
  readonly system: PinnedSystem;
}): EffectTargetAdapter {
  const loaded = new Map<string, SystemPackage>();
  const systemFor = (facts: ResourceFacts) => loaded.get(facts.resourceId);
  return {
    targetClass: PARTICIPANT_CLASS,
    load: async (transaction, { campaignId, targetId }) => {
      const executor = transaction as unknown as EncountersTransaction;
      const participant = await deps.encounters.getParticipant(campaignId, targetId, {
        executor,
        lock: true,
      });
      if (
        participant === undefined ||
        participant.deletedAt !== undefined ||
        participant.sourceKind !== 'entity'
      ) {
        return undefined;
      }
      const encounter = await deps.encounters.getEncounter(campaignId, participant.encounterId, {
        executor,
      });
      if (encounter === undefined || encounter.status === 'ended') return undefined;
      const row = await deps.encounters.getState(campaignId, targetId, { executor, lock: true });
      const system = await deps.system(campaignId);
      if (row === undefined || system === undefined) return undefined;
      loaded.set(targetId, system);
      return {
        state: mergeInstanceState(participant.conditions, row.state),
        facts: encounterFacts(PARTICIPANT_CLASS, participant),
      };
    },
    save: async (transaction, { campaignId, targetId, state, actorUserId }) => {
      const system = loaded.get(targetId);
      if (system === undefined) throw new Error('participant not loaded');
      const { conditions, secret } = splitInstanceState(system, state);
      await deps.encounters.writeInstance(transaction as unknown as EncountersTransaction, {
        campaignId,
        id: targetId,
        conditions,
        state: secret,
        actorUserId,
      });
    },
    deniedPaths: (_actor, paths, facts) => {
      const system = systemFor(facts);
      return system === undefined ? paths : paths.filter((path) => !isDeclaredPath(system, path));
    },
    hiddenPaths: (paths, facts) => {
      const system = systemFor(facts);
      return system === undefined
        ? paths
        : paths.filter((path) => !isPublicConditionPath(system, path));
    },
    constrain: (state, facts) => {
      const system = systemFor(facts);
      return system === undefined ? state : clampTargetState(system, state);
    },
  };
}
