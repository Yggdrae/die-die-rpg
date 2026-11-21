import { AD_HOC_PARTICIPANT_TYPE } from '@rpg/content';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { browserCharacterSource, installedRegistry } from '../characters/index.ts';
import {
  browserContentSource,
  CONTENT_SESSION_QUICK_ACTIONS,
  ContentQuickCreateHost,
  type ContentSource,
} from '../content/index.ts';
import { HANDOUT_SESSION_QUICK_ACTIONS } from '../handouts/index.ts';
import { browserSessionSource, SessionWorkspace } from '../sessions/index.ts';
import { useBrowserSync } from '../sync/useBrowserSync.ts';
import { EncounterHost } from './EncounterHost.tsx';
import { EncounterWorkspace } from './EncounterWorkspace.tsx';
import { browserEncounterSource } from './encounter-source.ts';
import { ENCOUNTER_SESSION_QUICK_ACTIONS } from './session-quick-actions.ts';

/**
 * Playwright-only host (imported dynamically from `encounters.e2e.ts`; never from production code): the dashboard's
 * Session Mode and tracker composition over the production browser replica, with the shell's quick actions and the
 * one tracker overlay. Seeding helpers write through the production device repositories.
 */

const QUICK_ACTIONS = [
  ...CONTENT_SESSION_QUICK_ACTIONS,
  ...HANDOUT_SESSION_QUICK_ACTIONS,
  ...ENCOUNTER_SESSION_QUICK_ACTIONS,
];
const TABLES = [
  'encounters',
  'encounter_gm_notes',
  'encounter_participants',
  'encounter_participant_states',
];

let session: BrowserSyncSession | undefined;
let content: ContentSource | undefined;
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
  const sessionSource = useMemo(
    () =>
      sync.session === undefined
        ? undefined
        : browserSessionSource(sync.session, { ...props, resolve }),
    [sync.session, props, resolve],
  );
  const encounterSource = useMemo(
    () =>
      sync.session === undefined
        ? undefined
        : browserEncounterSource(sync.session, { ...props, resolve }),
    [sync.session, props, resolve],
  );
  useEffect(() => {
    session = sync.session;
    content = contentSource;
  }, [sync.session, contentSource]);
  return (
    <main>
      <ContentQuickCreateHost {...(contentSource === undefined ? {} : { source: contentSource })} />
      <EncounterHost {...(encounterSource === undefined ? {} : { source: encounterSource })} />
      {sessionSource !== undefined && (
        <SessionWorkspace source={sessionSource} quickActions={QUICK_ACTIONS} />
      )}
      {encounterSource !== undefined && <EncounterWorkspace source={encounterSource} />}
    </main>
  );
}

export function mountEncounters(input: { readonly userId: string; readonly campaignId: string }) {
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

/** Every row of one of this feature's tables on the device: absence means absent, not hidden. */
export async function storedRows(table: string): Promise<readonly string[]> {
  if (!TABLES.includes(table)) throw new Error('unknown table');
  const rows = await current().database.getAll<Record<string, unknown>>(`SELECT * FROM ${table}`);
  return rows.map((row) => JSON.stringify(row));
}

/** A GM-only creature entity, as the content screens create one. */
export async function createCreature(name: string): Promise<string> {
  for (let attempt = 0; attempt < 100 && content === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (content === undefined) throw new Error('no content source');
  const created = await content.entities.create({ type: AD_HOC_PARTICIPANT_TYPE, name });
  if (!created.ok) throw new Error('create failed');
  return created.value.id;
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
