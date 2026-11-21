import { ACTIONS_REPLICA_TABLES } from '@rpg/actions';
import type { OfflineAttachmentStore } from '@rpg/attachments/offline';
import { CHARACTER_REPLICA_TABLES } from '@rpg/characters';
import { CONTENT_REPLICA_TABLES } from '@rpg/content';
import { DICE_REPLICA_TABLES } from '@rpg/dice';
import { ENCOUNTER_REPLICA_TABLES } from '@rpg/encounters';
import { RULES_REPLICA_TABLES } from '@rpg/rules';
import { SESSION_REPLICA_TABLES } from '@rpg/sessions';
import type { LocalAuditRead, SyncStatus } from '@rpg/sync';
import type { BrowserSyncSession } from '@rpg/sync/browser';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ContentDraftStore } from '../content/draft-store.ts';
import { EXPORT_REPLICA_TABLES } from '../portability/replica-export.ts';
import { reconcileMembershipCache } from './membership-rule.ts';

/** Feature 05: at most one offline-set reconciliation per this interval while synchronized. */
const ATTACHMENT_RECONCILE_MS = 30_000;

/**
 * Opens the signed-in user's browser replica (local first, usable offline), starts provider
 * synchronization, and exposes its status. `campaignId` names a campaign the user just joined or
 * opened, so a first bootstrap has a campaign to authorize against.
 *
 * Feature 05 task 05: the user's offline attachment store opens beside the replica and is a
 * `ReplicaPurgeListener`, so revocation, campaign deletion and sign-out remove attachment bytes
 * and metadata together with the replica. Each observed synchronization (throttled) reconciles
 * the device's attachments against the authority's current offline set (narrowing, deletion).
 *
 * Feature 16 task 12: the user's long-text draft store (D-17) is a `ReplicaPurgeListener` too, and
 * sign-out clears it. The open session is exposed for the content screens.
 */
export function useBrowserSync(userId: string | undefined, campaignId: string | undefined) {
  const [status, setStatus] = useState<SyncStatus>();
  const [attachments, setAttachments] = useState<OfflineAttachmentStore>();
  const [openSession, setOpenSession] = useState<BrowserSyncSession>();
  const drafts = useMemo(
    () => (userId === undefined ? undefined : ContentDraftStore.forUser(userId)),
    [userId],
  );
  const session = useRef<BrowserSyncSession | undefined>(undefined);
  const attachmentStore = useRef<OfflineAttachmentStore | undefined>(undefined);

  useEffect(() => {
    if (userId === undefined || campaignId === undefined || drafts === undefined) return;
    let cancelled = false;
    let opened: BrowserSyncSession | undefined;
    let closeAttachments = () => {};
    let unsubscribe = () => {};
    const start = async () => {
      const store = await openAttachmentStore(userId).catch(() => undefined);
      if (store !== undefined) {
        closeAttachments = store.close;
        if (cancelled) return closeAttachments();
        attachmentStore.current = store.store;
        setAttachments(store.store);
      }
      const { BrowserSyncSession } = await import('@rpg/sync/browser');
      if (cancelled) return;
      opened = await BrowserSyncSession.open({
        userId,
        reconcile: reconcileMembershipCache,
        listeners: store === undefined ? [drafts] : [store.store, drafts],
        // Feature 16: campaign entities and personal notes (stream `authorized_content`).
        // Feature 07: exact pins and export metadata (stream `campaign_export_metadata`).
        // Feature 09: recorded rolls (stream `authorized_rolls`).
        // Feature 11: effect applications (stream `authorized_effects`).
        tables: {
          ...CONTENT_REPLICA_TABLES,
          ...DICE_REPLICA_TABLES,
          ...ACTIONS_REPLICA_TABLES,
          // Feature 15: characters and their GM-only half (stream `authorized_characters`).
          ...CHARACTER_REPLICA_TABLES,
          // Feature 18: sessions, GM notes (GM roles), log entries (stream `authorized_sessions`).
          ...SESSION_REPLICA_TABLES,
          // Feature 19: encounters, participants, GM notes and instance states (GM roles).
          ...ENCOUNTER_REPLICA_TABLES,
          // Feature 14: the user's own section marks (stream `authorized_rules_marks`).
          ...RULES_REPLICA_TABLES,
          ...EXPORT_REPLICA_TABLES,
        },
      });
      if (cancelled) {
        await opened.close();
        return;
      }
      session.current = opened;
      setOpenSession(opened);
      let lastReconciled = 0;
      unsubscribe = opened.status.subscribe((next) => {
        setStatus(next);
        const now = Date.now();
        if (next.state === 'synchronized' && now - lastReconciled >= ATTACHMENT_RECONCILE_MS) {
          lastReconciled = now;
          void store?.store.reconcileAll().catch(() => undefined);
        }
      });
      await opened.connect(campaignId);
    };
    start().catch(() => setStatus(undefined));
    return () => {
      cancelled = true;
      unsubscribe();
      if (session.current === opened) session.current = undefined;
      setOpenSession(undefined);
      attachmentStore.current = undefined;
      setAttachments(undefined);
      void opened?.close();
      closeAttachments();
    };
  }, [userId, campaignId, drafts]);

  return {
    status,
    /** The open browser replica session (undefined until opened). */
    session: openSession,
    /** Feature 16 D-17: this user's device-only long-text drafts. */
    drafts,
    /** Feature 05: this user's offline attachment store (undefined until opened). */
    attachments,
    /** Removes every campaign replica, queued mutation and attachment byte from this device. */
    signOut: async () => {
      await session.current?.signOut();
      await attachmentStore.current?.clear();
      drafts?.clear();
    },
    /** Feature 06 task 04/05: the replica's merged audit log (pending above accepted). */
    readLocalAudit: async (
      campaignId: string,
      input: {
        readonly store: 'campaign' | 'private';
        readonly sessionId?: string;
        readonly filters: { actorId?: string; targetType?: string; targetId?: string };
      },
    ): Promise<LocalAuditRead | undefined> =>
      session.current?.audit.read({
        campaignId,
        store: input.store,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.filters.actorId === undefined ? {} : { actorUserId: input.filters.actorId }),
        ...(input.filters.targetType === undefined ? {} : { targetType: input.filters.targetType }),
        ...(input.filters.targetId === undefined ? {} : { targetId: input.filters.targetId }),
      }),
  };
}

async function openAttachmentStore(userId: string) {
  const [{ OfflineAttachmentStore }, { IndexedDbOfflineAttachmentDb, offlineAttachmentDbName }] =
    await Promise.all([import('@rpg/attachments/offline'), import('../attachments/offline-db.ts')]);
  const { httpOfflineAttachmentSource } = await import('../attachments/offline-source.ts');
  const db = await IndexedDbOfflineAttachmentDb.open(offlineAttachmentDbName(userId));
  const store = new OfflineAttachmentStore({ db, source: httpOfflineAttachmentSource() });
  await store.start();
  return { store, close: () => db.close() };
}
