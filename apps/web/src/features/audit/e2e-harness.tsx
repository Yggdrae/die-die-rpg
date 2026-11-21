import type { LocalAuditLog, LocalAuditRead } from '@rpg/sync';
import { createRoot } from 'react-dom/client';
import { AuditLog } from './AuditLog.tsx';
import type { MemberName } from './audit-model.ts';

/**
 * Playwright-only host (imported dynamically from `e2e/audit.e2e.ts`; never from production code).
 * The API is the spec's route mock; the local replica log stands in for the browser replica
 * (`BrowserSyncSession.audit.read`, proved against PowerSync in `live-sync.e2e.ts`).
 */
export interface AuditHarnessOptions {
  readonly campaignId: string;
  readonly sessionId?: string;
  readonly viewerRole?: string;
  readonly members: readonly MemberName[];
  readonly online: boolean;
  /** Per store; `undefined` means no local replica for that store. */
  readonly local?: { readonly campaign?: LocalAuditLog; readonly private?: LocalAuditLog };
}

export function mountAuditHarness(options: AuditHarnessOptions): void {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const reads: { store: string; filters: unknown }[] = [];
  (globalThis as { auditLocalReads?: unknown }).auditLocalReads = reads;
  createRoot(host).render(
    <AuditLog
      campaignId={options.campaignId}
      {...(options.sessionId === undefined ? {} : { sessionId: options.sessionId })}
      {...(options.viewerRole === undefined ? {} : { viewerRole: options.viewerRole })}
      members={options.members}
      online={options.online}
      readLocal={async ({ store, filters }): Promise<LocalAuditRead | undefined> => {
        reads.push({ store, filters });
        const log = options.local?.[store];
        if (log !== undefined) return { ok: true, log };
        return store === 'private' ? { ok: false, reason: 'private_unavailable' } : undefined;
      }}
    />,
  );
}
