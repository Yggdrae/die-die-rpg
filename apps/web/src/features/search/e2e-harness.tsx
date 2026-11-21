import type { BrowserSyncSession } from '@rpg/sync/browser';
import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { deviceSearchActor, searchPaletteProvider } from '../campaigns/search-composition.ts';
import {
  browserCharacterSource,
  CharacterWorkspace,
  characterSearchContribution,
  installedRegistry,
} from '../characters/index.ts';
import {
  browserContentSource,
  type ContentSource,
  ContentWorkspace,
  contentSearchContribution,
} from '../content/index.ts';
import { browserEncounterSource, encounterSearchContribution } from '../encounters/index.ts';
import { browserSessionSource, SessionWorkspace } from '../sessions/index.ts';
import { useBrowserSync } from '../sync/useBrowserSync.ts';
import { SearchWorkspace, useSearchService } from './SearchWorkspace.tsx';
import type { SearchService } from './search-service.ts';

/**
 * Playwright-only host (imported dynamically from `search.e2e.ts`; never from production code): the dashboard's search
 * composition over the production browser replica: the same contributions, device actor, screen, and Session Mode
 * palette provider as `CampaignDashboard`, plus the owning content and character views results open. Seeding helpers
 * write through the production device repositories.
 */

let session: BrowserSyncSession | undefined;
let content: ContentSource | undefined;
let search: SearchService | undefined;
let user: { readonly userId: string; readonly campaignId: string } | undefined;

function Harness(props: { readonly userId: string; readonly campaignId: string }) {
  const sync = useBrowserSync(props.userId, props.campaignId);
  const resolve = useMemo(
    () => (ref: Parameters<ReturnType<typeof installedRegistry>['resolve']>[0]) =>
      installedRegistry().resolve(ref),
    [],
  );
  const contentSource = useMemo(
    () =>
      sync.session === undefined || sync.drafts === undefined
        ? undefined
        : browserContentSource(sync.session, { ...props, drafts: sync.drafts }),
    [sync.session, sync.drafts, props],
  );
  const characterSource = useMemo(
    () => (sync.session === undefined ? undefined : browserCharacterSource(sync.session, props)),
    [sync.session, props],
  );
  const encounterSource = useMemo(
    () =>
      sync.session === undefined
        ? undefined
        : browserEncounterSource(sync.session, { ...props, resolve }),
    [sync.session, props, resolve],
  );
  const sessionSource = useMemo(
    () =>
      sync.session === undefined
        ? undefined
        : browserSessionSource(sync.session, { ...props, resolve }),
    [sync.session, props, resolve],
  );
  const contributions = useMemo(
    () =>
      contentSource === undefined || characterSource === undefined || encounterSource === undefined
        ? undefined
        : [
            contentSearchContribution(contentSource),
            characterSearchContribution(characterSource),
            encounterSearchContribution(encounterSource),
          ],
    [contentSource, characterSource, encounterSource],
  );
  const actor = useMemo(
    () =>
      sync.session === undefined ? async () => undefined : deviceSearchActor(sync.session, props),
    [sync.session, props],
  );
  const service = useSearchService({ campaignId: props.campaignId, contributions, actor });
  const providers = useMemo(
    () => (service === undefined ? undefined : [searchPaletteProvider(service)]),
    [service],
  );
  useEffect(() => {
    session = sync.session;
    content = contentSource;
    search = service;
  }, [sync.session, contentSource, service]);
  return (
    <main>
      {service !== undefined && <SearchWorkspace service={service} />}
      {sessionSource !== undefined && (
        <SessionWorkspace
          source={sessionSource}
          {...(providers === undefined ? {} : { paletteProviders: providers })}
        />
      )}
      {characterSource !== undefined && <CharacterWorkspace source={characterSource} />}
      {contentSource !== undefined && <ContentWorkspace source={contentSource} />}
    </main>
  );
}

export function mountSearch(input: { readonly userId: string; readonly campaignId: string }) {
  user = input;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(<Harness {...input} />);
}

function current(): BrowserSyncSession {
  if (session === undefined) throw new Error('no session');
  return session;
}

async function contentSource(): Promise<ContentSource> {
  for (let attempt = 0; attempt < 100 && content === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (content === undefined) throw new Error('no content source');
  return content;
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

/** An entity as the content screens create one: GM-only unless `everyone`. */
export async function createEntity(input: {
  readonly type: string;
  readonly name: string;
  readonly summary?: string;
  readonly everyone?: boolean;
}): Promise<string> {
  const source = await contentSource();
  const created = await source.entities.create({
    type: input.type,
    name: input.name,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  });
  if (!created.ok) throw new Error('create failed');
  if (input.everyone === true) {
    const revealed = await source.entities.changeVisibility(
      created.value.id,
      { operation: 'reveal', target: { mode: 'everyone' } },
      created.value.version,
    );
    if (!revealed.ok) throw new Error('reveal failed');
  }
  return created.value.id;
}

/** Waits until the device index has no run in flight. */
export async function searchSettled(): Promise<void> {
  for (let attempt = 0; attempt < 100 && search === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await search?.settled();
}

/** A character of the campaign's pinned system, owned by this device's user. */
export async function createCharacter(name: string): Promise<string> {
  if (user === undefined) throw new Error('not mounted');
  const characters = browserCharacterSource(current(), user);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pinned = await characters.system();
    if (pinned !== undefined) {
      const made = await characters.characters.create(pinned.system, pinned.ref, name);
      if (!made.ok) throw new Error(made.error.code);
      return made.value.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no campaign pin on the device');
}
