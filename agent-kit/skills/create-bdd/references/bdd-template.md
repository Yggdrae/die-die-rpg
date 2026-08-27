# BDD: [Feature Name]

## Behavioral Overview

[1-2 paragraphs describing expected user-visible behavior, MVP boundary, and main behavioral risk.]

## Behavioral Scope

### In Scope

- [Behavior]

### Out of Scope

- [Deferred behavior]

## Business Rules

- BR-001: [Observable rule]
- BR-002: [Observable rule]

## PRD -> BDD Traceability

| PRD Item | Type | Scenario(s) | Status |
| --- | --- | --- | --- |
| [Goal/Story] | Goal/Story | [Scenario] | Covered/Pending |

## Scenarios

```gherkin
Feature: [feature name]
  As a [persona]
  I want [action]
  So that [benefit]

  Background:
    Given [shared initial state]

  Scenario: [happy path]
    Given [specific precondition]
    When [main action]
    Then [expected result]
    And [expected side effect]

  Scenario: [failure/alternative]
    Given [exception condition]
    When [main action]
    Then [expected failure/result]
    And [consistent final state]
```

## Priority

- P0: [MVP scenarios]
- P1: [Important scenarios]
- P2: [Later scenarios]

## Acceptance Criteria

- [ ] [Measurable criterion]
- [ ] [Measurable criterion]

## Example Test Data

- Valid input: [example]
- Invalid input: [example]
- Boundary condition: [example]

## Risks and Gaps

- TODO: [Behavioral ambiguity]
