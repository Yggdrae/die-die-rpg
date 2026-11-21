import type { EntityRecord, EntityVisibilityChange } from '@rpg/content';
import { HANDOUT_ENTITY_TYPE } from '@rpg/content';
import type { MutationState } from '@rpg/sync';
import type { MemberLike } from '../visibility/visibility-model.ts';
import { revealablePlayers } from '../visibility/visibility-model.ts';

/**
 * Feature 17 pure model: which handouts a device holds, who has each one, what a reveal names, and
 * what the GM's queue says about it. A UI hint only: the authority decides every reveal.
 */

/** Handouts on the device, most recently changed first (D-09). */
export function handoutsOf(entities: readonly EntityRecord[]): readonly EntityRecord[] {
  return entities
    .filter((record) => record.type === HANDOUT_ENTITY_TYPE)
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
}

export type HandoutAudience =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'everyone' }
  | { readonly kind: 'players'; readonly names: readonly string[] }
  | { readonly kind: 'party' };

/** Who has it now (D-07): named from the member list; an unknown id is a former member. */
export function audienceOf(record: EntityRecord, members: readonly MemberLike[]): HandoutAudience {
  const visibility = record.visibility;
  if (visibility.mode === 'gm_only') return { kind: 'hidden' };
  if (visibility.mode === 'everyone') return { kind: 'everyone' };
  if (visibility.mode === 'party') return { kind: 'party' };
  const names = new Map(members.map((member) => [member.user.id, member.user.username]));
  return {
    kind: 'players',
    names: visibility.playerIds.map((id) => names.get(id) ?? 'a former member'),
  };
}

export function audienceText(audience: HandoutAudience): string {
  switch (audience.kind) {
    case 'hidden':
      return 'Hidden';
    case 'everyone':
      return 'Revealed to everyone';
    case 'party':
      return 'Revealed to a party';
    case 'players':
      return `Revealed to ${listOf(audience.names)}`;
  }
}

/** "Ana", "Ana and Bruno", "Ana, Bruno, and Caio". */
export function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? 'nobody';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** What the GM chose in the reveal dialog. */
export type RevealChoice =
  | { readonly kind: 'everyone' }
  | { readonly kind: 'players'; readonly playerIds: readonly string[] };

/** Players a reveal may name: current players not already recipients. */
export function revealCandidates(
  record: EntityRecord,
  members: readonly MemberLike[],
): readonly { readonly id: string; readonly username: string }[] {
  const current = new Set(record.visibility.mode === 'players' ? record.visibility.playerIds : []);
  return revealablePlayers(members).filter((player) => !current.has(player.id));
}

/**
 * The confirm button's text (`_bdd.md`: the recipients are explicit before the reveal executes).
 * `undefined` means there is nothing to confirm yet.
 */
export function confirmLabel(
  choice: RevealChoice,
  members: readonly MemberLike[],
): string | undefined {
  if (choice.kind === 'everyone') return 'Reveal to everyone';
  if (choice.playerIds.length === 0) return undefined;
  const names = new Map(members.map((member) => [member.user.id, member.user.username]));
  return `Reveal to ${listOf(choice.playerIds.map((id) => names.get(id) ?? 'a former member'))}`;
}

export function revealChange(choice: RevealChoice): EntityVisibilityChange {
  return choice.kind === 'everyone'
    ? { operation: 'reveal', target: { mode: 'everyone' } }
    : { operation: 'reveal', target: { mode: 'players', playerIds: [...choice.playerIds] } };
}

/** Un-reveal removes every audience (D-02): the handout returns to hidden. */
export const HIDE_CHANGE: EntityVisibilityChange = {
  operation: 'unreveal',
  target: { mode: 'everyone' },
};

export type DeliveryState = 'waiting' | 'sent' | 'refused' | undefined;

/** The GM's queue for this handout (D-03): waiting to send, sent, or refused by the authority. */
export function deliveryOf(state: MutationState | undefined): DeliveryState {
  if (state === 'pending' || state === 'uploading') return 'waiting';
  if (state === 'accepted') return 'sent';
  if (state === 'rejected' || state === 'conflicted') return 'refused';
  return undefined;
}

export function deliveryText(state: DeliveryState): string | undefined {
  switch (state) {
    case 'waiting':
      return 'Waiting to send. Players receive it when this device reconnects.';
    case 'refused':
      return 'The last change was not applied. Nothing new was revealed; review the handout and try again.';
    default:
      return undefined;
  }
}

export const UNREVEAL_NOTE =
  'Hiding stops future access. Anyone who already read this handout keeps what they read.';
