import { ExportRegistry } from '@rpg/campaign-portability';
import { err } from '@rpg/contracts';
import { createRoot } from 'react-dom/client';
import { CampaignExport } from './CampaignExport.tsx';
import { CampaignImport } from './CampaignImport.tsx';
import type { OfflineExportSource } from './export-client.ts';
import { browserReplicaExportSource } from './replica-export.ts';

/**
 * Playwright-only host (imported dynamically from `e2e/portability.e2e.ts`; never from production
 * code). `replica: 'browser'` is the production browser replica composition; `replica: 'complete'`
 * stands in for a fully synchronized replica whose contributors read local data only.
 */
export interface PortabilityHarnessOptions {
  readonly campaignId: string;
  readonly replica: 'browser' | 'complete';
}

function completeReplica(campaignId: string): OfflineExportSource {
  const local = (moduleId: string, payload: unknown) => ({
    moduleId,
    export: async () => ({ moduleId, chunkVersion: '1', payload }),
    import: async () => err('unsupported'),
  });
  return {
    registry: new ExportRegistry()
      .register(
        local('campaign', {
          name: 'Ashen Road',
          description: '',
          system: { systemId: 'fixture-system', version: '0.1.0' },
          gameMode: 'standard',
          modulePins: [],
          settings: {},
        }),
        { placement: 'campaign', countRecords: () => 1 },
      )
      .register(
        local('attachments', {
          campaignId,
          binaries: 'excluded',
          entries: [],
        }),
        { placement: 'attachments-manifest', countRecords: () => 0 },
      ),
    rules: {
      pins: async () => ({ system: { systemId: 'fixture-system', version: '0.1.0' }, modules: [] }),
    },
    replica: {
      coverage: async () => ({
        cursor: 'checkpoint-1',
        modules: { campaign: true, attachments: true },
      }),
    },
    mayExport: async () => true,
    displayName: 'gm_ana',
    applicationVersion: 'e2e',
  };
}

export function mountPortabilityHarness(options: PortabilityHarnessOptions): void {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(
    <CampaignExport
      campaignId={options.campaignId}
      offline={
        options.replica === 'complete'
          ? completeReplica(options.campaignId)
          : browserReplicaExportSource({ displayName: 'gm_ana', applicationVersion: 'e2e' })
      }
    />,
  );
}

/** Export (online, production browser replica offline) and import side by side. */
export function mountRoundTripHarness(options: { readonly campaignId: string }): void {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(
    <>
      <CampaignExport
        campaignId={options.campaignId}
        offline={browserReplicaExportSource({ displayName: 'gm_ana', applicationVersion: 'e2e' })}
      />
      <CampaignImport />
    </>,
  );
}
