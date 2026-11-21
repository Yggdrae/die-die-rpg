# BDD: Identity and Membership

Source: `_prd.md`.

## Account and Session

### Scenario: Create an account with a unique username

**Given** no account exists for a username  
**When** a user creates an account with that username and a valid password  
**Then** exactly one account is created for the username  
**And** the user receives an authenticated server-issued session credential with an expiry  
**And** no password or password hash is returned or logged

### Scenario: Reject a username already registered

**Given** an account exists with username `Table_GM`  
**When** another account creation is submitted as `  table_gm  `  
**Then** account creation is rejected  
**And** no second account is created for normalized username `table_gm`

### Scenario Outline: Reject a username outside the P0 policy

**Given** no account exists for the submitted username  
**When** account creation uses username `<username>`  
**Then** account creation is rejected before password hashing  
**And** no account or session is created

| username | reason |
| --- | --- |
| `ab` | fewer than 3 characters |
| `abcdefghijklmnopqrstuvwxyz1234567` | more than 32 characters |
| `_tablegm` | does not start with a letter or digit |
| `table gm` | contains a disallowed character |
| `josé` | contains a non-ASCII character |

### Scenario Outline: Enforce the P0 password boundaries

**Given** an account is being created or recovered  
**When** the supplied password contains `<code_points>` Unicode code points and `<utf8_bytes>`
UTF-8 bytes  
**Then** the password is `<outcome>`

| code_points | utf8_bytes | outcome |
| ---: | ---: | --- |
| 14 | 14 | rejected |
| 15 | 15 | accepted |
| 128 | 512 | accepted |
| 129 | 129 | rejected |

### Scenario: Preserve password input exactly

**Given** a valid password contains leading whitespace or Unicode with multiple representations  
**When** the account is created  
**Then** the exact submitted sequence is the password  
**And** trimming or Unicode normalization does not produce an equivalent password

### Scenario: Log in with valid credentials

**Given** an account exists with a username and password  
**When** the user logs in with those credentials  
**Then** the user receives an authenticated server-issued session credential with an expiry

### Scenario: Reject invalid login credentials

**Given** an account exists  
**When** a login attempt supplies credentials that do not match the account  
**Then** authentication is rejected  
**And** no session credential is issued  
**And** the failure is logged without the password or other credential material

### Scenario: Log out

**Given** a user has an active session credential  
**When** the user logs out  
**Then** that session credential is revoked  
**And** a later request using it is rejected

### Scenario: Reject an expired or revoked session

**Given** a session credential is expired or revoked  
**When** it is used to authenticate a request  
**Then** the request is treated as unauthenticated

### Scenario: Session expiry uses an exclusive boundary

**Given** a session was issued with an expiry exactly 30 days after issuance  
**When** authentication occurs at the expiry instant  
**Then** the session is expired  
**And** only authentication before that instant can succeed

## Password Recovery

### Scenario: Instance operator issues a recovery token

**Given** an account exists on a private instance  
**And** the instance operator has trusted access to the host  
**When** the operator requests password recovery for the account  
**Then** a single-use, expiring recovery token is issued  
**And** the operator does not choose or learn the user's new password  
**And** issuance is auditable

### Scenario: Campaign authority does not grant recovery authority

**Given** a user is a campaign `owner` or `gm` without trusted host access  
**When** the user attempts to issue a recovery token for an account  
**Then** no recovery token is issued

### Scenario: Recover an account with an operator-issued token

**Given** a password-recovery token was issued by the instance operator  
**And** the token has not expired, been used, or been revoked  
**When** the user submits the token with a valid new password  
**Then** the account password is changed  
**And** the recovery token becomes unusable  
**And** every session that existed before recovery is revoked  
**And** the user must log in with the new password to obtain a session

### Scenario: Recovery expiry uses an exclusive boundary

**Given** a recovery token was issued with an expiry exactly 30 minutes after issuance  
**When** recovery is attempted at the expiry instant  
**Then** the token is expired  
**And** the password and sessions remain unchanged

### Scenario Outline: Reject an unusable recovery token

**Given** a password-recovery token is `<state>`  
**When** a user attempts to set a new password with the token  
**Then** the password is not changed  
**And** recovery fails closed

| state |
| --- |
| expired |
| already used |
| revoked |
| not recognized |

### Scenario: A recovery token cannot be consumed twice

**Given** two recovery attempts use the same valid token concurrently  
**When** the attempts are processed  
**Then** exactly one attempt changes the password  
**And** the other attempt is rejected

## Campaign Ownership and Membership

### Scenario: Campaign creator becomes the sole owner

**Given** an authenticated user has no membership in a new campaign  
**When** the user creates the campaign  
**Then** a membership binds the user to that campaign with role `owner`  
**And** the campaign has exactly one `owner`

### Scenario: A membership has exactly one MVP role

**Given** a user is a member of a campaign  
**When** the membership is returned  
**Then** it has exactly one of `owner`, `gm`, `assistant_gm`, or `player`  
**And** it does not have `observer`

### Scenario: List campaign members

**Given** a campaign has memberships  
**When** its membership list is requested through an authorized request  
**Then** each current member is returned once with exactly one role  
**And** removed memberships are not returned as current members

### Scenario: List a user's campaigns

**Given** a user has current memberships in multiple campaigns  
**When** the user's campaign list is requested by that user  
**Then** each campaign with a current membership is returned once  
**And** campaigns from which the user was removed are not returned

## Invitations

### Scenario Outline: An authorized inviter creates an invitation

**Given** an authenticated user has role `<inviter_role>` in a campaign  
**When** the user creates an invitation for one assignable MVP role  
**Then** an expiring, revocable, single-use invitation is created for that campaign  
**And** the invitation carries exactly the selected role

| inviter_role |
| --- |
| owner |
| gm |

### Scenario: Reject invitation creation by any other role

**Given** an authenticated user has role `assistant_gm` or `player` in a campaign  
**When** the user attempts to create an invitation  
**Then** no invitation is created

### Scenario: Reject an invitation for the reserved observer role

**Given** an authenticated `owner` or `gm` is creating a campaign invitation  
**When** the target role is `observer`  
**Then** no invitation is created

### Scenario: Reject an invitation that would create another owner

**Given** a campaign already has its required `owner`  
**When** an invitation is requested with target role `owner`  
**Then** no invitation is created  
**And** the campaign still has exactly one `owner`

### Scenario: A logged-in user accepts an invitation

**Given** a logged-in user has no membership in the invited campaign  
**And** the invitation is valid, unused, unexpired, and unrevoked  
**When** the user accepts the invitation  
**Then** exactly one membership is created for that user and campaign  
**And** its role equals the invitation's target role  
**And** the invitation becomes unusable  
**And** the user lands in the campaign

### Scenario: Preview a usable invitation without authentication

**Given** a usable invitation token identifies a campaign  
**When** a logged-out user previews it  
**Then** the preview contains only the campaign display name, target role, and expiry  
**And** it contains no inviter identity, campaign membership, or internal campaign identifier

### Scenario Outline: Preview an unusable invitation generically

**Given** an invitation token is `<state>`  
**When** it is previewed without authentication  
**Then** the same generic unusable-invitation result is returned

| state |
| --- |
| expired |
| revoked |
| already used |
| not recognized |

### Scenario: Invitation expiry uses an exclusive boundary

**Given** an invitation has a configured expiry between five minutes and 30 days after creation  
**When** preview or acceptance occurs at the expiry instant  
**Then** the invitation is expired  
**And** no membership is created from it

### Scenario: A logged-out user retains the invitation through authentication

**Given** a logged-out user opens a valid invitation  
**When** the user creates an account or logs in  
**Then** the same invitation remains pending through authentication  
**And** acceptance completes the join  
**And** the user lands in the invited campaign

### Scenario Outline: Reject an unusable invitation

**Given** an invitation token is `<state>`  
**When** a user attempts to accept it  
**Then** no membership is created from the token  
**And** acceptance fails closed

| state |
| --- |
| expired |
| revoked |
| already used |
| not recognized |

### Scenario: An invitation cannot be consumed twice

**Given** two users attempt to accept the same valid invitation concurrently  
**When** the attempts are processed  
**Then** exactly one membership is created from the invitation  
**And** the other attempt is rejected

### Scenario: Revoke an unused invitation

**Given** an unused and unexpired invitation exists  
**And** the invitation was created by a different user  
**When** any current `owner` or `gm` in that campaign revokes it  
**Then** the invitation can no longer create a membership  
**And** creator identity does not affect revocation authority

### Scenario: An invitation grants nothing outside its campaign and role

**Given** a user accepts a valid invitation for role `player` in campaign A  
**When** the user's memberships are resolved  
**Then** the user has role `player` in campaign A  
**And** the invitation creates no membership or role in any other campaign

## Membership Administration

### Scenario Outline: Remove a lower-authority member

**Given** an authenticated user has role `<remover_role>` in a campaign  
**And** another user has role `<target_role>` in that campaign  
**When** the authenticated user removes that membership  
**Then** the removed user immediately loses server and connected-sync access to the campaign  
**And** content authored by the removed user remains in the campaign  
**And** a membership-change audit event is emitted

| remover_role | target_role |
| --- | --- |
| owner | gm |
| owner | assistant_gm |
| owner | player |
| gm | assistant_gm |
| gm | player |

### Scenario: A GM cannot remove another GM

**Given** an authenticated user has role `gm` in a campaign  
**And** another user has role `gm` in that campaign  
**When** the authenticated user attempts to remove the other GM  
**Then** the membership remains unchanged

### Scenario: A GM removes themselves

**Given** an authenticated user has role `gm` in a campaign  
**When** that user removes their own membership  
**Then** their membership is removed  
**And** they immediately lose server and connected-sync access to the campaign  
**And** the campaign owner remains unchanged

### Scenario: Reject member removal by any other role

**Given** an authenticated user has role `assistant_gm` or `player` in a campaign  
**When** the user attempts to remove another member  
**Then** the membership remains unchanged

### Scenario: The sole owner cannot be removed

**Given** a campaign has exactly one `owner`  
**When** any user attempts to remove the owner's membership  
**Then** removal is rejected  
**And** the campaign still has exactly one `owner`

### Scenario: Owner changes a non-owner role

**Given** an authenticated `owner` and another non-owner member belong to a campaign  
**When** the owner changes that member to an assignable non-owner MVP role  
**Then** the membership contains exactly the new role  
**And** the prior role no longer resolves  
**And** connected server and sync access use the new role immediately  
**And** a membership-change audit event is emitted

### Scenario: Reject role change by a non-owner

**Given** an authenticated user is not the campaign `owner`  
**When** the user attempts to change a membership role  
**Then** the membership remains unchanged

### Scenario: Reject assigning the reserved observer role

**Given** an authenticated `owner` is changing a membership role  
**When** the requested role is `observer`  
**Then** the membership remains unchanged

### Scenario: Reject ownership transfer by a non-owner

**Given** an authenticated user is not the campaign `owner`  
**When** the user attempts to transfer campaign ownership  
**Then** ownership remains unchanged  
**And** the campaign still has exactly one `owner`

### Scenario: Transfer ownership atomically

**Given** a campaign has exactly one `owner`  
**And** another user is a member of the campaign  
**When** the current owner transfers ownership to that member  
**Then** the target member becomes the campaign's `owner`  
**And** the former owner remains a member with role `gm`  
**And** the campaign never has zero or multiple owners at a committed state  
**And** a membership-change audit event is emitted

### Scenario: Account deletion is unavailable in P0

**Given** an account exists  
**When** the user looks for an account-deletion operation  
**Then** no P0 account-deletion operation is available  
**And** membership removal remains the supported way to revoke campaign access

## Actor Resolution and Offline Behavior

### Scenario: Resolve an actor from authoritative membership

**Given** an authenticated user has role `assistant_gm` in a campaign  
**When** a feature resolves the user's `ActorRef` for that campaign through the published module API  
**Then** the result contains that user's ID, the campaign ID, and role `assistant_gm`  
**And** no client-supplied role changes the resolved role

### Scenario: Fail actor resolution without membership

**Given** an authenticated user has no current membership in a campaign  
**When** `ActorRef` is resolved for that user and campaign  
**Then** no actor is returned  
**And** campaign access is denied

### Scenario: Resolve a cached role while offline

**Given** a campaign and its current membership role were synchronized to a user's device  
**And** the device is offline  
**When** the client resolves the user's role for that campaign  
**Then** the locally cached role is returned for offline use  
**And** the cached role is treated as a read cache rather than new authority

### Scenario: Server revocation wins after reconnect

**Given** a user's membership was cached on a device  
**And** the membership was removed on the server while that device was offline  
**When** the device reconnects and synchronizes  
**Then** the server removal supersedes the cached membership  
**And** the user can no longer resolve an actor or access the campaign locally

## P1 Behavior

### Scenario: List active sessions

**Given** a user has multiple active sessions  
**When** the user requests their session list  
**Then** each active session is returned  
**And** no other user's session is returned

### Scenario: Sign out a remote session

**Given** a user has an active session on another device  
**When** the user remotely signs out that session  
**Then** the selected session credential is revoked  
**And** later requests using it are rejected  
**And** the user's other sessions remain active

### Scenario: Add or change an optional verified email address

**Given** an outbound email provider is configured  
**When** a user adds or changes an optional email address and completes verification  
**Then** the verified email address is associated with the account  
**And** the account username remains its login identifier  
**And** operator-assisted recovery remains available without the email address

### Scenario: Core account flows work without email delivery

**Given** no outbound email provider is configured  
**When** users create accounts, log in, exchange invitation links, or recover through the instance operator  
**Then** each core flow remains available

### Scenario: Create an invitation for an email address

**Given** an authenticated `owner` or `gm` supplies an email address and assignable role  
**And** an outbound email provider is configured  
**When** the user creates an email invitation  
**Then** a single-use, expiring invitation for that campaign and role is sent to the address

## Traceability

| PRD source | Covered by |
| --- | --- |
| Goal: GM account creation and activation | Create an account; Campaign creator becomes the sole owner |
| Goal: invitation creates exactly one role | Invitation acceptance and concurrency scenarios; A membership has exactly one MVP role |
| Goal / FR-011: published `ActorRef` boundary | Actor resolution scenarios |
| Goal / FR-201: future external identity provider | Model constraint only; no P0/P1 observable behavior |
| FR-001 | Account creation, username normalization, username policy, and password policy scenarios |
| FR-002 | Login, logout, and expired/revoked session scenarios |
| FR-003 | Operator issuance, recovery authorization, token use, expiry, revocation, and concurrency scenarios |
| FR-004 | Membership role scenario; invitation acceptance scenarios |
| FR-005 | Campaign creator and ownership-invariant scenarios |
| FR-006 | Invitation creation, preview, expiry, rejection, revocation, acceptance, and concurrency scenarios |
| FR-007 | Logged-out invitation scenario |
| FR-008 | Campaign-member and user-campaign listing scenarios |
| FR-009 | Membership removal, GM self-removal, connected sync revocation, and offline reconciliation scenarios |
| FR-010 | Role-change and ownership-transfer scenarios, including former-owner role |
| FR-011 | Actor resolution scenarios |
| FR-101 | Session listing and remote sign-out scenarios |
| FR-102 | Optional verified email and no-email dependency scenarios |
| FR-103 | Email invitation scenario |
| Behavioral constraints | Invitation scope, actor resolution, removal, offline, and fail-closed scenarios |
| Data and privacy | Account creation, authentication failure, recovery authorization, token, account-deletion, content retention, and audit scenarios |
| Success signal: PRD s.87 Test 1 | Campaign creation, invitation join, role resolution, and offline cache scenarios |

## External Dependencies

- Feature 02 must choose and test the database-enforced mechanism that guarantees exactly one
  active owner for every committed campaign.
- Feature 03 must define when synchronized membership tombstones are acknowledged by all eligible
  clients and may be purged safely.
