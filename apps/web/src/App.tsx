import { useState } from 'react';
import { CampaignDashboard } from './features/campaigns/CampaignDashboard.tsx';
import { IdentityFlow } from './features/identity/IdentityFlow.tsx';

export function App() {
  const path = typeof window === 'undefined' ? '/' : window.location.pathname;
  const invitationToken = path.startsWith('/invite/') ? path.slice('/invite/'.length) : undefined;
  const [authenticated, setAuthenticated] = useState(path !== '/' && invitationToken === undefined);
  const [campaignId, setCampaignId] = useState<string>();
  const [userId, setUserId] = useState<string>();
  if (authenticated) {
    return (
      <CampaignDashboard
        initialCampaignId={campaignId}
        userId={userId}
        onLogout={() => {
          setAuthenticated(false);
          setCampaignId(undefined);
          setUserId(undefined);
        }}
      />
    );
  }
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        lineHeight: 1.5,
        maxWidth: 720,
      }}
    >
      <IdentityFlow
        invitationToken={invitationToken}
        onAuthenticated={(joinedCampaignId, authenticatedUserId) => {
          setCampaignId(joinedCampaignId);
          setUserId(authenticatedUserId);
          setAuthenticated(true);
        }}
      />
    </main>
  );
}
