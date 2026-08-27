---
name: create-prd
description: Create or update a Product Requirements Document for a feature. Use when defining product scope, goals, user stories, requirements, non-goals, risks, rollout, or success criteria.
---

# Create PRD

1. Read `docs/SPEC_GUIDELINE.md`, existing feature artifacts, relevant ADRs, and repository context.
2. Separate product problem from implementation choice.
3. Define goals, users, stories, functional requirements, non-goals, risks, success signals, rollout, and open questions.
4. Apply YAGNI aggressively. Defer infrastructure or generalization without demonstrated MVP need.
5. Research externally only when current external facts materially affect the decision.
6. Create ADRs only for significant durable decisions with plausible alternatives.
7. Save `.speckit/features/<feature>/_prd.md`.
8. Use `references/prd-template.md` and `references/question-protocol.md` when useful.

Do not invent unresolved product decisions. Use `TODO:` for gaps that cannot be resolved from repository context.
