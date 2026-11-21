import { clampTargetState } from '@rpg/actions/engine';
import type { EffectTargetAdapter } from '@rpg/actions/postgres';
import type { Capability, Decision, ResourceFacts } from '@rpg/authorization';
import type { ActorRef, SystemRef, Visibility } from '@rpg/contracts';
import { systemRefToString } from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';
import { Value } from '@sinclair/typebox/value';
import { CHARACTER_AUDIT_ACTIONS } from './audit-declarations.ts';
import type {
  CharactersTransaction,
  PostgresCharacterRepository,
} from './infra/postgres/repository.ts';
import { CHARACTER_CLASS, characterFacts } from './policies.ts';
import { type CharacterRecord, CharacterReplicaSchema, characterVisibility } from './records.ts';
import {
  displayName,
  initialCharacterState,
  isDeclaredPath,
  isGmOnlyPath,
  mergeState,
  splitState,
} from './sheet.ts';

/**
 * Feature 15 authority (`_techspec.md` "Authority"): create and delete as this feature's own mutations, and the
 * feature 11 target adapter through which every edit arrives. The pinned package interprets every state.
 */

export interface CharacterDecider {
  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): Decision;
}

/** The pinned package by exact reference, from the validated registry. */
export type SystemResolver = (ref: SystemRef) => SystemPackage | undefined;

/** Feature 02, structurally: the campaign's exact pin as the actor sees it. */
export type CampaignPin = (actor: ActorRef) => Promise<SystemRef | undefined>;

export interface CharacterAuditRecorder {
  recordWithin(
    executor: CharactersTransaction,
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

export type CharacterFence = (transaction: CharactersTransaction) => Promise<void>;

export type CharacterWriteResult =
  | { readonly ok: true; readonly record: CharacterRecord }
  | { readonly ok: false; readonly code: 'invalid_character' | 'not_found_or_forbidden' }
  | { readonly ok: false; readonly code: 'version_conflict'; readonly current: CharacterRecord };

const HIDDEN = { ok: false, code: 'not_found_or_forbidden' } as const;
const INVALID = { ok: false, code: 'invalid_character' } as const;

export class CharacterService {
  constructor(
    private readonly deps: {
      readonly characters: PostgresCharacterRepository;
      readonly decider: CharacterDecider;
      readonly systems: SystemResolver;
      readonly pin: CampaignPin;
      readonly audit?: CharacterAuditRecorder;
    },
  ) {}

  /**
   * D-08: pinned to the campaign's system, owned by the actor, starting from the schema's defaults. The
   * uploaded visible state must be exactly those defaults with the name in place, so a create cannot smuggle
   * values past the edit rules.
   */
  async create(
    actor: ActorRef,
    candidate: unknown,
    options: { readonly fence?: CharacterFence; readonly originId: string },
  ): Promise<CharacterWriteResult> {
    if (!Value.Check(CharacterReplicaSchema, candidate)) return INVALID;
    const record = candidate as CharacterRecord;
    if (
      record.campaignId !== actor.campaignId ||
      record.ownerUserId !== actor.userId ||
      record.createdBy !== actor.userId ||
      record.version !== 1 ||
      record.deletedAt !== undefined
    ) {
      return INVALID;
    }
    const facts = characterFacts({ ...record, version: 1 });
    if (!this.deps.decider.decide(actor, 'create', facts).allowed) return HIDDEN;
    const pin = await this.deps.pin(actor);
    if (pin === undefined || systemRefToString(pin) !== systemRefToString(record.system))
      return INVALID;
    const system = this.deps.systems(pin);
    if (system === undefined) return INVALID;
    const name = displayName(system, record.state);
    const expected = splitState(system, initialCharacterState(system, name));
    if (JSON.stringify(expected.visible) !== JSON.stringify(record.state)) return INVALID;
    const { characters, audit } = this.deps;
    return characters.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const inserted = await characters.insert(transaction, {
        id: record.id,
        campaignId: record.campaignId,
        ownerUserId: actor.userId,
        system: pin,
        state: expected.visible,
        secretState: expected.secret,
        actorUserId: actor.userId,
      });
      if (inserted === undefined) {
        const existing = await characters.get(record.campaignId, record.id, {
          executor: transaction,
        });
        return existing !== undefined &&
          existing.ownerUserId === actor.userId &&
          JSON.stringify(existing.state) === JSON.stringify(expected.visible)
          ? { ok: true as const, record: existing }
          : HIDDEN;
      }
      await audit?.recordWithin(transaction, {
        event: {
          campaignId: record.campaignId,
          actor,
          action: CHARACTER_AUDIT_ACTIONS.created,
          targetType: CHARACTER_CLASS,
          targetId: record.id,
          after: { name, system: systemRefToString(pin) },
          at: record.createdAt,
          private: false,
        },
        originMutationId: options.originId,
        targetVisibility: { visibility: characterVisibility(actor.userId) },
      });
      return { ok: true as const, record: inserted };
    });
  }

  async tombstone(
    actor: ActorRef,
    input: { readonly campaignId: string; readonly id: string; readonly expectedVersion: number },
    options: { readonly fence?: CharacterFence; readonly originId: string },
  ): Promise<CharacterWriteResult> {
    const { characters, decider, audit } = this.deps;
    return characters.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const current = await characters.get(input.campaignId, input.id, {
        executor: transaction,
        lock: true,
      });
      if (current === undefined || current.deletedAt !== undefined) return HIDDEN;
      if (!decider.decide(actor, 'delete', characterFacts(current)).allowed) return HIDDEN;
      if (current.version !== input.expectedVersion) {
        return { ok: false as const, code: 'version_conflict' as const, current };
      }
      const removed = await characters.tombstone(transaction, {
        ...input,
        actorUserId: actor.userId,
      });
      if (removed === undefined) return HIDDEN;
      const system = this.deps.systems(current.system);
      await audit?.recordWithin(transaction, {
        event: {
          campaignId: input.campaignId,
          actor,
          action: CHARACTER_AUDIT_ACTIONS.deleted,
          targetType: CHARACTER_CLASS,
          targetId: input.id,
          before: {
            ...(system === undefined ? {} : { name: displayName(system, current.state) }),
            system: systemRefToString(current.system),
          },
          at: new Date().toISOString(),
          private: false,
        },
        originMutationId: options.originId,
        targetVisibility: { visibility: current.visibility },
      });
      return { ok: true as const, record: removed };
    });
  }
}

/**
 * The feature 11 adapter for class `character` (D-12 of feature 11). Both rows are locked and read as one
 * state; a save splits it back by path, so a GM-only value never lands in the row players receive.
 */
export function characterTargetAdapter(deps: {
  readonly characters: PostgresCharacterRepository;
  readonly systems: SystemResolver;
  readonly decider: CharacterDecider;
}): EffectTargetAdapter {
  const loaded = new Map<string, SystemPackage>();
  const systemFor = (facts: ResourceFacts) => loaded.get(facts.resourceId);
  return {
    targetClass: CHARACTER_CLASS,
    load: async (transaction, { campaignId, targetId }) => {
      const executor = transaction as unknown as CharactersTransaction;
      const record = await deps.characters.get(campaignId, targetId, { executor, lock: true });
      if (record === undefined || record.deletedAt !== undefined) return undefined;
      const system = deps.systems(record.system);
      if (system === undefined) return undefined;
      const secret = await deps.characters.getSecret(campaignId, targetId, {
        executor,
        lock: true,
      });
      loaded.set(targetId, system);
      return { state: mergeState(record.state, secret?.state), facts: characterFacts(record) };
    },
    save: async (transaction, { campaignId, targetId, state, actorUserId }) => {
      const system = loaded.get(targetId);
      if (system === undefined) throw new Error('character not loaded');
      const { visible, secret } = splitState(system, state);
      await deps.characters.writeState(transaction as unknown as CharactersTransaction, {
        campaignId,
        id: targetId,
        state: visible,
        secretState: secret,
        actorUserId,
      });
    },
    deniedPaths: (actor, paths, facts) => {
      const system = systemFor(facts);
      if (system === undefined) return paths;
      const gmOnlyAllowed = deps.decider.decide(actor, 'read', {
        ...facts,
        resourceClass: 'character_secret',
        visibility: { mode: 'gm_only' },
      }).allowed;
      return paths.filter(
        (path) => !isDeclaredPath(system, path) || (!gmOnlyAllowed && isGmOnlyPath(system, path)),
      );
    },
    hiddenPaths: (paths, facts) => {
      const system = systemFor(facts);
      return system === undefined ? [] : paths.filter((path) => isGmOnlyPath(system, path));
    },
    constrain: (state, facts) => {
      const system = systemFor(facts);
      return system === undefined ? state : clampTargetState(system, state);
    },
  };
}
