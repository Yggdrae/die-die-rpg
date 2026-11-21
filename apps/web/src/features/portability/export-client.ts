import {
  type ContributorSummary,
  ExportOrchestrator,
  type ExportRegistry,
  type ReplicaCoverage,
  type RulesContextSource,
  replicaConsistency,
} from '@rpg/campaign-portability';

/**
 * Feature 07 tasks 04–05 client: online export through the API (owner/gm decided by the server),
 * and the complete-replica offline export over local data. Both produce the same `.rpgpack`
 * format; neither ever offers a partial file.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ExportOutcome =
  | {
      readonly kind: 'ready';
      readonly source: 'online' | 'offline';
      readonly file: Blob;
      readonly filename: string;
      readonly summary: readonly ContributorSummary[];
    }
  /** Safe 404: not a current owner/gm, not a member, or no such campaign. */
  | { readonly kind: 'denied' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'incomplete_replica'; readonly modules: readonly string[] }
  | { readonly kind: 'network_unavailable' };

interface JobView {
  readonly jobId: string;
  readonly state: 'requested' | 'running' | 'completed' | 'failed';
  readonly summary: ContributorSummary[];
  readonly errorCode?: string;
}

export async function exportOnline(
  campaignId: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  jobId: string = crypto.randomUUID(),
): Promise<ExportOutcome> {
  let started: Response;
  try {
    started = await fetchImpl(`/campaigns/${campaignId}/exports`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, acknowledgeGmSecrets: true }),
    });
  } catch {
    return { kind: 'network_unavailable' };
  }
  if (started.status === 404) return { kind: 'denied' };
  if (!started.ok) return { kind: 'failed', code: 'request_failed' };
  const job = (await started.json()) as JobView;
  if (job.state !== 'completed') return { kind: 'failed', code: job.errorCode ?? 'export_failed' };
  let file: Response;
  try {
    file = await fetchImpl(`/exports/${job.jobId}/file`, { credentials: 'include' });
  } catch {
    return { kind: 'network_unavailable' };
  }
  if (file.status === 404) return { kind: 'denied' };
  if (!file.ok) return { kind: 'failed', code: 'file_unavailable' };
  return {
    kind: 'ready',
    source: 'online',
    file: await file.blob(),
    filename: `campaign-${job.jobId}.rpgpack`,
    summary: job.summary,
  };
}

/** Everything an offline export reads: registered local contributors, pins, replica coverage. */
export interface OfflineExportSource {
  readonly registry: ExportRegistry;
  readonly rules: RulesContextSource;
  readonly replica: ReplicaCoverage;
  /** The same decision the server makes for an online export, before anything is read. */
  mayExport(campaignId: string): Promise<boolean>;
  readonly displayName: string;
  readonly applicationVersion: string;
}

export async function exportOffline(
  campaignId: string,
  source: OfflineExportSource,
): Promise<ExportOutcome> {
  if (!(await source.mayExport(campaignId))) return { kind: 'denied' };
  const result = await new ExportOrchestrator({
    registry: source.registry,
    rules: source.rules,
    applicationVersion: source.applicationVersion,
    consistency: replicaConsistency(source.registry, source.replica),
  }).export(campaignId, { exportedBy: { displayName: source.displayName } });
  if (result.ok) {
    return {
      kind: 'ready',
      source: 'offline',
      file: new Blob(result.value.parts as BlobPart[], { type: 'application/zip' }),
      filename: `campaign-${campaignId}-offline.rpgpack`,
      summary: result.value.summary,
    };
  }
  if (result.error.code === 'incomplete_replica') {
    return { kind: 'incomplete_replica', modules: result.error.incompleteModules ?? [] };
  }
  return { kind: 'failed', code: result.error.code };
}

/** Online first; offline (or on a network failure) the replica export, never a partial file. */
export async function exportCampaign(
  campaignId: string,
  options: {
    readonly online: boolean;
    readonly offline: OfflineExportSource;
    readonly fetchImpl?: FetchLike;
  },
): Promise<ExportOutcome> {
  if (options.online) {
    const outcome = await exportOnline(campaignId, options.fetchImpl);
    if (outcome.kind !== 'network_unavailable') return outcome;
  }
  return exportOffline(campaignId, options.offline);
}
