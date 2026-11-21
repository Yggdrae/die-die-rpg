import { type TSchema, Type } from '@sinclair/typebox';

/**
 * Feature 02's audit contributions (feature 06 FR-005, FR-006): one declaration per event type
 * `CampaignService` records, with its payload schema and human-readable renderer. Structural
 * shape of feature 06's `AuditEventDeclaration` (this package does not depend on `@rpg/audit`);
 * the API composition registers them. Renderers read only the already-redacted values the
 * service records and never echo raw JSON.
 */
export interface CampaignAuditDeclaration {
  readonly action: string;
  readonly version: number;
  readonly payload?: TSchema;
  render(event: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly before?: Record<string, unknown>;
    readonly after?: Record<string, unknown>;
    readonly at: string;
  }): { readonly text: string };
}

export const CAMPAIGN_AUDIT_ACTIONS = {
  created: 'campaign.created',
  detailsUpdated: 'campaign.details_updated',
  settingChanged: 'campaign.setting_changed',
  systemUpdated: 'campaign.system_updated',
  deleted: 'campaign.deleted',
  imported: 'campaign.imported',
} as const;

const System = Type.Object({ systemId: Type.String(), version: Type.String() });

function text(value: unknown, limit = 80): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function system(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const ref = value as { systemId?: unknown; version?: unknown };
  const id = text(ref.systemId, 60);
  const version = text(ref.version, 20);
  return id === undefined || version === undefined ? undefined : `${id}@${version}`;
}

export const CAMPAIGN_AUDIT_DECLARATIONS: readonly CampaignAuditDeclaration[] = [
  {
    action: CAMPAIGN_AUDIT_ACTIONS.created,
    version: 1,
    payload: Type.Object({ system: Type.Optional(System) }),
    render: ({ after }) => {
      const ref = system(after?.system);
      return {
        text: ref === undefined ? 'Created the campaign.' : `Created the campaign with ${ref}.`,
      };
    },
  },
  {
    action: CAMPAIGN_AUDIT_ACTIONS.detailsUpdated,
    version: 1,
    payload: Type.Object({
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    render: ({ before, after }) => {
      const from = text(before?.name);
      const to = text(after?.name);
      const renamed = from !== undefined && to !== undefined && from !== to;
      const described = before?.description !== after?.description;
      if (renamed) {
        return {
          text: `Renamed the campaign from "${from}" to "${to}".${described ? ' Updated the description.' : ''}`,
        };
      }
      return {
        text: described ? 'Updated the campaign description.' : 'Saved the campaign details.',
      };
    },
  },
  {
    action: CAMPAIGN_AUDIT_ACTIONS.settingChanged,
    version: 1,
    payload: Type.Object({ namespace: Type.Optional(Type.String()) }),
    render: ({ after }) => {
      const namespace = text(after?.namespace, 64);
      return {
        text:
          namespace === undefined
            ? 'Changed a campaign setting.'
            : `Changed the campaign setting ${namespace}.`,
      };
    },
  },
  {
    action: CAMPAIGN_AUDIT_ACTIONS.systemUpdated,
    version: 1,
    payload: Type.Object({ system: Type.Optional(System) }),
    render: ({ before, after }) => {
      const from = system(before?.system);
      const to = system(after?.system);
      return {
        text:
          from !== undefined && to !== undefined
            ? `Updated the game system from ${from} to ${to}.`
            : 'Updated the game system version.',
      };
    },
  },
  {
    action: CAMPAIGN_AUDIT_ACTIONS.deleted,
    version: 1,
    render: () => ({ text: 'Deleted the campaign.' }),
  },
  {
    // Feature 07: a campaign created from an `.rpgpack` package (the importer is its owner).
    action: CAMPAIGN_AUDIT_ACTIONS.imported,
    version: 1,
    payload: Type.Object({ system: Type.Optional(System) }),
    render: ({ after }) => {
      const ref = system(after?.system);
      return {
        text:
          ref === undefined
            ? 'Imported the campaign from a package.'
            : `Imported the campaign from a package with ${ref}.`,
      };
    },
  },
];
