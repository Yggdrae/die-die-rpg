import type { CampaignView } from '@rpg/campaigns';
import type {
  InvitationIssuedView,
  InvitationView,
  MembershipPage,
  MembershipView,
} from '@rpg/identity';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../api.ts';

export function CampaignAdmin(props: {
  readonly campaign: CampaignView;
  readonly userId?: string;
  readonly onCampaignUpdated: (campaign: CampaignView) => void;
  readonly onCampaignDeleted: (campaignId: string) => void;
}) {
  const campaignId = props.campaign.id;
  const [members, setMembers] = useState<readonly MembershipView[]>([]);
  const [invitations, setInvitations] = useState<readonly InvitationView[]>([]);
  const [issuedToken, setIssuedToken] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const [memberPage, invitationList] = await Promise.all([
      apiRequest<MembershipPage>(`/campaigns/${campaignId}/members`),
      apiRequest<InvitationView[]>(`/campaigns/${campaignId}/invitations`).catch(() => []),
    ]);
    setMembers(memberPage.items);
    setInvitations(invitationList);
  }, [campaignId]);

  useEffect(() => {
    refresh().catch(() => setError('Campaign administration unavailable.'));
  }, [refresh]);

  const actor = members.find((membership) => membership.user.id === props.userId);
  const canInvite = actor?.role === 'owner' || actor?.role === 'gm';

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const role = String(new FormData(event.currentTarget).get('role'));
    try {
      const result = await apiRequest<InvitationIssuedView>(
        `/campaigns/${campaignId}/invitations`,
        { method: 'POST', body: JSON.stringify({ targetRole: role }) },
      );
      setIssuedToken(result.token);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Invitation failed.');
    }
  }

  async function revoke(invitationId: string) {
    await apiRequest<void>(`/campaigns/${campaignId}/invitations/${invitationId}`, {
      method: 'DELETE',
    });
    await refresh();
  }

  async function remove(userId: string) {
    await apiRequest<void>(`/campaigns/${campaignId}/members/${userId}`, { method: 'DELETE' });
    await refresh();
  }

  async function changeRole(userId: string, role: 'gm' | 'assistant_gm' | 'player') {
    await apiRequest<MembershipView>(`/campaigns/${campaignId}/members/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    await refresh();
  }

  async function transfer(userId: string) {
    await apiRequest(`/campaigns/${campaignId}/ownership-transfer`, {
      method: 'POST',
      body: JSON.stringify({ targetUserId: userId }),
    });
    await refresh();
  }

  async function updateSystem() {
    const review = await apiRequest<{
      readonly target?: { readonly systemId: string; readonly version: string };
    }>(`/campaigns/${campaignId}/system-update`);
    if (review.target === undefined) {
      setError('No system update available.');
      return;
    }
    const updated = await apiRequest<CampaignView>(`/campaigns/${campaignId}/system-update`, {
      method: 'POST',
      body: JSON.stringify({
        targetVersion: review.target.version,
        expectedVersion: props.campaign.version,
      }),
    });
    props.onCampaignUpdated(updated);
  }

  async function updateDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const updated = await apiRequest<CampaignView>(`/campaigns/${campaignId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: String(data.get('name') ?? ''),
        description: String(data.get('description') ?? ''),
        expectedVersion: props.campaign.version,
      }),
    });
    props.onCampaignUpdated(updated);
  }

  async function deleteCampaign() {
    await apiRequest<void>(`/campaigns/${campaignId}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedVersion: props.campaign.version }),
    });
    props.onCampaignDeleted(campaignId);
  }

  return (
    <section aria-labelledby="members-title">
      <h2 id="members-title">Members</h2>
      <ul>
        {members.map((membership) => {
          const canRemove =
            membership.role !== 'owner' &&
            (actor?.role === 'owner' ||
              (actor?.role === 'gm' &&
                (membership.role === 'assistant_gm' ||
                  membership.role === 'player' ||
                  membership.user.id === actor.user.id)));
          return (
            <li key={membership.user.id}>
              {membership.user.username} — {membership.role}
              {actor?.role === 'owner' && membership.role !== 'owner' && (
                <>
                  <select
                    aria-label={`Role for ${membership.user.username}`}
                    value={membership.role}
                    onChange={(event) =>
                      changeRole(
                        membership.user.id,
                        event.target.value as 'gm' | 'assistant_gm' | 'player',
                      ).catch(() => setError('Role change failed.'))
                    }
                  >
                    <option value="gm">GM</option>
                    <option value="assistant_gm">Assistant GM</option>
                    <option value="player">Player</option>
                  </select>
                  <button type="button" onClick={() => transfer(membership.user.id)}>
                    Transfer ownership
                  </button>
                </>
              )}
              {canRemove && (
                <button type="button" onClick={() => remove(membership.user.id)}>
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {canInvite && (
        <>
          <h3>Invitations</h3>
          <form onSubmit={issue}>
            <select name="role" defaultValue="player">
              <option value="gm">GM</option>
              <option value="assistant_gm">Assistant GM</option>
              <option value="player">Player</option>
            </select>
            <button type="submit">Create invitation</button>
          </form>
          {issuedToken !== undefined && (
            <p>
              Copy this token now: <code>{issuedToken}</code>
            </p>
          )}
          <ul>
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                {invitation.targetRole} — {invitation.state}
                {invitation.state === 'usable' && (
                  <button type="button" onClick={() => revoke(invitation.id)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {actor?.role === 'owner' && (
        <>
          <section aria-labelledby="campaign-details-title">
            <h3 id="campaign-details-title">Campaign details</h3>
            <form
              onSubmit={(event) => updateDetails(event).catch(() => setError('Update failed.'))}
            >
              <input name="name" defaultValue={props.campaign.name} required maxLength={120} />
              <textarea
                name="description"
                defaultValue={props.campaign.description}
                maxLength={10_000}
              />
              <button type="submit">Save details</button>
            </form>
            <button
              type="button"
              onClick={() => deleteCampaign().catch(() => setError('Delete failed.'))}
            >
              Delete campaign
            </button>
          </section>
          <section aria-labelledby="system-update-title">
            <h3 id="system-update-title">System version</h3>
            <p>
              Current pin: {props.campaign.system.systemId}@{props.campaign.system.version}. Updates
              are never automatic.
            </p>
            <button
              type="button"
              onClick={() => updateSystem().catch(() => setError('Update failed.'))}
            >
              Review and update to latest installed version
            </button>
            <button type="button">Keep current</button>
          </section>
        </>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
    </section>
  );
}
