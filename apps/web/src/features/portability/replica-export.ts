import {
  ATTACHMENT_EXPORT_REPLICA_TABLES,
  type AttachmentManifest,
  AttachmentManifestExporter,
} from '@rpg/attachments/export';
import {
  AuthorizationService,
  ResourcePolicyRegistry,
  visibilityFromColumns,
} from '@rpg/authorization';
import {
  ExportRegistry,
  PRESERVED_CHUNK_REPLICA_TABLES,
  unreplicatedContributor,
} from '@rpg/campaign-portability';
import {
  CAMPAIGN_EXPORT_REPLICA_TABLES,
  CampaignExporter,
  campaignReplicaGap,
  campaignReplicaSource,
} from '@rpg/campaigns/export';
import { CAMPAIGN_RESOURCE_POLICY } from '@rpg/campaigns/policy';
import {
  CHARACTER_REPLICA_TABLE,
  CHARACTER_SECRET_REPLICA_TABLE,
  CHARACTERS_SYNC_FEATURE_ID,
  CharacterExporter,
  type CharacterRecord,
  characterCodec,
  countCharacterRecords,
  secretFromRow,
} from '@rpg/characters';
import {
  CONTENT_SYNC_FEATURE_ID,
  ContentExporter,
  countContentRecords,
  ENTITY_REPLICA_TABLE,
  ENTITY_ROW_CODEC,
  type EntityRecord,
  RELATIONSHIP_REPLICA_TABLE,
  RELATIONSHIP_ROW_CODEC,
  type RelationshipRecord,
} from '@rpg/content';
import {
  countDiceRecords,
  DICE_ROLL_REPLICA_TABLE,
  DICE_SYNC_FEATURE_ID,
  ROLL_ROW_CODEC,
  RollExporter,
  type RollRecord,
} from '@rpg/dice';
import {
  countEncounterRecords,
  ENCOUNTER_NOTE_REPLICA_TABLE,
  ENCOUNTER_NOTE_ROW_CODEC,
  ENCOUNTER_REPLICA_TABLE,
  ENCOUNTER_ROW_CODEC,
  EncounterExporter,
  PARTICIPANT_REPLICA_TABLE,
  PARTICIPANT_ROW_CODEC,
  PARTICIPANT_STATE_REPLICA_TABLE,
  participantStateFromRow,
} from '@rpg/encounters';
import {
  countSessionRecords,
  SESSION_LOG_REPLICA_TABLE,
  SESSION_LOG_ROW_CODEC,
  SESSION_NOTE_REPLICA_TABLE,
  SESSION_NOTE_ROW_CODEC,
  SESSION_REPLICA_TABLE,
  SESSION_ROW_CODEC,
  SessionExporter,
} from '@rpg/sessions';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import type { OfflineExportSource } from './export-client.ts';

/**
 * Feature 07 task 05: the offline export over the device replica. The same contributors the API
 * registers (`apps/api/src/modules/portability/composition.ts`), reading local rows, so the chunks
 * match the online export.
 *
 * Complete means a consistent checkpoint is on the device, this campaign has its exact pins, nothing
 * of it awaits upload (a backup of writes the authority may refuse is not a backup of the campaign),
 * and no preserved import chunk exists, since only the authority holds their payloads. Anything else
 * refuses and names the module; there is no partial file.
 */

type AttachmentMimeType = Awaited<
  ReturnType<ConstructorParameters<typeof AttachmentManifestExporter>[0]['listReadyInCampaign']>
>[number]['mime'];

const MODULE_IDS = [
  'campaign',
  'attachments',
  'content',
  'dice_rolls',
  'characters',
  'sessions',
  'encounters',
] as const;

/** Every table only the offline export reads, for the replica schema. */
export const EXPORT_REPLICA_TABLES = {
  ...CAMPAIGN_EXPORT_REPLICA_TABLES,
  ...ATTACHMENT_EXPORT_REPLICA_TABLES,
  ...PRESERVED_CHUNK_REPLICA_TABLES,
};

/** Provider timestamps arrive as text, `T` or a space. */
function instant(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function jsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function hexColumn(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value.toLowerCase() : undefined;
}

function registryOf(
  campaign: ConstructorParameters<typeof CampaignExporter>[0],
  attachments: ConstructorParameters<typeof AttachmentManifestExporter>[0],
  content: ConstructorParameters<typeof ContentExporter>[0],
  rolls: ConstructorParameters<typeof RollExporter>[0],
  characters: ConstructorParameters<typeof CharacterExporter>[0],
  sessions: ConstructorParameters<typeof SessionExporter>[0],
  encounters: ConstructorParameters<typeof EncounterExporter>[0],
) {
  const campaigns = new CampaignExporter(campaign);
  return {
    campaigns,
    registry: new ExportRegistry()
      .register(campaigns, { placement: 'campaign', countRecords: () => 1 })
      .register(new AttachmentManifestExporter(attachments), {
        placement: 'attachments-manifest',
        countRecords: (payload) => (payload as AttachmentManifest).entries.length,
      })
      .register(new ContentExporter(content), {
        placement: 'entities',
        countRecords: countContentRecords,
      })
      .register(new RollExporter(rolls), {
        placement: 'entities',
        countRecords: countDiceRecords,
      })
      .register(new CharacterExporter(characters), {
        placement: 'entities',
        countRecords: countCharacterRecords,
      })
      .register(new SessionExporter(sessions), {
        placement: 'entities',
        countRecords: countSessionRecords,
      })
      .register(new EncounterExporter(encounters), {
        placement: 'entities',
        countRecords: countEncounterRecords,
      }),
  };
}

function exportDecider() {
  const policies = new ResourcePolicyRegistry();
  policies.register(CAMPAIGN_RESOURCE_POLICY);
  return new AuthorizationService(policies);
}

export function browserReplicaExportSource(input: {
  /** The open replica; `undefined` before sync opened, which refuses like any incomplete copy. */
  readonly session?: BrowserSyncSession;
  readonly displayName: string;
  readonly applicationVersion: string;
}): OfflineExportSource {
  const { session, displayName, applicationVersion } = input;
  if (session === undefined) {
    const registry = new ExportRegistry();
    for (const [moduleId, placement] of [
      ['campaign', 'campaign'],
      ['attachments', 'attachments-manifest'],
      ['content', 'entities'],
      ['dice_rolls', 'entities'],
      ['characters', 'entities'],
      ['sessions', 'entities'],
      ['encounters', 'entities'],
    ] as const) {
      const contributor = unreplicatedContributor(moduleId, placement);
      registry.register(contributor.module, { placement: contributor.placement });
    }
    return {
      registry,
      rules: { pins: async () => undefined },
      replica: {
        coverage: async () => ({
          cursor: undefined,
          modules: Object.fromEntries(MODULE_IDS.map((id) => [id, 'replica_not_open'])),
        }),
      },
      mayExport: async () => true,
      displayName,
      applicationVersion,
    };
  }

  const db = session.database;
  const { campaigns, registry } = registryOf(
    campaignReplicaSource(db),
    {
      listReadyInCampaign: async (campaignId) => {
        const rows = await session.store.featureRows('attachments', campaignId);
        return rows
          .flatMap((row) => {
            const visibility = visibilityFromColumns(
              row.visibility_mode,
              jsonColumn(row.visibility_targets),
            );
            const createdAt = instant(row.created_at);
            const finalizedAt = instant(row.finalized_at);
            const declaredChecksum = hexColumn(row.declared_checksum);
            if (
              visibility === undefined ||
              createdAt === undefined ||
              finalizedAt === undefined ||
              declaredChecksum === undefined
            ) {
              throw new Error('attachment_row_invalid');
            }
            const verifiedChecksum = hexColumn(row.verified_checksum);
            return [
              {
                id: String(row.id),
                ownerResourceClass: String(row.owner_resource_class),
                ownerResourceId: String(row.owner_resource_id),
                filename: String(row.filename),
                mime: String(row.mime_type) as AttachmentMimeType,
                declaredSize: Number(row.declared_size),
                verifiedSize: typeof row.verified_size === 'number' ? row.verified_size : undefined,
                declaredChecksum,
                verifiedChecksum,
                visibility,
                version: Number(row.version),
                createdAt,
                finalizedAt,
              },
            ];
          })
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              left.id.localeCompare(right.id),
          );
      },
    },
    {
      entities: {
        list: async (campaignId, filter) => {
          const listed = await session
            .repository<EntityRecord>({
              tableName: ENTITY_REPLICA_TABLE,
              featureId: CONTENT_SYNC_FEATURE_ID,
              campaignId,
              codec: ENTITY_ROW_CODEC,
            })
            .list(campaignId, filter);
          if (!listed.ok) throw new Error('content_unavailable');
          return listed.value;
        },
      },
      relationships: {
        list: async (campaignId) => {
          const listed = await session
            .repository<RelationshipRecord>({
              tableName: RELATIONSHIP_REPLICA_TABLE,
              featureId: CONTENT_SYNC_FEATURE_ID,
              campaignId,
              codec: RELATIONSHIP_ROW_CODEC,
            })
            .list(campaignId, { includeDeleted: true });
          if (!listed.ok) throw new Error('content_unavailable');
          return listed.value;
        },
      },
    },
    {
      list: async (campaignId) => {
        const listed = await session
          .repository<RollRecord>({
            tableName: DICE_ROLL_REPLICA_TABLE,
            featureId: DICE_SYNC_FEATURE_ID,
            campaignId,
            codec: ROLL_ROW_CODEC,
            audited: false,
          })
          .list(campaignId);
        if (!listed.ok) throw new Error('rolls_unavailable');
        return listed.value;
      },
    },
    {
      list: async (campaignId) => {
        const listed = await session
          .repository<CharacterRecord>({
            tableName: CHARACTER_REPLICA_TABLE,
            featureId: CHARACTERS_SYNC_FEATURE_ID,
            campaignId,
            // The name is not exported: any derivation will do here.
            codec: characterCodec(() => 'Character'),
            audited: false,
          })
          .list(campaignId);
        if (!listed.ok) throw new Error('characters_unavailable');
        return listed.value;
      },
      listSecrets: async (campaignId) =>
        (await session.store.featureRows(CHARACTER_SECRET_REPLICA_TABLE, campaignId)).flatMap(
          (row) => {
            const secret = secretFromRow(row);
            return secret === undefined ? [] : [secret];
          },
        ),
    },
    {
      // Feature 18: the export roles are GM roles, so a synchronized replica holds every row.
      listSessions: async (campaignId) =>
        (await session.store.featureRows(SESSION_REPLICA_TABLE, campaignId)).flatMap((row) => {
          const record = SESSION_ROW_CODEC.fromRow(row);
          return record === undefined ? [] : [record];
        }),
      listNotes: async (campaignId) =>
        (await session.store.featureRows(SESSION_NOTE_REPLICA_TABLE, campaignId)).flatMap((row) => {
          const record = SESSION_NOTE_ROW_CODEC.fromRow(row);
          return record === undefined ? [] : [record];
        }),
      listEntries: async (campaignId) =>
        (await session.store.featureRows(SESSION_LOG_REPLICA_TABLE, campaignId)).flatMap((row) => {
          const record = SESSION_LOG_ROW_CODEC.fromRow(row);
          return record === undefined ? [] : [record];
        }),
    },
    {
      // Feature 19: the export roles are GM roles, so a synchronized replica holds every row.
      listEncounters: async (campaignId) =>
        (await session.store.featureRows(ENCOUNTER_REPLICA_TABLE, campaignId)).flatMap((row) => {
          const record = ENCOUNTER_ROW_CODEC.fromRow(row);
          return record === undefined ? [] : [record];
        }),
      listNotes: async (campaignId) =>
        (await session.store.featureRows(ENCOUNTER_NOTE_REPLICA_TABLE, campaignId)).flatMap(
          (row) => {
            const record = ENCOUNTER_NOTE_ROW_CODEC.fromRow(row);
            return record === undefined ? [] : [record];
          },
        ),
      listParticipants: async (campaignId) =>
        (await session.store.featureRows(PARTICIPANT_REPLICA_TABLE, campaignId)).flatMap((row) => {
          const record = PARTICIPANT_ROW_CODEC.fromRow(row);
          return record === undefined ? [] : [record];
        }),
      listStates: async (campaignId) =>
        (await session.store.featureRows(PARTICIPANT_STATE_REPLICA_TABLE, campaignId)).flatMap(
          (row) => {
            const record = participantStateFromRow(row);
            return record === undefined ? [] : [record];
          },
        ),
    },
  );
  const decider = exportDecider();

  return {
    registry,
    rules: { pins: (campaignId) => campaigns.pins(campaignId) },
    mayExport: async (campaignId) => {
      const membership = await session.store.cachedMembership(campaignId);
      if (membership === undefined || membership.removedAt !== null) return false;
      return decider.decide(
        { userId: membership.userId, campaignId, role: membership.role },
        'export',
        {
          campaignId,
          resourceClass: 'campaign',
          resourceId: campaignId,
          visibility: { mode: 'everyone' },
          version: 1,
        },
      ).allowed;
    },
    replica: {
      coverage: async (campaignId) => {
        const [applied, gap, preserved, waiting] = await Promise.all([
          // What the replica has applied, from the provider's own bookkeeping: unlike the status
          // object's timestamp, it stays put across a restart and a failed reconnect.
          db.getOptional<{ cursor: number | null }>(
            'SELECT sum(last_applied_op) AS cursor FROM ps_buckets',
          ),
          campaignReplicaGap(db, campaignId),
          session.store.featureRows('import_preserved_chunks', campaignId),
          session.store.campaignPendingCount(campaignId),
        ]);
        const unsynced = waiting > 0 ? 'unsynchronized_changes' : undefined;
        const preservedGap = preserved.length > 0 ? 'preserved_chunks_not_on_device' : undefined;
        const campaignGap = unsynced ?? gap ?? preservedGap ?? true;
        return {
          cursor:
            db.currentStatus.hasSynced === true && (applied?.cursor ?? null) !== null
              ? String(applied?.cursor)
              : undefined,
          modules: {
            campaign: campaignGap,
            attachments: true,
            content: unsynced ?? true,
            // The export roles read every roll, so a synchronized replica holds all of them.
            dice_rolls: unsynced ?? true,
            // The export roles read every character and its GM-only half.
            characters: unsynced ?? true,
            sessions: unsynced ?? true,
            encounters: unsynced ?? true,
          },
        };
      },
    },
    displayName,
    applicationVersion,
  };
}
