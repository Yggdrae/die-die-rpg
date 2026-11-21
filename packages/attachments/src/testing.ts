import {
  AuthorizationService,
  type Capability,
  type ResourceFacts,
  type ResourcePolicy,
  ResourcePolicyRegistry,
  type VisibilityActorResolver,
} from '@rpg/authorization';
import { type ActorRef, err, ok, type Role, type Visibility } from '@rpg/contracts';
import type { AttachmentAuthorizer, OwnerDecision } from './application.ts';

/**
 * Test-only feature 04 stand-in for package tests: invented owner classes over the real
 * `AuthorizationService` (no production content class exists yet). The API tests use the real
 * `ContentAccess.authorizeResource` instead. Not exported from the package entry point.
 */

export const CAMPAIGN = '00000000-0000-4000-8000-0000000000a1';
export const OTHER_CAMPAIGN = '00000000-0000-4000-8000-0000000000a2';
export const GM = '00000000-0000-4000-8000-0000000000b1';
export const CASEY = '00000000-0000-4000-8000-0000000000c1';
export const ROWAN = '00000000-0000-4000-8000-0000000000d1';
export const OBSERVER = '00000000-0000-4000-8000-0000000000f1';
export const STRANGER = '00000000-0000-4000-8000-0000000000e1';
export const NOTE = 'fixture_note';
export const SECRET = 'fixture_secret';

export function ownerId(index: number): string {
  return `00000000-0000-4000-8000-${(0x1000 + index).toString(16).padStart(12, '0')}`;
}

function policy(resourceClass: string, authorPrivate: boolean): ResourcePolicy {
  return {
    resourceClass,
    capabilities: ['read', 'update'],
    roleCapabilities: {
      owner: ['read', 'update'],
      gm: ['read', 'update'],
      assistant_gm: ['read', 'update'],
      player: authorPrivate ? ['read', 'update'] : ['read'],
      observer: [],
    },
    defaultVisibility: 'explicit',
    ...(authorPrivate
      ? {
          ownership: {
            field: 'authorUserId' as const,
            capabilities: ['read', 'update'] as Capability[],
            exemptRoles: [],
          },
        }
      : {}),
    sync: { kind: 'server_only' },
  };
}

export class FixtureMembers implements VisibilityActorResolver {
  readonly roles = new Map<string, Role>([
    [`${CAMPAIGN}:${GM}`, 'gm'],
    [`${CAMPAIGN}:${CASEY}`, 'player'],
    [`${CAMPAIGN}:${ROWAN}`, 'player'],
    [`${CAMPAIGN}:${OBSERVER}`, 'observer'],
    [`${OTHER_CAMPAIGN}:${STRANGER}`, 'gm'],
  ]);

  async resolve(userId: string, campaignId: string) {
    const role = this.roles.get(`${campaignId}:${userId}`);
    return role === undefined
      ? err('membership_not_found' as const)
      : ok<ActorRef>({ userId, campaignId, role });
  }

  revoke(campaignId: string, userId: string): void {
    this.roles.delete(`${campaignId}:${userId}`);
  }
}

/** Same contract as the API's adapter over `ContentAccess.authorizeResource`. */
export class FixtureAuthorizer implements AttachmentAuthorizer {
  readonly registry = new ResourcePolicyRegistry();
  readonly #authorization: AuthorizationService;
  readonly owners = new Map<string, ResourceFacts>();
  /** Decisions requested, in order (to prove a fresh decision per operation). */
  readonly requests: { readonly capability: Capability; readonly resourceId: string }[] = [];
  unavailable = false;

  constructor(readonly members: FixtureMembers = new FixtureMembers()) {
    this.registry.register(policy(NOTE, false));
    this.registry.register(policy(SECRET, true));
    this.#authorization = new AuthorizationService(this.registry);
  }

  putOwner(
    resourceClass: string,
    resourceId: string,
    visibility: Visibility,
    extra: { campaignId?: string; authorUserId?: string } = {},
  ): void {
    this.owners.set(`${resourceClass}:${resourceId}`, {
      campaignId: extra.campaignId ?? CAMPAIGN,
      resourceClass,
      resourceId,
      visibility,
      version: 1,
      ...(extra.authorUserId === undefined ? {} : { authorUserId: extra.authorUserId }),
    });
  }

  async authorizeOwner(
    userId: string,
    input: {
      readonly campaignId: string;
      readonly resourceClass: string;
      readonly resourceId: string;
      readonly capability: Capability;
    },
  ): Promise<OwnerDecision> {
    this.requests.push({ capability: input.capability, resourceId: input.resourceId });
    if (this.unavailable) throw new Error('authorization_unavailable');
    const actor = await this.members.resolve(userId, input.campaignId);
    if (!actor.ok) return { allowed: false };
    const facts = this.owners.get(`${input.resourceClass}:${input.resourceId}`);
    if (facts === undefined || facts.campaignId !== input.campaignId) return { allowed: false };
    return this.#authorization.decide(actor.value, input.capability, facts).allowed
      ? { allowed: true, actor: actor.value, facts }
      : { allowed: false };
  }

  decide(actor: ActorRef, capability: Capability, facts: ResourceFacts): boolean {
    return this.#authorization.decide(actor, capability, facts).allowed;
  }
}

/** Minimal valid file bodies (signature + padding) and their SHA-256. */
export function fileBytes(mime: string, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  const signatures: Record<string, number[]> = {
    'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
    'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
    'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'image/webp': [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  };
  bytes.set(signatures[mime] ?? []);
  for (let index = 16; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

export function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}
