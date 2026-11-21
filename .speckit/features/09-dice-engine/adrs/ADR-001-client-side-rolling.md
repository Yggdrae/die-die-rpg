# ADR-001: Client-side rolling with no server verification

Status: accepted (2026-10-31, delegated by the owner).

## Context

`PRD.md` s.76 requires rolling with no network. The product is a trust-based table tool, not a competitive
game. A record must still be honest about what was rolled and who may see it.

## Decision

The device rolls with a cryptographic source and records the result. The authority validates the record:
identity, actor, visibility, and that the faces replay exactly through the evaluator. It does not re-roll
and does not attest fairness.

## Alternatives

- **Server-authoritative rolls.** Rejected: no offline rolling, which s.76 requires, and a round trip on the
  most frequent action in the product.
- **Commit-reveal or signed seeds.** Rejected for MVP: real cost for a trust problem nobody has
  demonstrated. PRD FR-201 keeps it for later.

## Consequences

- A modified client can choose its faces, and replay will accept them. This is accepted and known.
- A player can never create a roll hidden from themself, because their device already computed it. A blind
  check on a player is a GM rolling with the player as target.
- Hidden means absent from a replica, which only holds if the device that rolled may read the result.
