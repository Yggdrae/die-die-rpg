---
name: create-db-doc
description: Create or update a persistence/data design document. Use when a feature stores, synchronizes, migrates, versions, or deletes data, including offline state, blobs, CRDT content, or conflict handling.
---

# Create Data/Persistence Document

1. Read PRD, BDD, domain doc, TechSpec, relevant ADRs, and current schemas/migrations.
2. Identify each persisted data category and its source of truth.
3. Define ownership, read/write permissions, lifecycle, retention, deletion, and versioning when relevant.
4. Define relational schema changes and migration/backfill strategy.
5. For offline data, define local representation, sync rules, and conflict behavior.
6. For blobs, separate metadata from object storage.
7. For collaborative text, justify CRDT usage and define document identity/lifecycle.
8. Save `.speckit/features/<feature>/_db.md`.

Do not force PostgreSQL, PowerSync, MinIO, or Yjs into a feature that does not need them.
