---
name: fastify-server
description: Implement or review Fastify HTTP APIs using TypeBox/JSON Schema, typed boundaries, consistent errors, authorization, and thin route handlers.
---

# Fastify Server

Follow `docs/SPEC_GUIDELINE.md` and existing repository conventions first.

## Rules

- Register modules/plugins explicitly; avoid hidden global coupling.
- Define structured request and response schemas with TypeBox.
- Treat JSON Schema as runtime contract, not only TypeScript decoration.
- Validate at HTTP boundaries.
- Keep route handlers thin: parse/authorize -> application call -> map result.
- Keep domain/application code independent of Fastify request/reply types.
- Centralize HTTP error mapping and never leak stack/internal details.
- Make authorization/visibility explicit for every protected operation.
- Use WebSocket only for ephemeral realtime behavior; persist durable state elsewhere.
- Prefer repository-defined plugins/hooks over duplicate local mechanisms.

See `references/routes.md` and `references/errors.md`.
