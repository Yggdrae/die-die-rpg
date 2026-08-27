---
name: create-bdd
description: Convert PRD behavior into testable, traceable BDD scenarios. Use for rules, permissions, state transitions, failures, concurrency, offline behavior, or other observable product behavior.
---

# Create BDD

1. Read `_prd.md`, relevant ADRs, and existing feature artifacts.
2. Map goals and user stories to observable behavior.
3. Write Given/When/Then scenarios without internal implementation details.
4. Cover happy path plus relevant failure, authorization/visibility, idempotency, concurrency, and offline cases only when applicable.
5. Avoid redundant combinatorial cases. Use Scenario Outline only when it represents a real rule matrix.
6. Record PRD -> BDD traceability.
7. Save `.speckit/features/<feature>/_bdd.md`.

Every scenario must have an objectively verifiable outcome. BDD is optional for purely visual/mechanical details with no meaningful product behavior.
