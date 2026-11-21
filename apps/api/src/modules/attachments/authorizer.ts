import type { AttachmentAuthorizer } from '@rpg/attachments';
import type { AuthorizationService } from '@rpg/authorization';
import type { ContentAccess } from '../authorization/content-access.ts';

/**
 * Feature 05 over feature 04: the owning record's decision always comes from
 * `ContentAccess.authorizeResource`, which resolves the Actor from identity and reloads the
 * owner's facts from its registered source (never from the caller). The attachment's own
 * Visibility narrows that decision through the same `AuthorizationService`.
 */
export function contentAccessAttachmentAuthorizer(
  access: ContentAccess,
  authorization: AuthorizationService,
): AttachmentAuthorizer {
  return {
    authorizeOwner: async (userId, input) => {
      const outcome = await access.authorizeResource(userId, input);
      return outcome.allowed
        ? { allowed: true, actor: outcome.actor, facts: outcome.facts }
        : { allowed: false };
    },
    decide: (actor, capability, facts) => authorization.decide(actor, capability, facts).allowed,
  };
}
