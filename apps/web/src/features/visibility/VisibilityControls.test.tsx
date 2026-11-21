import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type MembersState,
  type PanelStatus,
  VisibilityControls,
  VisibilityPanel,
  type VisibilityPanelProps,
} from './VisibilityControls.tsx';
import { PARTY_UNAVAILABLE, UNREVEAL_LIMITATION } from './visibility-model.ts';

const CASEY = '00000000-0000-4000-8000-0000000000c1';
const ROWAN = '00000000-0000-4000-8000-0000000000d1';
const members: MembersState = {
  kind: 'ready',
  members: [
    { user: { id: CASEY, username: 'casey' }, role: 'player' },
    { user: { id: ROWAN, username: 'rowan' }, role: 'player' },
    { user: { id: '00000000-0000-4000-8000-0000000000b1', username: 'gm-user' }, role: 'gm' },
    {
      user: { id: '00000000-0000-4000-8000-0000000000f1', username: 'watcher-user' },
      role: 'observer',
    },
  ],
};

function panel(overrides: Partial<VisibilityPanelProps> = {}): string {
  return renderToStaticMarkup(
    <VisibilityPanel
      visibility={{ mode: 'gm_only' }}
      members={members}
      selected={new Set()}
      status={{ kind: 'idle' } as PanelStatus}
      busy={false}
      onToggle={() => {}}
      onIntent={() => {}}
      onReload={() => {}}
      onRetry={() => {}}
      {...overrides}
    />,
  );
}

describe('VisibilityPanel', () => {
  test('panels on one page label themselves with their own title id', () => {
    const props: VisibilityPanelProps = {
      visibility: { mode: 'gm_only' },
      members,
      selected: new Set(),
      status: { kind: 'idle' },
      busy: false,
      onToggle: () => {},
      onIntent: () => {},
      onReload: () => {},
      onRetry: () => {},
    };
    const html = renderToStaticMarkup(
      <>
        <VisibilityPanel {...props} />
        <VisibilityPanel {...props} />
      </>,
    );
    const ids = [...html.matchAll(/<h3 id="([^"]+)"/g)].map((match) => match[1]);
    const labels = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(labels).toEqual(ids);
  });

  test('GM-only record: picker lists current players only; no hide control or limitation note', () => {
    const html = panel();
    expect(html).toContain('GM only');
    expect(html).toContain('casey');
    expect(html).toContain('rowan');
    expect(html).not.toContain('gm-user');
    expect(html).not.toContain('watcher-user');
    expect(html).toContain('Reveal to selected players');
    expect(html).toContain('Reveal to everyone');
    expect(html).not.toContain('Hide from everyone');
    expect(html).not.toContain('visibility-unreveal-note');
  });

  test('the reveal button is disabled until a player is selected', () => {
    expect(panel()).toMatch(/<button[^>]*disabled=""[^>]*>Reveal to selected players/);
    const some = panel({ selected: new Set([CASEY]) });
    expect(some).not.toMatch(/<button[^>]*disabled=""[^>]*>Reveal to selected players/);
  });

  test('targeted record: shows recipients with remove buttons, hide control and the limitation copy', () => {
    const html = panel({ visibility: { mode: 'players', playerIds: [CASEY] } });
    expect(html).toContain('Selected players');
    expect(html).toContain('aria-label="Remove casey"');
    expect(html).not.toContain('aria-label="Remove rowan"');
    expect(html).toContain('Hide from everyone');
    expect(html).toContain('Reveal to everyone');
    expect(html).toContain('visibility-unreveal-note');
    expect(html).toContain('keeps what they saw');
    expect(UNREVEAL_LIMITATION).toContain('copy or export');
  });

  test('a granted removed member still shows as removable "Former member"', () => {
    const html = panel({
      visibility: { mode: 'players', playerIds: ['00000000-0000-4000-8000-0000000000e1'] },
    });
    expect(html).toContain('aria-label="Remove Former member"');
  });

  test('everyone record: picker is disabled and reveal-to-everyone is absent', () => {
    const html = panel({ visibility: { mode: 'everyone' } });
    expect(html).toContain('Already visible to everyone');
    expect(html).toContain('<fieldset disabled=""');
    expect(html).not.toContain('Reveal to everyone');
    expect(html).toContain('Hide from everyone');
  });

  test('party records are read-only: party controls are absent and fail closed', () => {
    const html = panel({ visibility: { mode: 'party', partyIds: [CASEY] } });
    expect(html).toContain(PARTY_UNAVAILABLE);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(panel()).not.toMatch(/party/i);
  });

  test('members that failed to load give no picker and an alert', () => {
    const html = panel({ members: { kind: 'unavailable' } });
    expect(html).toContain('Members could not be loaded');
    expect(html).not.toContain('type="checkbox"');
  });

  test('conflict: explains nothing was applied; Retry is disabled until the record is reloaded', () => {
    const before = panel({ status: { kind: 'conflict', reloaded: false } });
    expect(before).toContain('data-testid="visibility-conflict"');
    expect(before).toContain('was not applied');
    expect(before).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(before).toMatch(/<button[^>]*disabled=""[^>]*>Retry my change/);
    const after = panel({ status: { kind: 'conflict', reloaded: true } });
    expect(after).not.toMatch(/<button[^>]*disabled=""[^>]*>Retry my change/);
  });

  test('busy state disables every action', () => {
    const html = panel({ busy: true, visibility: { mode: 'players', playerIds: [CASEY] } });
    expect(html.match(/<button/g)?.length).toBe(html.match(/<button[^>]*disabled=""/g)?.length);
  });

  test('error and notice statuses are announced', () => {
    expect(panel({ status: { kind: 'error', message: 'bad' } })).toContain('role="alert">bad');
    expect(panel({ status: { kind: 'notice', message: 'ok' } })).toContain('role="status">ok');
  });
});

describe('VisibilityControls role hint', () => {
  const props = {
    campaignId: '00000000-0000-4000-8000-0000000000a1',
    resourceClass: 'fixture_note',
    resourceId: '00000000-0000-4000-8000-000000001001',
    visibility: { mode: 'gm_only' } as const,
    version: 1,
    members: [],
    onChanged: () => {},
    onReload: async () => {},
  };

  test('renders nothing for player, observer and unknown roles', () => {
    for (const viewerRole of ['player', 'observer', 'stranger', undefined]) {
      const html = renderToStaticMarkup(
        <VisibilityControls {...props} {...(viewerRole === undefined ? {} : { viewerRole })} />,
      );
      expect(html).toBe('');
    }
  });

  test('renders the panel for owner, gm and assistant_gm', () => {
    for (const viewerRole of ['owner', 'gm', 'assistant_gm']) {
      const html = renderToStaticMarkup(<VisibilityControls {...props} viewerRole={viewerRole} />);
      expect(html).toContain('Who can see this');
    }
  });
});
