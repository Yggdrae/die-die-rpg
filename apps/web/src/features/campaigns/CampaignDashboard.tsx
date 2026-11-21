import type { CampaignView, SystemDefinition, SystemSummary } from '@rpg/campaigns';
import { ErrorCode } from '@rpg/contracts';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import { type SystemPackage, systemDefinitionOf } from '@rpg/systems';
import { type FormEvent, useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { apiRequest } from '../../api.ts';
import { OfflineAttachments } from '../attachments/OfflineAttachments.tsx';
import { CampaignHistory } from '../audit/CampaignHistory.tsx';
import {
  browserCharacterSource,
  CharacterWorkspace,
  characterSearchContribution,
  installedRegistry,
} from '../characters/index.ts';
import {
  browserContentSource,
  CONTENT_SESSION_QUICK_ACTIONS,
  ContentQuickCreateHost,
  ContentWorkspace,
  contentSearchContribution,
} from '../content/index.ts';
import {
  browserEncounterSource,
  ENCOUNTER_SESSION_QUICK_ACTIONS,
  EncounterHost,
  EncounterWorkspace,
  encounterSearchContribution,
} from '../encounters/index.ts';
import {
  HANDOUT_SESSION_QUICK_ACTIONS,
  HandoutRevealHost,
  HandoutsWorkspace,
} from '../handouts/index.ts';
import { CampaignAdmin } from '../identity/CampaignAdmin.tsx';
import { CampaignExport } from '../portability/CampaignExport.tsx';
import { CampaignImport } from '../portability/CampaignImport.tsx';
import { browserReplicaExportSource } from '../portability/replica-export.ts';
import {
  browserRulesSource,
  RulesLibrary,
  RulesPreview,
  rulesSearchContribution,
} from '../rules/index.ts';
import { SearchWorkspace, useSearchService } from '../search/index.ts';
import { browserSessionSource, SessionWorkspace } from '../sessions/index.ts';
import { SyncStatusIndicator } from '../sync/SyncStatus.tsx';
import { useBrowserSync } from '../sync/useBrowserSync.ts';
import { deviceSearchActor, searchPaletteProvider } from './search-composition.ts';
import { initialWizardState, toCreateInput, wizardReducer } from './wizard-state.ts';

/**
 * Feature 18 D-11: Session Mode's quick actions, contributed by the features that own them. A feature adds its
 * action here; Session Mode itself never changes.
 */
const SESSION_QUICK_ACTIONS = [
  ...CONTENT_SESSION_QUICK_ACTIONS,
  ...HANDOUT_SESSION_QUICK_ACTIONS,
  // Feature 19 D-11: "Add encounter" opens the tracker over the session screen.
  ...ENCOUNTER_SESSION_QUICK_ACTIONS,
];

/** Feature 14 D-14: the installed package of a catalog entry, for the rules preview (by reference, never by name). */
function installedPackage(ref: SystemDefinition['summary']['ref']): SystemPackage | undefined {
  return installedRegistry().resolve(ref);
}

const INSTALLED_MANIFESTS: readonly SystemDefinition[] = [
  FIXTURE_SYSTEM_DEFINITION,
  ...(INSTALLED_SYSTEM_PACKAGES as readonly SystemPackage[]).map(systemDefinitionOf),
];

/** Every declared integration status, shown separately; unsupported ones are not omitted. */
function integrationStatus(integration: SystemSummary['integration']): string {
  const supported = (value: boolean) => (value ? 'supported' : 'unsupported');
  const integrated = (value: boolean) => (value ? 'integrated' : 'not integrated');
  return `${[
    `Mechanics ${supported(integration.mechanicsSupported)}`,
    `character sheet ${supported(integration.characterSheetSupported)}`,
    `rules text ${integrated(integration.rulesTextIntegrated)}`,
    `compendium ${integrated(integration.compendiumIntegrated)}`,
    `external documentation ${integration.externalDocumentation === undefined ? 'unavailable' : 'available'}`,
  ].join('; ')}.`;
}

export function CampaignDashboard(props: {
  readonly initialCampaignId?: string;
  /** The campaign this device last opened: the reopened app's way to its replica while offline. */
  readonly lastCampaignId?: string;
  readonly userId?: string;
  readonly onCampaignOpened?: (campaignId: string) => void;
  readonly onLogout: () => void;
}) {
  const { onCampaignOpened, onLogout } = props;
  const [campaigns, setCampaigns] = useState<readonly CampaignView[]>([]);
  const [campaignList, setCampaignList] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [systems, setSystems] = useState<readonly SystemDefinition[]>([]);
  const [systemQuery, setSystemQuery] = useState('');
  const [preview, setPreview] = useState<SystemPackage>();
  const [error, setError] = useState<string>();
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState());
  const syncedCampaignId =
    props.initialCampaignId ??
    (campaignList === 'loaded' ? campaigns[0]?.id : (campaigns[0]?.id ?? props.lastCampaignId));
  const sync = useBrowserSync(props.userId, syncedCampaignId);
  // Feature 15: the campaign's characters over the local replica (offline-capable).
  const characters = useMemo(
    () =>
      sync.session === undefined || props.userId === undefined || syncedCampaignId === undefined
        ? undefined
        : browserCharacterSource(sync.session, {
            userId: props.userId,
            campaignId: syncedCampaignId,
          }),
    [sync.session, props.userId, syncedCampaignId],
  );
  // Feature 16: the campaign's content over the local replica (offline-capable).
  const content = useMemo(
    () =>
      sync.session === undefined ||
      sync.drafts === undefined ||
      props.userId === undefined ||
      syncedCampaignId === undefined
        ? undefined
        : browserContentSource(sync.session, {
            userId: props.userId,
            campaignId: syncedCampaignId,
            drafts: sync.drafts,
          }),
    [sync.session, sync.drafts, props.userId, syncedCampaignId],
  );

  // Feature 18: Session Mode over the local replica (offline-capable).
  const sessions = useMemo(
    () =>
      sync.session === undefined || props.userId === undefined || syncedCampaignId === undefined
        ? undefined
        : browserSessionSource(sync.session, {
            userId: props.userId,
            campaignId: syncedCampaignId,
            resolve: (ref) => installedRegistry().resolve(ref),
          }),
    [sync.session, props.userId, syncedCampaignId],
  );

  // Feature 19: the encounter tracker over the local replica (offline-capable).
  const encounters = useMemo(
    () =>
      sync.session === undefined || props.userId === undefined || syncedCampaignId === undefined
        ? undefined
        : browserEncounterSource(sync.session, {
            userId: props.userId,
            campaignId: syncedCampaignId,
            resolve: (ref) => installedRegistry().resolve(ref),
          }),
    [sync.session, props.userId, syncedCampaignId],
  );

  // Feature 14: the campaign's pinned rules and the user's own marks over the local replica (offline-capable).
  const rules = useMemo(
    () =>
      sync.session === undefined || props.userId === undefined || syncedCampaignId === undefined
        ? undefined
        : browserRulesSource(sync.session, {
            userId: props.userId,
            campaignId: syncedCampaignId,
            resolve: (ref) => installedRegistry().resolve(ref),
          }),
    [sync.session, props.userId, syncedCampaignId],
  );

  // Feature 20 D-09: every owning feature's search contribution over the same replica; search imports none.
  const searchContributions = useMemo(
    () =>
      characters === undefined ||
      content === undefined ||
      encounters === undefined ||
      rules === undefined
        ? undefined
        : [
            contentSearchContribution(content),
            characterSearchContribution(characters),
            encounterSearchContribution(encounters),
            // Feature 14 D-15: rules reach search, and through it the Session Mode palette.
            rulesSearchContribution(rules),
          ],
    [characters, content, encounters, rules],
  );
  const searchActor = useMemo(
    () =>
      sync.session === undefined || props.userId === undefined || syncedCampaignId === undefined
        ? async () => undefined
        : deviceSearchActor(sync.session, {
            userId: props.userId,
            campaignId: syncedCampaignId,
          }),
    [sync.session, props.userId, syncedCampaignId],
  );
  const search = useSearchService({
    campaignId: syncedCampaignId,
    contributions: searchContributions,
    actor: searchActor,
  });
  // Feature 18 D-12: the palette searches through feature 20.
  const paletteProviders = useMemo(
    () => (search === undefined ? undefined : [searchPaletteProvider(search)]),
    [search],
  );

  useEffect(() => {
    apiRequest<CampaignView[]>('/campaigns')
      .then((listed) => {
        setCampaigns(listed);
        setCampaignList('loaded');
      })
      .catch((caught: unknown) => {
        // A rejected session ends here; any other failure is the offline case, replica intact.
        if (caught instanceof Error && caught.message === ErrorCode.UNAUTHENTICATED) onLogout();
        else setCampaignList('unavailable');
      });
  }, [onLogout]);

  useEffect(() => {
    if (syncedCampaignId !== undefined) onCampaignOpened?.(syncedCampaignId);
  }, [syncedCampaignId, onCampaignOpened]);

  const searchSystems = useCallback(async (query = '') => {
    const summaries = await apiRequest<readonly SystemSummary[]>(
      `/systems${query === '' ? '' : `?query=${encodeURIComponent(query)}`}`,
    );
    setSystems(
      summaries.flatMap((summary) => {
        const manifest = INSTALLED_MANIFESTS.find(
          (candidate) =>
            candidate.summary.ref.systemId === summary.ref.systemId &&
            candidate.summary.ref.version === summary.ref.version,
        );
        return manifest === undefined ? [] : [{ ...manifest, summary }];
      }),
    );
  }, []);

  useEffect(() => {
    searchSystems().catch(() => setError('System catalog unavailable.'));
  }, [searchSystems]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const input = toCreateInput(state, crypto.randomUUID());
    if (input === undefined) {
      setError('Complete every required step.');
      return;
    }
    try {
      const campaign = await apiRequest<CampaignView>('/campaigns', {
        method: 'POST',
        headers: { origin: window.location.origin },
        body: JSON.stringify(input),
      });
      if (state.invitationRole !== undefined) {
        await apiRequest(`/campaigns/${campaign.id}/invitations`, {
          method: 'POST',
          headers: { origin: window.location.origin },
          body: JSON.stringify({ targetRole: state.invitationRole }),
        });
      }
      setCampaigns((current) => [campaign, ...current]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Campaign creation failed.');
    }
  }

  return (
    <main>
      <header>
        <h1>Campaigns</h1>
        {props.initialCampaignId !== undefined && <p>Joined campaign {props.initialCampaignId}.</p>}
        {sync.status !== undefined && <SyncStatusIndicator status={sync.status} />}
        <button
          type="button"
          onClick={() =>
            apiRequest<void>('/auth/session', { method: 'DELETE' })
              .then(() => sync.signOut().catch(() => undefined))
              .then(onLogout)
          }
        >
          Log out
        </button>
      </header>
      {search !== undefined && <SearchWorkspace service={search} />}
      {/* Feature 16 D-14: the one quick-create overlay for session quick actions. */}
      <ContentQuickCreateHost {...(content === undefined ? {} : { source: content })} />
      {/* Feature 17 D-08: the reveal overlay for the session quick action. */}
      {/* Feature 18 D-03: a reveal made from Session Mode is logged in that session. */}
      <HandoutRevealHost
        {...(content === undefined ? {} : { source: content })}
        onRevealed={({ sessionId, handoutId }) => void sessions?.log.reveal(sessionId, handoutId)}
      />
      {/* Feature 19 D-11: the tracker overlay for the session quick action. */}
      <EncounterHost {...(encounters === undefined ? {} : { source: encounters })} />
      {sessions !== undefined && (
        <SessionWorkspace
          source={sessions}
          quickActions={SESSION_QUICK_ACTIONS}
          {...(paletteProviders === undefined ? {} : { paletteProviders })}
        />
      )}
      {encounters !== undefined && <EncounterWorkspace source={encounters} />}
      {rules !== undefined && <RulesLibrary source={rules} />}
      {characters !== undefined && <CharacterWorkspace source={characters} />}
      {content !== undefined && <HandoutsWorkspace source={content} />}
      {content !== undefined && <ContentWorkspace source={content} />}
      <section aria-labelledby="campaign-list-title">
        <h2 id="campaign-list-title">Your campaigns</h2>
        {campaignList === 'unavailable' ? (
          <p role="status">The campaign list needs a connection. Local content stays available.</p>
        ) : campaigns.length === 0 ? (
          <p>No campaign yet.</p>
        ) : (
          <ul>
            {campaigns.map((campaign) => (
              <li key={campaign.id}>
                <strong>{campaign.name}</strong>{' '}
                <small>
                  {campaign.system.systemId}@{campaign.system.version}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="wizard-title">
        <h2 id="wizard-title">Create campaign</h2>
        <search>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              searchSystems(systemQuery).catch(() => setError('System catalog unavailable.'));
            }}
          >
            <label>
              Search systems
              <input value={systemQuery} onChange={(event) => setSystemQuery(event.target.value)} />
            </label>
            <button type="submit">Search</button>
          </form>
        </search>
        {/* Feature 14 FR-008: the rules before a campaign exists, outside the creation form; the selection does
            not change. */}
        {preview !== undefined && (
          <RulesPreview system={preview} onClose={() => setPreview(undefined)} />
        )}
        <form onSubmit={create}>
          <fieldset>
            <legend>System</legend>
            {systems.map((system) => {
              const { integration } = system.summary;
              const installed = installedPackage(system.summary.ref);
              return (
                <div key={`${system.summary.ref.systemId}@${system.summary.ref.version}`}>
                  <label>
                    <input
                      type="radio"
                      name="system"
                      checked={state.system?.summary.ref.systemId === system.summary.ref.systemId}
                      onChange={() => dispatch({ type: 'select_system', system })}
                    />
                    {system.summary.name} — {system.summary.shortDescription}
                    <small>{integrationStatus(integration)}</small>
                  </label>{' '}
                  <a href={system.summary.rulesEntryPoint} target="_blank" rel="noreferrer">
                    Rules for {system.summary.name}
                  </a>{' '}
                  {installed !== undefined && (
                    <button type="button" onClick={() => setPreview(installed)}>
                      Preview rules of {system.summary.name}
                    </button>
                  )}
                </div>
              );
            })}
            {systems.length === 0 && <p>No installed system matches.</p>}
          </fieldset>
          {state.system !== undefined && (
            <fieldset>
              <legend>Game mode</legend>
              {state.system.gameModes.map((mode) => (
                <label key={mode.id}>
                  <input
                    type="radio"
                    name="gameMode"
                    checked={state.gameMode === mode.id}
                    onChange={() => dispatch({ type: 'select_mode', gameMode: mode.id })}
                  />
                  {mode.label}
                </label>
              ))}
            </fieldset>
          )}
          {state.system !== undefined && state.system.options.length > 0 && (
            <fieldset>
              <legend>System options</legend>
              {state.system.options.map((option) => {
                const value = state.options[option.key] ?? option.default;
                if (option.type === 'boolean') {
                  return (
                    <label key={option.key}>
                      <input
                        type="checkbox"
                        checked={value === true}
                        onChange={(event) =>
                          dispatch({
                            type: 'set_option',
                            key: option.key,
                            value: event.target.checked,
                          })
                        }
                      />
                      {option.label}
                    </label>
                  );
                }
                if (option.type === 'select') {
                  return (
                    <label key={option.key}>
                      {option.label}
                      <select
                        value={String(value)}
                        onChange={(event) =>
                          dispatch({
                            type: 'set_option',
                            key: option.key,
                            value: event.target.value,
                          })
                        }
                      >
                        {option.values.map((choice) => (
                          <option key={choice} value={choice}>
                            {choice}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                }
                return (
                  <label key={option.key}>
                    {option.label}
                    <input
                      value={String(value)}
                      minLength={option.minLength}
                      maxLength={option.maxLength}
                      onChange={(event) =>
                        dispatch({ type: 'set_option', key: option.key, value: event.target.value })
                      }
                    />
                  </label>
                );
              })}
            </fieldset>
          )}
          {state.system !== undefined && state.system.compatibleModules.length > 0 && (
            <fieldset>
              <legend>Modules</legend>
              {state.system.compatibleModules.map((module) => (
                <label key={module.id}>
                  <input
                    type="checkbox"
                    checked={state.moduleIds.includes(module.id)}
                    onChange={() => dispatch({ type: 'toggle_module', moduleId: module.id })}
                  />
                  {module.name}
                </label>
              ))}
            </fieldset>
          )}
          <label>
            Campaign name
            <input
              value={state.name}
              maxLength={120}
              required
              onChange={(event) =>
                dispatch({
                  type: 'set_details',
                  name: event.target.value,
                  description: state.description,
                })
              }
            />
          </label>
          <label>
            Description
            <textarea
              value={state.description}
              maxLength={10_000}
              onChange={(event) =>
                dispatch({
                  type: 'set_details',
                  name: state.name,
                  description: event.target.value,
                })
              }
            />
          </label>
          <label>
            Optional first invitation
            <select
              value={state.invitationRole ?? ''}
              onChange={(event) =>
                dispatch({
                  type: 'set_invitation_role',
                  role:
                    event.target.value === ''
                      ? undefined
                      : (event.target.value as 'gm' | 'assistant_gm' | 'player'),
                })
              }
            >
              <option value="">None</option>
              <option value="gm">GM</option>
              <option value="assistant_gm">Assistant GM</option>
              <option value="player">Player</option>
            </select>
          </label>
          <button type="submit">Create campaign</button>
          {state.system !== undefined &&
            state.gameMode !== undefined &&
            state.name.trim() !== '' && (
              <p>
                Review: {state.name.trim()} — {state.system.summary.name}, {state.gameMode};{' '}
                {state.moduleIds.length} module(s).
              </p>
            )}
          {error !== undefined && <p role="alert">{error}</p>}
        </form>
      </section>
      <CampaignImport
        onImported={() => {
          apiRequest<CampaignView[]>('/campaigns')
            .then((listed) => {
              setCampaigns(listed);
              setCampaignList('loaded');
            })
            .catch(() => undefined);
        }}
      />
      {campaigns[0] !== undefined && (
        <CampaignHistory
          campaignId={campaigns[0].id}
          {...(props.userId === undefined ? {} : { userId: props.userId })}
          readLocal={(input) => sync.readLocalAudit(campaigns[0]?.id ?? '', input)}
        />
      )}
      {campaigns[0] !== undefined && sync.attachments !== undefined && (
        <details>
          <summary>Offline attachments</summary>
          <OfflineAttachments campaignId={campaigns[0].id} store={sync.attachments} />
        </details>
      )}
      {syncedCampaignId !== undefined && (
        <details>
          <summary>Export</summary>
          <CampaignExport
            campaignId={syncedCampaignId}
            offline={browserReplicaExportSource({
              ...(sync.session === undefined ? {} : { session: sync.session }),
              displayName: 'Game master',
              // The browser has no build version yet; the API default is the same.
              applicationVersion: '0.0.0',
            })}
          />
        </details>
      )}
      {campaigns[0] !== undefined && (
        <CampaignAdmin
          campaign={campaigns[0]}
          userId={props.userId}
          onCampaignUpdated={(updated) =>
            setCampaigns((current) =>
              current.map((campaign) => (campaign.id === updated.id ? updated : campaign)),
            )
          }
          onCampaignDeleted={(deletedId) =>
            setCampaigns((current) => current.filter((campaign) => campaign.id !== deletedId))
          }
        />
      )}
    </main>
  );
}
