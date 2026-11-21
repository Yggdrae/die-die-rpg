import type { BrowserSyncSession } from '@rpg/sync/browser';
import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { deviceSearchActor, searchPaletteProvider } from '../campaigns/search-composition.ts';
import { installedRegistry } from '../characters/index.ts';
import { SearchWorkspace, useSearchService } from '../search/index.ts';
import { browserSessionSource, SessionWorkspace } from '../sessions/index.ts';
import { useBrowserSync } from '../sync/useBrowserSync.ts';
import { RulesLibrary } from './RulesLibrary.tsx';
import { browserRulesSource } from './rules-source.ts';
import { rulesSearchContribution } from './search-contribution.ts';

/**
 * Playwright-only host (imported dynamically from `rules.e2e.ts`; never from production code): the dashboard's rules
 * composition over the production browser replica: the library, the rules contribution to the campaign search, and
 * Session Mode with the shell's palette provider, exactly as `CampaignDashboard` lists them.
 */

let session: BrowserSyncSession | undefined;
let user: { readonly userId: string; readonly campaignId: string } | undefined;

function Harness(props: { readonly userId: string; readonly campaignId: string }) {
  const sync = useBrowserSync(props.userId, props.campaignId);
  const resolve = useMemo(
    () => (ref: Parameters<ReturnType<typeof installedRegistry>['resolve']>[0]) =>
      installedRegistry().resolve(ref),
    [],
  );
  const rules = useMemo(
    () =>
      sync.session === undefined
        ? undefined
        : browserRulesSource(sync.session, { ...props, resolve }),
    [sync.session, props, resolve],
  );
  const sessions = useMemo(
    () =>
      sync.session === undefined
        ? undefined
        : browserSessionSource(sync.session, { ...props, resolve }),
    [sync.session, props, resolve],
  );
  const contributions = useMemo(
    () => (rules === undefined ? undefined : [rulesSearchContribution(rules)]),
    [rules],
  );
  const actor = useMemo(
    () =>
      sync.session === undefined ? async () => undefined : deviceSearchActor(sync.session, props),
    [sync.session, props],
  );
  const search = useSearchService({ campaignId: props.campaignId, contributions, actor });
  const providers = useMemo(
    () => (search === undefined ? undefined : [searchPaletteProvider(search)]),
    [search],
  );
  useEffect(() => {
    session = sync.session;
  }, [sync.session]);
  return (
    <main>
      {search !== undefined && <SearchWorkspace service={search} />}
      {sessions !== undefined && (
        <SessionWorkspace
          source={sessions}
          {...(providers === undefined ? {} : { paletteProviders: providers })}
        />
      )}
      {rules !== undefined && <RulesLibrary source={rules} />}
    </main>
  );
}

export function mountRules(input: { readonly userId: string; readonly campaignId: string }) {
  user = input;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(<Harness {...input} />);
}

function current(): BrowserSyncSession {
  if (session === undefined) throw new Error('no session');
  return session;
}

export async function pauseSync(): Promise<void> {
  await current().disconnect();
}

export async function resumeSync(): Promise<void> {
  await current().connect(user?.campaignId);
}

export async function pendingCount(): Promise<number> {
  return current().store.pendingCount();
}

/** The owners of every section mark this device's replica holds (D-10: only its own user's). */
export async function markOwners(): Promise<string[]> {
  const rows = await current().database.getAll<{ user_id: string }>(
    'SELECT user_id FROM rules_section_marks',
  );
  return rows.map((row) => row.user_id);
}
