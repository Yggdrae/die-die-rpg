---
name: generate-spec-guideline
description: Create or update the repository development/specification guideline from verified code, configuration, documentation, and ADRs without inventing stack decisions.
---

# Generate Spec Guideline

1. Read manifests, configs, repository structure, docs, tests, and ADRs.
2. Distinguish current facts, desired defaults, and open decisions.
3. Do not hard-code an ORM/query builder/framework/coverage target/architecture unless already decided.
4. State that specific ADRs override project defaults.
5. Cover runtime/tooling, architecture, API/schema, persistence/offline/realtime, code rules, tests/gates, SpecKit, and documentation.
6. Include Caveman Mode for engineering output unless the project explicitly opts out.
7. Use `TODO:` for missing information; do not invent it.
8. Save `docs/SPEC_GUIDELINE.md`.
