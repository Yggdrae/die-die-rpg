---
name: create-techspec
description: Create or update a technical specification from approved product/domain behavior. Use before implementing a meaningful feature or architectural change.
---

# Create TechSpec

1. Read PRD, BDD, optional domain/data docs, ADRs, repository architecture, and relevant code.
2. State the smallest architecture that satisfies the approved behavior.
3. Define components, interfaces, schemas, APIs, data flow, failure handling, and test strategy.
4. Explicitly address authorization/visibility, offline/sync, conflicts, realtime, and blob storage when relevant.
5. List affected modules/files at a useful level, not speculative line-by-line changes.
6. Separate current facts from proposed changes.
7. Create ADRs only for durable decisions with meaningful alternatives.
8. Save `.speckit/features/<feature>/_techspec.md`.

Do not invent infrastructure merely to complete template sections. Mark irrelevant sections `N/A` or omit them.
