import { ACTIONS_REPLICA_TABLES } from '@rpg/actions';
import { CAMPAIGN_EXPORT_REPLICA_TABLES } from '@rpg/campaigns/export';
import { CHARACTER_REPLICA_TABLES } from '@rpg/characters';
import { DICE_REPLICA_TABLES } from '@rpg/dice';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { reconcileMembershipCache } from '../sync/membership-rule.ts';
import { CharacterWorkspace } from './CharacterWorkspace.tsx';
import { browserCharacterSource, type CharacterSource } from './character-source.ts';

/**
 * Playwright-only host (imported dynamically from `characters.e2e.ts`; never from production code): the
 * dashboard's character composition alone, over the production browser replica.
 */

let session: BrowserSyncSession | undefined;
let campaign: string | undefined;

function current(): BrowserSyncSession {
  if (session === undefined) throw new Error('no session');
  return session;
}

function Harness(props: { readonly source: CharacterSource }) {
  return <CharacterWorkspace source={props.source} />;
}

function Loader(props: { readonly userId: string; readonly campaignId: string }) {
  const [source, setSource] = useState<CharacterSource>();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { BrowserSyncSession } = await import('@rpg/sync/browser');
      const opened = await BrowserSyncSession.open({
        userId: props.userId,
        reconcile: reconcileMembershipCache,
        tables: {
          ...CHARACTER_REPLICA_TABLES,
          ...ACTIONS_REPLICA_TABLES,
          ...DICE_REPLICA_TABLES,
          ...CAMPAIGN_EXPORT_REPLICA_TABLES,
        },
      });
      await opened.connect(props.campaignId);
      if (cancelled) return;
      session = opened;
      setSource(browserCharacterSource(opened, props));
    })();
    return () => {
      cancelled = true;
    };
  }, [props]);
  return source === undefined ? <p>Opening the replica…</p> : <Harness source={source} />;
}

export function mountCharacters(input: { readonly userId: string; readonly campaignId: string }) {
  campaign = input.campaignId;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  createRoot(host).render(<Loader {...input} />);
}

export async function pauseSync(): Promise<void> {
  await current().disconnect();
}

export async function resumeSync(): Promise<void> {
  await current().connect(campaign);
}

export async function pendingCount(): Promise<number> {
  return current().store.pendingCount();
}

export async function storedCharacters(): Promise<readonly string[]> {
  const rows = await current().database.getAll<{ id: string }>('SELECT id FROM characters');
  return rows.map((row) => row.id);
}
