import {
  err,
  type RepositoryError,
  type Result,
  type SyncedRepository,
  type Visibility,
} from '@rpg/contracts';
import { evaluateRoll } from './engine/evaluator.ts';
import type {
  RandomSource,
  RollEvaluationFailure,
  RollParseFailure,
  RollRequest,
} from './engine/model.ts';
import { parseRoll } from './engine/parser.ts';
import { cryptoRandom } from './engine/random.ts';
import {
  checkRollRecord,
  ROLL_RECORD_TYPE,
  type RollRecord,
  type RollRecordDefect,
  type RollVisibility,
  rollDisplayName,
  rollVisibilityToVisibility,
} from './records.ts';

/**
 * Feature 09 published device API (FR-012, consumed by features 11, 15, 18, 19). It sits on the feature
 * 03 `SyncedRepository`: a roll is evaluated here, written to the replica and the queue in one local
 * transaction, and visible at once with no network. The authority re-validates on upload.
 *
 * The record id is generated before queueing, so a retried upload can never become a second roll
 * (D-10). The repository is bound with `audited: false`: a roll is its own record, not an audit event.
 */

export interface RollContext {
  readonly visibility: RollVisibility;
  /** Whisper only: who else may read it, besides the roller and the GM roles. */
  readonly recipients?: readonly string[];
  readonly actorRef?: string;
  readonly targetRef?: string;
  readonly action?: string;
  readonly sessionId?: string;
}

export type LocalRollError =
  | { readonly code: 'parse'; readonly failure: RollParseFailure }
  | { readonly code: 'evaluation'; readonly failure: RollEvaluationFailure }
  | { readonly code: 'invalid_recipients' }
  | { readonly code: 'hidden_from_roller' }
  | { readonly code: 'invalid_record'; readonly defect: RollRecordDefect }
  | { readonly code: 'storage'; readonly failure: RepositoryError };

export interface RollListFilter {
  readonly sessionId?: string;
}

export class RollLocalRepository {
  readonly #random: RandomSource;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    private readonly records: SyncedRepository<RollRecord>,
    private readonly actor: { readonly userId: string; readonly campaignId: string },
    /**
     * D-12 on the device, from the cached membership through feature 04. Answer `false` when the role
     * is unknown, so a hidden roll is refused rather than written where it may never be.
     */
    private readonly mayCreate: (roll: {
      readonly id: string;
      readonly visibility: Visibility;
    }) => Promise<boolean>,
    options: {
      readonly random?: RandomSource;
      readonly clock?: () => Date;
      readonly createId?: () => string;
    } = {},
  ) {
    this.#random = options.random ?? cryptoRandom();
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** Rolls and records. A refused roll rolls nothing into the replica and queues nothing. */
  async roll(request: RollRequest & RollContext): Promise<Result<RollRecord, LocalRollError>> {
    const parsed = parseRoll(request.expression);
    if (!parsed.ok) return err({ code: 'parse', failure: parsed.error });
    const visibility = rollVisibilityToVisibility(
      request.visibility,
      this.actor.userId,
      request.recipients,
    );
    if (typeof visibility === 'string') return err({ code: 'invalid_recipients' });
    const id = this.#createId();
    if (!(await this.mayCreate({ id, visibility }))) return err({ code: 'hidden_from_roller' });
    const result = evaluateRoll(parsed.value, request.inputs ?? {}, this.#random);
    if (!result.ok) return err({ code: 'evaluation', failure: result.error });
    // A caller may pass its whole context; the record keeps only what the expression named.
    const inputs = Object.fromEntries(
      result.value.terms.flatMap((term) =>
        term.kind === 'input' ? [[term.name, term.value] as const] : [],
      ),
    );
    const now = this.#clock().toISOString();
    const record: RollRecord = {
      id,
      campaignId: this.actor.campaignId,
      type: ROLL_RECORD_TYPE,
      name: rollDisplayName(request.action, request.expression),
      tags: [],
      metadata: {},
      visibility,
      version: 1,
      createdAt: now,
      createdBy: this.actor.userId,
      updatedAt: now,
      updatedBy: this.actor.userId,
      actorUserId: this.actor.userId,
      ...(request.actorRef === undefined ? {} : { actorRef: request.actorRef }),
      ...(request.targetRef === undefined ? {} : { targetRef: request.targetRef }),
      ...(request.action === undefined ? {} : { action: request.action }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      expression: request.expression,
      inputs,
      result: result.value,
      rollVisibility: request.visibility,
      rolledAt: now,
    };
    const defect = checkRollRecord(record);
    if (defect !== undefined) return err({ code: 'invalid_record', defect });
    const stored = await this.records.upsert(record, null);
    return stored.ok ? stored : err({ code: 'storage', failure: stored.error });
  }

  async get(id: string): Promise<RollRecord | undefined> {
    const found = await this.records.get(id);
    return found.ok ? found.value : undefined;
  }

  /** What this replica holds, oldest first (chronological logs). Only what the device may read. */
  async list(filter: RollListFilter = {}): Promise<RollRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return listed.value
      .filter((record) => filter.sessionId === undefined || record.sessionId === filter.sessionId)
      .sort(
        (left, right) =>
          left.rolledAt.localeCompare(right.rolledAt) || left.id.localeCompare(right.id),
      );
  }
}
