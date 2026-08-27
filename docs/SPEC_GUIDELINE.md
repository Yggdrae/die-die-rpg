# Development Specification Guideline

## Purpose

This document defines project defaults. It does not replace ADRs. A feature-specific ADR overrides a default when the two conflict.

## Principles

- Prefer simple, reversible solutions appropriate to the current product stage.
- Do not add infrastructure, abstractions, or dependencies without demonstrated need.
- Do not turn architecture patterns into ceremony. Domain complexity may justify DDD; simple CRUD does not.
- Specifications describe decisions and observable behavior. Code and tests provide final evidence.
- Optimize for maintainability and low agent-context cost.

## Runtime and Tooling

- Runtime and package manager: **Bun**.
- Language: **strict TypeScript**.
- Monorepo: Bun Workspaces/Turborepo when present in the repository.
- Lint/format: **Biome**.
- Unit/integration tests: repository-adopted runner; prefer Vitest or Bun Test when consistent with existing configuration.
- E2E: **Playwright** when user-facing critical flows justify it.
- Frontend: **React + Vite + PWA**.
- HTTP server: **Fastify**.
- Serializable HTTP schemas/contracts: **TypeBox + JSON Schema**.

## Persistence, Offline, and Realtime

Choose storage by data responsibility:

- Authoritative relational server data: **PostgreSQL**.
- Local/offline synchronized state: **SQLite/WASM + PowerSync** when offline-first behavior is required.
- Large files/blobs: **S3-compatible storage; MinIO in development**. Store metadata in the database, not large blobs.
- Concurrent collaborative text: **Yjs/CRDT only when true simultaneous collaboration exists**.
- Presence, cursors, ephemeral events, and transient realtime notifications: **WebSocket**. Never use them as source of truth.

Every feature that persists or synchronizes data must state, when relevant:
1. source of truth;
2. read/write ownership and permissions;
3. offline availability;
4. synchronization strategy;
5. conflict-resolution strategy;
6. retention/versioning requirements.

## Architecture

- Default: **modular monolith**.
- Organize by business capability/module before global technical layer.
- Split `domain`, `application`, `infra`, and `main` only when complexity justifies it.
- Domain dependencies must not point to Fastify, React, PowerSync, PostgreSQL, MinIO, or other infrastructure.
- Use a `Result` pattern for business failures when it simplifies control flow; do not wrap trivial functions mechanically.
- Repositories, gateways, domain services, domain events, and aggregates exist only when they solve a concrete problem.
- Use `clean-ddd` when a feature contains meaningful invariants or domain rules.

## API and Validation

- Fastify routes must define request/response schemas for structured payloads.
- Prefer TypeBox to keep runtime schema and TypeScript types aligned.
- Validate at system boundaries. Domain code must not depend on Fastify request objects.
- HTTP errors must use a consistent shape and must not leak internal details.
- Authorization and visibility are application/domain requirements, not cosmetic middleware concerns.
- Use `fastify-server` for HTTP implementation guidance.

## Code

- Avoid `any`; use `unknown` plus narrowing for genuinely unknown data.
- Do not add `try/catch` to every async function. Catch only where handling, translation, compensation, or useful context exists.
- Follow the repository's established domain vocabulary. Do not force a global language convention without an explicit decision.
- Do not duplicate domain rules between frontend and backend; share pure contracts/rules when appropriate.
- Do not create wrappers, factories, adapters, or interfaces with one implementation unless they provide concrete value.
- Prefer minimal diffs. Do not rewrite unrelated code.

## Caveman Mode

For engineering responses and agent-to-user communication:

- English only.
- No greetings, pleasantries, apologies, or filler.
- Default to minimal output.
- Code change requested: return only changed code/patch unless the whole file is necessary or explicitly requested.
- No code explanation unless requested or necessary for correctness.
- Short status language is preferred: `Bug here.`, `Me fix.`, `Tests pass.`
- Brevity never overrides correctness, safety, failed-check disclosure, or migration requirements.

## Tests and Gates

### During a task

Run only what provides current evidence for the affected scope:
- Biome/check on affected files or workspace;
- typecheck for affected workspaces;
- related unit/integration tests;
- affected build when packaging may break.

### Before PR/merge

Run repository-defined full gates, normally:
- lint/check;
- typecheck;
- tests;
- build;
- critical E2E when applicable.

Do not use a global coverage percentage as a substitute for quality. Prioritize domain rules, authorization, sync/conflicts, persistence boundaries, and critical user flows.

## SpecKit

Feature artifacts live under `.speckit/features/<feature>/`:

```text
_prd.md
_bdd.md            # when behavior is meaningful
_domain.md         # when domain complexity justifies it
_techspec.md
_db.md             # when persistence/sync/migration exists
_tasks.md
tasks/
adrs/
diagrams/          # only diagrams that improve understanding
```

Recommended flow:

`PRD -> BDD -> Domain (if needed) -> TechSpec -> DB (if needed) -> Tasks -> Execute -> Verify`

Create ADRs only for significant, durable decisions with plausible alternatives.

## External Research

Web research is not mandatory for every artifact. Use it when there is:
- product/market comparison;
- current external documentation dependency;
- a technical decision likely to have changed;
- regulatory or external factual requirements;
- material uncertainty that the repository cannot resolve.

## Documentation

- Document only repository-verifiable facts or explicitly approved decisions.
- Do not invent commands, ports, variables, dependencies, or architecture.
- Use `TODO:` for required missing information.
- Keep README operational and concise; link to deeper docs instead of duplicating them.
