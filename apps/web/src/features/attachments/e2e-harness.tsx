import { createRoot } from 'react-dom/client';
import { AttachmentList } from './Attachments.tsx';

/**
 * Playwright-only host (imported dynamically from `e2e/attachments.e2e.ts`; never from production
 * code). No production owner class exists yet, so this stands in for a content owner page. The
 * API is the spec's route mock; the read URLs it returns point at the real storage provider.
 */
export interface AttachmentHarnessOptions {
  readonly campaignId: string;
  readonly resourceClass: string;
  readonly resourceId: string;
}

export function mountAttachmentHarness(options: AttachmentHarnessOptions): void {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(
    <main>
      <h1 data-testid="app-shell">Campaign</h1>
      <AttachmentList
        campaignId={options.campaignId}
        owner={{ resourceClass: options.resourceClass, resourceId: options.resourceId }}
      />
    </main>,
  );
}
