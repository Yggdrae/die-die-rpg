# BDD: Rules Library

Source: `_prd.md`, `PRD.md` s.8, s.9, s.14, s.26, s.66, s.69, s.76, s.78, s.87 Test 8, s.88, s.89. P0 only. Light,
per `_index.md`.

## Finding a rule

### Scenario: A rule is found in under 10 seconds (FR-002, `PRD.md` s.78, s.87 Test 8)

**Given** a campaign pinned to a package that ships rules text, open on the GM's device  
**When** the GM focuses the rules search and types the word they would say out loud  
**Then** the matching section's text is on screen less than 10 seconds after the search was focused  
**And** the same holds with the device offline

### Scenario: Results carry enough context to choose (FR-002, FR-007)

**Given** sections "Healing", which declares a quick rule, and "Harm", whose body mentions healing  
**When** the user searches "heal"  
**Then** both are listed with their category, a section with a quick rule first, showing the quick rule  
**And** a section without one shows a snippet of its own text

### Scenario: The search states its scope

**Then** the library says how many sections of which pinned system and version it searches, on this device

### Scenario: Rules appear in the global search and the Session Mode palette (FR-012)

**Given** the campaign search of feature 20 and the Session Mode palette  
**When** the user types the start of a section title  
**Then** the section is listed with the type "Rule"  
**And** choosing it opens the section in the library

## Reading

### Scenario: The declared tree is rendered, not an imposed outline (FR-001)

**Given** a package whose sections declare categories in their own order  
**Then** the library groups sections by category in first-appearance order, sections in declared order

### Scenario: A cross-reference is one tap away (FR-004)

**Given** an open section that references another section  
**When** the user follows the reference  
**Then** the referenced section opens

### Scenario: Attribution travels with the content (FR-013)

**Then** the licence, the attribution text, and the source link are shown with the library and its sections

### Scenario: Only the pinned version is shown (FR-011)

**Given** a campaign pinned to version 1.0.0 of a system and an app that installs no such version  
**Then** the library says the pinned rules are not installed, and shows no other version

## Honest empty states (FR-010)

### Scenario: A package that ships no text points elsewhere

**Given** a package whose sections carry no text and which declares external documentation  
**Then** the library lists the declared sections, says the text is not included in the app and why, and links the
external documentation  
**And** a search still finds sections by title

### Scenario: Forbidden text is never displayed

**Given** a package whose licence does not allow rules text, but whose sections carry text anyway  
**Then** no section text is displayed and the licence reason is stated

## Bookmarks and history (FR-005, FR-006)

### Scenario: The third lookup is faster than the first

**When** the user bookmarks a section  
**Then** it is listed under the bookmarks, and removing the bookmark removes it  
**And** opening sections lists them under recently viewed, newest first

### Scenario: Bookmarks and history are private (`_prd.md` "Data and Privacy")

**Given** a player who bookmarked and viewed sections  
**Then** the GM's device never holds the player's bookmarks or history, and the player's never holds the GM's

### Scenario: Bookmarks work offline

**Given** a device with no connection  
**When** the user bookmarks a section  
**Then** it is listed at once and reaches the authority when the connection returns

### Scenario: Two devices never conflict

**Given** the same user bookmarks a section on one device and removes it on another  
**Then** the later change wins on both, and no conflict is shown

## Access

### Scenario: Every member reads the rules (FR-009)

**Given** a player of the campaign  
**Then** the player reads the whole library of the pinned package

### Scenario: Rules before a campaign exists (FR-008)

**Given** the system selection step of campaign creation  
**When** the GM previews the rules of an installed system  
**Then** the library of that system opens, with no bookmarks or history, and the selection does not change
