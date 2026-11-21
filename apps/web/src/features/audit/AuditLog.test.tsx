import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuditLogView, type AuditLogViewProps } from './AuditLog.tsx';

const GM = '00000000-0000-4000-8000-0000000000a1';

function view(overrides: Partial<AuditLogViewProps> = {}): string {
  return renderToStaticMarkup(
    <AuditLogView
      store="campaign"
      showPrivateTab={false}
      members={[{ id: GM, username: 'gm_ana' }]}
      filters={{}}
      model={{ items: [], partial: false, pendingCount: 0 }}
      status={{ kind: 'ready' }}
      online
      canLoadMore={false}
      onStore={() => {}}
      onFilters={() => {}}
      onLoadMore={() => {}}
      {...overrides}
    />,
  );
}

describe('AuditLogView', () => {
  test('a GM reads actor, time, and the rendered explanation of a change', () => {
    const html = view({
      model: {
        items: [
          {
            id: 'e1',
            state: 'accepted',
            source: 'authority',
            actor: 'gm_ana',
            at: '2026-10-26T14:35:00Z',
            text: 'Changed setting torches from 6 to 2.',
          },
        ],
        totalLabel: '1 event',
        partial: false,
        pendingCount: 0,
      },
    });
    expect(html).toContain('2026-10-26 14:35:00');
    expect(html).toContain('gm_ana');
    expect(html).toContain('Changed setting torches from 6 to 2.');
    expect(html).toContain('1 event');
    expect(html).not.toContain('Pending');
  });

  test('the private tab is only offered as a GM-role hint', () => {
    expect(view()).not.toContain('GM-private log');
    expect(view({ showPrivateTab: true })).toContain('GM-private log');
  });

  test('pending device entries are labeled apart from accepted history; partial is stated', () => {
    const html = view({
      online: false,
      model: {
        items: [
          {
            id: 'q1',
            state: 'pending',
            source: 'device',
            actor: 'gm_ana',
            at: '2026-10-26T15:00:00Z',
            text: 'Recorded campaign.details_updated on campaign.',
          },
          {
            id: 'a1',
            state: 'accepted',
            source: 'authority',
            actor: 'gm_ana',
            at: '2026-10-26T14:00:00Z',
            text: 'Recorded campaign.details_updated on campaign.',
          },
        ],
        partial: true,
        pendingCount: 1,
      },
    });
    expect(html).toContain('data-audit-state="pending"');
    expect(html).toContain('Pending — not yet accepted');
    expect(html).toContain('data-audit-source="authority"');
    expect(html).toContain('Older history may be missing on this device');
    expect(html).toContain('Offline');
    expect(html).not.toContain('data-testid="audit-total"');
  });

  test('a refused log says so without content', () => {
    const html = view({ store: 'private', status: { kind: 'unavailable' } });
    expect(html).toContain('This log is not available to you.');
    expect(html).not.toContain('<li');
  });
});
