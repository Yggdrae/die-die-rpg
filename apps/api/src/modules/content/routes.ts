import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { ResourceFacts } from '@rpg/authorization';
import {
  CAMPAIGN_ENTITY_CLASS,
  ENTITY_RELATIONSHIP_CLASS,
  EntityReplicaSchema,
  entityFactsOf,
  normalizeTag,
  PERSONAL_NOTE_CLASS,
  type PersonalNoteRecord,
  PersonalNoteReplicaSchema,
  RelationshipReplicaSchema,
} from '@rpg/content';
import {
  type PostgresEntityRepository,
  type PostgresPersonalNoteRepository,
  type PostgresRelationshipRepository,
  relationshipFacts,
} from '@rpg/content/postgres';
import { ApiError, Id, Visibility } from '@rpg/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { type ContentAccess, sendSafeDenial } from '../authorization/content-access.ts';
import { inline } from '../authorization/schemas.ts';
import { requireAuthenticatedUser } from '../identity/authenticate.ts';

/**
 * Feature 16 task 07: read-only content routes (`_techspec.md` "API"). Writes go only through
 * `POST /sync/mutations`. Every route is a guarded content route (`config.contentRoute`, a
 * sanctioned `ContentAccess` helper); lists filter and count through `request.contentAccess.page`,
 * so totals and pages come from the permitted set, and every miss or denial is the safe 404.
 * Nothing here reads a role from the request.
 */

export interface ContentRouteServices {
  readonly access: ContentAccess;
  readonly entities: PostgresEntityRepository;
  readonly notes: PostgresPersonalNoteRepository;
  /** Task 09: enables the relationships route. */
  readonly relationships?: PostgresRelationshipRepository;
}

const CampaignParams = Type.Object({ campaignId: Id }, { additionalProperties: false });
const RecordParams = Type.Object(
  { campaignId: Id, resourceId: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false },
);
const Offset = Type.Integer({ minimum: 0, maximum: 100_000 });
const Limit = Type.Integer({ minimum: 1, maximum: 200 });
const EntityQuery = Type.Object(
  {
    type: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' })),
    tag: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    visibility: Type.Optional(
      Type.Union([Type.Literal('gm_only'), Type.Literal('everyone'), Type.Literal('players')]),
    ),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    offset: Type.Optional(Offset),
    limit: Type.Optional(Limit),
  },
  { additionalProperties: false },
);
const PageQuery = Type.Object(
  { offset: Type.Optional(Offset), limit: Type.Optional(Limit) },
  { additionalProperties: false },
);
const TagQuery = Type.Object(
  { prefix: Type.Optional(Type.String({ maxLength: 64 })) },
  { additionalProperties: false },
);
const Entity = inline(EntityReplicaSchema);
const PersonalNote = inline(PersonalNoteReplicaSchema);
const EntityPage = Type.Object({ items: Type.Array(Entity), total: Type.Integer({ minimum: 0 }) });
const NotePage = Type.Object({
  items: Type.Array(PersonalNote),
  total: Type.Integer({ minimum: 0 }),
});
const TagList = Type.Object({ tags: Type.Array(Type.String()) });
const NotFound = inline(ApiError);

/** Tag suggestions returned per request. */
export const TAG_SUGGESTION_LIMIT = 50;
const DEFAULT_LIMIT = 50;

function noteFactsOf(record: PersonalNoteRecord): ResourceFacts {
  return {
    campaignId: record.campaignId,
    resourceClass: PERSONAL_NOTE_CLASS,
    resourceId: record.id,
    visibility: record.visibility,
    version: record.version,
    authorUserId: record.authorUserId,
  };
}

export function registerContentRoutes(
  instance: FastifyInstance,
  services: ContentRouteServices,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const { access, entities, notes } = services;
  if (services.relationships !== undefined) {
    registerRelationshipRoutes(instance, { ...services, relationships: services.relationships });
  }

  app.get(
    '/campaigns/:campaignId/entities',
    {
      config: { contentRoute: true },
      preHandler: [
        requireAuthenticatedUser,
        access.requireCollection({ capability: 'read', resourceClass: CAMPAIGN_ENTITY_CLASS }),
      ],
      schema: {
        params: CampaignParams,
        querystring: EntityQuery,
        response: { 200: EntityPage, 404: NotFound },
      },
    },
    async (request, reply) => {
      const scoped = request.contentAccess;
      if (scoped === undefined) return sendSafeDenial(reply);
      const query = request.query;
      // Filters only narrow; a Visibility filter is applied before the decision, so a player
      // asking for `gm_only` gets an empty permitted set, never an error that confirms anything.
      const rows = await entities.list(request.params.campaignId, {
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.tag === undefined ? {} : { tag: normalizeTag(query.tag) }),
        ...(query.visibility === undefined ? {} : { visibilityModes: [query.visibility] }),
        ...(query.q === undefined ? {} : { nameFragment: query.q }),
      });
      const page = scoped.page(rows, entityFactsOf, {
        offset: query.offset ?? 0,
        limit: query.limit ?? DEFAULT_LIMIT,
      });
      return reply.status(200).send(page);
    },
  );

  app.get(
    '/campaigns/:campaignId/entities/:resourceId',
    {
      config: { contentRoute: true },
      preHandler: [
        requireAuthenticatedUser,
        access.requireResource({ capability: 'read', resourceClass: CAMPAIGN_ENTITY_CLASS }),
      ],
      schema: { params: RecordParams, response: { 200: Entity, 404: NotFound } },
    },
    async (request, reply) => {
      const facts = request.contentAccess?.facts;
      if (facts === undefined) return sendSafeDenial(reply);
      const record = await entities.get(facts.campaignId, facts.resourceId);
      // Changed between the decision and the read: decide again on what is returned.
      if (record === undefined || !request.contentAccess?.decide(entityFactsOf(record)).allowed) {
        return sendSafeDenial(reply);
      }
      return reply.status(200).send(record);
    },
  );

  app.get(
    '/campaigns/:campaignId/entity-tags',
    {
      config: { contentRoute: true },
      preHandler: [
        requireAuthenticatedUser,
        access.requireCollection({ capability: 'read', resourceClass: CAMPAIGN_ENTITY_CLASS }),
      ],
      schema: {
        params: CampaignParams,
        querystring: TagQuery,
        response: { 200: TagList, 404: NotFound },
      },
    },
    async (request, reply) => {
      const scoped = request.contentAccess;
      if (scoped === undefined) return sendSafeDenial(reply);
      // Suggestions come only from rows the actor may read (BR-009): no tag table, no leak.
      const permitted = scoped.filter(
        await entities.list(request.params.campaignId),
        entityFactsOf,
      );
      const prefix = normalizeTag(request.query.prefix ?? '');
      const tags = new Set<string>();
      for (const record of permitted) {
        for (const tag of record.tags) if (tag.startsWith(prefix)) tags.add(tag);
      }
      return reply.status(200).send({ tags: [...tags].sort().slice(0, TAG_SUGGESTION_LIMIT) });
    },
  );

  app.get(
    '/campaigns/:campaignId/personal-notes',
    {
      config: { contentRoute: true },
      preHandler: [
        requireAuthenticatedUser,
        access.requireCollection({ capability: 'read', resourceClass: PERSONAL_NOTE_CLASS }),
      ],
      schema: {
        params: CampaignParams,
        querystring: PageQuery,
        response: { 200: NotePage, 404: NotFound },
      },
    },
    async (request, reply) => {
      const scoped = request.contentAccess;
      if (scoped === undefined) return sendSafeDenial(reply);
      // Only the requester's own notes are candidates; the decision still applies the rule.
      const rows = await notes.listByAuthor(request.params.campaignId, scoped.actor.userId);
      const page = scoped.page(rows, noteFactsOf, {
        offset: request.query.offset ?? 0,
        limit: request.query.limit ?? DEFAULT_LIMIT,
      });
      return reply.status(200).send(page);
    },
  );

  app.get(
    '/campaigns/:campaignId/personal-notes/:resourceId',
    {
      config: { contentRoute: true },
      preHandler: [
        requireAuthenticatedUser,
        access.requireResource({ capability: 'read', resourceClass: PERSONAL_NOTE_CLASS }),
      ],
      schema: { params: RecordParams, response: { 200: PersonalNote, 404: NotFound } },
    },
    async (request, reply) => {
      const facts = request.contentAccess?.facts;
      if (facts === undefined) return sendSafeDenial(reply);
      const record = await notes.get(facts.campaignId, facts.resourceId);
      if (record === undefined || !request.contentAccess?.decide(noteFactsOf(record)).allowed) {
        return sendSafeDenial(reply);
      }
      return reply.status(200).send(record);
    },
  );
}

/** FR-016 summary of the other endpoint; a tombstoned endpoint is only `{ deleted: true }`. */
const EntitySummary = Type.Object({
  id: Id,
  type: Type.String(),
  name: Type.String(),
  summary: Type.String(),
  visibility: inline(Visibility),
  deleted: Type.Literal(false),
});
// Built before `inline` so TypeBox computes `required` (optional markers are symbols).
const RelationshipView = inline(
  Type.Object({
    ...RelationshipReplicaSchema.properties,
    other: Type.Union([EntitySummary, Type.Object({ deleted: Type.Literal(true) })]),
  }),
);
const RelationshipList = Type.Object({ items: Type.Array(RelationshipView) });

/**
 * Task 09: both directions of an entity's links. The entity needs `read`; each link gets its own
 * `entity_relationship` decision and the other endpoint its own `campaign_entity` decision, both
 * through the sanctioned `authorizeResource` on facts already loaded. A link to a deleted entity
 * shows `{ deleted: true }` to whoever may read the link (BR-004); anything not permitted is
 * omitted, never placeheld.
 */
export function registerRelationshipRoutes(
  instance: FastifyInstance,
  services: ContentRouteServices & { readonly relationships: PostgresRelationshipRepository },
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();
  const { access, entities, relationships } = services;
  app.get(
    '/campaigns/:campaignId/entities/:resourceId/relationships',
    {
      config: { contentRoute: true },
      preHandler: [
        requireAuthenticatedUser,
        access.requireResource({ capability: 'read', resourceClass: CAMPAIGN_ENTITY_CLASS }),
      ],
      schema: { params: RecordParams, response: { 200: RelationshipList, 404: NotFound } },
    },
    async (request, reply) => {
      const user = request.authenticatedUser;
      const facts = request.contentAccess?.facts;
      if (user === undefined || facts === undefined) return sendSafeDenial(reply);
      const { campaignId, resourceId } = facts;
      const permitted = async (resourceClass: string, loaded: ResourceFacts) =>
        (
          await access.authorizeResource(
            user.userId,
            {
              campaignId,
              resourceClass,
              resourceId: loaded.resourceId,
              capability: 'read',
              load: async () => loaded,
            },
            request,
          )
        ).allowed;
      const items = [];
      for (const link of await relationships.listTouching(campaignId, resourceId)) {
        if (!(await permitted(ENTITY_RELATIONSHIP_CLASS, relationshipFacts(link)))) continue;
        const otherId =
          link.sourceEntityId === resourceId ? link.targetEntityId : link.sourceEntityId;
        const other = await entities.get(campaignId, otherId, { includeDeleted: true });
        if (other === undefined) continue;
        if (other.deletedAt !== undefined) {
          items.push({ ...link, other: { deleted: true as const } });
          continue;
        }
        if (!(await permitted(CAMPAIGN_ENTITY_CLASS, entityFactsOf(other)))) continue;
        items.push({
          ...link,
          other: {
            id: other.id,
            type: other.type,
            name: other.name,
            summary: other.summary,
            visibility: other.visibility,
            deleted: false as const,
          },
        });
      }
      return reply.status(200).send({ items });
    },
  );
}
