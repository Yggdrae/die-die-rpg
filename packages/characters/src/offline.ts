import { type EffectLocalRepository, projectTargetState, type TargetState } from '@rpg/actions';
import {
  err,
  ok,
  type RepositoryError,
  type Result,
  type SyncedRepository,
  type SystemRef,
} from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';
import { CHARACTER_CLASS } from './policies.ts';
import {
  CHARACTER_RECORD_TYPE,
  type CharacterRecord,
  type CharacterSecretRecord,
  characterVisibility,
} from './records.ts';
import {
  displayName,
  editPlan,
  initialCharacterState,
  mergeState,
  type SheetEdit,
  type SheetEditFailure,
  splitState,
} from './sheet.ts';

/**
 * Feature 15 published device API (FR-003, FR-009, FR-012). Create and delete go through this feature's own
 * mutations; every edit is a feature 11 application on the character (D-02), so it is local first, merges or
 * refuses explicitly, and is audited once by the authority.
 */

export type LocalCharacterError =
  | { readonly code: 'invalid_name' }
  | { readonly code: 'not_found' }
  | { readonly code: 'edit'; readonly failure: SheetEditFailure }
  | { readonly code: 'apply'; readonly failure: string }
  | { readonly code: 'storage'; readonly failure: RepositoryError };

export class CharacterLocalRepository {
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    private readonly records: SyncedRepository<CharacterRecord>,
    private readonly secrets: {
      list(campaignId: string): Promise<readonly CharacterSecretRecord[]>;
    },
    private readonly effects: EffectLocalRepository,
    private readonly actor: { readonly userId: string; readonly campaignId: string },
    options: { readonly clock?: () => Date; readonly createId?: () => string } = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** A new character of the campaign's pinned system, owned by the actor. */
  async create(
    system: SystemPackage,
    pin: SystemRef,
    name: string,
  ): Promise<Result<CharacterRecord, LocalCharacterError>> {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > 200) return err({ code: 'invalid_name' });
    const now = this.#clock().toISOString();
    const { visible } = splitState(system, initialCharacterState(system, trimmed));
    const record: CharacterRecord = {
      id: this.#createId(),
      campaignId: this.actor.campaignId,
      type: CHARACTER_RECORD_TYPE,
      name: trimmed,
      tags: [],
      metadata: {},
      visibility: characterVisibility(this.actor.userId),
      version: 1,
      createdAt: now,
      createdBy: this.actor.userId,
      updatedAt: now,
      updatedBy: this.actor.userId,
      ownerUserId: this.actor.userId,
      system: pin,
      state: visible,
    };
    const stored = await this.records.upsert(record, null);
    return stored.ok ? stored : err({ code: 'storage', failure: stored.error });
  }

  async remove(id: string, expectedVersion: number): Promise<Result<void, LocalCharacterError>> {
    const removed = await this.records.softDelete(id, expectedVersion);
    return removed.ok ? ok(undefined) : err({ code: 'storage', failure: removed.error });
  }

  async list(): Promise<CharacterRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return listed.value
      .filter((record) => record.deletedAt === undefined)
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
  }

  async get(id: string): Promise<CharacterRecord | undefined> {
    const found = await this.records.get(id);
    return found.ok && found.value.deletedAt === undefined ? found.value : undefined;
  }

  /**
   * What the sheet shows: the character's row, its GM-only row when this device holds it, and every edit the
   * authority has not accepted yet. `excluded` names refused applications, which stop counting.
   */
  async displayed(
    character: CharacterRecord,
    excluded: ReadonlySet<string> = new Set(),
  ): Promise<TargetState> {
    const secret = (await this.secrets.list(this.actor.campaignId)).find(
      (row) => row.id === character.id && row.deletedAt === undefined,
    );
    const base = mergeState(character.state, secret?.state);
    const pending = (await this.effects.list()).filter(
      (record) =>
        record.targetClass === CHARACTER_CLASS &&
        record.targetId === character.id &&
        record.acceptedAt === undefined &&
        !excluded.has(record.id),
    );
    return projectTargetState(base, pending);
  }

  /** One sheet edit (D-02), validated against the schema before anything is queued. */
  async edit(
    system: SystemPackage,
    character: CharacterRecord,
    edit: SheetEdit,
    mayEditGmOnly: boolean,
  ): Promise<Result<string, LocalCharacterError>> {
    const state = await this.displayed(character);
    const plan = editPlan(system, state, edit, mayEditGmOnly);
    if (!plan.ok) return err({ code: 'edit', failure: plan.error });
    const applied = await this.effects.apply(
      { targetClass: CHARACTER_CLASS, targetId: character.id, visibility: character.visibility },
      plan.value,
    );
    return applied.ok ? ok(applied.value.id) : err({ code: 'apply', failure: applied.error.code });
  }

  /** The display name of a record, derived from its state (D-10). */
  static nameOf(system: SystemPackage | undefined, record: Pick<CharacterRecord, 'state'>): string {
    return system === undefined ? 'Character' : displayName(system, record.state);
  }
}
