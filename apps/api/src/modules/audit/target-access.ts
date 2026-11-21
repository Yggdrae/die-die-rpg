import {
  type AuditReadAuthorizer,
  type CampaignAuditStoreName,
  isValidVisibilitySnapshot,
} from '@rpg/audit';
import {
  AuthorizationService,
  type ResourceFacts,
  type ResourcePolicyRegistry,
} from '@rpg/authorization';
import { type ActorRef, GM_ONLY } from '@rpg/contracts';
import type { ResourceFactsSource } from '../authorization/content-access.ts';

/**
 * Feature 06 read authorization over feature 04 (task 03).
 *
 * An event is readable only when the target class is declared, the target's current facts load
 * from its registered source, and `AuthorizationService.decide(actor, 'read', ...)` allows:
 *
 * 1. the current facts (current Visibility and the class's Ownership Rule);
 * 2. the stored snapshot, applied to the same record (the event's own narrowing, for example a
 *    visibility change recorded as GM-only);
 * 3. for the GM-private store, the current facts narrowed to GM-only.
 *
 * Anything else, including an undeclared class, a missing record, a source that has no answer,
 * or a malformed snapshot, is hidden. The snapshot never widens the current rule, and a `gm_only`
 * snapshot never overrides an author-private Ownership Rule, because the rule comes from the
 * class declaration and is checked on every decision.
 */
export class AuditTargetAccess {
  readonly #authorization: AuthorizationService;
  readonly #registry: Pick<ResourcePolicyRegistry, 'get' | 'adapterFor'>;
  readonly #sources = new Map<string, ResourceFactsSource>();

  constructor(deps: {
    readonly registry: ResourcePolicyRegistry;
    /** Facts sources for classes without a Visibility adapter (same as `ContentAccess`). */
    readonly sources?: readonly ResourceFactsSource[];
  }) {
    this.#authorization = new AuthorizationService(deps.registry);
    this.#registry = deps.registry;
    for (const source of deps.sources ?? []) this.#sources.set(source.resourceClass, source);
  }

  /** One authorizer per request: facts load once per target and are never shared across Actors. */
  readerFor(actor: ActorRef, store: CampaignAuditStoreName): AuditReadAuthorizer {
    const facts = new Map<string, Promise<ResourceFacts | undefined>>();
    const load = (resourceClass: string, resourceId: string) => {
      const key = `${resourceClass}\u0000${resourceId}`;
      let pending = facts.get(key);
      if (pending === undefined) {
        const source = this.#sources.get(resourceClass) ?? this.#registry.adapterFor(resourceClass);
        pending =
          source === undefined
            ? Promise.resolve(undefined)
            : source.loadFacts(actor.campaignId, resourceId);
        facts.set(key, pending);
      }
      return pending;
    };
    const allows = (candidate: ResourceFacts) =>
      this.#authorization.decide(actor, 'read', candidate).allowed;

    return {
      permits: async ({ targetType, targetId, snapshot }) => {
        if (this.#registry.get(targetType) === undefined) return false;
        if (!isValidVisibilitySnapshot(snapshot)) return false;
        const current = await load(targetType, targetId);
        if (
          current === undefined ||
          current.campaignId !== actor.campaignId ||
          current.resourceClass !== targetType ||
          current.resourceId !== targetId
        ) {
          return false;
        }
        if (!allows(current)) return false;
        const recorded: ResourceFacts = {
          ...current,
          visibility: snapshot.visibility,
          ...(snapshot.authorUserId === undefined ? {} : { authorUserId: snapshot.authorUserId }),
        };
        if (!allows(recorded)) return false;
        return store === 'campaign' || allows({ ...current, visibility: GM_ONLY });
      },
    };
  }
}
