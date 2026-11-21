# Decision Note: Account-Scoped Audit Store

- Date: 2026-10-24
- Requested by: feature 01 task 12 (operator-issued password recovery audit)
- Review status: Approved (2026-10-28, delegated by owner), as written. Checked against the code:
  no read route or sync stream addresses `audit_account_events`, it is not in the `powersync`
  publication (0007), and the 0004 guard triggers cover it. Track A/B/C per feature 00 FR-008
  applies only if this later becomes a `packages/contracts` change.

## Reason

`_db.md` defines two campaign-scoped stores. Operator-issued recovery (feature 01 `_prd.md`
risk table: "audited") has no campaign, and the frozen `AuditEvent` requires `campaignId` and a
campaign `ActorRef`. Neither store fits: the GM-private store is readable by campaign GM roles,
so a recovery fact there would disclose account administration to a campaign GM.

## Decision (implemented, reversible)

- Add a third physical table `audit_account_events`: operator-only, no campaign reader, never
  in a sync stream or the `powersync` publication. Same append-only privileges and triggers as the
  campaign stores. Ordered by an identity column (no campaign, so no campaign allocator).
- `@rpg/audit` exposes `DurableAuditRecorder.recordAccount()` with its own `AccountAuditEvent`
  schema (subject user, operator/user actor, action, target, after, at). Not part of
  `@rpg/contracts`.
- Feature 01 keeps its own `RecoveryIssuanceAudit` port. The API composition root and the
  operator CLI adapt it to `recordAccount()` with the recovery token ID as origin ID.

## Contract Impact

None. `packages/contracts` is unchanged, so no feature 00 contract-change note is required. If a
second feature needs account-scoped audit, promote `AccountAuditEvent` and an
`AccountAuditRecorder` port into `@rpg/contracts` through the FR-008 process.

## Review Points (resolved)

- Operator-only readership, no P0 read surface: Approved (2026-10-28, delegated by owner).
- Retention follows the campaign stores' 365-day policy: Approved (2026-10-28, delegated by
  owner). Account rows are never replicated, so no watermark holds them; the executor deletes
  them only when an operator enables deletion (feature 06 task 06, "Deletion executor").
