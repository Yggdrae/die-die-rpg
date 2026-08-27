---
name: clean-ddd
description: Apply pragmatic DDD/Clean Architecture when real domain invariants, lifecycle, transactional boundaries, or business rules justify it. Do not use to impose layers on simple CRUD.
---

# Pragmatic DDD

Read `docs/SPEC_GUIDELINE.md` first.

## Use When

- rules/invariants must survive UI/framework/database changes;
- concepts have identity and lifecycle;
- domain transactions need explicit consistency boundaries;
- business capabilities have meaningful boundaries.

## Do Not Create by Default

Repository, Gateway, Aggregate, Domain Service, Domain Event, Mapper, DTO, Factory, or an interface with one implementation.

## Heuristics

- **Value Object:** invariant-rich value without identity.
- **Entity:** identity matters over time.
- **Aggregate:** real transactional consistency boundary; keep it small.
- **Domain Service:** domain rule that naturally belongs to no entity/value object.
- **Repository:** aggregate access when decoupling/testability provides concrete value.
- **Domain Event:** business fact another component genuinely needs to observe.
- **Application service/use case:** coordinates IO, authorization, and transaction; domain rules stay in domain objects/policies.

## Optional Structure

```text
modules/<module>/
  domain/
  application/
  infra/
  main/
```

Collapse layers when complexity does not justify them. Domain dependencies must not point to Fastify, React, PowerSync, PostgreSQL, or MinIO.

Before adding an abstraction, answer: what change, test, invariant, or boundary does it make simpler? If there is no concrete answer, do not add it.
