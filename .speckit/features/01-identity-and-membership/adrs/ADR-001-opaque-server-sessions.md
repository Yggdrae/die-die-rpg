# ADR-001: Opaque server-side sessions

- Status: Accepted
- Date: 2026-08-27

## Context

Feature 01 must support immediate logout and membership revocation, P1 remote sign-out, and a sync
layer that stops accepting requests as soon as server authority changes. The browser also needs a
credential that does not expose user, campaign, or role claims and that can be revoked without
waiting for expiry.

The private self-hosted deployment is small enough that one indexed PostgreSQL lookup per
authenticated request is acceptable. PostgreSQL is already authoritative for identity and
membership.

## Decision

Use opaque server-side sessions.

Each login creates a 32-byte CSPRNG credential, encoded as 43 unpadded base64url characters. The
client receives it only in an `HttpOnly` cookie that is `Secure` in production and `SameSite=Lax`.
The database stores only its 32-byte SHA-256 digest with the session ID, user ID, creation time,
absolute expiry, and optional revocation time.

A session is valid only when its digest resolves to one row where `revoked_at IS NULL` and database
time is strictly before `expires_at`. Sessions expire 30 days after issuance and have no P0 idle
timeout. Equality with `expires_at` is expired. Logout revokes the current row before clearing the
cookie. Successful password recovery revokes every existing session for the user in the password
change transaction and creates no replacement session.

The session identifies only the authenticated user and session. Campaign role is resolved from
current membership on each server operation through `ActorResolver`; it is never copied into the
credential.

## Alternatives Considered

### Signed stateless access tokens

- Advantages: avoids a session lookup and can be verified by services without shared storage.
- Disadvantages: a valid token remains usable until expiry unless every verifier also consults a
  denylist or revocation version. Remote sign-out, password-recovery revocation, and immediate
  access removal would therefore reintroduce shared state. Embedded campaign roles would also go
  stale and conflict with the authoritative membership boundary.
- Reason rejected: avoiding one indexed lookup does not justify delayed revocation or a second
  revocation store. The deployment is a modular monolith, not an independently verified service
  mesh.

### Short-lived stateless access token plus rotating refresh token

- Advantages: limits access-token exposure and reduces database reads on ordinary requests.
- Disadvantages: revocation is still delayed until the access token expires, rotation adds replay
  and token-family state, and refresh endpoints expand the security surface.
- Reason rejected: it is more complex than an opaque session and still fails the immediate
  revocation requirement without per-request state.

## Consequences

### Positive

- Logout, password recovery, P1 remote sign-out, and administrative revocation take effect on the
  next authenticated server request.
- The browser credential contains no identity, campaign, or role data.
- Credential theft can be contained by revoking one row; raw credentials are not recoverable from
  the database.
- Membership remains the single authoritative role source.

### Negative / Tradeoffs

- Every authenticated request performs an indexed database lookup.
- Authentication depends on PostgreSQL availability; offline browser use relies only on the
  separate synchronized read cache and cannot create new server authority.
- Session cleanup is required. Revoked rows are retained for 30 days after revocation; never
  revoked rows are retained for 30 days after expiry, then may be hard-deleted.
- Cookie authentication requires same-origin enforcement and CSRF protection on state-changing
  routes.

## Follow-up

Task 03 creates the session schema and digest lookup. Task 04 implements issuance, authentication,
logout, cookie policy, expiry-boundary tests, and secret redaction. Task 05 proves that recovery
revokes all sessions atomically.

Revisit only if the application is split into independently deployed verifiers that cannot share
the authoritative session store. Any replacement must preserve immediate revocation and must not
embed campaign roles.
