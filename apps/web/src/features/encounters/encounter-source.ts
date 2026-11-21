import {
  ACTIONS_SYNC_FEATURE_ID,
  EFFECT_REPLICA_TABLE,
  EFFECT_ROW_CODEC,
  EffectLocalRepository,
  type EffectRecord,
} from '@rpg/actions';
import { AuthorizationService, ResourcePolicyRegistry } from '@rpg/authorization';
import { CAMPAIGN_PIN_REPLICA_TABLE, campaignReplicaSystem } from '@rpg/campaigns/export';
import {
  CHARACTER_REPLICA_TABLE,
  CHARACTER_SECRET_POLICY,
  CHARACTER_SECRET_REPLICA_TABLE,
  CHARACTERS_SYNC_FEATURE_ID,
  CharacterLocalRepository,
  type CharacterRecord,
  characterCodec,
  displayName,
  secretFromRow,
} from '@rpg/characters';
import {
  CONTENT_SYNC_FEATURE_ID,
  ENTITY_REPLICA_TABLE,
  ENTITY_ROW_CODEC,
  EntityLocalRepository,
  type EntityRecord,
} from '@rpg/content';
import type { EntityEnvelope, Role, SystemRef } from '@rpg/contracts';
import {
  ENCOUNTER_NOTE_POLICY,
  ENCOUNTER_NOTE_REPLICA_TABLE,
  ENCOUNTER_NOTE_ROW_CODEC,
  ENCOUNTER_REPLICA_TABLE,
  ENCOUNTER_REPLICA_TABLES,
  ENCOUNTER_ROW_CODEC,
  ENCOUNTERS_SYNC_FEATURE_ID,
  EncounterLocalRepository,
  type EncounterNoteRecord,
  EncounterNotesLocalRepository,
  type EncounterRecord,
  PARTICIPANT_REPLICA_TABLE,
  PARTICIPANT_ROW_CODEC,
  PARTICIPANT_STATE_REPLICA_TABLE,
  ParticipantLocalRepository,
  type ParticipantRecord,
  participantStateFromRow,
} from '@rpg/encounters';
import type { BrowserRecordCodec, BrowserSyncSession } from '@rpg/sync/browser';
import type { SystemPackage } from '@rpg/systems';

/**
 * Feature 19 device composition: what the tracker reads and writes, over the browser replica only, so it runs
 * offline (FR-012). Other features' rows are read and written through their published packages (feature 15
 * characters, feature 16 entities, feature 11 effects); nothing here imports another web feature. Tests build their
 * own `EncounterSource`.
 */
export interface EncounterSource {
  readonly userId: string;
  readonly campaignId: string;
  readonly encounters: EncounterLocalRepository;
  readonly notes: EncounterNotesLocalRepository;
  readonly participants: ParticipantLocalRepository;
  /** Feature 16: improvised enemies are real entities (D-03). */
  readonly entities: Pick<EntityLocalRepository, 'create' | 'list'>;
  /** Feature 15: characters the device holds, as their sheet shows them. */
  readonly characters: Pick<CharacterLocalRepository, 'list' | 'displayed'>;
  /** The campaign's pinned package, validated; `undefined` before the pin arrives. */
  system(): Promise<SystemPackage | undefined>;
  /** Feature 04's answer for the cached role: may this device run encounters. */
  mayRun(): Promise<boolean>;
  /** Feature 04's answer: may this device read and write GM-only character values. */
  mayEditGmOnly(): Promise<boolean>;
  /** Applications the authority refused, so the tracker stops showing them. */
  refused(): Promise<ReadonlySet<string>>;
  subscribe(listener: () => void): () => void;
}

const WATCHED = [
  ...Object.keys(ENCOUNTER_REPLICA_TABLES),
  ENTITY_REPLICA_TABLE,
  CHARACTER_REPLICA_TABLE,
  CHARACTER_SECRET_REPLICA_TABLE,
  CAMPAIGN_PIN_REPLICA_TABLE,
  EFFECT_REPLICA_TABLE,
  'sync_pending_mutations',
  'sync_membership_cache',
];

function decider() {
  const policies = new ResourcePolicyRegistry();
  policies.register(ENCOUNTER_NOTE_POLICY);
  policies.register(CHARACTER_SECRET_POLICY);
  return new AuthorizationService(policies);
}

export function browserEncounterSource(
  session: BrowserSyncSession,
  input: {
    readonly userId: string;
    readonly campaignId: string;
    /** The app shell's validated registry (validation runs once per page). */
    readonly resolve: (ref: SystemRef) => SystemPackage | undefined;
  },
): EncounterSource {
  const { userId, campaignId, resolve } = input;
  const actor = { userId, campaignId };
  const repository = <T extends EntityEnvelope>(
    tableName: string,
    featureId: string,
    codec: BrowserRecordCodec<T>,
    audited = false,
  ) =>
    // The authority records the encounter events, the effects, and the character events itself.
    session.repository<T>({ tableName, featureId, campaignId, codec, audited });
  const effects = new EffectLocalRepository(
    repository<EffectRecord>(EFFECT_REPLICA_TABLE, ACTIONS_SYNC_FEATURE_ID, EFFECT_ROW_CODEC),
    actor,
  );
  const states = {
    list: async (campaign: string) =>
      (await session.store.featureRows(PARTICIPANT_STATE_REPLICA_TABLE, campaign)).flatMap(
        (row) => {
          const record = participantStateFromRow(row);
          return record === undefined ? [] : [record];
        },
      ),
  };
  const characterSecrets = {
    list: async (campaign: string) =>
      (await session.store.featureRows(CHARACTER_SECRET_REPLICA_TABLE, campaign)).flatMap((row) => {
        const secret = secretFromRow(row);
        return secret === undefined ? [] : [secret];
      }),
  };
  const pinned = async () => {
    const ref = await campaignReplicaSystem(session.database, campaignId);
    return ref === undefined ? undefined : resolve(ref);
  };
  const characterRecords = repository<CharacterRecord>(
    CHARACTER_REPLICA_TABLE,
    CHARACTERS_SYNC_FEATURE_ID,
    characterCodec((record) => {
      const system = resolve(record.system);
      return system === undefined ? 'Character' : displayName(system, record.state);
    }),
  );
  const authorization = decider();
  const allowed = async (capability: 'update' | 'read', resourceClass: string) => {
    const cached = await session.store.cachedMembership(campaignId);
    if (cached === undefined || cached.removedAt !== null) return false;
    return authorization.decide({ userId, campaignId, role: cached.role as Role }, capability, {
      campaignId,
      resourceClass,
      resourceId: campaignId,
      visibility: { mode: 'gm_only' },
      version: 1,
    }).allowed;
  };
  return {
    userId,
    campaignId,
    encounters: new EncounterLocalRepository(
      repository<EncounterRecord>(
        ENCOUNTER_REPLICA_TABLE,
        ENCOUNTERS_SYNC_FEATURE_ID,
        ENCOUNTER_ROW_CODEC,
      ),
      actor,
    ),
    notes: new EncounterNotesLocalRepository(
      repository<EncounterNoteRecord>(
        ENCOUNTER_NOTE_REPLICA_TABLE,
        ENCOUNTERS_SYNC_FEATURE_ID,
        ENCOUNTER_NOTE_ROW_CODEC,
      ),
      actor,
    ),
    participants: new ParticipantLocalRepository(
      repository<ParticipantRecord>(
        PARTICIPANT_REPLICA_TABLE,
        ENCOUNTERS_SYNC_FEATURE_ID,
        PARTICIPANT_ROW_CODEC,
      ),
      states,
      effects,
      actor,
    ),
    // Feature 16 entities carry their audit envelope (`entity.created`), like the content screens.
    entities: new EntityLocalRepository(
      repository<EntityRecord>(
        ENTITY_REPLICA_TABLE,
        CONTENT_SYNC_FEATURE_ID,
        ENTITY_ROW_CODEC,
        true,
      ),
      actor,
    ),
    characters: new CharacterLocalRepository(characterRecords, characterSecrets, effects, actor),
    system: pinned,
    mayRun: () => allowed('update', ENCOUNTER_NOTE_POLICY.resourceClass),
    mayEditGmOnly: () => allowed('read', CHARACTER_SECRET_POLICY.resourceClass),
    async refused() {
      const rows = await session.database.getAll<{ record_id: string }>(
        "SELECT record_id FROM sync_pending_mutations WHERE table_name = ? AND state = 'rejected'",
        [EFFECT_REPLICA_TABLE],
      );
      return new Set(rows.map((row) => row.record_id));
    },
    subscribe(listener) {
      return session.database.onChange(
        { onChange: () => listener() },
        { tables: WATCHED, throttleMs: 50 },
      );
    },
  };
}
