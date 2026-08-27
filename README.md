# RPG Companion

Campaign, rules and session operating system for tabletop RPGs.

The core does not know how to play RPGs. Systems do.

## Status

Wave 0 — platform foundation. Contracts, fixtures, application shells, CI, and the
architecture guard. No product feature is implemented yet.

- Vision: [`PRD.md`](PRD.md)
- Feature split, tracks, and the freeze gate: [`.speckit/features/_index.md`](.speckit/features/_index.md)
- Current feature: [`.speckit/features/00-platform-foundation/`](.speckit/features/00-platform-foundation/)
- Project defaults: [`docs/SPEC_GUIDELINE.md`](docs/SPEC_GUIDELINE.md)

## Requirements

- [Bun](https://bun.sh) 1.3.14
- Docker, for the local PostgreSQL and MinIO stack

## Setup

```bash
bun install
```

```bash
cp .env.example .env
```

```bash
docker compose up -d
```

## Gates

The four scripts CI runs, plus the architecture guard.

```bash
bun run check
```

```bash
bun run typecheck
```

```bash
bun test
```

```bash
bun run build
```

```bash
bun run guard
```

## Running

```bash
bun run --filter @rpg/api dev
```

```bash
bun run --filter @rpg/web dev
```

## Layout

```text
apps/
├── api/          Fastify shell
└── web/          React + Vite + PWA shell

packages/
├── contracts/    Frozen shared contracts. Types and validators only.
├── fixtures/     Sandbox campaign. Build against this, never another developer branch.
└── config/       Shared TypeScript configuration

tools/
└── guard/        Architecture guard, runs in CI
```

Packages beyond these are created by their owning feature, in their own wave.

## Working here

Three developers work in parallel on independent features. Three rules make that possible:

1. A feature owns its data, its API, and its UI. Features never import each other.
2. Features meet only at contracts in `@rpg/contracts`. Changing one after the freeze tag
   needs a note in `.speckit/features/00-platform-foundation/` and a reviewer per track.
3. No generic page, service, or component branches on system identity. Read
   `system.capabilities` instead. `bun run guard` enforces this.

Full rules and the wave plan are in
[`.speckit/features/_index.md`](.speckit/features/_index.md).
