import type { LongTextHold } from '@rpg/sync';

/**
 * Feature 03 long-text hold routes (`/sync/holds/:campaignId/{acquire,takeover,renew,release}`).
 * The hold belongs to this browser session (the server reads the session; nothing here names a
 * user or role). Any network failure is `unavailable`, which the editor treats as offline: typing
 * continues into the device draft (D-17).
 */

export interface HoldField {
  readonly resourceClass: string;
  readonly recordId: string;
  readonly fieldPath: string;
}

export type AcquireOutcome =
  | { readonly kind: 'held'; readonly hold: LongTextHold }
  | { readonly kind: 'busy'; readonly heldBy: string; readonly expiresAt: string }
  | { readonly kind: 'unavailable' };

export type RenewOutcome =
  | { readonly kind: 'held'; readonly hold: LongTextHold }
  | { readonly kind: 'lost' }
  | { readonly kind: 'unavailable' };

export interface HoldApi {
  acquire(campaignId: string, field: HoldField): Promise<AcquireOutcome>;
  takeover(campaignId: string, field: HoldField): Promise<AcquireOutcome>;
  renew(campaignId: string, field: HoldField, version: number): Promise<RenewOutcome>;
  release(campaignId: string, field: HoldField, version: number): Promise<void>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function holdUrl(campaignId: string, action: string): string {
  return `/sync/holds/${encodeURIComponent(campaignId)}/${action}`;
}

function isHold(value: unknown): value is LongTextHold {
  if (typeof value !== 'object' || value === null) return false;
  const hold = value as Record<string, unknown>;
  return (
    typeof hold.version === 'number' &&
    typeof hold.holderSessionId === 'string' &&
    typeof hold.expiresAt === 'string'
  );
}

export function httpHoldApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)): HoldApi {
  const post = (campaignId: string, action: string, body: unknown) =>
    fetchImpl(holdUrl(campaignId, action), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const claim = async (
    campaignId: string,
    action: 'acquire' | 'takeover',
    field: HoldField,
  ): Promise<AcquireOutcome> => {
    try {
      const response = await post(campaignId, action, field);
      if (!response.ok) return { kind: 'unavailable' };
      const body = (await response.json()) as {
        acquired?: boolean;
        hold?: unknown;
        heldBy?: string;
        expiresAt?: string;
      };
      if (body.acquired === true && isHold(body.hold)) return { kind: 'held', hold: body.hold };
      if (body.acquired === false && typeof body.heldBy === 'string') {
        return { kind: 'busy', heldBy: body.heldBy, expiresAt: body.expiresAt ?? '' };
      }
      return { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  };

  return {
    acquire: (campaignId, field) => claim(campaignId, 'acquire', field),
    takeover: (campaignId, field) => claim(campaignId, 'takeover', field),
    async renew(campaignId, field, version) {
      try {
        const response = await post(campaignId, 'renew', { ...field, expectedVersion: version });
        if (response.status === 409 || response.status === 404) return { kind: 'lost' };
        if (!response.ok) return { kind: 'unavailable' };
        const body: unknown = await response.json();
        return isHold(body) ? { kind: 'held', hold: body } : { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    async release(campaignId, field, version) {
      try {
        await post(campaignId, 'release', { ...field, expectedVersion: version });
      } catch {
        // The hold expires on its own (two minutes).
      }
    },
  };
}
