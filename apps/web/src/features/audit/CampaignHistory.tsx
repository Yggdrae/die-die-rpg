import type { MembershipView } from '@rpg/identity';
import { useEffect, useState } from 'react';
import { apiRequestAllPages } from '../../api.ts';
import { AuditLog, type AuditLogProps } from './AuditLog.tsx';
import type { MemberName } from './audit-model.ts';

/**
 * Dashboard entry to a campaign's history (feature 06 task 05). Mounted only when opened, so
 * nothing is requested until the user asks. Member names and the viewer's role come from the
 * member list; the role only decides whether the GM-private tab is offered.
 */
export function CampaignHistory(props: {
  readonly campaignId: string;
  readonly userId?: string;
  readonly readLocal?: AuditLogProps['readLocal'];
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>History</summary>
      {open && <HistoryBody {...props} />}
    </details>
  );
}

function HistoryBody(props: {
  readonly campaignId: string;
  readonly userId?: string;
  readonly readLocal?: AuditLogProps['readLocal'];
}) {
  const [members, setMembers] = useState<readonly MembershipView[]>([]);
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine ?? true);
  useEffect(() => {
    apiRequestAllPages<MembershipView>(`/campaigns/${props.campaignId}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [props.campaignId]);
  useEffect(() => {
    const update = () => setOnline(globalThis.navigator?.onLine ?? true);
    globalThis.addEventListener('online', update);
    globalThis.addEventListener('offline', update);
    return () => {
      globalThis.removeEventListener('online', update);
      globalThis.removeEventListener('offline', update);
    };
  }, []);
  const names: MemberName[] = members.map((member) => ({
    id: member.user.id,
    username: member.user.username,
  }));
  const role = members.find((member) => member.user.id === props.userId)?.role;
  return (
    <AuditLog
      campaignId={props.campaignId}
      members={names}
      online={online}
      {...(role === undefined ? {} : { viewerRole: role })}
      {...(props.readLocal === undefined ? {} : { readLocal: props.readLocal })}
    />
  );
}
