import { FIXTURE_CAMPAIGN, FIXTURE_ENTITIES } from '@rpg/fixtures';

/**
 * Web shell.
 *
 * No navigation, no design system, no domain screens. Feature 15 builds the first real
 * one. What this proves is the thing wave 1 depends on: a feature can render against
 * `@rpg/fixtures` with the API stack stopped (`.speckit/features/_index.md`, rule 7).
 */
export function App() {
  const visible = FIXTURE_ENTITIES.filter((entity) => entity.visibility.mode === 'everyone');

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', lineHeight: 1.5 }}>
      <h1>{FIXTURE_CAMPAIGN.name}</h1>
      <p>{FIXTURE_CAMPAIGN.description}</p>
      <p>
        Pinned system:{' '}
        <code>
          {FIXTURE_CAMPAIGN.system.systemId}@{FIXTURE_CAMPAIGN.system.version}
        </code>
      </p>

      <h2>Publicly visible content</h2>
      <p>
        {visible.length} of {FIXTURE_ENTITIES.length} fixture entities are visible to everyone. The
        rest are GM-only or revealed to specific players, and a real screen must never receive them
        at all.
      </p>
      <ul>
        {visible.map((entity) => (
          <li key={entity.id}>
            {entity.name} <small>({entity.type})</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
