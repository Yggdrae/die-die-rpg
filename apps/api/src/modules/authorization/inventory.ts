import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';

/**
 * Runtime inventory of content routes (feature 04 task 04). Static analysis cannot prove every
 * path, so this is the primary proof: every route that matches a content prefix, or declares
 * `config.contentRoute`, must carry a pre-handler minted by `ContentAccess`. A route that does not
 * makes the application fail `ready()` and therefore fail to start. Task 07 adds the static rule.
 */

export interface SanctionedRouteMeta {
  readonly kind: 'resource' | 'collection';
  /** `*` when the class is read from the path. */
  readonly resourceClass: string;
  readonly capability: string;
}

/** Module-private, so only `ContentAccess` can mint a sanctioned pre-handler. */
const SANCTIONED = new WeakMap<object, SanctionedRouteMeta>();

export function registerSanctionedHandler<T extends object>(
  handler: T,
  meta: SanctionedRouteMeta,
): T {
  SANCTIONED.set(handler, meta);
  return handler;
}

export interface RouteInventoryEntry {
  readonly method: string;
  readonly url: string;
  /** Matches a content prefix, declares `config.contentRoute`, or carries a sanctioned helper. */
  readonly content: boolean;
  readonly sanctioned: SanctionedRouteMeta | undefined;
}

export interface InventoryViolation {
  readonly method: string;
  readonly url: string;
  readonly reason: 'content_route_without_sanctioned_helper';
}

export class UnsanctionedContentRouteError extends Error {
  constructor(readonly violations: readonly InventoryViolation[]) {
    super(
      `unsanctioned_content_routes: ${violations
        .map((violation) => `${violation.method} ${violation.url}`)
        .join(', ')}`,
    );
    this.name = 'UnsanctionedContentRouteError';
  }
}

export class UnfilteredContentResponseError extends Error {
  constructor() {
    super('content_route_response_not_filtered');
    this.name = 'UnfilteredContentResponseError';
  }
}

export class ContentRouteInventory {
  readonly #entries: RouteInventoryEntry[] = [];

  constructor(private readonly contentPrefixes: readonly string[]) {}

  /** Every route observed after `attach`, content or not. */
  routes(): readonly RouteInventoryEntry[] {
    return [...this.#entries];
  }

  /** Content routes that carry a sanctioned helper. */
  guarded(): readonly RouteInventoryEntry[] {
    return this.#entries.filter((entry) => entry.content && entry.sanctioned !== undefined);
  }

  violations(): readonly InventoryViolation[] {
    return this.#entries
      .filter((entry) => entry.content && entry.sanctioned === undefined)
      .map((entry) => ({
        method: entry.method,
        url: entry.url,
        reason: 'content_route_without_sanctioned_helper' as const,
      }));
  }

  assertComplete(): void {
    const violations = this.violations();
    if (violations.length > 0) throw new UnsanctionedContentRouteError(violations);
  }

  /** Observes routes registered afterwards; asserts completeness when the app becomes ready. */
  attach(app: FastifyInstance): void {
    app.addHook('onRoute', (route) => this.#observe(route));
    app.addHook('onReady', async () => this.assertComplete());
  }

  #observe(route: RouteOptions): void {
    const handlers = asHandlerList((route as { preHandler?: unknown }).preHandler);
    const sanctioned = handlers
      .map((handler) => SANCTIONED.get(handler))
      .find((meta) => meta !== undefined);
    const config = (route.config ?? {}) as { contentRoute?: unknown };
    const content =
      sanctioned !== undefined ||
      config.contentRoute === true ||
      this.contentPrefixes.some((prefix) => route.url.startsWith(prefix));
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      this.#entries.push({ method, url: route.url, content, sanctioned });
    }
    if (sanctioned?.kind === 'collection') {
      // Before serialization: a collection handler that skipped the Actor-scoped filter must not
      // be able to send its rows.
      const hooks = asHandlerList((route as { preSerialization?: unknown }).preSerialization);
      (route as { preSerialization?: unknown }).preSerialization = [...hooks, requireFiltered];
    }
  }
}

async function requireFiltered(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  if (reply.statusCode < 300 && request.contentAccess?.consulted !== true) {
    throw new UnfilteredContentResponseError();
  }
  return payload;
}

function asHandlerList(value: unknown): object[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is object => typeof item === 'function',
  );
}
