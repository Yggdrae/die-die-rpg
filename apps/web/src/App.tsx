import { useCallback, useState } from 'react';
import { CampaignDashboard } from './features/campaigns/CampaignDashboard.tsx';
import {
  forgetDeviceSession,
  readDeviceSession,
  rememberDeviceSession,
} from './features/identity/device-session.ts';
import { IdentityFlow } from './features/identity/IdentityFlow.tsx';

export function App() {
  const path = typeof window === 'undefined' ? '/' : window.location.pathname;
  const invitationToken = path.startsWith('/invite/') ? path.slice('/invite/'.length) : undefined;
  const [remembered] = useState(() =>
    invitationToken === undefined ? readDeviceSession() : undefined,
  );
  const [authenticated, setAuthenticated] = useState(
    (path !== '/' && invitationToken === undefined) || remembered !== undefined,
  );
  const [campaignId, setCampaignId] = useState<string>();
  const [userId, setUserId] = useState(remembered?.userId);
  const signedOut = useCallback(() => {
    forgetDeviceSession();
    setAuthenticated(false);
    setCampaignId(undefined);
    setUserId(undefined);
  }, []);
  const campaignOpened = useCallback(
    (opened: string) => {
      if (userId !== undefined) rememberDeviceSession({ userId, campaignId: opened });
    },
    [userId],
  );
  if (authenticated) {
    return (
      <CampaignDashboard
        initialCampaignId={campaignId}
        {...(remembered?.campaignId === undefined ? {} : { lastCampaignId: remembered.campaignId })}
        userId={userId}
        onCampaignOpened={campaignOpened}
        onLogout={signedOut}
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
          rememberDeviceSession({ userId: authenticatedUserId });
          setCampaignId(joinedCampaignId);
          setUserId(authenticatedUserId);
          setAuthenticated(true);
        }}
      />
    </main>
  );
}
