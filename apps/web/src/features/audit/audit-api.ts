import {
  type AuditFilters,
  type AuditPageView,
  type AuditStore,
  auditPath,
} from './audit-model.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type AuditPageResult =
  | { readonly kind: 'page'; readonly page: AuditPageView }
  /** The cursor's anchor is no longer readable (or never was): restart from the first page. */
  | { readonly kind: 'invalid_cursor' }
  /** Safe 404: not a member, no GM role for the private log, or the campaign is gone. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

/** One page of one store. The Actor is the session; nothing in the request names a role. */
export async function fetchAuditPage(
  input: {
    readonly campaignId: string;
    readonly store: AuditStore;
    readonly sessionId?: string;
    readonly filters?: AuditFilters;
    readonly cursor?: string;
    readonly limit?: number;
  },
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<AuditPageResult> {
  try {
    const response = await fetchImpl(auditPath(input), { credentials: 'include' });
    if (response.ok) return { kind: 'page', page: (await response.json()) as AuditPageView };
    if (response.status === 404) return { kind: 'unavailable' };
    if (response.status === 400) {
      const body = (await response.json().catch(() => ({}))) as {
        details?: { reason?: string };
      };
      if (body.details?.reason === 'invalid_cursor') return { kind: 'invalid_cursor' };
    }
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}
