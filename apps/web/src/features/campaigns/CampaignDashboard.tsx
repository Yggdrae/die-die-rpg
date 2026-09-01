import type { CampaignView, SystemDefinition, SystemSummary } from '@rpg/campaigns';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { type FormEvent, useCallback, useEffect, useReducer, useState } from 'react';
import { apiRequest } from '../../api.ts';
import { CampaignAdmin } from '../identity/CampaignAdmin.tsx';
import { initialWizardState, toCreateInput, wizardReducer } from './wizard-state.ts';

const INSTALLED_MANIFESTS: readonly SystemDefinition[] = [FIXTURE_SYSTEM_DEFINITION];

export function CampaignDashboard(props: {
  readonly initialCampaignId?: string;
  readonly userId?: string;
  readonly onLogout: () => void;
}) {
  const [campaigns, setCampaigns] = useState<readonly CampaignView[]>([]);
  const [systems, setSystems] = useState<readonly SystemDefinition[]>([]);
  const [systemQuery, setSystemQuery] = useState('');
  const [error, setError] = useState<string>();
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState());

  useEffect(() => {
    apiRequest<CampaignView[]>('/campaigns')
      .then(setCampaigns)
      .catch(() => setCampaigns([]));
  }, []);

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
        <button
          type="button"
          onClick={() =>
            apiRequest<void>('/auth/session', { method: 'DELETE' }).then(props.onLogout)
          }
        >
          Log out
        </button>
      </header>
      <section aria-labelledby="campaign-list-title">
        <h2 id="campaign-list-title">Your campaigns</h2>
        {campaigns.length === 0 ? (
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
        <form onSubmit={create}>
          <fieldset>
            <legend>System</legend>
            {systems.map((system) => (
              <label key={`${system.summary.ref.systemId}@${system.summary.ref.version}`}>
                <input
                  type="radio"
                  name="system"
                  checked={state.system?.summary.ref.systemId === system.summary.ref.systemId}
                  onChange={() => dispatch({ type: 'select_system', system })}
                />
                {system.summary.name} — {system.summary.shortDescription}
                <small>
                  Mechanics{' '}
                  {system.summary.integration.mechanicsSupported ? 'supported; ' : 'unsupported; '}
                  rules text{' '}
                  {system.summary.integration.rulesTextIntegrated ? 'integrated' : 'not integrated'}
                  .
                </small>
              </label>
            ))}
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
