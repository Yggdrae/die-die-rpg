import type { AttachmentMetadata } from '@rpg/attachments';
import type {
  DownloadResult,
  OfflineAttachmentSource,
  OfflineSetResult,
  ReadCheck,
} from '@rpg/attachments/offline';
import { readOutcomeOf } from './attachment-model.ts';
import type { FetchLike } from './attachments-api.ts';

/**
 * Network side of the offline store (feature 05 task 05). Every download asks the API for a
 * fresh five-minute read grant first (a fresh feature 04 decision), then fetches the bytes from
 * the storage origin without cookies or referrer. A 404 is a denial (hidden, deleted, revoked);
 * anything else that fails is retryable and never treated as permission.
 */
export function httpOfflineAttachmentSource(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  appOrigin: string = globalThis.location?.origin ?? '',
): OfflineAttachmentSource {
  const campaignPath = (campaignId: string) => `/campaigns/${encodeURIComponent(campaignId)}`;

  async function grant(campaignId: string, attachmentId: string, signal?: AbortSignal) {
    const response = await fetchImpl(
      `${campaignPath(campaignId)}/attachments/${encodeURIComponent(attachmentId)}/read?disposition=inline`,
      { credentials: 'include', ...(signal === undefined ? {} : { signal }) },
    );
    if (response.status === 404) return { kind: 'denied' as const };
    const body: unknown = await response.json().catch(() => undefined);
    const outcome = readOutcomeOf(response.status, body, appOrigin);
    return outcome.kind === 'granted'
      ? { kind: 'granted' as const, url: outcome.url }
      : { kind: 'failed' as const };
  }

  return {
    async offlineSet(campaignId): Promise<OfflineSetResult> {
      try {
        const response = await fetchImpl(
          `${campaignPath(campaignId)}/attachments/offline-estimate`,
          { credentials: 'include' },
        );
        if (response.status === 404) return { kind: 'denied' };
        if (!response.ok) return { kind: 'offline' };
        const body = (await response.json()) as { items?: unknown };
        if (!Array.isArray(body.items)) return { kind: 'offline' };
        const items = (body.items as AttachmentMetadata[]).filter(
          (item) => item.campaignId === campaignId,
        );
        return { kind: 'ok', items };
      } catch {
        return { kind: 'offline' };
      }
    },

    async check(campaignId, attachmentId): Promise<ReadCheck> {
      try {
        const outcome = await grant(campaignId, attachmentId);
        if (outcome.kind === 'denied') return 'denied';
        return outcome.kind === 'granted' ? 'allowed' : 'offline';
      } catch {
        return 'offline';
      }
    },

    async download(campaignId, attachmentId, options): Promise<DownloadResult> {
      try {
        const outcome = await grant(campaignId, attachmentId, options.signal);
        if (outcome.kind !== 'granted') return outcome;
        const response = await fetchImpl(outcome.url, {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          mode: 'cors',
          cache: 'no-store',
          signal: options.signal,
        });
        if (!response.ok || response.body === null) return { kind: 'failed' };
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          options.onProgress(received);
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { kind: 'ok', bytes };
      } catch {
        return { kind: 'failed' };
      }
    },
  };
}
