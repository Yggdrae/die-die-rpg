import {
  AuthorizationService,
  type Capability,
  type Decision,
  type DecisionReason,
  type ResourceFacts,
  type ResourcePolicyRegistry,
  type VisibilityActorResolver,
} from '@rpg/authorization';
import { type ActorRef, type ApiError, apiError, check, ErrorCode, Id } from '@rpg/contracts';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import { ContentRouteInventory, registerSanctionedHandler } from './inventory.ts';

/**
 * The sanctioned decision helper for content routes (feature 04 techspec, API).
 *
 * A content route resolves the Actor server-side from the authenticated session, asks
 * `AuthorizationService.decide` for one decision per record, and answers every denial with the
 * same public response as a miss. Nothing here reads a role from the request.
 */

/** Public body for every denial where existence matters. Byte-identical to the 404 handler. */
export function safeDenialBody(): ApiError {
  return apiError(ErrorCode.NOT_FOUND_OR_FORBIDDEN, 'Not found.');
}

export function sendSafeDenial(reply: FastifyReply): FastifyReply {
  return reply.status(404).send(safeDenialBody());
}

/** Stable internal reasons for aggregated metrics. Never sent to a client. */
export type ContentDenialReason =
  | 'invalid_input'
  | 'actor_not_member'
  | 'unknown_resource_class'
  | 'not_found'
  | Exclude<DecisionReason, 'allowed_by_policy'>;

export type ContentOutcome =
  | { readonly allowed: true; readonly actor: ActorRef; readonly facts: ResourceFacts }
  | { readonly allowed: false; readonly reason: ContentDenialReason };

/** Owner-supplied read of one record's facts. `VisibilityAdapter` satisfies it. */
export interface ResourceFactsSource {
  readonly resourceClass: string;
  loadFacts(campaignId: string, resourceId: string): Promise<ResourceFacts | undefined>;
}

export interface ContentAccessDependencies {
  readonly registry: ResourcePolicyRegistry;
  /** Identity's `ActorResolver` (the only sanctioned membership read). */
  readonly actors: VisibilityActorResolver;
  /** Extra facts sources (for classes that do not register a Visibility adapter). */
  readonly sources?: readonly ResourceFactsSource[];
  /** Aggregated by class and reason only; the actor is never passed. */
  readonly onDenied?: (resourceClass: string, reason: ContentDenialReason) => void;
  /** Route prefixes whose routes must carry the sanctioned helper. */
  readonly contentPrefixes?: readonly string[];
}

export const DEFAULT_CONTENT_PREFIXES: readonly string[] = ['/campaigns/:campaignId/resources/'];

export interface ResourceRouteOptions {
  readonly capability: Capability;
  /** Fixed class, or a function reading it from the request path. */
  readonly resourceClass: string | ((request: FastifyRequest) => string);
  /** Defaults to `request.params.campaignId`. */
  readonly campaignId?: (request: FastifyRequest) => unknown;
  /** Defaults to `request.params.resourceId`. */
  readonly resourceId?: (request: FastifyRequest) => unknown;
  /** Owner-specific loader. Defaults to the registered Visibility adapter or facts source. */
  readonly load?: (
    request: FastifyRequest,
    ids: { readonly campaignId: string; readonly resourceId: string },
  ) => Promise<ResourceFacts | undefined>;
}

export interface CollectionRouteOptions {
  readonly capability: Capability;
  readonly resourceClass: string;
  readonly campaignId?: (request: FastifyRequest) => unknown;
}

export interface PageRequest {
  readonly offset: number;
  readonly limit: number;
}

export interface PermittedPage<T> {
  readonly items: T[];
  /** Counted over the permitted set only. */
  readonly total: number;
}

/**
 * What a handler receives on `request.contentAccess`. Collection handlers must filter through it:
 * a 2xx response from a collection route that never consulted it is replaced with a 500 before
 * serialization.
 */
export interface RequestContentAccess {
  readonly actor: ActorRef;
  readonly resourceClass: string;
  readonly capability: Capability;
  /** Facts the pre-handler decided on (single-record routes only). */
  readonly facts: ResourceFacts | undefined;
  readonly consulted: boolean;
  decide(facts: ResourceFacts, capability?: Capability): Decision;
  /** Keeps only records the Actor may use. Order preserved. */
  filter<T>(items: Iterable<T>, factsOf: (item: T) => ResourceFacts, capability?: Capability): T[];
  /** Filters first, then pages, so totals and page boundaries come from the permitted set. */
  page<T>(
    items: Iterable<T>,
    factsOf: (item: T) => ResourceFacts,
    page: PageRequest,
    capability?: Capability,
  ): PermittedPage<T>;
}

declare module 'fastify' {
  interface FastifyRequest {
    contentAccess: RequestContentAccess | undefined;
  }
}

export class ContentAccess {
  readonly inventory: ContentRouteInventory;
  readonly #authorization: AuthorizationService;
  readonly #deps: ContentAccessDependencies;
  readonly #sources = new Map<string, ResourceFactsSource>();

  constructor(deps: ContentAccessDependencies) {
    this.#deps = deps;
    this.#authorization = new AuthorizationService(deps.registry);
    this.inventory = new ContentRouteInventory(deps.contentPrefixes ?? DEFAULT_CONTENT_PREFIXES);
    for (const source of deps.sources ?? []) this.#sources.set(source.resourceClass, source);
  }

  /** Current membership of the authenticated user, or `undefined`. */
  async resolveActor(userId: string, campaignId: string): Promise<ActorRef | undefined> {
    if (!check(Id, userId) || !check(Id, campaignId)) return undefined;
    const resolved = await this.#deps.actors.resolve(userId, campaignId);
    return resolved.ok ? resolved.value : undefined;
  }

  /**
   * One decision for one record, for code outside a request: delegating owners (an attachment
   * asks for its parent's decision) and application services repeating the check. The facts
   * come from the class's registered source, never from the caller.
   */
  async authorizeResource(
    userId: string,
    input: {
      readonly campaignId: string;
      readonly resourceClass: string;
      readonly resourceId: string;
      readonly capability: Capability;
      readonly load?: ResourceRouteOptions['load'];
    },
    request?: FastifyRequest,
  ): Promise<ContentOutcome> {
    const { campaignId, resourceClass, resourceId, capability } = input;
    if (!check(Id, campaignId) || !check(Id, resourceId) || !check(Id, userId)) {
      return this.#deny(resourceClass, 'invalid_input');
    }
    const actor = await this.resolveActor(userId, campaignId);
    if (actor === undefined) return this.#deny(resourceClass, 'actor_not_member');
    if (this.#deps.registry.get(resourceClass) === undefined) {
      return this.#deny(resourceClass, 'unknown_resource_class');
    }
    let facts: ResourceFacts | undefined;
    if (input.load !== undefined && request !== undefined) {
      facts = await input.load(request, { campaignId, resourceId });
    } else {
      const source = this.#sourceFor(resourceClass);
      if (source === undefined) return this.#deny(resourceClass, 'unknown_resource_class');
      facts = await source.loadFacts(campaignId, resourceId);
    }
    if (
      facts === undefined ||
      facts.campaignId !== campaignId ||
      facts.resourceId !== resourceId ||
      facts.resourceClass !== resourceClass
    ) {
      return this.#deny(resourceClass, 'not_found');
    }
    const decision = this.#decide(actor, capability, facts);
    return decision.allowed
      ? { allowed: true, actor, facts }
      : this.#deny(resourceClass, decision.reason);
  }

  /** Pre-handler for single-record routes: read, update, delete, reveal, export. */
  requireResource(options: ResourceRouteOptions) {
    const resourceClassOf =
      typeof options.resourceClass === 'function'
        ? options.resourceClass
        : (_request: FastifyRequest) => options.resourceClass as string;
    const run = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
      const user = request.authenticatedUser;
      if (user === undefined) return respond(reply, sendUnauthenticated);
      const params = (request.params ?? {}) as Record<string, unknown>;
      const resourceClass = String(resourceClassOf(request));
      const campaignId = (options.campaignId ?? (() => params.campaignId))(request);
      const resourceId = (options.resourceId ?? (() => params.resourceId))(request);
      if (typeof campaignId !== 'string' || typeof resourceId !== 'string') {
        this.#deps.onDenied?.(resourceClass, 'invalid_input');
        return respond(reply, sendSafeDenial);
      }
      const outcome = await this.authorizeResource(
        user.userId,
        {
          campaignId,
          resourceClass,
          resourceId,
          capability: options.capability,
          load: options.load,
        },
        request,
      );
      if (!outcome.allowed) return respond(reply, sendSafeDenial);
      request.contentAccess = new ScopedContentAccess(
        this.#authorization,
        outcome.actor,
        resourceClass,
        options.capability,
        outcome.facts,
        (reason) => this.#deps.onDenied?.(resourceClass, reason),
        true,
      );
      return true;
    };
    const meta = {
      kind: 'resource' as const,
      resourceClass: typeof options.resourceClass === 'string' ? options.resourceClass : '*',
      capability: options.capability,
    };
    return registerSanctionedHandler(callbackHook(run), meta);
  }

  /**
   * Pre-handler for list, count and create routes. It resolves the Actor and nothing else; the
   * handler must filter through `request.contentAccess`.
   */
  requireCollection(options: CollectionRouteOptions) {
    const run = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
      const user = request.authenticatedUser;
      if (user === undefined) return respond(reply, sendUnauthenticated);
      const params = (request.params ?? {}) as Record<string, unknown>;
      const campaignId = (options.campaignId ?? (() => params.campaignId))(request);
      const deny = (reason: ContentDenialReason) => {
        this.#deps.onDenied?.(options.resourceClass, reason);
        return respond(reply, sendSafeDenial);
      };
      if (typeof campaignId !== 'string') return deny('invalid_input');
      const actor = await this.resolveActor(user.userId, campaignId);
      if (actor === undefined) return deny('actor_not_member');
      if (this.#deps.registry.get(options.resourceClass) === undefined) {
        return deny('unknown_resource_class');
      }
      request.contentAccess = new ScopedContentAccess(
        this.#authorization,
        actor,
        options.resourceClass,
        options.capability,
        undefined,
        (reason) => this.#deps.onDenied?.(options.resourceClass, reason),
        false,
      );
      return true;
    };
    return registerSanctionedHandler(callbackHook(run), {
      kind: 'collection',
      resourceClass: options.resourceClass,
      capability: options.capability,
    });
  }

  /** Decorates the request and starts route inventory. Call before registering routes. */
  install(app: FastifyInstance): void {
    app.decorateRequest('contentAccess', undefined);
    this.inventory.attach(app);
  }

  #sourceFor(resourceClass: string): ResourceFactsSource | undefined {
    return this.#sources.get(resourceClass) ?? this.#deps.registry.adapterFor(resourceClass);
  }

  #decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): Decision {
    return this.#authorization.decide(actor, capability, facts);
  }

  #deny(resourceClass: string, reason: ContentDenialReason): ContentOutcome {
    this.#deps.onDenied?.(resourceClass, reason);
    return { allowed: false, reason };
  }
}

class ScopedContentAccess implements RequestContentAccess {
  #consulted: boolean;

  constructor(
    private readonly authorization: AuthorizationService,
    readonly actor: ActorRef,
    readonly resourceClass: string,
    readonly capability: Capability,
    readonly facts: ResourceFacts | undefined,
    private readonly onDenied: (reason: ContentDenialReason) => void,
    consulted: boolean,
  ) {
    this.#consulted = consulted;
  }

  get consulted(): boolean {
    return this.#consulted;
  }

  decide(facts: ResourceFacts, capability: Capability = this.capability): Decision {
    this.#consulted = true;
    const decision = this.#evaluate(facts, capability);
    if (!decision.allowed) this.onDenied(decision.reason);
    return decision;
  }

  filter<T>(
    items: Iterable<T>,
    factsOf: (item: T) => ResourceFacts,
    capability: Capability = this.capability,
  ): T[] {
    this.#consulted = true;
    // Hidden rows in a list are not denials; nothing is reported per row.
    const permitted: T[] = [];
    for (const item of items) {
      if (this.#evaluate(factsOf(item), capability).allowed) permitted.push(item);
    }
    return permitted;
  }

  #evaluate(facts: ResourceFacts, capability: Capability): Decision {
    // Facts of another class never ride on this route's declaration.
    return facts.resourceClass === this.resourceClass
      ? this.authorization.decide(this.actor, capability, facts)
      : { allowed: false, reason: 'unknown_resource_class' };
  }

  page<T>(
    items: Iterable<T>,
    factsOf: (item: T) => ResourceFacts,
    page: PageRequest,
    capability: Capability = this.capability,
  ): PermittedPage<T> {
    const permitted = this.filter(items, factsOf, capability);
    const offset = Math.max(0, Math.trunc(page.offset));
    const limit = Math.max(0, Math.trunc(page.limit));
    return { items: permitted.slice(offset, offset + limit), total: permitted.length };
  }
}

function sendUnauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send(apiError(ErrorCode.UNAUTHENTICATED, 'Authentication required.'));
}

/** Sends the response and stops the route chain (returns `false`). */
function respond(reply: FastifyReply, send: (reply: FastifyReply) => FastifyReply): false {
  send(reply);
  return false;
}

/**
 * Callback-style hook, as `requireSameOrigin` and `requireAuthenticatedUser` are. An async hook
 * that returns the sent reply double-sends under Bun's HTTP shim, so the chain continues only
 * through `done`.
 */
function callbackHook(run: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>) {
  return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    run(request, reply).then(
      (proceed) => {
        if (proceed) done();
      },
      (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
    );
  };
}
