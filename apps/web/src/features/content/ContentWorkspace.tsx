import {
  attachmentVisibilityFor,
  CAMPAIGN_ENTITY_CLASS,
  type EntityRecord,
  type LocalEntityFilter,
  matchesEntityFilter,
  QUICK_CREATE_ENTRY_POINTS,
  type QuickCreateEntryPoint,
} from '@rpg/content';
import type { Visibility } from '@rpg/contracts';
import { useEffect, useRef, useState } from 'react';
import { useRouteTarget } from '../../routes.ts';
import { ConflictSurface } from '../sync/SyncStatus.tsx';
import { VisibilityControls } from '../visibility/VisibilityControls.tsx';
import {
  type ContentAffordances,
  contentAffordances,
  contentErrorMessage,
  tagOptions,
  visibilityOptions,
} from './content-model.ts';
import type { ContentSource } from './content-source.ts';
import { EntityAttachments } from './EntityAttachments.tsx';
import { EntityEditor } from './EntityEditor.tsx';
import {
  EntityDetailView,
  EntityFiltersView,
  EntityListView,
  QuickCreateForm,
} from './EntityViews.tsx';
import { LongTextEditor } from './LongTextEditor.tsx';
import { PersonalNotes } from './PersonalNotes.tsx';
import { RelationshipPanel } from './RelationshipPanel.tsx';
import { CONTENT_ROUTE } from './search-contribution.ts';
import { type ContentData, useContentData } from './useContentData.ts';

/**
 * Feature 16 web screen: one generic list and detail for every type over the local replica
 * (works offline), quick create entry points, the feature 03 conflict surface, and the player's
 * own notes. Which entry points and controls appear is a hint from the declarations and the
 * cached role (`contentAffordances`); the authority re-decides every write.
 */
export function ContentWorkspace(props: { readonly source: ContentSource }) {
  const { source } = props;
  const data = useContentData(source);
  const affordances = contentAffordances(data.role);
  const [filter, setFilter] = useState<LocalEntityFilter>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [quick, setQuick] = useState<{ readonly entry?: QuickCreateEntryPoint }>();
  const visible = data.entities.filter((record) => matchesEntityFilter(record, filter));
  const selected = data.entities.find((record) => record.id === selectedId);
  // Feature 20 D-10: a search result (or any link) to this view selects the record and shows it.
  const target = useRouteTarget(CONTENT_ROUTE);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (target === undefined) return;
    setFilter({});
    setSelectedId(target.id);
    section.current?.scrollIntoView?.({ block: 'start' });
  }, [target]);

  return (
    <section ref={section} aria-label="Campaign content" data-content-loaded={data.loaded}>
      <h2>Campaign content</h2>
      <ConflictSurface
        conflicts={data.conflicts}
        onDefer={(id) => void withConflict(data, id, (conflict) => source.deferConflict(conflict))}
        onKeepAuthority={(id) =>
          void withConflict(data, id, (conflict) =>
            source.resolveConflict(conflict, 'keep_authority'),
          )
        }
        onResubmitMine={(id) =>
          void withConflict(data, id, (conflict) => source.resolveConflict(conflict, 'resubmit'))
        }
      />
      {affordances.createEntities && (
        <div role="toolbar" aria-label="Create entities">
          <button type="button" onClick={() => setQuick({})}>
            New entity
          </button>
          {QUICK_CREATE_ENTRY_POINTS.map((entry) => (
            <button key={entry.id} type="button" onClick={() => setQuick({ entry })}>
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {quick !== undefined && (
        <QuickCreateForm
          key={quick.entry?.id ?? 'default'}
          {...(quick.entry === undefined ? {} : { entry: quick.entry })}
          onCancel={() => setQuick(undefined)}
          onSave={async (input) => {
            const created = await source.entities.quickCreate(input);
            if (!created.ok) return contentErrorMessage(created.error);
            setQuick(undefined);
            setSelectedId(created.value.id);
            return undefined;
          }}
        />
      )}
      <EntityFiltersView
        filter={filter}
        tags={tagOptions(data.entities)}
        visibilityModes={visibilityOptions(data.entities)}
        onChange={setFilter}
      />
      <EntityListView
        records={visible}
        total={data.entities.length}
        {...(selectedId === undefined ? {} : { selectedId })}
        onSelect={setSelectedId}
      />
      {selected !== undefined && (
        <EntityDetail
          key={selected.id}
          source={source}
          record={selected}
          data={data}
          affordances={affordances}
          onOpen={setSelectedId}
          onDeleted={() => setSelectedId(undefined)}
        />
      )}
      {affordances.personalNotes && <PersonalNotes source={source} notes={data.notes} />}
    </section>
  );
}

async function withConflict(
  data: ContentData,
  conflictId: string,
  act: (conflict: ContentData['conflicts'][number]) => Promise<void>,
): Promise<void> {
  const conflict = data.conflicts.find((candidate) => candidate.conflictId === conflictId);
  if (conflict !== undefined) await act(conflict);
}

function EntityDetail(props: {
  readonly source: ContentSource;
  readonly record: EntityRecord;
  readonly data: ContentData;
  readonly affordances: ContentAffordances;
  readonly onOpen: (id: string) => void;
  readonly onDeleted: () => void;
}) {
  const { source, record, data, affordances } = props;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  /** The server's result of a Visibility change, until the replica delivers it. */
  const [override, setOverride] = useState<{ visibility: Visibility; version: number }>();
  const shown =
    override !== undefined && override.version > record.version
      ? { ...record, visibility: override.visibility }
      : record;
  const visibilityVersion =
    override !== undefined && override.version > record.version ? override.version : record.version;

  return (
    <EntityDetailView record={shown}>
      {affordances.editEntities &&
        (editing ? (
          <EntityEditor
            source={source}
            record={record}
            visibleRecords={data.entities}
            onDone={() => setEditing(false)}
          />
        ) : (
          <button type="button" onClick={() => setEditing(true)}>
            Edit details
          </button>
        ))}
      {affordances.editEntities && (
        <LongTextEditor
          source={source}
          field={{
            resourceClass: CAMPAIGN_ENTITY_CLASS,
            recordId: record.id,
            fieldPath: 'description',
          }}
          label="Description"
          text={record.description}
          version={record.version}
          save={(text, hold) => source.entities.saveDescription(record.id, text, hold)}
        />
      )}
      {affordances.deleteEntities && (
        <button
          type="button"
          onClick={async () => {
            const removed = await source.entities.remove(record.id, record.version);
            if (!removed.ok) setError(contentErrorMessage(removed.error));
            else props.onDeleted();
          }}
        >
          Delete entity
        </button>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
      <VisibilityControls
        campaignId={source.campaignId}
        resourceClass={CAMPAIGN_ENTITY_CLASS}
        resourceId={record.id}
        visibility={shown.visibility}
        version={visibilityVersion}
        {...(data.role === undefined ? {} : { viewerRole: data.role })}
        onChanged={setOverride}
        onReload={async () => setOverride(await reloadEntity(source.campaignId, record.id))}
      />
      <RelationshipPanel
        source={source}
        entity={record}
        entities={data.entities}
        allEntities={data.allEntities}
        links={data.links}
        canLink={affordances.linkEntities}
        {...(data.role === undefined ? {} : { viewerRole: data.role })}
        onOpen={props.onOpen}
      />
      <EntityAttachments
        campaignId={source.campaignId}
        entityId={record.id}
        visibility={attachmentVisibilityFor(record.type, shown.visibility)}
        canAttach={affordances.editEntities}
      />
    </EntityDetailView>
  );
}

/** Feature 04 409 carries no current version: the host refetches the entity from the server. */
async function reloadEntity(campaignId: string, entityId: string) {
  const response = await fetch(
    `/campaigns/${encodeURIComponent(campaignId)}/entities/${encodeURIComponent(entityId)}`,
    { credentials: 'include' },
  );
  if (!response.ok) throw new Error('reload_failed');
  const body = (await response.json()) as { visibility: Visibility; version: number };
  return { visibility: body.visibility, version: body.version };
}
