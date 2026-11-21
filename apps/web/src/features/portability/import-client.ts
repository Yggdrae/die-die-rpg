import { type ImportJobView, PACKAGE_LIMITS } from '@rpg/campaign-portability';
import type { FetchLike } from './export-client.ts';

/**
 * Feature 07 tasks 06–07 client: atomic import through the API. Import needs the server in P0
 * (`_techspec.md`): the authority validates the package, requires the exact pinned system and
 * restores every contributor in one transaction. The file is sent as-is; nothing is parsed or
 * trusted here, and every outcome comes from the server's job report.
 */

export type ImportOutcome =
  | {
      readonly kind: 'imported';
      readonly campaignId: string;
      readonly modules: ImportJobView['report']['modules'];
    }
  /** The server rejected the package; nothing was imported. */
  | {
      readonly kind: 'rejected';
      readonly code: string;
      readonly failure: NonNullable<ImportJobView['failure']>;
    }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'network_unavailable' }
  | { readonly kind: 'failed'; readonly code: string };

export async function importCampaign(
  file: Blob,
  options: {
    readonly online?: boolean;
    readonly fetchImpl?: FetchLike;
    readonly jobId?: string;
  } = {},
): Promise<ImportOutcome> {
  if (options.online === false) return { kind: 'offline' };
  if (file.size > PACKAGE_LIMITS.maxPackageBytes) return { kind: 'too_large' };
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const jobId = options.jobId ?? crypto.randomUUID();
  let response: Response;
  try {
    response = await fetchImpl(`/imports/${jobId}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/zip' },
      body: file,
    });
  } catch {
    return { kind: 'network_unavailable' };
  }
  if (response.status === 413) return { kind: 'too_large' };
  if (!response.ok) return { kind: 'failed', code: `http_${response.status}` };
  const job = (await response.json()) as ImportJobView;
  if (job.state === 'completed' && job.campaignId !== undefined) {
    return { kind: 'imported', campaignId: job.campaignId, modules: job.report.modules };
  }
  if (job.state === 'failed') {
    return { kind: 'rejected', code: job.errorCode ?? 'import_failed', failure: job.failure ?? {} };
  }
  return { kind: 'failed', code: 'import_in_progress' };
}
