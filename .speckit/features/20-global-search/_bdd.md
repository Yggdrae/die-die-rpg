# BDD: Global Search

Source: `_prd.md`, `PRD.md` s.26, s.45, s.68, s.76, s.78, s.88. P0 only. Light, per `_index.md`.

## Finding

### Scenario: A GM finds an NPC by typing three letters (FR-003, FR-007)

**Given** a campaign whose replica on the GM's device holds the NPC "Mirela Voss"  
**When** the GM types "mir" into the campaign search  
**Then** "Mirela Voss" is the first result, labelled with its type, in under 5 seconds  
**And** activating it opens the entity in the content view (FR-006)

### Scenario: Partial words and accents do not matter (FR-007)

**Given** documents titled "Wareham Ford" and "Mérchant Guild"  
**Then** "ware fo" finds "Wareham Ford" and "merch" finds "Mérchant Guild"  
**And** every typed word must match the start of some word of the document

### Scenario: Title matches rank before body matches

**Given** an NPC titled "Ford Keeper" and a location whose description mentions a ford  
**When** the GM searches "ford"  
**Then** the title match ranks first, with no ranking by type

## Visibility

### Scenario: A player never finds GM-only content (FR-004)

**Given** a GM-only NPC "Mirela Voss" and a location "Wareham Ford" visible to everyone  
**When** the player searches "mir"  
**Then** there is no result and the result count reads 0  
**And** searching "ware" finds "Wareham Ford"

### Scenario: Visibility is decided at query time

**Given** a document indexed while GM-only  
**When** the content is revealed to the player and the change reaches the device  
**Then** the player's next search finds it, with no rebuild

### Scenario: Counts and snippets never reveal hidden content

**Given** documents the actor may not read  
**Then** they are dropped before ranking, counting, and limiting, and a snippet comes only from the result's own body

### Scenario: The index only holds what the replica holds

**Given** a contributor that returns a document of another campaign or an invalid document  
**Then** the document is not indexed and the module reports it

## Freshness

### Scenario: A newly synchronized NPC is findable without a rebuild (FR-005)

**Given** a player's search screen is open  
**When** the GM creates an everyone-visible location and it synchronizes  
**Then** the player's search finds it without reloading

### Scenario: Search works offline (`PRD.md` s.76)

**Given** the GM's device is offline  
**When** the GM creates an NPC locally and searches for it  
**Then** it is found, as it would be online

### Scenario: The index rebuilds from scratch (FR-009)

**When** the index is rebuilt  
**Then** every contributor runs again and the results equal those of the incremental index

### Scenario: A failing contributor is stated, not silent

**Given** one contributor throws  
**Then** the other contributors' results still appear and the screen states which content could not be indexed

## Composition

### Scenario: The palette uses this search (FR-008)

**Given** an open session and the shell's search provider  
**When** the GM types "ware" in the command palette  
**Then** "Wareham Ford" appears from search, and choosing it shows the session lookup panel  
**And** Session Mode imports nothing of feature 20

### Scenario: A new feature becomes searchable with no change here (FR-001)

**Given** a feature that registers a `SearchIndexer` contribution in the shell  
**Then** its documents appear in search, and `@rpg/search` names no other feature's type
