import { useState } from 'react';
import { type ExportOutcome, exportCampaign, type OfflineExportSource } from './export-client.ts';

/**
 * Campaign export (feature 07, `_bdd.md` "A GM exports one campaign as one file"). The warning is
 * shown and must be acknowledged before anything is generated. The server decides who may export
 * (current owner or gm); the interface makes no role decision and reports a denial plainly.
 */

const MODULE_LABELS: Readonly<Record<string, string>> = {
  campaign: 'campaign details and rules pins',
  attachments: 'attachment list',
  content: 'campaign content',
};

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done'; readonly outcome: ExportOutcome };

export function CampaignExport(props: {
  readonly campaignId: string;
  readonly offline: OfflineExportSource;
  /** Defaults to `navigator.onLine`. */
  readonly online?: () => boolean;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const run = async () => {
    setPhase({ kind: 'working' });
    const online = props.online?.() ?? globalThis.navigator?.onLine ?? true;
    const outcome = await exportCampaign(props.campaignId, {
      online,
      offline: props.offline,
    }).catch((): ExportOutcome => ({ kind: 'failed', code: 'export_failed' }));
    if (outcome.kind === 'ready') saveFile(outcome.file, outcome.filename);
    setPhase({ kind: 'done', outcome });
  };

  return (
    <section aria-label="Export campaign">
      <p role="note">
        The export file contains everything in this campaign, including GM-only secrets. Anyone who
        has the file can read all of it: it has no access control once downloaded. Attachment files
        are listed, not included.
      </p>
      <label>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
        />{' '}
        I understand this file reveals GM secrets
      </label>{' '}
      <button
        type="button"
        disabled={!acknowledged || phase.kind === 'working'}
        onClick={() => void run()}
      >
        Export campaign
      </button>
      {phase.kind === 'working' && <p role="status">Preparing export…</p>}
      {phase.kind === 'done' && <OutcomeMessage outcome={phase.outcome} />}
    </section>
  );
}

function OutcomeMessage(props: { readonly outcome: ExportOutcome }) {
  const { outcome } = props;
  switch (outcome.kind) {
    case 'ready':
      return (
        <p role="status" data-export-source={outcome.source}>
          Export ready: {outcome.filename} (
          {outcome.summary
            .map((entry) =>
              entry.records === undefined ? entry.moduleId : `${entry.moduleId} ${entry.records}`,
            )
            .join(', ')}
          ).
        </p>
      );
    case 'denied':
      return <p role="alert">Only the campaign owner or a game master can export this campaign.</p>;
    case 'incomplete_replica':
      return (
        <p role="alert" data-incomplete-modules={outcome.modules.join(',')}>
          Cannot export offline: this device does not hold a complete copy of the{' '}
          {outcome.modules.map((moduleId) => MODULE_LABELS[moduleId] ?? moduleId).join(' and ')}. No
          partial file was created. Export again when you are online.
        </p>
      );
    case 'network_unavailable':
      return <p role="alert">The server could not be reached. No file was created.</p>;
    case 'failed':
      return (
        <p role="alert" data-error-code={outcome.code}>
          The export failed. No file was created.
        </p>
      );
  }
}

function saveFile(file: Blob, filename: string): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
