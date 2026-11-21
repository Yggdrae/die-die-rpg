# ADR-002: Generic features gate on closed capability keys

Status: accepted, 2026-10-30.

## Context

`PRD.md` s.89 is the central acceptance criterion: character, session, encounter, and rules pages work with both
Cairn and Fate with no branch on system identity. The easy failure is a capability key that is a system's name in
disguise.

## Decision

Generic code asks `hasCapability(system, key)`. Keys are a closed union in `@rpg/contracts`, each with a documented
meaning, and adding one is a contract change. A capability is an honest claim: load refuses a key with no matching
declaration, and a declaration with no matching key.

## Alternatives

- **Open string keys.** Cheap to add, and exactly how `has_fate_points` happens.
- **Inspecting declarations only, with no keys.** Honest, but every consumer reinvents the question, and "the system
  has a `track` resource" cannot express a pure behavior claim such as turn order.
- **Branching on system identity.** What the architecture guard refuses.

## Consequences

The friction of adding a key is intentional. The two-way check means a consumer gating on a key never meets an empty
block, and a package cannot quietly gain a mechanic its capabilities do not advertise.
