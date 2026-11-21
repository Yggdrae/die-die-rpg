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
  CHARACTER_POLICY,
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
import type { Role, SystemRef } from '@rpg/contracts';
import type { RollLocalRepository } from '@rpg/dice';
import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { createInstalledRegistry } from '@rpg/installed-systems';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import type { SystemPackage } from '@rpg/systems';
import { browserRollRepository } from '../dice/roll-source.ts';

/**
 * Feature 15 device composition: what the sheet reads and writes, over the browser replica. The pinned package
 * comes from the replicated campaign pin and the installed registry, validated by every engine, so the browser
 * interprets a character exactly as the authority does.
 */
export interface CharacterSource {
  readonly userId: string;
  readonly campaignId: string;
  readonly characters: CharacterLocalRepository;
  readonly rolls: RollLocalRepository;
  readonly effects: EffectLocalRepository;
  /** The campaign's pinned system, as a validated package; `undefined` before the pin arrives. */
  system(): Promise<{ readonly ref: SystemRef; readonly system: SystemPackage } | undefined>;
  /** Feature 04's answer for this device's cached membership: may it read and write GM-only values. */
  mayEditGmOnly(): Promise<boolean>;
  /** Applications the authority refused, so the sheet stops showing them. */
  refused(): Promise<ReadonlySet<string>>;
  subscribe(listener: () => void): () => void;
}

let registry: ReturnType<typeof createInstalledRegistry> | undefined;

/** One registry per page: loading validates every package with every engine. */
export function installedRegistry() {
  registry ??= createInstalledRegistry([FIXTURE_SYSTEM_PACKAGE]);
  return registry;
}

const WATCHED = [
  CHARACTER_REPLICA_TABLE,
  CHARACTER_SECRET_REPLICA_TABLE,
  EFFECT_REPLICA_TABLE,
  'dice_rolls',
  CAMPAIGN_PIN_REPLICA_TABLE,
  'sync_pending_mutations',
  // What `mayEditGmOnly` reads: the device's reconciled membership.
  'sync_membership_cache',
];

function decider() {
  const policies = new ResourcePolicyRegistry();
  policies.register(CHARACTER_POLICY);
  policies.register(CHARACTER_SECRET_POLICY);
  return new AuthorizationService(policies);
}

export function browserCharacterSource(
  session: BrowserSyncSession,
  input: { readonly userId: string; readonly campaignId: string },
): CharacterSource {
  const systems = installedRegistry();
  const authorization = decider();
  const effects = new EffectLocalRepository(
    session.repository<EffectRecord>({
      tableName: EFFECT_REPLICA_TABLE,
      featureId: ACTIONS_SYNC_FEATURE_ID,
      campaignId: input.campaignId,
      codec: EFFECT_ROW_CODEC,
      audited: false,
    }),
    input,
  );
  const codec = characterCodec((record) => {
    const system = systems.resolve(record.system);
    return system === undefined ? 'Character' : displayName(system, record.state);
  });
  const records = session.repository<CharacterRecord>({
    tableName: CHARACTER_REPLICA_TABLE,
    featureId: CHARACTERS_SYNC_FEATURE_ID,
    campaignId: input.campaignId,
    codec,
    // The authority records `character.created` and `character.deleted` itself.
    audited: false,
  });
  const secrets = {
    list: async (campaignId: string) =>
      (await session.store.featureRows(CHARACTER_SECRET_REPLICA_TABLE, campaignId)).flatMap(
        (row) => {
          const secret = secretFromRow(row);
          return secret === undefined ? [] : [secret];
        },
      ),
  };
  return {
    ...input,
    characters: new CharacterLocalRepository(records, secrets, effects, input),
    rolls: browserRollRepository(session, input),
    effects,
    async system() {
      const ref = await campaignReplicaSystem(session.database, input.campaignId);
      if (ref === undefined) return undefined;
      const system = systems.resolve(ref);
      return system === undefined ? undefined : { ref, system };
    },
    async mayEditGmOnly() {
      const cached = await session.store.cachedMembership(input.campaignId);
      if (cached === undefined || cached.removedAt !== null) return false;
      return authorization.decide(
        { userId: input.userId, campaignId: input.campaignId, role: cached.role as Role },
        'read',
        {
          campaignId: input.campaignId,
          resourceClass: CHARACTER_SECRET_POLICY.resourceClass,
          resourceId: input.campaignId,
          visibility: { mode: 'gm_only' },
          version: 1,
        },
      ).allowed;
    },
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
