# ADR-001: Plan then apply, through semantic operations

Status: accepted (2026-11-01, delegated by the owner).

## Context

`PRD.md` s.27 says the application assists and never takes narrative control. `PRD.md` s.57 requires that concurrent
offline changes merge. Features 15, 18, and 19 all execute actions, and each would otherwise grow its own idea of damage.

## Decision

Every play-driven change is a plan first: an inspectable value computed from declarations and state, with nothing
written. A person's decision turns it into ordered `SemanticOp`s with optional guards, recorded once under a client
identity. The authority applies them to the target in one transaction.

## Alternatives

- **Direct application.** Rejected: no preview, no decline, and automation by default, which is what s.27 forbids.
- **Absolute writes with version checks.** Rejected: two offline changes to one pool conflict at a table where both are
  right. That turns a normal event into a dialog.
- **Replaying the action at the authority.** Rejected: the authority does not have the table's decisions or the fiction,
  and rolling offline means the device already holds the result.

## Consequences

- A resource change merges, and a spend of the last point refuses at the authority instead of going negative.
- A member can always upload larger numbers on a target they may update. Accepted: this is a trust-based table tool, and
  the audit log shows it.
- Targets store a published state shape, and feature 11 owns what operations mean on it.
