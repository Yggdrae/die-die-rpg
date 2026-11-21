import { err, ok, type RepositoryError, type Result, type SyncedRepository } from '@rpg/contracts';
import {
  changeSession,
  openSessionOf,
  provisionalNumber,
  type SessionChange,
  type SessionChangeError,
} from './domain.ts';
import {
  isValidLogEntry,
  MAX_LOG_TEXT,
  MAX_NOTES_LENGTH,
  NOTES_VISIBILITY,
  SESSION_LOG_RECORD_TYPE,
  SESSION_NOTE_RECORD_TYPE,
  SESSION_RECORD_TYPE,
  SESSION_VISIBILITY,
  type SessionLogEntryRecord,
  type SessionNoteRecord,
  type SessionRecord,
  type StatusEvent,
  sessionName,
} from './records.ts';

/**
 * Feature 18 published device API (`_techspec.md` "Device"). Every change is local first through feature 03
 * repositories and waits in the queue offline (FR-011). A session change and its log entry are two queued writes,
 * sent in order. The authority records the audit events itself, so these repositories queue no envelope.
 */

export type LocalSessionError =
  | { readonly code: 'session_already_open' }
  | { readonly code: 'not_found' }
  | { readonly code: 'invalid_text' }
  | { readonly code: 'change'; readonly failure: SessionChangeError }
  | { readonly code: 'storage'; readonly failure: RepositoryError };

interface Actor {
  readonly userId: string;
  readonly campaignId: string;
}

interface Options {
  readonly clock?: () => Date;
  readonly createId?: () => string;
}

function storage<T>(result: Result<T, RepositoryError>): Result<T, LocalSessionError> {
  return result.ok ? ok(result.value) : err({ code: 'storage', failure: result.error });
}

export class SessionLogLocalRepository {
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    private readonly records: SyncedRepository<SessionLogEntryRecord>,
    private readonly actor: Actor,
    options: Options = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async list(sessionId?: string): Promise<SessionLogEntryRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return listed.value.filter(
      (entry) =>
        entry.deletedAt === undefined && (sessionId === undefined || entry.sessionId === sessionId),
    );
  }

  /** A GM log note (D-10): `gm_only` unless the GM shows it to the table. */
  async addNote(
    sessionId: string,
    text: string,
    shown: boolean,
  ): Promise<Result<SessionLogEntryRecord, LocalSessionError>> {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.length > MAX_LOG_TEXT) return err({ code: 'invalid_text' });
    return this.#add(sessionId, 'note', trimmed, shown ? 'everyone' : 'gm_only');
  }

  status(sessionId: string, event: StatusEvent) {
    return this.#add(sessionId, 'status', event, 'everyone');
  }

  scene(sessionId: string, sceneId: string) {
    return this.#add(sessionId, 'scene', '', 'everyone', sceneId);
  }

  /** A reveal made from Session Mode (D-03): GM-only, the recipients see the content itself. */
  reveal(sessionId: string, entityId: string) {
    return this.#add(sessionId, 'reveal', '', 'gm_only', entityId);
  }

  async #add(
    sessionId: string,
    kind: SessionLogEntryRecord['kind'],
    text: string,
    mode: 'gm_only' | 'everyone',
    subjectId?: string,
  ): Promise<Result<SessionLogEntryRecord, LocalSessionError>> {
    const now = this.#clock().toISOString();
    const record: SessionLogEntryRecord = {
      id: this.#createId(),
      campaignId: this.actor.campaignId,
      type: SESSION_LOG_RECORD_TYPE,
      name: kind,
      tags: [],
      metadata: {},
      visibility: { mode },
      version: 1,
      createdAt: now,
      createdBy: this.actor.userId,
      updatedAt: now,
      updatedBy: this.actor.userId,
      sessionId,
      kind,
      text,
      ...(subjectId === undefined ? {} : { subjectId }),
    };
    if (!isValidLogEntry(record)) return err({ code: 'invalid_text' });
    return storage(await this.records.upsert(record, null));
  }
}

export class SessionNotesLocalRepository {
  readonly #clock: () => Date;

  constructor(
    private readonly records: SyncedRepository<SessionNoteRecord>,
    private readonly actor: Actor,
    options: Pick<Options, 'clock'> = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(sessionId: string): Promise<SessionNoteRecord | undefined> {
    const found = await this.records.get(sessionId);
    return found.ok && found.value.deletedAt === undefined ? found.value : undefined;
  }

  /**
   * D-06: a save names the version it edited (`null` for the first save), so a concurrent edit is an explicit
   * conflict, never an overwrite.
   */
  async save(
    sessionId: string,
    body: string,
    expectedVersion: number | null,
  ): Promise<Result<SessionNoteRecord, LocalSessionError>> {
    if (body.length > MAX_NOTES_LENGTH) return err({ code: 'invalid_text' });
    const now = this.#clock().toISOString();
    const current = expectedVersion === null ? undefined : await this.get(sessionId);
    if (expectedVersion !== null && current === undefined) return err({ code: 'not_found' });
    const record: SessionNoteRecord = {
      id: sessionId,
      campaignId: this.actor.campaignId,
      type: SESSION_NOTE_RECORD_TYPE,
      name: 'GM notes',
      tags: [],
      metadata: {},
      visibility: NOTES_VISIBILITY,
      version: expectedVersion ?? 1,
      createdAt: current?.createdAt ?? now,
      createdBy: current?.createdBy ?? this.actor.userId,
      updatedAt: now,
      updatedBy: this.actor.userId,
      body,
    };
    return storage(await this.records.upsert(record, expectedVersion));
  }
}

export class SessionLocalRepository {
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    private readonly records: SyncedRepository<SessionRecord>,
    private readonly log: SessionLogLocalRepository,
    private readonly actor: Actor,
    options: Options = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** Every session the device holds, newest first. */
  async list(): Promise<SessionRecord[]> {
    const listed = await this.records.list(this.actor.campaignId);
    if (!listed.ok) return [];
    return listed.value
      .filter((record) => record.deletedAt === undefined)
      .sort((left, right) => right.number - left.number || left.id.localeCompare(right.id));
  }

  async open(): Promise<SessionRecord | undefined> {
    return openSessionOf(await this.list());
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const found = await this.records.get(id);
    return found.ok && found.value.deletedAt === undefined ? found.value : undefined;
  }

  /** FR-002: starts session N+1 (provisional number, D-04) with its participants (D-09). */
  async start(
    participantUserIds: readonly string[],
  ): Promise<Result<SessionRecord, LocalSessionError>> {
    const sessions = await this.list();
    if (openSessionOf(sessions) !== undefined) return err({ code: 'session_already_open' });
    const now = this.#clock().toISOString();
    const number = provisionalNumber(sessions);
    const record: SessionRecord = {
      id: this.#createId(),
      campaignId: this.actor.campaignId,
      type: SESSION_RECORD_TYPE,
      name: sessionName(number),
      tags: [],
      metadata: {},
      visibility: SESSION_VISIBILITY,
      version: 1,
      createdAt: now,
      createdBy: this.actor.userId,
      updatedAt: now,
      updatedBy: this.actor.userId,
      number,
      status: 'active',
      startedAt: now,
      participantUserIds: [...new Set(participantUserIds)],
    };
    const stored = await this.records.upsert(record, null);
    if (!stored.ok) return err({ code: 'storage', failure: stored.error });
    await this.log.status(record.id, 'started');
    return ok(stored.value);
  }

  /** FR-002, FR-006: pause, resume, end, scene, presence, each with its log entry. */
  async change(
    id: string,
    change: SessionChange,
  ): Promise<Result<SessionRecord, LocalSessionError>> {
    const current = await this.get(id);
    if (current === undefined) return err({ code: 'not_found' });
    const now = this.#clock().toISOString();
    const changed = changeSession(current, change, now);
    if (!changed.ok) return err({ code: 'change', failure: changed.error });
    const stored = await this.records.upsert(
      { ...changed.value.record, updatedAt: now, updatedBy: this.actor.userId },
      current.version,
    );
    if (!stored.ok) return err({ code: 'storage', failure: stored.error });
    if (changed.value.event !== undefined) await this.log.status(id, changed.value.event);
    if (changed.value.scene === true && changed.value.record.currentSceneId !== undefined) {
      await this.log.scene(id, changed.value.record.currentSceneId);
    }
    return ok(stored.value);
  }
}
