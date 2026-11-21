import type { Visibility } from '@rpg/contracts';

/**
 * Pure model for the generic Visibility controls (feature 04 task 06).
 *
 * Everything here is a UI hint. The server resolves the Actor and decides every change
 * (`PATCH /campaigns/:campaignId/resources/:class/:resourceId/visibility`); hiding or showing a
 * control is never an authorization.
 */

/** Roles that may be offered reveal controls. A hint only: policy is per Resource Class. */
const REVEAL_HINT_ROLES: ReadonlySet<string> = new Set(['owner', 'gm', 'assistant_gm']);

export function mayShowRevealControls(role: string | undefined): boolean {
  return role !== undefined && REVEAL_HINT_ROLES.has(role);
}

/** Subset of identity's `MembershipView` that the picker needs. */
export interface MemberLike {
  readonly user: { readonly id: string; readonly username: string };
  readonly role: string;
}

export interface MemberOption {
  readonly id: string;
  readonly username: string;
}

/**
 * Reveal candidates come only from the current member list. Only players are offered: GM roles
 * already read everything, observers are never an audience, and a removed member is not in the
 * list at all.
 */
export function revealablePlayers(members: readonly MemberLike[]): readonly MemberOption[] {
  const seen = new Set<string>();
  const options: MemberOption[] = [];
  for (const member of members) {
    if (member.role !== 'player' || seen.has(member.user.id)) continue;
    seen.add(member.user.id);
    options.push({ id: member.user.id, username: member.user.username });
  }
  return options.sort((left, right) => left.username.localeCompare(right.username));
}

export function audienceLabel(visibility: Visibility): string {
  switch (visibility.mode) {
    case 'gm_only':
      return 'GM only';
    case 'everyone':
      return 'Everyone in the campaign';
    case 'players':
      return 'Selected players';
    case 'party':
      return 'A party';
  }
}

export interface Recipient {
  readonly id: string;
  readonly label: string;
  /** False when the id is not a current member (for example, a removed member). */
  readonly current: boolean;
}

/** Granted players, named from the current member list; unknown ids stay removable. */
export function recipientsOf(
  visibility: Visibility,
  members: readonly MemberLike[],
): readonly Recipient[] {
  if (visibility.mode !== 'players') return [];
  const names = new Map(members.map((member) => [member.user.id, member.user.username]));
  return visibility.playerIds.map((id) => {
    const username = names.get(id);
    return username === undefined
      ? { id, label: 'Former member', current: false }
      : { id, label: username, current: true };
  });
}

export type VisibilityIntent =
  | { readonly kind: 'reveal_players'; readonly playerIds: readonly string[] }
  | { readonly kind: 'reveal_everyone' }
  | { readonly kind: 'unreveal_players'; readonly playerIds: readonly string[] }
  | { readonly kind: 'hide_everyone' };

/** Request body. It never carries an actor, role, user or campaign field. */
export interface VisibilityRequestBody {
  readonly operation: 'reveal' | 'unreveal';
  readonly target:
    | { readonly mode: 'everyone' }
    | { readonly mode: 'players'; readonly playerIds: readonly string[] };
  readonly expectedVersion: number;
}

export function requestFor(
  intent: VisibilityIntent,
  expectedVersion: number,
): VisibilityRequestBody {
  switch (intent.kind) {
    case 'reveal_players':
      return {
        operation: 'reveal',
        target: { mode: 'players', playerIds: [...new Set(intent.playerIds)] },
        expectedVersion,
      };
    case 'unreveal_players':
      return {
        operation: 'unreveal',
        target: { mode: 'players', playerIds: [...new Set(intent.playerIds)] },
        expectedVersion,
      };
    case 'reveal_everyone':
      return { operation: 'reveal', target: { mode: 'everyone' }, expectedVersion };
    case 'hide_everyone':
      return { operation: 'unreveal', target: { mode: 'everyone' }, expectedVersion };
  }
}

export type VisibilityOutcome =
  | {
      readonly kind: 'applied';
      readonly visibility: Visibility;
      readonly version: number;
      readonly changed: boolean;
    }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'signed_out' }
  | { readonly kind: 'failed' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((entry) => typeof entry === 'string' && UUID.test(entry))
    ? (value as string[])
    : undefined;
}

/** Fail-closed parse of the server's normalized Visibility; anything else is rejected. */
export function parseVisibility(value: unknown): Visibility | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  switch (record.mode) {
    case 'gm_only':
    case 'everyone':
      return { mode: record.mode };
    case 'players': {
      const playerIds = idList(record.playerIds);
      return playerIds === undefined ? undefined : { mode: 'players', playerIds: [...playerIds] };
    }
    case 'party': {
      const partyIds = idList(record.partyIds);
      return partyIds === undefined ? undefined : { mode: 'party', partyIds: [...partyIds] };
    }
    default:
      return undefined;
  }
}

/** Maps an HTTP status and parsed JSON body to an outcome. Unknown shapes fail closed. */
export function outcomeOf(status: number, body: unknown): VisibilityOutcome {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (status === 200) {
    const visibility = parseVisibility(record.visibility);
    if (
      visibility === undefined ||
      typeof record.version !== 'number' ||
      !Number.isInteger(record.version) ||
      typeof record.changed !== 'boolean'
    ) {
      return { kind: 'failed' };
    }
    return { kind: 'applied', visibility, version: record.version, changed: record.changed };
  }
  if (status === 409) return { kind: 'conflict' };
  if (status === 400) {
    const details = record.details as { reason?: unknown } | undefined;
    return { kind: 'rejected', reason: typeof details?.reason === 'string' ? details.reason : '' };
  }
  if (status === 404) return { kind: 'unavailable' };
  if (status === 401 || status === 403) return { kind: 'signed_out' };
  return { kind: 'failed' };
}

export const UNREVEAL_LIMITATION =
  'Hiding removes access from now on, and the record leaves players’ devices on their next sync. Anyone who already saw it keeps what they saw, including any copy or export they made.';

export const PARTY_UNAVAILABLE =
  'This record is shared with a party. Party sharing is not available yet, so its visibility cannot be changed here.';

export type FailureOutcome = Exclude<VisibilityOutcome, { kind: 'applied' } | { kind: 'conflict' }>;

export function outcomeMessage(outcome: FailureOutcome): string {
  switch (outcome.kind) {
    case 'rejected':
      switch (outcome.reason) {
        case 'target_not_member':
          return 'One of the selected people is no longer a member of this campaign. The list was refreshed; choose again.';
        case 'target_mode_not_allowed':
        case 'party_unresolved':
          return 'This kind of sharing is not available for this record.';
        case 'incompatible_visibility':
          return 'That change does not fit how the record is currently shared. Reload and try again.';
        default:
          return 'The change was rejected.';
      }
    case 'unavailable':
      return 'This record is not available, or you cannot change who sees it.';
    case 'signed_out':
      return 'Your session ended or the request was refused. Sign in again.';
    case 'failed':
      return 'The change could not be completed. Nothing was changed on this screen; try again.';
  }
}
