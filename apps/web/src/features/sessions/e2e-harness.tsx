import { HANDOUT_ENTITY_TYPE } from '@rpg/content';
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
import { HANDOUT_SESSION_QUICK_ACTIONS, HandoutRevealHost } from '../handouts/index.ts';
import { useBrowserSync } from '../sync/useBrowserSync.ts';
import { SessionWorkspace } from './SessionWorkspace.tsx';
import { browserSessionSource } from './session-source.ts';

/**
 * Playwright-only host (imported dynamically from `sessions.e2e.ts`; never from production code): the dashboard's
 * Session Mode composition, over the production browser replica: the content quick-create and handout overlays the
 * app shell mounts, and the shell's quick actions. Seeding helpers write through the production device repositories.
 */

const QUICK_ACTIONS = [...CONTENT_SESSION_QUICK_ACTIONS, ...HANDOUT_SESSION_QUICK_ACTIONS];

let session: BrowserSyncSession | undefined;
let content: ContentSource | undefined;
let user: { readonly userId: string; readonly campaignId: string } | undefined;

function Harness(props: { readonly userId: string; readonly campaignId: string }) {
  const sync = useBrowserSync(props.userId, props.campaignId);
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
        : browserSessionSource(sync.session, {
            ...props,
            resolve: (ref) => installedRegistry().resolve(ref),
          }),
    [sync.session, props],
  );
  useEffect(() => {
    session = sync.session;
    content = contentSource;
  }, [sync.session, contentSource]);
  return (
    <main>
      <ContentQuickCreateHost {...(contentSource === undefined ? {} : { source: contentSource })} />
      <HandoutRevealHost
        {...(contentSource === undefined ? {} : { source: contentSource })}
        onRevealed={({ sessionId, handoutId }) =>
          void sessionSource?.log.reveal(sessionId, handoutId)
        }
      />
      {sessionSource !== undefined && (
        <SessionWorkspace source={sessionSource} quickActions={QUICK_ACTIONS} />
      )}
    </main>
  );
}

export function mountSessions(input: { readonly userId: string; readonly campaignId: string }) {
  user = input;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(<Harness {...input} />);
}

function current(): BrowserSyncSession {
  if (session === undefined) throw new Error('no session');
  return session;
}

function source(): ContentSource {
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

/** Every row of one of this feature's tables on the device: absence means absent, not hidden. */
export async function storedRows(table: string): Promise<readonly string[]> {
  if (!['campaign_sessions', 'session_gm_notes', 'session_log_entries'].includes(table)) {
    throw new Error('unknown table');
  }
  const rows = await current().database.getAll<Record<string, unknown>>(`SELECT * FROM ${table}`);
  return rows.map((row) => JSON.stringify(row));
}

export async function storedEntityNames(): Promise<readonly string[]> {
  const rows = await current().database.getAll<{ name: string }>(
    'SELECT name FROM content_entities',
  );
  return rows.map((row) => row.name);
}

async function created(result: Promise<{ ok: boolean; value?: { id: string; version: number } }>) {
  const value = await result;
  if (!value.ok || value.value === undefined) throw new Error('create failed');
  return value.value;
}

/** A scene located at a location, with one NPC in it, all GM-only unless `revealScene`. */
export async function seedScene(input: {
  readonly scene: string;
  readonly location: string;
  readonly npc: string;
  readonly revealScene?: boolean;
}): Promise<string> {
  const { entities, relationships } = source();
  const scene = await created(entities.create({ type: 'scene', name: input.scene }));
  const location = await created(entities.create({ type: 'location', name: input.location }));
  const npc = await created(entities.create({ type: 'npc', name: input.npc, summary: 'Nervous' }));
  await relationships.link({
    sourceEntityId: scene.id,
    targetEntityId: location.id,
    kind: 'located_at',
  });
  await relationships.link({
    sourceEntityId: npc.id,
    targetEntityId: scene.id,
    kind: 'appears_in',
  });
  if (input.revealScene === true) {
    await entities.changeVisibility(
      scene.id,
      { operation: 'reveal', target: { mode: 'everyone' } },
      scene.version,
    );
  }
  return scene.id;
}

export async function createHandout(input: { readonly title: string; readonly text: string }) {
  return (
    await created(
      source().entities.create({
        type: HANDOUT_ENTITY_TYPE,
        name: input.title,
        description: input.text,
      }),
    )
  ).id;
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
