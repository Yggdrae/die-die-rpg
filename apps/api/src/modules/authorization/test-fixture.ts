import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuditSqlExecutor, CampaignAuditSubmission } from '@rpg/audit';
import {
  type Capability,
  type ResourceFacts,
  type ResourcePolicy,
  ResourcePolicyRegistry,
  type VisibilityActorResolver,
  type VisibilityAdapter,
  type VisibilityAuditRecorder,
  VisibilityService,
  type VisibilityWrite,
  type VisibilityWriteResult,
} from '@rpg/authorization';
import { type ActorRef, err, Id, ok, type Role, type Visibility } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.ts';
import { registerIdentityAuthentication } from '../identity/authenticate.ts';
import { ContentAccess, type ContentDenialReason, sendSafeDenial } from './content-access.ts';
import { inline } from './schemas.ts';
import { registerVisibilityRoutes } from './visibility-routes.ts';

/**
 * Test-only fixture: two invented resource classes, an in-memory owner adapter and a test app.
 * No production content class or table exists yet (feature 04 task 04). Never imported by
 * production code.
 */

export const ORIGIN = 'https://table.invalid';
export const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
export const OTHER_CAMPAIGN = '00000000-0000-4000-8000-0000000000a2';
export const GM = '00000000-0000-4000-8000-0000000000b1';
export const CASEY = '00000000-0000-4000-8000-0000000000c1';
export const ROWAN = '00000000-0000-4000-8000-0000000000d1';
export const OBSERVER = '00000000-0000-4000-8000-0000000000f1';
export const STRANGER = '00000000-0000-4000-8000-0000000000e1';
export const OUTSIDER = '00000000-0000-4000-8000-0000000000e2';

export const NOTE = 'fixture_note';
export const SECRET = 'fixture_secret';

export const CREDENTIALS: Readonly<Record<string, string>> = {
  [GM]: 'G'.repeat(43),
  [CASEY]: 'C'.repeat(43),
  [ROWAN]: 'R'.repeat(43),
  [OBSERVER]: 'O'.repeat(43),
  [STRANGER]: 'S'.repeat(43),
  [OUTSIDER]: 'X'.repeat(43),
};

export function noteId(index: number): string {
  return `00000000-0000-4000-8000-${(0x1000 + index).toString(16).padStart(12, '0')}`;
}

const NOW = new Date('2026-10-25T12:00:00.000Z');
const EXECUTOR: AuditSqlExecutor = {
  execute: async () => [],
  transaction: (work) => work(EXECUTOR),
};

export function sessionCookie(userId: string): string {
  return `rpg_session=${CREDENTIALS[userId]}`;
}

export function notePolicy(resourceClass: string, ownership: boolean): ResourcePolicy {
  return {
    resourceClass,
    capabilities: ['read', 'update', 'reveal'],
    roleCapabilities: {
      owner: ['read', 'update', 'reveal'],
      gm: ['read', 'update', 'reveal'],
      assistant_gm: ['read', 'update', 'reveal'],
      player: ownership ? ['read', 'update'] : ['read'],
      observer: [],
    },
    defaultVisibility: 'explicit',
    ...(ownership
      ? {
          // Author-private: even a GM role cannot read another author's record.
          ownership: {
            field: 'authorUserId' as const,
            capabilities: ['read', 'update', 'reveal'] as Capability[],
            exemptRoles: [],
          },
        }
      : {}),
    sync: {
      kind: 'replicated',
      source: `${resourceClass}s`,
      campaignColumn: 'campaign_id',
      visibility: { modeColumn: 'visibility_mode', targetsColumn: 'visibility_targets' },
      deletedAtColumn: 'deleted_at',
      ...(ownership ? { ownershipColumns: { authorUserId: 'author_user_id' } } : {}),
    },
  };
}

export interface NoteRow {
  readonly id: string;
  readonly campaignId: string;
  visibility: Visibility;
  version: number;
  deleted: boolean;
  readonly authorUserId?: string;
  readonly title: string;
}

/** Contract-conformant in-memory owner adapter (compare-and-set, audit before commit). */
export class MemoryNoteAdapter implements VisibilityAdapter {
  readonly rows = new Map<string, NoteRow>();
  writes = 0;

  constructor(readonly resourceClass: string) {}

  put(row: Partial<NoteRow> & { id: string; visibility: Visibility }): NoteRow {
    const stored: NoteRow = {
      campaignId: CAMPAIGN,
      version: 1,
      deleted: false,
      title: `title-${row.id.slice(-4)}`,
      ...row,
    };
    this.rows.set(stored.id, stored);
    return stored;
  }

  async loadFacts(campaignId: string, resourceId: string): Promise<ResourceFacts | undefined> {
    const row = this.rows.get(resourceId);
    if (row === undefined || row.campaignId !== campaignId || row.deleted) return undefined;
    return this.factsOf(row);
  }

  async writeVisibility(write: VisibilityWrite): Promise<VisibilityWriteResult> {
    const row = this.rows.get(write.resourceId);
    if (row === undefined || row.campaignId !== write.campaignId || row.deleted) {
      return { ok: false, reason: 'not_found' };
    }
    if (row.version !== write.expectedVersion) return { ok: false, reason: 'version_conflict' };
    const snapshot = { visibility: row.visibility, version: row.version };
    row.visibility = write.visibility;
    row.version += 1;
    try {
      await write.recordAudit(EXECUTOR);
    } catch (error) {
      row.visibility = snapshot.visibility;
      row.version = snapshot.version;
      throw error;
    }
    this.writes += 1;
    return { ok: true, facts: this.factsOf(row) };
  }

  factsOf(row: NoteRow): ResourceFacts {
    return {
      campaignId: row.campaignId,
      resourceClass: this.resourceClass,
      resourceId: row.id,
      visibility: row.visibility,
      version: row.version,
      ...(row.authorUserId === undefined ? {} : { authorUserId: row.authorUserId }),
    };
  }
}

/** Stand-in for identity's `ActorResolver`: current memberships only. */
export class Members implements VisibilityActorResolver {
  private readonly roles = new Map<string, Role>();
  /** Lookups remaining before every membership disappears (simulates a revocation race). */
  private lookupsBeforeRevocation: number | undefined;

  constructor(entries: readonly (readonly [string, string, Role])[]) {
    for (const [campaignId, userId, role] of entries) {
      this.roles.set(`${campaignId}:${userId}`, role);
    }
  }

  revokeAfter(lookups: number): void {
    this.lookupsBeforeRevocation = lookups;
  }

  async resolve(userId: string, campaignId: string) {
    if (this.lookupsBeforeRevocation !== undefined) {
      if (this.lookupsBeforeRevocation <= 0) return err('membership_not_found' as const);
      this.lookupsBeforeRevocation -= 1;
    }
    const role = this.roles.get(`${campaignId}:${userId}`);
    return role === undefined
      ? err('membership_not_found' as const)
      : ok<ActorRef>({ userId, campaignId, role });
  }
}

export class AuditSpy implements VisibilityAuditRecorder {
  readonly submissions: CampaignAuditSubmission[] = [];

  async recordWithin(_executor: AuditSqlExecutor, submission: CampaignAuditSubmission) {
    this.submissions.push(submission);
    return 'recorded' as const;
  }

  async recordCampaign(submission: CampaignAuditSubmission) {
    this.submissions.push(submission);
    return 'recorded' as const;
  }
}

export function fixtureContext() {
  const registry = new ResourcePolicyRegistry({ requireVisibilityAdapters: true });
  const notes = new MemoryNoteAdapter(NOTE);
  const secrets = new MemoryNoteAdapter(SECRET);
  registry.register(notePolicy(NOTE, false), notes);
  registry.register(notePolicy(SECRET, true), secrets);
  const members = new Members([
    [CAMPAIGN, GM, 'gm'],
    [CAMPAIGN, CASEY, 'player'],
    [CAMPAIGN, ROWAN, 'player'],
    [CAMPAIGN, OBSERVER, 'observer'],
    [OTHER_CAMPAIGN, STRANGER, 'gm'],
  ]);
  const audit = new AuditSpy();
  const denials: [string, ContentDenialReason][] = [];
  const visibility = new VisibilityService({
    registry,
    actors: members,
    audit,
    now: () => NOW,
  });
  const access = new ContentAccess({
    registry,
    actors: members,
    onDenied: (resourceClass, reason) => denials.push([resourceClass, reason]),
  });
  return { registry, notes, secrets, members, audit, denials, visibility, access };
}

export type FixtureContext = ReturnType<typeof fixtureContext>;

/** App with authentication, the generic visibility route and sanctioned inventory installed. */
export function fixtureApp(context: FixtureContext = fixtureContext()) {
  const app = buildApp();
  const byCredential = new Map(
    Object.entries(CREDENTIALS).map(([userId, value]) => [value, userId]),
  );
  registerIdentityAuthentication(app, {
    authenticate: async (credential) => {
      const userId = byCredential.get(credential);
      return userId === undefined
        ? undefined
        : { userId, sessionId: '00000000-0000-4000-8000-000000000999' };
    },
  });
  context.access.install(app);
  registerVisibilityRoutes(
    app,
    { access: context.access, visibility: context.visibility },
    { allowedOrigin: ORIGIN },
  );
  return { app, ...context };
}

const NoteParams = Type.Object(
  { campaignId: inline(Id), resourceId: inline(Id) },
  { additionalProperties: false },
);
const CollectionParams = Type.Object({ campaignId: inline(Id) }, { additionalProperties: false });
const PageQuery = Type.Object(
  {
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

/**
 * Fixture owner routes written the way a content owner will write them: the sanctioned
 * pre-handler, then a thin handler. `unfiltered` registers a collection route that forgets to
 * filter, to prove the tripwire.
 */
export function registerFixtureContentRoutes(
  instance: FastifyInstance,
  context: FixtureContext,
  options: { readonly unfiltered?: boolean } = {},
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  for (const [resourceClass, adapter] of [
    [NOTE, context.notes],
    [SECRET, context.secrets],
  ] as const) {
    app.get(
      `/campaigns/:campaignId/resources/${resourceClass}/:resourceId`,
      {
        preHandler: context.access.requireResource({ capability: 'read', resourceClass }),
        schema: { params: NoteParams },
      },
      async (request, reply) => {
        const facts = request.contentAccess?.facts;
        const row = facts === undefined ? undefined : adapter.rows.get(facts.resourceId);
        if (facts === undefined || row === undefined) return sendSafeDenial(reply);
        return reply.status(200).send({ id: row.id, title: row.title, version: facts.version });
      },
    );
    app.get(
      `/campaigns/:campaignId/resources/${resourceClass}`,
      {
        preHandler: context.access.requireCollection({ capability: 'read', resourceClass }),
        schema: { params: CollectionParams, querystring: PageQuery },
      },
      async (request, reply) => {
        const scoped = request.contentAccess;
        if (scoped === undefined) return sendSafeDenial(reply);
        const rows = [...adapter.rows.values()]
          .filter((row) => row.campaignId === request.params.campaignId && !row.deleted)
          .sort((left, right) => left.id.localeCompare(right.id));
        if (options.unfiltered === true) {
          return reply.status(200).send({ items: rows.map((row) => row.id), total: rows.length });
        }
        const page = scoped.page(rows, (row) => adapter.factsOf(row), {
          offset: request.query.offset ?? 0,
          limit: request.query.limit ?? 50,
        });
        return reply.status(200).send({
          items: page.items.map((row) => ({ id: row.id, title: row.title })),
          total: page.total,
        });
      },
    );
  }
}
