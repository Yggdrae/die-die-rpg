import type { ImportModuleView } from '@rpg/campaign-portability';
import { type FormEvent, useState } from 'react';
import type { FetchLike } from './export-client.ts';
import { type ImportOutcome, importCampaign } from './import-client.ts';

/**
 * Campaign import (feature 07, `_bdd.md` Validation Before Import, Atomic Import, Round Trip).
 * The server validates and restores the whole package or nothing; this screen only sends the
 * file and explains the job report. Every warning is shown, so nothing unrestored is silent.
 * Text from the package is never displayed: only module ids, counts, and the pinned system the
 * server reports as unavailable.
 */

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done'; readonly outcome: ImportOutcome };

export function CampaignImport(props: {
  /** Called with the new campaign id once the import committed. */
  readonly onImported?: (campaignId: string) => void;
  /** Defaults to `navigator.onLine`. */
  readonly online?: () => boolean;
  readonly fetchImpl?: FetchLike;
}) {
  const [file, setFile] = useState<File>();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (file === undefined) return;
    setPhase({ kind: 'working' });
    const outcome = await importCampaign(file, {
      online: props.online?.() ?? globalThis.navigator?.onLine ?? true,
      ...(props.fetchImpl === undefined ? {} : { fetchImpl: props.fetchImpl }),
    }).catch((): ImportOutcome => ({ kind: 'failed', code: 'import_failed' }));
    setPhase({ kind: 'done', outcome });
    if (outcome.kind === 'imported') props.onImported?.(outcome.campaignId);
  };

  return (
    <section aria-labelledby="import-title">
      <h2 id="import-title">Import campaign</h2>
      <form onSubmit={(event) => void submit(event)}>
        <p>
          Importing creates a new campaign that you own. Members are not imported: invite them
          again. Attachment files are not part of a package.
        </p>
        <label>
          Campaign file (.rpgpack){' '}
          <input
            type="file"
            accept=".rpgpack,application/zip"
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0]);
              setPhase({ kind: 'idle' });
            }}
          />
        </label>{' '}
        <button type="submit" disabled={file === undefined || phase.kind === 'working'}>
          Import campaign
        </button>
      </form>
      {phase.kind === 'working' && <p role="status">Checking and importing the file…</p>}
      {phase.kind === 'done' && <ImportResult outcome={phase.outcome} />}
    </section>
  );
}

const WARNING_TEXT: Readonly<Record<string, (count: number) => string>> = {
  attachment_binary_not_restored: (count) =>
    `${count} attachment${count === 1 ? ' was' : 's were'} listed without file contents and ${count === 1 ? 'was' : 'were'} not restored.`,
  visibility_narrowed_to_gm_only: (count) =>
    `${count} record${count === 1 ? '' : 's'} shared with specific players or parties ${count === 1 ? 'is' : 'are'} now GM-only, because members were not imported.`,
  setting_not_restored: (count) =>
    `${count} setting${count === 1 ? '' : 's'} unknown to this installation ${count === 1 ? 'was' : 'were'} not restored.`,
};

const PRESERVED_TEXT: Readonly<Record<string, string>> = {
  unknown_module: 'unknown to this installation',
  contributor_not_transactional: 'its feature cannot restore it safely yet',
  chunk_version_unsupported: 'its data version is not supported here',
  preserved_from_package: 'it was already kept from an earlier import',
};

function warningLines(module: ImportModuleView): string[] {
  const counts = new Map<string, number>();
  for (const warning of module.warnings) {
    counts.set(warning.code, (counts.get(warning.code) ?? 0) + (warning.count ?? 1));
  }
  return [...counts].map(
    ([code, count]) => WARNING_TEXT[code]?.(count) ?? `Warning ${code} (${count}).`,
  );
}

function ImportResult(props: { readonly outcome: ImportOutcome }) {
  const { outcome } = props;
  switch (outcome.kind) {
    case 'imported': {
      const restored = outcome.modules.filter((module) => module.outcome === 'restored');
      const preserved = outcome.modules.filter((module) => module.outcome === 'preserved');
      return (
        <div role="status" data-import-campaign={outcome.campaignId}>
          <p>Imported as a new campaign. You are its owner.</p>
          <ul aria-label="Restored">
            {restored.map((module) => (
              <li key={module.moduleId} data-module={module.moduleId}>
                {module.moduleId}: {module.restoredCount} restored
                {warningLines(module).map((line) => (
                  <span key={line} data-warning>
                    {' '}
                    {line}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {preserved.length > 0 && (
            <ul aria-label="Kept, not restored">
              {preserved.map((module) => (
                <li
                  key={`${module.moduleId}/${module.chunkVersion}`}
                  data-preserved={module.moduleId}
                >
                  {module.moduleId} (version {module.chunkVersion}) was kept unchanged for a later
                  export but not restored:{' '}
                  {module.warnings
                    .map((warning) => PRESERVED_TEXT[warning.code] ?? warning.code)
                    .join(', ')}
                  .
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case 'rejected':
      return (
        <p role="alert" data-error-code={outcome.code}>
          {rejectionText(outcome)} Nothing was imported.
        </p>
      );
    case 'too_large':
      return <p role="alert">The file is larger than 250 MB. Nothing was imported.</p>;
    case 'offline':
      return <p role="alert">Importing needs a connection to the server. Nothing was imported.</p>;
    case 'network_unavailable':
      return <p role="alert">The server could not be reached. Nothing was imported.</p>;
    case 'failed':
      return (
        <p role="alert" data-error-code={outcome.code}>
          The import failed. Nothing was imported.
        </p>
      );
  }
}

function rejectionText(outcome: Extract<ImportOutcome, { kind: 'rejected' }>): string {
  const { failure } = outcome;
  switch (outcome.code) {
    case 'system_unavailable': {
      const system = failure.unavailable?.system;
      return system === undefined
        ? 'This file needs a game system version this installation does not have.'
        : `This file needs the game system ${system.systemId} version ${system.version}, which this installation does not have. No other version is used instead.`;
    }
    case 'module_unavailable':
      return `This file needs module versions this installation does not have: ${(
        failure.unavailable?.modules ?? []
      )
        .map((pin) => `${pin.moduleId} ${pin.version}`)
        .join(', ')}.`;
    case 'contributor_failed':
    case 'chunk_rejected':
    case 'contributor_mismatch':
      return `The ${failure.moduleId ?? 'campaign'} data in this file could not be restored${
        failure.detail === undefined ? '' : ` (${failure.detail})`
      }.`;
    default:
      return `This is not a valid campaign file (${outcome.code}).`;
  }
}
