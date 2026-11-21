import { EFFECT_REPLICA_TABLE, EFFECT_ROW_CODEC } from '@rpg/actions';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import { CAMPAIGN_PIN_REPLICA_TABLE, campaignReplicaSystem } from '@rpg/campaigns/export';
import {
  CHARACTER_REPLICA_TABLE,
  characterCodec,
  characterSummary,
  displayName,
  type SummaryValue,
} from '@rpg/characters';
import {
  ENTITY_REPLICA_TABLE,
  ENTITY_ROW_CODEC,
  RELATIONSHIP_REPLICA_TABLE,
  RELATIONSHIP_ROW_CODEC,
} from '@rpg/content';
import type { Role, SystemRef } from '@rpg/contracts';
import { DICE_ROLL_REPLICA_TABLE, ROLL_ROW_CODEC } from '@rpg/dice';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { createInstalledRegistry } from '@rpg/installed-systems';
import {
  type ContextEntity,
  type ContextRelationship,
  type LogEffect,
  type LogRoll,
  SESSION_LOG_REPLICA_TABLE,
  SESSION_LOG_ROW_CODEC,
  SESSION_NOTE_POLICY,
  SESSION_NOTE_REPLICA_TABLE,
  SESSION_NOTE_ROW_CODEC,
  SESSION_POLICY,
  SESSION_REPLICA_TABLE,
  SESSION_REPLICA_TABLES,
  SESSION_ROW_CODEC,
  SESSIONS_SYNC_FEATURE_ID,
  SessionLocalRepository,
  type SessionLogEntryRecord,
  SessionLogLocalRepository,
  type SessionNoteRecord,
  SessionNotesLocalRepository,
  type SessionRecord,
} from '@rpg/sessions';
import type { MutationConflict } from '@rpg/sync';
import type { BrowserSyncedRepository, BrowserSyncSession } from '@rpg/sync/browser';
import type { SystemPackage } from '@rpg/systems';

/**
 * Feature 18 device composition: what Session Mode reads and writes, over the browser replica only, so it opens
 * offline (FR-011, FR-015). Other features' rows are read through their public codecs; nothing here imports another
 * web feature. Production builds it over the browser replica; tests build their own `SessionSource`.
 */

export interface PartyMember {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly summary: readonly SummaryValue[];
}

export interface SessionSource {
  readonly userId: string;
  readonly campaignId: string;
  readonly sessions: SessionLocalRepository;
  readonly notes: SessionNotesLocalRepository;
  readonly log: SessionLogLocalRepository;
  /** The cached membership role (a hint; the authority decides every write). */
  role(): Promise<Role | undefined>;
  /** Feature 04's answer for the cached role: may this device run sessions and read GM notes. */
  mayRun(): Promise<boolean>;
  /** Feature 16 rows the device holds (already filtered by Visibility at the sync boundary). */
  content(): Promise<{
    readonly entities: readonly ContextEntity[];
    readonly relationships: readonly ContextRelationship[];
  }>;
  /** Characters the device holds, with their declared summaries (D-08). */
  party(): Promise<readonly PartyMember[]>;
  /** What the pinned system declares, for capability-gated quick actions (D-11). */
  capabilities(): Promise<readonly string[]>;
  rolls(): Promise<readonly LogRoll[]>;
  effects(): Promise<readonly LogEffect[]>;
  /** Feature 03 conflicts on this feature's tables (GM notes, sessions). */
  conflicts(): Promise<readonly MutationConflict[]>;
  resolveConflict(conflict: MutationConflict, choice: 'keep_authority' | 'resubmit'): Promise<void>;
  subscribe(listener: () => void): () => void;
}

const WATCHED = [
  ...Object.keys(SESSION_REPLICA_TABLES),
  ENTITY_REPLICA_TABLE,
  RELATIONSHIP_REPLICA_TABLE,
  CHARACTER_REPLICA_TABLE,
  CAMPAIGN_PIN_REPLICA_TABLE,
  DICE_ROLL_REPLICA_TABLE,
  EFFECT_REPLICA_TABLE,
  'sync_conflicts',
  'sync_pending_mutations',
  'sync_membership_cache',
];

let registry: ReturnType<typeof createInstalledRegistry> | undefined;

function systems(): ReturnType<typeof createInstalledRegistry> {
  registry ??= createInstalledRegistry([FIXTURE_SYSTEM_PACKAGE]);
  return registry;
}

function decider() {
  const policies = new ResourcePolicyRegistry();
  policies.register(SESSION_POLICY);
  policies.register(SESSION_NOTE_POLICY);
  return new AuthorizationService(policies);
}

function decoded<T>(
  rows: readonly Readonly<Record<string, unknown>>[],
  decode: (row: Readonly<Record<string, unknown>>) => T | undefined,
): T[] {
  return rows.flatMap((row) => {
    const value = decode(row);
    return value === undefined ? [] : [value];
  });
}

export function browserSessionSource(
  session: BrowserSyncSession,
  input: {
    readonly userId: string;
    readonly campaignId: string;
    /** The app shell's validated registry, when it has one (validation runs once per page). */
    readonly resolve?: (ref: SystemRef) => SystemPackage | undefined;
  },
): SessionSource {
  const { userId, campaignId } = input;
  const actor = { userId, campaignId };
  // The authority records `session.*` itself; these tables queue no envelope.
  const sessionRecords = session.repository<SessionRecord>({
    tableName: SESSION_REPLICA_TABLE,
    featureId: SESSIONS_SYNC_FEATURE_ID,
    campaignId,
    codec: SESSION_ROW_CODEC,
    audited: false,
  });
  const noteRecords = session.repository<SessionNoteRecord>({
    tableName: SESSION_NOTE_REPLICA_TABLE,
    featureId: SESSIONS_SYNC_FEATURE_ID,
    campaignId,
    codec: SESSION_NOTE_ROW_CODEC,
    audited: false,
  });
  const logRecords = session.repository<SessionLogEntryRecord>({
    tableName: SESSION_LOG_REPLICA_TABLE,
    featureId: SESSIONS_SYNC_FEATURE_ID,
    campaignId,
    codec: SESSION_LOG_ROW_CODEC,
    audited: false,
  });
  const log = new SessionLogLocalRepository(logRecords, actor);
  const byTable = new Map<string, Pick<BrowserSyncedRepository<SessionRecord>, 'resolveConflict'>>([
    [SESSION_REPLICA_TABLE, sessionRecords],
    [SESSION_NOTE_REPLICA_TABLE, noteRecords],
  ]);
  const authorization = decider();
  const resolve = input.resolve ?? ((ref: SystemRef) => systems().resolve(ref));
  const rows = (table: string) => session.store.featureRows(table, campaignId);
  const pinned = async () => {
    const ref = await campaignReplicaSystem(session.database, campaignId);
    return ref === undefined ? undefined : resolve(ref);
  };
  const role = async (): Promise<Role | undefined> => {
    const cached = await session.store.cachedMembership(campaignId);
    return cached === undefined || cached.removedAt !== null ? undefined : (cached.role as Role);
  };
  return {
    userId,
    campaignId,
    sessions: new SessionLocalRepository(sessionRecords, log, actor),
    notes: new SessionNotesLocalRepository(noteRecords, actor),
    log,
    role,
    async mayRun() {
      const current = await role();
      if (current === undefined) return false;
      return authorization.decide({ userId, campaignId, role: current }, 'update', {
        campaignId,
        resourceClass: SESSION_NOTE_POLICY.resourceClass,
        resourceId: campaignId,
        visibility: { mode: 'gm_only' },
        version: 1,
      }).allowed;
    },
    async content() {
      const [entities, relationships] = await Promise.all([
        rows(ENTITY_REPLICA_TABLE),
        rows(RELATIONSHIP_REPLICA_TABLE),
      ]);
      return {
        entities: decoded(entities, (row) => ENTITY_ROW_CODEC.fromRow(row)),
        relationships: decoded(relationships, (row) => RELATIONSHIP_ROW_CODEC.fromRow(row)),
      };
    },
    async capabilities() {
      return (await pinned())?.capabilities ?? [];
    },
    async party() {
      const system = await pinned();
      const codec = characterCodec((record) =>
        system === undefined ? 'Character' : displayName(system, record.state),
      );
      return decoded(await rows(CHARACTER_REPLICA_TABLE), (row) => codec.fromRow(row))
        .filter((record) => record.deletedAt === undefined)
        .map((record) => ({
          id: record.id,
          ownerUserId: record.ownerUserId,
          name: record.name,
          summary: system === undefined ? [] : characterSummary(system, record.state),
        }))
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        );
    },
    async rolls() {
      return decoded(await rows(DICE_ROLL_REPLICA_TABLE), (row) => ROLL_ROW_CODEC.fromRow(row));
    },
    async effects() {
      return decoded(await rows(EFFECT_REPLICA_TABLE), (row) => EFFECT_ROW_CODEC.fromRow(row));
    },
    async conflicts() {
      return (await session.store.conflicts(campaignId)).filter((conflict) =>
        byTable.has(conflict.table),
      );
    },
    async resolveConflict(conflict, choice) {
      await byTable.get(conflict.table)?.resolveConflict(conflict.conflictId, choice);
    },
    subscribe(listener) {
      return session.database.onChange(
        { onChange: () => listener() },
        { tables: WATCHED, throttleMs: 50 },
      );
    },
  };
}
