# BDD: System Package Contract and Registry

Source: `_prd.md`. P0 only. "Package" is a declarative system package; "loading" is what the
registry does with one at startup.

## Validation at Load

### Scenario: A valid package loads and is served by its exact reference

**Given** a package whose declarations satisfy the contract  
**When** the registry loads it  
**Then** the registry resolves `system-id@version` to that package  
**And** the package appears in the list of installed systems

### Scenario Outline: An invalid package is rejected whole, with a precise error

**Given** a package with <defect>  
**When** the registry loads it  
**Then** loading fails with an error naming <where>  
**And** no part of that package is served

| defect | where |
| --- | --- |
| a missing required block | the missing block |
| a property the contract does not define | the unknown property's path |
| a capability outside the closed registry | the capability key |
| a field referencing an undeclared resource | the field and the resource |
| an action referencing an undeclared field in its condition inputs | the action and the input |
| two fields with one key | the duplicated key |
| a default outside the field's own constraints | the field |
| a `min` greater than its `max` | the field or resource |
| a licence permission outside the allowed values | the asset class |
| a system identifier or version in the wrong format | the identity block |

### Scenario: First-party packages get no exemption

**Given** a package shipped with the application that has a defect  
**When** the registry loads it  
**Then** it is rejected exactly as any other package would be

### Scenario: One bad package does not take the others down

**Given** a valid package and an invalid package  
**When** the registry loads both  
**Then** the valid package is served  
**And** the invalid one is reported with its error and is not served

## No Executable Content

### Scenario: Loading a package never evaluates its content

**Given** a package whose text values are valid strings that look like code  
**When** the registry loads it and a generic consumer reads it  
**Then** nothing in those strings runs  
**And** dice and formula references stay inert text until their own engines parse them

### Scenario Outline: Non-data values are refused

**Given** a package value that is <value>  
**When** the registry loads it  
**Then** the package is rejected

| value |
| --- |
| a function |
| a symbol |
| a class instance |
| an object with an accessor property |

### Scenario: A package cannot pollute shared objects

**Given** a package that declares the keys `__proto__`, `constructor`, or `prototype`  
**When** the registry loads it  
**Then** the package is rejected  
**And** the prototype of ordinary objects is unchanged

## Capabilities

### Scenario: A generic consumer gates on a capability, not on a system

**Given** two packages where only one declares a capability  
**When** a generic consumer asks each package whether it has that capability  
**Then** the answer differs by declaration alone  
**And** the consumer never receives or compares a system identifier to get that answer

### Scenario: The capability set is closed and documented

**Given** the capability registry  
**Then** every key has a documented meaning  
**And** no key contains the name of a system

### Scenario: The two MVP systems are expressible with no key of their own

**Given** declarations of the mechanics in `PRD.md` s.10 for both a rules-light slot-based system and
a narrative aspect-based system, as contract test data  
**When** both load  
**Then** both pass the conformance kit  
**And** neither needed a field or capability used only because of its own name

## Declared Mechanics

### Scenario: A pool resource and a track of marked boxes are both expressible

**Given** a resource declared as a numeric pool with `min`, `max`, and recovery  
**And** a resource declared as a track of separately marked boxes  
**When** the package loads  
**Then** a consumer reads each one's shape from the declaration  
**And** the box track stays boxes, never a single number

### Scenario: Repeatable structured text carries its entry type

**Given** a repeatable field whose entries hold free text and a declared entry type  
**When** the package loads  
**Then** the free text is unconstrained by an enumeration  
**And** the entry type is one of the values the field declares

### Scenario: An action declares its roll and outcome branches without evaluating them

**Given** an action with a roll expression, a success condition, and outcome branches  
**When** the package loads  
**Then** the roll and condition are available as dice and formula references by contract type  
**And** no dice are rolled and no formula is evaluated

### Scenario: Outcome branches can offer choices to the table

**Given** an action outcome that offers several options instead of one effect  
**When** a consumer reads it  
**Then** the outcome is marked as a choice for the table, so nothing is applied automatically

### Scenario: Hidden declarations stay declared

**Given** a resource or field declared as visible to GMs only  
**When** a consumer reads the package  
**Then** the declared visibility uses the feature 04 vocabulary

## Licence and Integration

### Scenario: Mechanical support and documentation rights are separate

**Given** a package with mechanics supported and rules text not redistributable  
**When** a consumer reads its integration status and licence  
**Then** the two are separate fields with separate answers

### Scenario Outline: Integration claims cannot contradict the licence

**Given** a package that claims <claim>  
**And** whose licence declares <permission>  
**When** the registry loads it  
**Then** the package is rejected naming the contradiction

| claim | permission |
| --- | --- |
| rules text integrated | rules text forbidden |
| rules sections with shipped text | rules text forbidden |

### Scenario: A package with no integrated text points elsewhere honestly

**Given** a package with rules text not integrated  
**When** the summary is derived  
**Then** its documentation status is external or unavailable, never integrated

## Versions

### Scenario: Two versions of one system are served side by side

**Given** versions `1.0.0` and `1.1.0` of one system are installed  
**When** a campaign pinned to `1.0.0` resolves its system  
**Then** it receives exactly `1.0.0`  
**And** the list of installed systems shows that system once, at its latest version

### Scenario: A published version is immutable

**Given** version `1.0.0` of a system is loaded  
**When** different content claims the same `system-id@version`  
**Then** the registry rejects it as a conflict and keeps serving the original

### Scenario: The same content loaded twice is not a conflict

**Given** version `1.0.0` of a system is loaded  
**When** byte-equivalent content is loaded again  
**Then** nothing changes and no error is raised

### Scenario: A pinned version that is not installed is reported

**Given** no installed package matches a reference  
**When** it is resolved  
**Then** the answer is "not installed", never a different version

### Scenario: Consumers cannot change a served package

**Given** a consumer holding a package from the registry  
**When** it attempts to change a value  
**Then** the change fails or does not affect what the registry serves next

## Campaign Integration

### Scenario: The creation wizard reads the summary alone

**Given** installed packages  
**When** feature 02 lists systems and starts the wizard  
**Then** selection renders from `SystemSummary`, options, game modes, and compatible modules derived
from the package, with no branch on system identity

### Scenario: Existing pinned campaigns keep resolving

**Given** a campaign pinned to the fixture system before this feature  
**When** the application starts on the registry  
**Then** the campaign still resolves to the same reference and the same options

## Conformance Kit

### Scenario: The kit passes a conforming package and names each failure

**Given** the conformance kit and a package  
**When** the kit runs  
**Then** a conforming package passes every check  
**And** a package failing a check is reported with that check's name and the offending path

### Scenario: The kit knows no system

**Given** the conformance kit source  
**Then** it contains no system identifier and no system-specific expectation

## PRD Traceability

| Requirement | Scenarios |
| --- | --- |
| FR-001, FR-002 manifest and identity | A valid package loads; invalid package rejected |
| FR-003 licence | Mechanical support and documentation rights; integration claims |
| FR-004 capability registry | Generic consumer gates on a capability; capability set closed |
| FR-005 character schema | Repeatable structured text; invalid package rejected |
| FR-006 resources | Pool and box track; hidden declarations |
| FR-007 actions | Action declares its roll; outcome branches offer choices |
| FR-008 options and modes | Creation wizard reads the summary |
| FR-009 strict validation | Invalid package rejected; first-party no exemption; one bad package |
| FR-010 no code | Loading never evaluates; non-data refused; prototype pollution |
| FR-011 registry | Versions section |
| FR-012 early-publish set | Creation wizard; pool and box track; two MVP systems expressible |
| FR-013 conformance kit | Conformance Kit section |
