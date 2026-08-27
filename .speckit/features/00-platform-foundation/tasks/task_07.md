# Task 07: Application Shells

## Goal

A Fastify API and a React PWA that build, run, and are ready for feature 01 to add the first real
route and screen.

## Dependencies

- Task 01

## Context

- PRD: `../_prd.md` (FR-002)
- TechSpec: `../_techspec.md` (Proposed Architecture, API)
- Stack per `docs/SPEC_GUIDELINE.md`: React + Vite + PWA, Fastify, TypeBox.

## Scope

### Change

- `apps/api/`: Fastify application, TypeBox schema validation wired at the route boundary, one
  unauthenticated `GET /health` returning `{ status, version }`.
- `apps/web/`: React + Vite application with the PWA manifest and service worker registration.
- Consistent `ApiError` shape wired as the error serializer, from `packages/contracts`.
- Both apps build and start from documented scripts.

### Do Not Change

- No authentication, no session handling, no user model. Feature 01 owns all of it.
- No domain routes, no domain screens, no navigation structure.
- No offline behavior beyond the PWA shell installing. Feature 03 owns the local database.
- No design system or component library. FR-101 is P1 and is deliberately extracted from real
  duplication later, not designed now.

## Acceptance Criteria

- [ ] `GET /health` responds successfully and its response validates against its declared schema.
- [ ] An error raised in the API serializes as `ApiError` and leaks no internal detail
      (`docs/SPEC_GUIDELINE.md`, API and Validation).
- [ ] The web app builds, serves, and installs as a PWA.
- [ ] Neither app imports anything from the other.
- [ ] Both apps consume `packages/contracts`; neither redefines a shape it already publishes.

## Verification

```bash
bun run build && bun test apps/api
```

## Notes

- Resist adding structure here. Every folder created now is a folder a feature developer has to
  either use or argue with, and none of the twenty features has asked for one yet.
- Task 09 scans this layout, so keep the app boundaries clean and conventional.
