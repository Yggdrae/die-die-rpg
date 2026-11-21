import type { MembershipPage } from '@rpg/identity';
import { apiRequestAllPages } from '../../api.ts';
import {
  type MemberLike,
  outcomeOf,
  type VisibilityOutcome,
  type VisibilityRequestBody,
} from './visibility-model.ts';

export interface VisibilityTarget {
  readonly campaignId: string;
  readonly resourceClass: string;
  readonly resourceId: string;
}

export function visibilityUrl(target: VisibilityTarget): string {
  return `/campaigns/${encodeURIComponent(target.campaignId)}/resources/${encodeURIComponent(target.resourceClass)}/${encodeURIComponent(target.resourceId)}/visibility`;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Sends one change. The Actor is the session; the body names no role or user. */
export async function submitVisibilityChange(
  target: VisibilityTarget,
  body: VisibilityRequestBody,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<VisibilityOutcome> {
  try {
    const response = await fetchImpl(visibilityUrl(target), {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    return outcomeOf(response.status, parsed);
  } catch {
    return { kind: 'failed' };
  }
}

/** The sanctioned members read: current memberships only (identity `GET /campaigns/:id/members`). */
export async function loadCurrentMembers(campaignId: string): Promise<readonly MemberLike[]> {
  return apiRequestAllPages<MembershipPage['items'][number]>(
    `/campaigns/${encodeURIComponent(campaignId)}/members`,
  );
}
