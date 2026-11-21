# ADR-001: One generic entity model; type as configuration

- Status: Accepted
- Date: 2026-10-28 (decisions delegated by the owner; `_techspec.md` "Decisions")

## Context

`PRD.md` s.29 lists sixteen kinds of campaign content. The MVP needs seven (FR-002: NPC, creature,
location, item, faction, note, scene) and V1 expects more (clues, secrets, quests, events, clocks,
timeline, FR-201). Section 30 lists what every entity shares: identity, name, type, tags, metadata,
notes, attachments, relationships, Visibility, custom fields, audit. The differences between the
MVP types are labels and, at most, which optional fields a screen offers.

Building each type as its own feature (table, routes, screens, sync rule, policy) would consume the
MVP and repeat the Visibility, sync, audit, and conflict plumbing seven times, each copy a place
where a GM-only record could leak.

## Decision

One record model and one implementation serve every entity type.

- One table, `content_entities`, holds every type; `type` is a token column. Personal notes and
  relationships have their own tables only because their authorization differs (author-private;
  endpoint-bounded Visibility), not because of their content.
- Types and relationship kinds are code configuration in `packages/content/src/types.ts`
  (`{ id, label, pluralLabel, quickCreate, enabled }`, `{ id, label, inverseLabel }`). Adding one is
  an entry there; no screen, route, table, migration, policy, or sync rule changes.
- Custom fields are free-form label/value strings (D-01), so no per-type field declarations exist.
- Type membership is checked by the application on create only. The database checks the token
  shape, so removing or disabling a type never invalidates stored rows.
- No code branches on a type identifier. The architecture guard rule `no-entity-type-branch`
  rejects type literals and type branches outside the configuration file (tests excepted).

## Alternatives Considered

### A model, table, and screen set per type

- Advantages: typed columns per type; per-type queries can use indexes on those columns.
- Rejected: multiplies the security-critical plumbing (feature 04 policy, adapter, sync stream,
  audit declarations, conflict handling) by the number of types, and makes a new type a feature.

### Per-type field schemas (declared custom fields)

- Advantages: typed fields, validation per type.
- Deferred: D-01 chose free-form pairs for P0. A later declaration can type the same keys without
  a data migration.

## Consequences

- Type-specific queries cannot use per-type columns; at MVP sizes the campaign/type partial index
  suffices.
- Creature statistics (FR-101, P1) must arrive as configuration or a separate capability, not as a
  creature-only code path.
- The guard's list of MVP type literals does not need to grow with the configuration: a new type is
  caught by the branch-shape patterns.
