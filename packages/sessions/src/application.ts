import type { Capability, Decision, ResourceFacts } from '@rpg/authorization';
import type { ActorRef, Visibility } from '@rpg/contracts';
import { SESSION_AUDIT_ACTIONS } from './audit-declarations.ts';
import { classifyUpdate } from './domain.ts';
import type {
  PostgresSessionRepository,
  SessionsTransaction,
} from './infra/postgres/repository.ts';
import { SESSION_CLASS, SESSION_LOG_CLASS, SESSION_NOTE_CLASS, sessionFacts } from './policies.ts';
import {
  isValidLogEntry,
  isValidNote,
  isValidSession,
  NOTES_VISIBILITY,
  SESSION_VISIBILITY,
  type SessionLogEntryRecord,
  type SessionNoteRecord,
  type SessionRecord,
  type StatusEvent,
} from './records.ts';

/**
 * Feature 18 authority (`_techspec.md` "Authority"). Every write is re-decided through feature 04, versioned, and
 * audited in its own transaction with the mutation ID as origin (D-14). The device's number is a placeholder: the
 * authority assigns the next one under a campaign lock (D-04).
 */

export interface SessionDecider {
  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): Decision;
}

export interface SessionAuditRecorder {
  recordWithin(
    executor: SessionsTransaction,
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

export type SessionFence = (transaction: SessionsTransaction) => Promise<void>;

export interface SessionWriteOptions {
  readonly fence?: SessionFence;
  readonly originId: string;
}

export type SessionWriteResult<T> =
  | { readonly ok: true; readonly record: T }
  | {
      readonly ok: false;
      readonly code: 'invalid_session' | 'session_already_open' | 'not_found_or_forbidden';
    }
  | { readonly ok: false; readonly code: 'version_conflict'; readonly current: T };

const HIDDEN = { ok: false, code: 'not_found_or_forbidden' } as const;
const INVALID = { ok: false, code: 'invalid_session' } as const;
/** A device clock may run a little ahead; a start further in the future is refused. */
const CLOCK_SKEW_MS = 5 * 60_000;

const EVENT_ACTION: Record<StatusEvent, string> = {
  started: SESSION_AUDIT_ACTIONS.started,
  paused: SESSION_AUDIT_ACTIONS.paused,
  resumed: SESSION_AUDIT_ACTIONS.resumed,
  ended: SESSION_AUDIT_ACTIONS.ended,
};

function notFuture(at: string): boolean {
  return Date.parse(at) <= Date.now() + CLOCK_SKEW_MS;
}

function owned(actor: ActorRef, record: { campaignId: string; createdBy: string }): boolean {
  return record.campaignId === actor.campaignId && record.createdBy === actor.userId;
}

export class SessionService {
  constructor(
    private readonly deps: {
      readonly sessions: PostgresSessionRepository;
      readonly decider: SessionDecider;
      readonly audit?: SessionAuditRecorder;
    },
  ) {}

  #allowed(actor: ActorRef, capability: Capability, facts: ResourceFacts): boolean {
    return this.deps.decider.decide(actor, capability, facts).allowed;
  }

  async #record(
    transaction: SessionsTransaction,
    actor: ActorRef,
    session: SessionRecord,
    action: string,
    after: Record<string, unknown>,
    originId: string,
  ): Promise<void> {
    await this.deps.audit?.recordWithin(transaction, {
      event: {
        campaignId: session.campaignId,
        actor,
        action,
        targetType: SESSION_CLASS,
        targetId: session.id,
        after,
        at: new Date().toISOString(),
        private: false,
      },
      originMutationId: originId,
      targetVisibility: { visibility: SESSION_VISIBILITY },
    });
  }

  /** FR-002: a new active session, numbered by the authority, while no other is open (D-04). */
  async start(
    actor: ActorRef,
    candidate: unknown,
    options: SessionWriteOptions,
  ): Promise<SessionWriteResult<SessionRecord>> {
    if (!isValidSession(candidate)) return INVALID;
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
    if (!this.#allowed(actor, 'create', sessionFacts(SESSION_CLASS, record))) return HIDDEN;
    const { sessions } = this.deps;
    return sessions.transaction(async (transaction) => {
      await options.fence?.(transaction);
      await sessions.lockCampaign(transaction, record.campaignId);
      const existing = await sessions.getSession(record.campaignId, record.id, {
        executor: transaction,
      });
      if (existing !== undefined) {
        return existing.createdBy === actor.userId
          ? { ok: true as const, record: existing }
          : HIDDEN;
      }
      if (await sessions.hasOpenSession(transaction, record.campaignId)) {
        return { ok: false as const, code: 'session_already_open' as const };
      }
      const inserted = await sessions.insertSession(transaction, {
        id: record.id,
        campaignId: record.campaignId,
        number: await sessions.nextNumber(transaction, record.campaignId),
        status: 'active',
        startedAt: record.startedAt,
        ...(record.currentSceneId === undefined ? {} : { currentSceneId: record.currentSceneId }),
        participantUserIds: record.participantUserIds,
        actorUserId: actor.userId,
      });
      if (inserted === undefined) return HIDDEN;
      await this.#record(
        transaction,
        actor,
        inserted,
        SESSION_AUDIT_ACTIONS.started,
        { number: inserted.number },
        options.originId,
      );
      return { ok: true as const, record: inserted };
    });
  }

  /** FR-002, FR-006: a valid transition, scene, or participant change against the stored version (D-05). */
  async update(
    actor: ActorRef,
    candidate: unknown,
    expectedVersion: number,
    options: SessionWriteOptions,
  ): Promise<SessionWriteResult<SessionRecord>> {
    if (!isValidSession(candidate)) return INVALID;
    const next = candidate;
    if (next.campaignId !== actor.campaignId) return INVALID;
    const { sessions } = this.deps;
    return sessions.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const current = await sessions.getSession(next.campaignId, next.id, {
        executor: transaction,
        lock: true,
      });
      if (current === undefined || current.deletedAt !== undefined) return HIDDEN;
      if (!this.#allowed(actor, 'update', sessionFacts(SESSION_CLASS, current))) return HIDDEN;
      if (current.version !== expectedVersion) {
        return { ok: false as const, code: 'version_conflict' as const, current };
      }
      const kind = classifyUpdate(current, next);
      if (!kind.ok) return INVALID;
      if (next.endedAt !== undefined && !notFuture(next.endedAt)) return INVALID;
      const updated = await sessions.updateSession(transaction, {
        campaignId: current.campaignId,
        id: current.id,
        expectedVersion,
        status: next.status,
        ...(next.endedAt === undefined ? {} : { endedAt: next.endedAt }),
        ...(next.currentSceneId === undefined ? {} : { currentSceneId: next.currentSceneId }),
        participantUserIds: next.participantUserIds,
        actorUserId: actor.userId,
      });
      if (updated === undefined) {
        const moved = await sessions.getSession(current.campaignId, current.id, {
          executor: transaction,
        });
        return moved === undefined
          ? HIDDEN
          : { ok: false as const, code: 'version_conflict' as const, current: moved };
      }
      if (kind.value === 'scene') {
        await this.#record(
          transaction,
          actor,
          updated,
          SESSION_AUDIT_ACTIONS.sceneChanged,
          { sceneId: updated.currentSceneId ?? null },
          options.originId,
        );
      } else if (kind.value !== 'none') {
        await this.#record(
          transaction,
          actor,
          updated,
          EVENT_ACTION[kind.value],
          { number: updated.number, status: updated.status },
          options.originId,
        );
      }
      return { ok: true as const, record: updated };
    });
  }

  /** D-06: the first save inserts, later saves compare the version. Only GM roles; the session must exist. */
  async saveNote(
    actor: ActorRef,
    candidate: unknown,
    expectedVersion: number | null,
    options: SessionWriteOptions,
  ): Promise<SessionWriteResult<SessionNoteRecord>> {
    if (!isValidNote(candidate)) return INVALID;
    const note = candidate;
    if (note.campaignId !== actor.campaignId) return INVALID;
    const facts = sessionFacts(SESSION_NOTE_CLASS, { ...note, visibility: NOTES_VISIBILITY });
    const capability = expectedVersion === null ? 'create' : 'update';
    if (!this.#allowed(actor, capability, facts)) return HIDDEN;
    const { sessions } = this.deps;
    return sessions.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const session = await sessions.getSession(note.campaignId, note.id, {
        executor: transaction,
      });
      if (session === undefined) return HIDDEN;
      if (expectedVersion === null) {
        const inserted = await sessions.insertNote(transaction, {
          id: note.id,
          campaignId: note.campaignId,
          body: note.body,
          actorUserId: actor.userId,
        });
        if (inserted !== undefined) return { ok: true as const, record: inserted };
        const existing = await sessions.getNote(note.campaignId, note.id, {
          executor: transaction,
        });
        if (existing === undefined) return HIDDEN;
        return existing.body === note.body && existing.version === 1
          ? { ok: true as const, record: existing }
          : { ok: false as const, code: 'version_conflict' as const, current: existing };
      }
      const current = await sessions.getNote(note.campaignId, note.id, {
        executor: transaction,
        lock: true,
      });
      if (current === undefined) return HIDDEN;
      if (current.version !== expectedVersion) {
        return { ok: false as const, code: 'version_conflict' as const, current };
      }
      const updated = await sessions.updateNote(transaction, {
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

  /** D-10: an immutable entry on an existing session of the campaign. */
  async addEntry(
    actor: ActorRef,
    candidate: unknown,
    options: SessionWriteOptions,
  ): Promise<SessionWriteResult<SessionLogEntryRecord>> {
    if (!isValidLogEntry(candidate)) return INVALID;
    const entry = candidate;
    if (!owned(actor, entry) || entry.version !== 1 || !notFuture(entry.createdAt)) return INVALID;
    if (!this.#allowed(actor, 'create', sessionFacts(SESSION_LOG_CLASS, entry))) return HIDDEN;
    const { sessions } = this.deps;
    return sessions.transaction(async (transaction) => {
      await options.fence?.(transaction);
      const session = await sessions.getSession(entry.campaignId, entry.sessionId, {
        executor: transaction,
      });
      if (session === undefined) return HIDDEN;
      const inserted = await sessions.insertEntry(transaction, {
        id: entry.id,
        campaignId: entry.campaignId,
        sessionId: entry.sessionId,
        kind: entry.kind,
        text: entry.text,
        ...(entry.subjectId === undefined ? {} : { subjectId: entry.subjectId }),
        visibilityMode: entry.visibility.mode === 'everyone' ? 'everyone' : 'gm_only',
        createdAt: entry.createdAt,
        actorUserId: actor.userId,
      });
      if (inserted !== undefined) return { ok: true as const, record: inserted };
      const existing = await sessions.getEntry(entry.campaignId, entry.id, {
        executor: transaction,
      });
      return existing !== undefined &&
        existing.createdBy === actor.userId &&
        existing.sessionId === entry.sessionId &&
        existing.text === entry.text
        ? { ok: true as const, record: existing }
        : HIDDEN;
    });
  }
}
