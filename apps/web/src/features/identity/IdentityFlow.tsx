import type { AccountSessionView, InvitationPreview, MembershipView } from '@rpg/identity';
import { type FormEvent, useEffect, useState } from 'react';
import { apiRequest } from '../../api.ts';

type Mode = 'login' | 'signup' | 'recovery';

export function IdentityFlow(props: {
  readonly invitationToken?: string;
  readonly onAuthenticated: (campaignId: string | undefined, userId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [preview, setPreview] = useState<InvitationPreview>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (props.invitationToken === undefined) return;
    apiRequest<InvitationPreview>(`/invitations/${encodeURIComponent(props.invitationToken)}`)
      .then(setPreview)
      .catch(() => setError('Invitation unavailable.'));
  }, [props.invitationToken]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const data = new FormData(event.currentTarget);
    const username = String(data.get('username') ?? '');
    const password = String(data.get('password') ?? '');
    try {
      const session = await apiRequest<AccountSessionView>(
        mode === 'signup' ? '/auth/accounts' : '/auth/sessions',
        { method: 'POST', body: JSON.stringify({ username, password }) },
      );
      if (props.invitationToken !== undefined) {
        const membership = await apiRequest<MembershipView>(
          `/invitations/${encodeURIComponent(props.invitationToken)}/accept`,
          { method: 'POST', headers: { origin: window.location.origin } },
        );
        props.onAuthenticated(membership.campaignId, session.user.id);
        return;
      }
      props.onAuthenticated(undefined, session.user.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed.');
    }
  }

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      await apiRequest<void>('/auth/recovery/consume', {
        method: 'POST',
        body: JSON.stringify({
          token: String(data.get('token') ?? ''),
          newPassword: String(data.get('newPassword') ?? ''),
        }),
      });
      setMode('login');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed.');
    }
  }

  return (
    <section aria-labelledby="identity-title">
      <h1 id="identity-title">
        {mode === 'signup' ? 'Create account' : mode === 'recovery' ? 'Recover account' : 'Log in'}
      </h1>
      {preview !== undefined && (
        <p>
          Join <strong>{preview.campaignDisplayName}</strong> as {preview.targetRole}. Invitation
          expires {new Date(preview.expiresAt).toLocaleString()}.
        </p>
      )}
      {mode === 'recovery' ? (
        <form onSubmit={recover}>
          <label>
            Recovery token
            <input name="token" required minLength={43} maxLength={43} autoComplete="off" />
          </label>
          <label>
            New password
            <input name="newPassword" type="password" required minLength={15} maxLength={512} />
          </label>
          <button type="submit">Replace password</button>
        </form>
      ) : (
        <form onSubmit={authenticate}>
          <label>
            Username
            <input name="username" required minLength={3} maxLength={32} autoComplete="username" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={15}
              maxLength={512}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </label>
          <button type="submit">{mode === 'signup' ? 'Create account' : 'Log in'}</button>
        </form>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
      <nav aria-label="Account actions">
        <button type="button" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
          {mode === 'signup' ? 'Use existing account' : 'Create account'}
        </button>
        <button type="button" onClick={() => setMode(mode === 'recovery' ? 'login' : 'recovery')}>
          {mode === 'recovery' ? 'Back to login' : 'Use recovery token'}
        </button>
      </nav>
    </section>
  );
}
