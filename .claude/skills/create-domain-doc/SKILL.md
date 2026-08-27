---
name: create-domain-doc
description: Create or update a domain document from PRD and BDD. Use when a feature has meaningful domain vocabulary, invariants, state transitions, ownership rules, or business workflows.
---

# Create Domain Document

1. Read `_prd.md`, `_bdd.md`, ADRs, and existing domain documentation.
2. Extract actors, commands/actions, entities, values, events, policies, invariants, and state transitions.
3. Define a shared glossary and remove synonymous terms unless the distinction is intentional.
4. Group behavior into meaningful domain flows. Do not create one diagram per BDD scenario.
5. Create diagrams only when they materially improve understanding.
6. Keep infrastructure concepts out of domain vocabulary unless the business actually cares about them.
7. Save `.speckit/features/<feature>/_domain.md`.

Skip this artifact when the feature has no meaningful domain complexity.
