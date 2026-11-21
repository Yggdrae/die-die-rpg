import { describe, expect, test } from 'bun:test';
import type { EntityRecord } from '@rpg/content';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemberLike } from '../visibility/visibility-model.ts';
import { HandoutListView, HandoutPreview, RevealPanel } from './HandoutsWorkspace.tsx';
import {
  audienceOf,
  audienceText,
  confirmLabel,
  deliveryOf,
  deliveryText,
  HIDE_CHANGE,
  handoutsOf,
  listOf,
  revealCandidates,
  revealChange,
} from './handout-model.ts';
import { HANDOUT_SESSION_QUICK_ACTIONS, registerHandoutHost } from './session-quick-actions.ts';

/** Feature 17 model and static markup (react-dom/server; no DOM library in this repo). */

const CAMPAIGN = '00000000-0000-4000-8000-0000000017c1';
const GM = '00000000-0000-4000-8000-0000000017a1';
const ANA = '00000000-0000-4000-8000-0000000017b1';
const BRUNO = '00000000-0000-4000-8000-0000000017b2';
const CAIO = '00000000-0000-4000-8000-0000000017b3';

const MEMBERS: readonly MemberLike[] = [
  { user: { id: GM, username: 'gm' }, role: 'gm' },
  { user: { id: ANA, username: 'Ana' }, role: 'player' },
  { user: { id: BRUNO, username: 'Bruno' }, role: 'player' },
  { user: { id: CAIO, username: 'Caio' }, role: 'observer' },
];

function handout(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: '00000000-0000-4000-8000-0000000017d1',
    campaignId: CAMPAIGN,
    type: 'handout',
    name: 'Weathered letter',
    tags: [],
    metadata: {},
    visibility: { mode: 'gm_only' },
    version: 3,
    createdAt: '2026-11-03T10:00:00Z',
    createdBy: GM,
    updatedAt: '2026-11-03T10:00:00Z',
    updatedBy: GM,
    summary: '',
    description: 'Meet me at the ford.',
    fields: {},
    ...overrides,
  };
}

describe('handout model', () => {
  test('only handouts, most recently changed first', () => {
    const older = handout({ id: '00000000-0000-4000-8000-0000000017d2', name: 'Old' });
    const newer = handout({ updatedAt: '2026-11-03T11:00:00Z', name: 'New' });
    const npc = handout({ id: '00000000-0000-4000-8000-0000000017d3', type: 'npc' });
    expect(handoutsOf([older, npc, newer]).map((record) => record.name)).toEqual(['New', 'Old']);
  });

  test('who has it, by name', () => {
    expect(audienceText(audienceOf(handout(), MEMBERS))).toBe('Hidden');
    expect(audienceText(audienceOf(handout({ visibility: { mode: 'everyone' } }), MEMBERS))).toBe(
      'Revealed to everyone',
    );
    expect(
      audienceText(
        audienceOf(
          handout({
            visibility: {
              mode: 'players',
              playerIds: [ANA, '00000000-0000-4000-8000-0000000017b9'],
            },
          }),
          MEMBERS,
        ),
      ),
    ).toBe('Revealed to Ana and a former member');
    expect(listOf(['Ana', 'Bruno', 'Caio'])).toBe('Ana, Bruno, and Caio');
  });

  test('the confirm action names the recipients, and nothing is confirmable without one', () => {
    expect(confirmLabel({ kind: 'players', playerIds: [] }, MEMBERS)).toBeUndefined();
    expect(confirmLabel({ kind: 'players', playerIds: [ANA] }, MEMBERS)).toBe('Reveal to Ana');
    expect(confirmLabel({ kind: 'players', playerIds: [ANA, BRUNO] }, MEMBERS)).toBe(
      'Reveal to Ana and Bruno',
    );
    expect(confirmLabel({ kind: 'everyone' }, MEMBERS)).toBe('Reveal to everyone');
  });

  test('candidates are current players not yet recipients; observers and GM roles never', () => {
    const revealed = handout({ visibility: { mode: 'players', playerIds: [ANA] } });
    expect(revealCandidates(revealed, MEMBERS).map((player) => player.username)).toEqual(['Bruno']);
  });

  test('changes and delivery', () => {
    expect(revealChange({ kind: 'players', playerIds: [ANA] })).toEqual({
      operation: 'reveal',
      target: { mode: 'players', playerIds: [ANA] },
    });
    expect(revealChange({ kind: 'everyone' }).target).toEqual({ mode: 'everyone' });
    expect(HIDE_CHANGE).toEqual({ operation: 'unreveal', target: { mode: 'everyone' } });
    expect(deliveryOf('pending')).toBe('waiting');
    expect(deliveryOf('uploading')).toBe('waiting');
    expect(deliveryOf('accepted')).toBe('sent');
    expect(deliveryOf('rejected')).toBe('refused');
    expect(deliveryOf('conflicted')).toBe('refused');
    expect(deliveryOf(undefined)).toBeUndefined();
    expect(deliveryText('waiting')).toContain('Waiting to send');
    expect(deliveryText('refused')).toContain('Nothing new was revealed');
  });
});

describe('handout views', () => {
  const noop = async () => ({ ok: true });

  test('the GM list shows who has each handout and what waits to be sent', () => {
    const html = renderToStaticMarkup(
      <HandoutListView
        handouts={[handout()]}
        members={MEMBERS}
        delivery={new Map([[handout().id, 'waiting' as const]])}
        gm={true}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('Weathered letter');
    expect(html).toContain('Hidden · waiting to send');
  });

  test('a player list shows titles only', () => {
    const html = renderToStaticMarkup(
      <HandoutListView
        handouts={[handout({ visibility: { mode: 'players', playerIds: [ANA] } })]}
        members={[]}
        delivery={new Map()}
        gm={false}
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('Weathered letter');
    expect(html).not.toContain('Revealed to');
    expect(
      renderToStaticMarkup(
        <HandoutListView
          handouts={[]}
          members={[]}
          delivery={new Map()}
          gm={false}
          onSelect={() => undefined}
        />,
      ),
    ).toContain('No handouts yet.');
  });

  test('the preview is the recipient view', () => {
    const html = renderToStaticMarkup(
      <HandoutPreview record={handout()} campaignId={CAMPAIGN} canAttach={false} />,
    );
    expect(html).toContain('aria-label="Handout Weathered letter"');
    expect(html).toContain('Meet me at the ford.');
    expect(html).not.toContain('Attach a file');
  });

  test('a hidden handout offers recipients and an unconfirmable button until one is chosen', () => {
    const html = renderToStaticMarkup(
      <RevealPanel record={handout()} members={MEMBERS} delivery={undefined} onChange={noop} />,
    );
    expect(html).toContain('Everyone');
    expect(html).toContain('Ana');
    expect(html).toContain('Bruno');
    expect(html).not.toContain('Caio');
    expect(html).toContain('Choose who receives it');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Choose who receives it/);
    expect(html).not.toContain('Hide again');
  });

  test('a revealed handout states what hiding does; offline without members offers everyone', () => {
    const html = renderToStaticMarkup(
      <RevealPanel
        record={handout({ visibility: { mode: 'players', playerIds: [ANA] } })}
        delivery="waiting"
        onChange={noop}
      />,
    );
    expect(html).toContain('Hide again');
    expect(html).toContain('keeps what they read');
    expect(html).toContain('The player list needs a connection');
    expect(html).toContain('data-delivery="waiting"');
    const everyone = renderToStaticMarkup(
      <RevealPanel
        record={handout({ visibility: { mode: 'everyone' } })}
        members={MEMBERS}
        delivery={undefined}
        onChange={noop}
      />,
    );
    expect(everyone).not.toContain('Recipients');
    expect(everyone).toContain('Hide again');
  });
});

describe('session quick action (D-08)', () => {
  const context = {
    actor: { userId: GM, campaignId: CAMPAIGN, role: 'gm' as const },
    sessionId: '00000000-0000-4000-8000-0000000017e1',
  };

  test('resolves at once without a host, and when the host closes', async () => {
    const [action] = HANDOUT_SESSION_QUICK_ACTIONS;
    if (action === undefined) throw new Error('missing action');
    expect(action.label).toBe('Reveal handout');
    await action.invoke(context);
    let opened = 0;
    const unregister = registerHandoutHost((request) => {
      opened += 1;
      request.close();
    });
    await action.invoke(context);
    unregister();
    expect(opened).toBe(1);
  });
});
