# Data Design: [Feature Name]

## Data Inventory

| Data | Source of Truth | Storage | Offline | Sync | Conflict Strategy |
| --- | --- | --- | --- | --- | --- |
| [Data] | [System] | [Postgres/SQLite/MinIO/Yjs/etc.] | Yes/No | [Method] | [Rule] |

## Ownership and Access

| Data | Owner | Read | Write | Visibility |
| --- | --- | --- | --- | --- |
| [Data] | [Module/User] | [Who] | [Who] | [Rule] |

## Relational Changes

### Tables / Columns

- [Change]

### Constraints / Indexes

- [Constraint/index]

## Offline and Sync

- Local representation: [schema/table/document]
- Sync direction: [server->client/client->server/bidirectional]
- Filter/partition rule: [rule]
- Conflict behavior: [rule]
- Reconnect behavior: [rule]

## Blob Storage

- Object type: [file]
- Metadata location: [table]
- Object key strategy: [strategy]
- Version/delete behavior: [behavior]

## Collaborative Documents

- CRDT needed: Yes/No
- Document identity: [rule]
- Persistence: [rule]
- Authorization: [rule]

## Migration and Backfill

- [Migration step]
- Rollback/recovery: [approach]

## Data Integrity Risks

- [Risk and mitigation]

## Open Questions

- TODO: [Question]
