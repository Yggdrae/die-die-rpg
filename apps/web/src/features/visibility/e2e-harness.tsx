import type { Visibility } from '@rpg/contracts';
import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VisibilityControls } from './VisibilityControls.tsx';

/**
 * Playwright-only host (imported dynamically from the spec; never from production code).
 * There is no production Resource Class yet, so this stands in for a content owner: it keeps the
 * record's visibility and version and reloads them from a mocked record endpoint.
 */
export interface HarnessOptions {
  readonly campaignId: string;
  readonly resourceClass: string;
  readonly resourceId: string;
  readonly viewerRole?: string;
  readonly visibility: Visibility;
  readonly version: number;
}

function Host(props: HarnessOptions) {
  const [record, setRecord] = useState({ visibility: props.visibility, version: props.version });
  const reload = useCallback(async () => {
    const response = await fetch(
      `/campaigns/${props.campaignId}/resources/${props.resourceClass}/${props.resourceId}`,
      { credentials: 'include' },
    );
    if (!response.ok) throw new Error('reload_failed');
    setRecord((await response.json()) as typeof record);
  }, [props.campaignId, props.resourceClass, props.resourceId]);
  return (
    <main>
      <p data-testid="record-version">version {record.version}</p>
      <VisibilityControls
        campaignId={props.campaignId}
        resourceClass={props.resourceClass}
        resourceId={props.resourceId}
        {...(props.viewerRole === undefined ? {} : { viewerRole: props.viewerRole })}
        visibility={record.visibility}
        version={record.version}
        onChanged={setRecord}
        onReload={reload}
      />
    </main>
  );
}

export function mountVisibilityHarness(options: HarnessOptions): void {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(<Host {...options} />);
}
