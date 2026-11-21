import { APPEARS_IN_KIND, LOCATED_AT_KIND, SCENE_ENTITY_TYPE } from '@rpg/content';
import { err, ok, type Result } from '@rpg/contracts';
import {
  MAX_PARTICIPANTS,
  type SessionLogEntryRecord,
  type SessionRecord,
  type StatusEvent,
} from './records.ts';

/**
 * The pure session model (`_techspec.md` "Device"): lifecycle (D-05), numbering (D-04), the scene context (D-02),
 * the merged log (D-03), and palette matching (D-12). It reads other features' rows structurally, so it imports
 * none of them.
 */

export type SessionChange =
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'end' }
  | { readonly kind: 'scene'; readonly sceneId: string | undefined }
  | { readonly kind: 'present'; readonly userId: string; readonly present: boolean };

export type SessionChangeError = 'session_ended' | 'invalid_transition' | 'too_many_participants';

export interface ChangedSession {
  readonly record: SessionRecord;
  /** The status event this change writes to the log, if any. */
  readonly event?: StatusEvent;
  /** A scene change writes a `scene` entry. */
  readonly scene?: boolean;
}

function live<T extends { readonly deletedAt?: string }>(record: T): boolean {
  return record.deletedAt === undefined;
}

/** D-04: at most one session is open (not ended) per campaign. */
export function openSessionOf(sessions: readonly SessionRecord[]): SessionRecord | undefined {
  return sessions
    .filter((session) => live(session) && session.status !== 'ended')
    .sort((left, right) => right.number - left.number)[0];
}

/** D-04: the number the device shows until the authority assigns one. */
export function provisionalNumber(sessions: readonly SessionRecord[]): number {
  return sessions.reduce((highest, session) => Math.max(highest, session.number), 0) + 1;
}

/** D-05: a valid transition, or a scene or presence change while open. `at` is the device time. */
export function changeSession(
  record: SessionRecord,
  change: SessionChange,
  at: string,
): Result<ChangedSession, SessionChangeError> {
  if (record.status === 'ended') return err('session_ended');
  switch (change.kind) {
    case 'pause':
      return record.status === 'active'
        ? ok({ record: { ...record, status: 'paused' }, event: 'paused' })
        : err('invalid_transition');
    case 'resume':
      return record.status === 'paused'
        ? ok({ record: { ...record, status: 'active' }, event: 'resumed' })
        : err('invalid_transition');
    case 'end': {
      const endedAt = Date.parse(at) < Date.parse(record.startedAt) ? record.startedAt : at;
      return ok({ record: { ...record, status: 'ended', endedAt }, event: 'ended' });
    }
    case 'scene': {
      if (record.currentSceneId === change.sceneId) return err('invalid_transition');
      const { currentSceneId: _previous, ...rest } = record;
      return ok({
        record: change.sceneId === undefined ? rest : { ...rest, currentSceneId: change.sceneId },
        scene: change.sceneId !== undefined,
      });
    }
    case 'present': {
      const has = record.participantUserIds.includes(change.userId);
      if (has === change.present) return err('invalid_transition');
      const participantUserIds = change.present
        ? [...record.participantUserIds, change.userId]
        : record.participantUserIds.filter((id) => id !== change.userId);
      if (participantUserIds.length > MAX_PARTICIPANTS) return err('too_many_participants');
      return ok({ record: { ...record, participantUserIds } });
    }
  }
}

/**
 * The authority's check of an update against the stored row (D-05): the same change the device may make, and
 * nothing else. Returns the status event to audit, `scene` for a scene change, or `none`.
 */
export function classifyUpdate(
  current: SessionRecord,
  next: SessionRecord,
): Result<'none' | 'scene' | StatusEvent, SessionChangeError> {
  if (current.status === 'ended') return err('session_ended');
  // The number is the authority's (D-04): a device may still hold its provisional one, so it is ignored here.
  if (next.startedAt !== current.startedAt || next.campaignId !== current.campaignId) {
    return err('invalid_transition');
  }
  let event: StatusEvent | undefined;
  if (next.status !== current.status) {
    if (current.status === 'active' && next.status === 'paused') event = 'paused';
    else if (current.status === 'paused' && next.status === 'active') event = 'resumed';
    else if (next.status === 'ended') event = 'ended';
    else return err('invalid_transition');
  }
  if ((next.endedAt !== undefined) !== (event === 'ended')) return err('invalid_transition');
  const sceneChanged = next.currentSceneId !== current.currentSceneId;
  if (event !== undefined && sceneChanged) return err('invalid_transition');
  if (event !== undefined) return ok(event);
  return ok(sceneChanged ? 'scene' : 'none');
}

/** Initial participants (D-09): the starter, then every character owner the device holds. */
export function initialParticipants(
  starterUserId: string,
  characters: readonly { readonly ownerUserId: string; readonly deletedAt?: string }[],
): string[] {
  const ids = [starterUserId];
  for (const character of characters) {
    if (character.deletedAt === undefined && !ids.includes(character.ownerUserId)) {
      ids.push(character.ownerUserId);
    }
  }
  return ids.slice(0, MAX_PARTICIPANTS);
}

/* -------------------------------------------------------------------------- */
/* Scene context (D-02)                                                       */
/* -------------------------------------------------------------------------- */

export interface ContextEntity {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly summary: string;
  readonly deletedAt?: string;
}

export interface ContextRelationship {
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly kind: string;
  readonly deletedAt?: string;
}

export interface SceneContext {
  /** `undefined` when no scene is set; `unavailable` when this device does not hold it. */
  readonly scene: ContextEntity | 'unavailable' | undefined;
  readonly locations: readonly ContextEntity[];
  readonly present: readonly ContextEntity[];
}

function byName(left: ContextEntity, right: ContextEntity): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function sceneContext(
  sceneId: string | undefined,
  entities: readonly ContextEntity[],
  relationships: readonly ContextRelationship[],
): SceneContext {
  if (sceneId === undefined) return { scene: undefined, locations: [], present: [] };
  const held = new Map(entities.filter(live).map((entity) => [entity.id, entity]));
  const scene = held.get(sceneId);
  if (scene === undefined) return { scene: 'unavailable', locations: [], present: [] };
  const links = relationships.filter(live);
  const pick = (ids: readonly string[]) =>
    [...new Set(ids)].flatMap((id) => {
      const found = held.get(id);
      return found === undefined ? [] : [found];
    });
  return {
    scene,
    locations: pick(
      links
        .filter((link) => link.kind === LOCATED_AT_KIND && link.sourceEntityId === sceneId)
        .map((link) => link.targetEntityId),
    ).sort(byName),
    present: pick(
      links
        .filter((link) => link.kind === APPEARS_IN_KIND && link.targetEntityId === sceneId)
        .map((link) => link.sourceEntityId),
    ).sort(byName),
  };
}

/** Scenes the device holds, by name: the scene picker and the palette's "Set scene" operations. */
export function scenesOf(entities: readonly ContextEntity[]): ContextEntity[] {
  return entities
    .filter((entity) => live(entity) && entity.type === SCENE_ENTITY_TYPE)
    .sort(byName);
}

/* -------------------------------------------------------------------------- */
/* Session log (D-03)                                                         */
/* -------------------------------------------------------------------------- */

export interface LogRoll {
  readonly id: string;
  readonly name: string;
  readonly result: { readonly modified: number };
  readonly rolledAt: string;
  readonly visibility: { readonly mode: string };
}

export interface LogEffect {
  readonly id: string;
  readonly name: string;
  readonly appliedAt: string;
}

export type LogLine =
  | {
      readonly kind: 'entry';
      readonly id: string;
      readonly at: string;
      readonly entry: SessionLogEntryRecord;
    }
  | { readonly kind: 'roll'; readonly id: string; readonly at: string; readonly roll: LogRoll }
  | {
      readonly kind: 'effect';
      readonly id: string;
      readonly at: string;
      readonly effect: LogEffect;
    };

function within(session: SessionRecord, at: string): boolean {
  const time = Date.parse(at);
  if (Number.isNaN(time) || time < Date.parse(session.startedAt)) return false;
  return session.endedAt === undefined || time <= Date.parse(session.endedAt);
}

/**
 * The session's log: its own entries (notes, scene and status changes, reveals made from Session Mode), plus rolls
 * and effect applications inside its window, newest last. Every input is what this device holds, so nothing here
 * widens what it may show.
 */
export function sessionLog(input: {
  readonly session: SessionRecord;
  readonly entries: readonly SessionLogEntryRecord[];
  readonly rolls?: readonly LogRoll[];
  readonly effects?: readonly LogEffect[];
}): LogLine[] {
  const { session } = input;
  const lines: LogLine[] = [
    ...input.entries
      .filter((entry) => live(entry) && entry.sessionId === session.id)
      .map((entry) => ({ kind: 'entry' as const, id: entry.id, at: entry.createdAt, entry })),
    ...(input.rolls ?? [])
      .filter((roll) => within(session, roll.rolledAt))
      .map((roll) => ({ kind: 'roll' as const, id: roll.id, at: roll.rolledAt, roll })),
    ...(input.effects ?? [])
      .filter((effect) => within(session, effect.appliedAt))
      .map((effect) => ({ kind: 'effect' as const, id: effect.id, at: effect.appliedAt, effect })),
  ];
  return lines.sort(
    (left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id),
  );
}

/* -------------------------------------------------------------------------- */
/* Command palette (D-12)                                                     */
/* -------------------------------------------------------------------------- */

export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  /** Shown beside the label: "Action", "Session", "Scene", an entity type. */
  readonly group: string;
}

function normalized(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/**
 * Items whose label contains every word of the query, labels starting with the query first. An empty query
 * lists everything in order. At most `limit`.
 */
export function matchPalette<T extends PaletteItem>(
  items: readonly T[],
  query: string,
  limit = 20,
): T[] {
  const words = normalized(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.slice(0, limit);
  const whole = normalized(query);
  return items
    .map((item, index) => ({ item, index, label: normalized(item.label) }))
    .filter(({ label }) => words.every((word) => label.includes(word)))
    .sort(
      (left, right) =>
        Number(right.label.startsWith(whole)) - Number(left.label.startsWith(whole)) ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map(({ item }) => item);
}
