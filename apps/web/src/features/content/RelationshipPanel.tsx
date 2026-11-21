import {
  CONTENT_CONFIGURATION,
  ENTITY_RELATIONSHIP_CLASS,
  type EntityRecord,
  type RelationshipRecord,
} from '@rpg/content';
import type { Visibility } from '@rpg/contracts';
import { type FormEvent, useState } from 'react';
import { VisibilityControls } from '../visibility/VisibilityControls.tsx';
import { contentErrorMessage, type RelationshipView, relationshipViews } from './content-model.ts';
import type { ContentSource } from './content-source.ts';
import { RelationshipListView } from './EntityViews.tsx';

/**
 * Task 13: an entity's links in both directions (inverse labels from configuration), broken links
 * to deleted entities, and for GM roles create/remove plus the feature 04 `VisibilityControls`
 * per link (`entity_relationship`). A reveal wider than an endpoint is refused by the server
 * (B-1, 400 `incompatible_visibility`) and the controls show its validation message.
 */
export function RelationshipPanel(props: {
  readonly source: ContentSource;
  readonly entity: EntityRecord;
  readonly entities: readonly EntityRecord[];
  readonly allEntities: ReadonlyMap<string, EntityRecord>;
  readonly links: readonly RelationshipRecord[];
  readonly canLink: boolean;
  readonly viewerRole?: string;
  readonly onOpen: (entityId: string) => void;
}) {
  const { source, entity } = props;
  const rows = relationshipViews(props.links, entity.id, props.allEntities);
  const [kind, setKind] = useState(CONTENT_CONFIGURATION.kinds[0]?.id ?? '');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string>();
  /** Server results of Visibility changes, until the replica delivers them. */
  const [overrides, setOverrides] = useState<
    ReadonlyMap<string, { readonly visibility: Visibility; readonly version: number }>
  >(new Map());
  const candidates = props.entities.filter((candidate) => candidate.id !== entity.id);

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const submitted = target;
    const linked = await source.relationships.link({
      sourceEntityId: entity.id,
      targetEntityId: submitted,
      kind,
    });
    if (!linked.ok) {
      setError(contentErrorMessage(linked.error));
      return;
    }
    // Only the submitted choice is cleared: the next endpoint may already be selected.
    setTarget((current) => (current === submitted ? '' : current));
  }

  function current(row: RelationshipView) {
    const override = overrides.get(row.link.id);
    return override !== undefined && override.version > row.link.version
      ? override
      : { visibility: row.link.visibility, version: row.link.version };
  }

  function remember(id: string, value: { visibility: Visibility; version: number }) {
    setOverrides((existing) => new Map(existing).set(id, value));
  }

  return (
    <section aria-label="Links">
      <h4>Links</h4>
      <RelationshipListView
        rows={rows.map((row) => ({ ...row, link: { ...row.link, ...current(row) } }))}
        onOpen={props.onOpen}
        controls={(row) =>
          props.canLink ? (
            <>
              {' '}
              <button
                type="button"
                onClick={() => {
                  const local = props.links.find((link) => link.id === row.link.id);
                  if (local !== undefined)
                    void source.relationships.unlink(local.id, local.version);
                }}
              >
                Remove link
              </button>
              <VisibilityControls
                campaignId={source.campaignId}
                resourceClass={ENTITY_RELATIONSHIP_CLASS}
                resourceId={row.link.id}
                visibility={row.link.visibility}
                version={row.link.version}
                {...(props.viewerRole === undefined ? {} : { viewerRole: props.viewerRole })}
                onChanged={(result) => remember(row.link.id, result)}
                onReload={async () => {
                  const reloaded = await reloadLink(source.campaignId, entity.id, row.link.id);
                  if (reloaded !== undefined) remember(row.link.id, reloaded);
                }}
              />
            </>
          ) : null
        }
      />
      {props.canLink && (
        <form aria-label="Link entity" onSubmit={(event) => void link(event)}>
          <label>
            Relationship
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              {CONTENT_CONFIGURATION.kinds.map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.label}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Entity
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">Choose…</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>{' '}
          <button type="submit" disabled={target === ''}>
            Link
          </button>
          {error !== undefined && <p role="alert">{error}</p>}
        </form>
      )}
    </section>
  );
}

/** The 409 carries no current version: the host refetches the link from the server. */
async function reloadLink(campaignId: string, entityId: string, linkId: string) {
  const response = await fetch(
    `/campaigns/${encodeURIComponent(campaignId)}/entities/${encodeURIComponent(entityId)}/relationships`,
    { credentials: 'include' },
  );
  if (!response.ok) throw new Error('reload_failed');
  const body = (await response.json()) as {
    items?: { id: string; visibility: Visibility; version: number }[];
  };
  const found = body.items?.find((item) => item.id === linkId);
  return found === undefined ? undefined : { visibility: found.visibility, version: found.version };
}
