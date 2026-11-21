import type { LocalAuditRead } from '@rpg/sync';
import { useCallback, useEffect, useState } from 'react';
import { type AuditPageResult, type FetchLike, fetchAuditPage } from './audit-api.ts';
import {
  type AuditFilters,
  type AuditPageView,
  type AuditStore,
  type AuditViewModel,
  canViewPrivate,
  type MemberName,
  offlineView,
  onlineView,
  stateLabel,
} from './audit-model.ts';

/**
 * Feature 06 task 05: campaign and session audit log.
 *
 * The GM-private tab is shown only to GM roles. That is a hint: the private route answers the
 * safe 404 to anyone else, and the player replica has no private table to read offline.
 */

export type AuditPanelStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

export interface AuditLogViewProps {
  readonly store: AuditStore;
  readonly showPrivateTab: boolean;
  readonly sessionId?: string;
  readonly members: readonly MemberName[];
  readonly filters: AuditFilters;
  readonly model: AuditViewModel;
  readonly status: AuditPanelStatus;
  readonly online: boolean;
  readonly canLoadMore: boolean;
  readonly notice?: string;
  readonly onStore: (store: AuditStore) => void;
  readonly onFilters: (filters: AuditFilters) => void;
  readonly onLoadMore: () => void;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace('T', ' ').slice(0, 19);
}

export function AuditLogView(props: AuditLogViewProps) {
  const title =
    props.sessionId === undefined ? 'Campaign history' : `Session history (${props.sessionId})`;
  return (
    <section aria-label={title} data-audit-store={props.store}>
      <h3>{title}</h3>
      <div role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={props.store === 'campaign'}
          onClick={() => props.onStore('campaign')}
        >
          Campaign log
        </button>
        {props.showPrivateTab && (
          <button
            type="button"
            role="tab"
            aria-selected={props.store === 'private'}
            onClick={() => props.onStore('private')}
          >
            GM-private log
          </button>
        )}
      </div>
      <form
        aria-label="Audit filters"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const text = (name: string) => {
            const value = String(data.get(name) ?? '').trim();
            return value === '' ? undefined : value;
          };
          props.onFilters({
            ...(text('actorId') === undefined ? {} : { actorId: text('actorId') }),
            ...(text('targetType') === undefined ? {} : { targetType: text('targetType') }),
            ...(text('targetId') === undefined ? {} : { targetId: text('targetId') }),
          });
        }}
      >
        <label>
          Actor
          <select name="actorId" defaultValue={props.filters.actorId ?? ''}>
            <option value="">Anyone</option>
            {props.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.username}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target type
          <input name="targetType" defaultValue={props.filters.targetType ?? ''} />
        </label>
        <label>
          Target id
          <input name="targetId" defaultValue={props.filters.targetId ?? ''} />
        </label>
        <button type="submit">Apply filters</button>
      </form>
      {!props.online && (
        <p data-testid="audit-offline">Offline: showing the history stored on this device.</p>
      )}
      {props.model.partial && (
        <p data-testid="audit-partial">
          Older history may be missing on this device. Reconnect to load it.
        </p>
      )}
      {props.notice !== undefined && <p role="status">{props.notice}</p>}
      {props.status.kind === 'unavailable' && (
        <p data-testid="audit-unavailable">This log is not available to you.</p>
      )}
      {props.status.kind === 'failed' && <p role="alert">History could not be loaded.</p>}
      {props.status.kind === 'loading' && <p>Loading history…</p>}
      {props.model.totalLabel !== undefined && (
        <p data-testid="audit-total">{props.model.totalLabel}</p>
      )}
      {props.status.kind === 'ready' && props.model.items.length === 0 && <p>No history yet.</p>}
      <ol data-testid="audit-entries">
        {props.model.items.map((item) => {
          const label = stateLabel(item.state);
          return (
            <li
              key={`${item.source}:${item.id}`}
              data-audit-id={item.id}
              data-audit-state={item.state}
              data-audit-source={item.source}
            >
              <time dateTime={item.at}>{formatTime(item.at)}</time> <strong>{item.actor}</strong>{' '}
              <span>{item.text}</span>
              {label !== undefined && <em data-testid="audit-state"> ({label})</em>}
            </li>
          );
        })}
      </ol>
      {props.canLoadMore && (
        <button type="button" onClick={props.onLoadMore}>
          Load older entries
        </button>
      )}
    </section>
  );
}

export interface AuditLogProps {
  readonly campaignId: string;
  readonly sessionId?: string;
  /** The viewer's role as the client knows it (hint only). */
  readonly viewerRole?: string;
  readonly members: readonly MemberName[];
  readonly online?: boolean;
  /** The local replica's merged log (task 04), when a browser replica is open. */
  readonly readLocal?: (input: {
    readonly store: AuditStore;
    readonly sessionId?: string;
    readonly filters: AuditFilters;
  }) => Promise<LocalAuditRead | undefined>;
  readonly fetchImpl?: FetchLike;
}

export function AuditLog(props: AuditLogProps) {
  const online = props.online ?? true;
  const showPrivateTab = canViewPrivate(props.viewerRole);
  const [store, setStore] = useState<AuditStore>('campaign');
  const [filters, setFilters] = useState<AuditFilters>({});
  const [pages, setPages] = useState<readonly AuditPageView[]>([]);
  const [model, setModel] = useState<AuditViewModel>({
    items: [],
    partial: false,
    pendingCount: 0,
  });
  const [status, setStatus] = useState<AuditPanelStatus>({ kind: 'loading' });
  const [notice, setNotice] = useState<string>();
  const { campaignId, sessionId, members, readLocal, fetchImpl } = props;

  const local = useCallback(async () => {
    const read = await readLocal?.({
      store,
      ...(sessionId === undefined ? {} : { sessionId }),
      filters,
    }).catch(() => undefined);
    return read?.ok === true ? read.log : undefined;
  }, [readLocal, store, sessionId, filters]);

  const page = useCallback(
    (cursor?: string): Promise<AuditPageResult> =>
      fetchAuditPage(
        {
          campaignId,
          store,
          ...(sessionId === undefined ? {} : { sessionId }),
          filters,
          ...(cursor === undefined ? {} : { cursor }),
        },
        fetchImpl,
      ),
    [campaignId, store, sessionId, filters, fetchImpl],
  );

  const load = useCallback(async () => {
    setStatus({ kind: 'loading' });
    setPages([]);
    if (!online) {
      const log = await local();
      if (log === undefined) {
        setModel({ items: [], partial: true, pendingCount: 0 });
        setStatus({ kind: store === 'private' ? 'unavailable' : 'ready' });
        return;
      }
      setModel(offlineView({ local: log, members }));
      setStatus({ kind: 'ready' });
      return;
    }
    const [result, log] = await Promise.all([page(), local()]);
    if (result.kind !== 'page') {
      setModel({ items: [], partial: false, pendingCount: 0 });
      setStatus({ kind: result.kind === 'unavailable' ? 'unavailable' : 'failed' });
      return;
    }
    setPages([result.page]);
    setModel(onlineView({ pages: [result.page], local: log, members, filters }));
    setStatus({ kind: 'ready' });
  }, [online, local, page, members, filters, store]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    const cursor = pages.at(-1)?.nextCursor;
    if (cursor === undefined) return;
    const result = await page(cursor);
    if (result.kind === 'invalid_cursor') {
      // The anchor became hidden (or changed visibility): restart from the newest entries.
      setNotice('History changed while you were reading it; showing the newest entries again.');
      await load();
      return;
    }
    if (result.kind !== 'page') {
      setStatus({ kind: result.kind === 'unavailable' ? 'unavailable' : 'failed' });
      return;
    }
    const next = [...pages, result.page];
    setPages(next);
    setModel(onlineView({ pages: next, local: await local(), members, filters }));
  }

  return (
    <AuditLogView
      store={store}
      showPrivateTab={showPrivateTab}
      {...(sessionId === undefined ? {} : { sessionId })}
      members={members}
      filters={filters}
      model={model}
      status={status}
      online={online}
      canLoadMore={online && pages.at(-1)?.nextCursor !== undefined}
      {...(notice === undefined ? {} : { notice })}
      onStore={(next) => {
        setNotice(undefined);
        setStore(next);
      }}
      onFilters={(next) => {
        setNotice(undefined);
        setFilters(next);
      }}
      onLoadMore={() => void loadMore()}
    />
  );
}
