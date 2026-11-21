import { GM_ROLES, type Role } from '@rpg/contracts';
import type { LocalAuditEntry, LocalAuditLog } from '@rpg/sync';

/**
 * Feature 06 task 05: pure view model of the campaign/session audit log.
 *
 * Online, entries come from the authorized API (task 03), which already decided visibility,
 * totals, and cursors, and rendered every description. The device adds its own unaccepted events
 * (pending, conflicted, rejected) above them, labeled, because they are not authority history yet.
 * Offline, the local replica (task 04) is the source; it may be partial, so no total is claimed.
 */

export type AuditStore = 'campaign' | 'private';

/** One API entry (`AuditEntryResponse`): no raw before/after values, no sequence. */
export interface AuditEntryView {
  readonly id: string;
  readonly sessionId: string | null;
  readonly actor: { readonly userId: string; readonly role: string };
  readonly action: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly acceptedAt: string;
  readonly description: { readonly kind: 'registered' | 'generic'; readonly text: string };
}

export interface AuditPageView {
  readonly items: readonly AuditEntryView[];
  readonly total: number;
  readonly nextCursor?: string;
}

export interface AuditFilters {
  readonly actorId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
}

export interface MemberName {
  readonly id: string;
  readonly username: string;
}

export type AuditItemState = 'accepted' | 'pending' | 'conflicted' | 'rejected';

export interface AuditItem {
  readonly id: string;
  readonly state: AuditItemState;
  /** `authority` (accepted, from the API or the replica) or `device` (not accepted yet). */
  readonly source: 'authority' | 'device';
  readonly actor: string;
  readonly at: string;
  readonly text: string;
}

export interface AuditViewModel {
  readonly items: readonly AuditItem[];
  /** Only an authority count of permitted events, never a local count. */
  readonly totalLabel?: string;
  readonly partial: boolean;
  readonly pendingCount: number;
}

/** UI hint only: the server decides (the private route answers 404 to everyone else). */
export function canViewPrivate(role: string | undefined): boolean {
  return role !== undefined && GM_ROLES.includes(role as Role);
}

const SAFE_TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * Text for an entry that did not come through the API renderer (device or offline replica). The
 * browser has no contributor renderers, so it never shows raw values: the same generic
 * description the server uses for an unregistered event.
 */
export function localDescription(entry: Pick<LocalAuditEntry, 'action' | 'target'>): string {
  return SAFE_TOKEN.test(entry.action) && SAFE_TOKEN.test(entry.target.type)
    ? `Recorded ${entry.action} on ${entry.target.type}.`
    : 'Recorded a change.';
}

export function actorName(members: readonly MemberName[], userId: string): string {
  return members.find((member) => member.id === userId)?.username ?? 'Former or unknown member';
}

export function stateLabel(state: AuditItemState): string | undefined {
  switch (state) {
    case 'pending':
      return 'Pending — not yet accepted';
    case 'conflicted':
      return 'Conflict — not accepted';
    case 'rejected':
      return 'Rejected — not part of history';
    case 'accepted':
      return undefined;
  }
}

function localItem(entry: LocalAuditEntry, members: readonly MemberName[]): AuditItem {
  return {
    id: entry.id,
    state: entry.state,
    source: entry.state === 'accepted' ? 'authority' : 'device',
    actor: actorName(members, entry.actor.userId),
    at: entry.at,
    text: localDescription(entry),
  };
}

function matches(entry: LocalAuditEntry, filters: AuditFilters): boolean {
  return (
    (filters.actorId === undefined || entry.actor.userId === filters.actorId) &&
    (filters.targetType === undefined || entry.target.type === filters.targetType) &&
    (filters.targetId === undefined || entry.target.id === filters.targetId)
  );
}

/** Online: device-only entries above the API pages (which are already newest first). */
export function onlineView(input: {
  readonly pages: readonly AuditPageView[];
  readonly local?: LocalAuditLog;
  readonly members: readonly MemberName[];
  readonly filters?: AuditFilters;
}): AuditViewModel {
  const filters = input.filters ?? {};
  const seen = new Set<string>();
  const accepted = input.pages.flatMap((page) => page.items);
  for (const item of accepted) seen.add(item.id);
  const device = (input.local?.entries ?? [])
    .filter((entry) => entry.state !== 'accepted' && !seen.has(entry.id) && matches(entry, filters))
    .map((entry) => localItem(entry, input.members));
  const total = input.pages[0]?.total;
  return {
    items: [
      ...device,
      ...accepted.map((item) => ({
        id: item.id,
        state: 'accepted' as const,
        source: 'authority' as const,
        actor: actorName(input.members, item.actor.userId),
        at: item.acceptedAt,
        text: item.description.text,
      })),
    ],
    ...(total === undefined ? {} : { totalLabel: `${total} ${total === 1 ? 'event' : 'events'}` }),
    partial: false,
    pendingCount: device.filter((item) => item.state === 'pending').length,
  };
}

/** Offline: the replica's merged log (pending above accepted); totals are not claimed. */
export function offlineView(input: {
  readonly local: LocalAuditLog;
  readonly members: readonly MemberName[];
}): AuditViewModel {
  return {
    items: input.local.entries.map((entry) => localItem(entry, input.members)),
    partial: input.local.partial,
    pendingCount: input.local.pendingCount,
  };
}

/** Query string of one API request; only narrowing filters and the cursor. */
export function auditPath(input: {
  readonly campaignId: string;
  readonly store: AuditStore;
  readonly sessionId?: string;
  readonly filters?: AuditFilters;
  readonly cursor?: string;
  readonly limit?: number;
}): string {
  const base =
    input.sessionId !== undefined && input.store === 'campaign'
      ? `/campaigns/${encodeURIComponent(input.campaignId)}/sessions/${encodeURIComponent(input.sessionId)}/audit`
      : `/campaigns/${encodeURIComponent(input.campaignId)}/audit${input.store === 'private' ? '/private' : ''}`;
  const query = new URLSearchParams();
  if (input.store === 'private' && input.sessionId !== undefined) {
    query.set('sessionId', input.sessionId);
  }
  const filters = input.filters ?? {};
  if (filters.actorId !== undefined) query.set('actorId', filters.actorId);
  if (filters.targetType !== undefined) query.set('targetType', filters.targetType);
  if (filters.targetId !== undefined) query.set('targetId', filters.targetId);
  if (input.cursor !== undefined) query.set('cursor', input.cursor);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  const text = query.toString();
  return text === '' ? base : `${base}?${text}`;
}
