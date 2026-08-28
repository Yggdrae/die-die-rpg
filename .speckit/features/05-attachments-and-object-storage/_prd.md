# PRD: Attachments and Object Storage

Source: `PRD.md` s.31, s.32, s.33, s.61, s.75, s.76, s.77, s.88.
Track: A. Depends on: `AttachmentRef` from feature 00, authorization from feature 04.

## Problem

A campaign is not only records. It is maps, letters, portraits, ambient audio, and PDFs
(`PRD.md` s.31). Those files are large, they must not enter the relational database
(`PRD.md` s.54), and they must be available at the table where the network is not
(`PRD.md` s.76). They are also the most dangerous content in the product, because a file
uploaded by one user is rendered to others (`PRD.md` s.33).

Every feature that shows a file needs the same upload, authorization, and offline behaviour.
Building it once here is the difference between one hardened path and six ad hoc ones.

## Goals

- A GM attaches a file to any entity without thinking about storage.
- Binary content lives in S3-compatible object storage; only metadata lives in PostgreSQL
  (`PRD.md` s.32).
- The domain depends on an `ObjectStorage` abstraction, never on MinIO or a specific vendor
  (`PRD.md` s.32, s.61).
- A campaign can be made available offline with a stated size cost, and previously available
  attachments open with no network (`PRD.md` s.76, s.77).
- Untrusted uploaded content is never executed in the application origin (`PRD.md` s.33).

## Non-Goals

- Handout reveal semantics. Feature 17 owns them and consumes attachments.
- Image editing, cropping, transcoding beyond thumbnails, or map tooling.
- Collaborative document editing. Yjs documents are V1 (`PRD.md` s.58).
- Content delivery network configuration or media streaming.
- Automatic download of every attachment. `PRD.md` s.77 explicitly rejects it.

## Users and Context

### Primary user

A GM preparing a campaign, attaching a map and two handout images, then marking the campaign
available offline before leaving for the session.

### Secondary users

Players viewing revealed attachments, often on a phone, often on the venue network.

## User Stories

- As a GM, I want to attach a file to an NPC, a location, or a note, so that my material lives
  next to the thing it belongs to.
- As a GM, I want to know how much space taking a campaign offline will cost, so that I can decide
  on a device with limited storage.
- As a GM, I want the map I pinned to open with no signal, so that the session is not blocked.
- As a player, I want a revealed image to display immediately, so that the table does not wait.
- As a GM, I want an oversized or wrong-type upload rejected clearly, so that I fix it before the session.

## Functional Requirements

### P0 — MVP

- FR-001: `ObjectStorage` abstraction with an S3-compatible implementation. MinIO is the local
  and self-hosted default (`PRD.md` s.32, s.91). No feature references MinIO directly.
- FR-002: Attachment metadata in PostgreSQL: owner entity reference, filename, MIME type, size,
  checksum, upload status, visibility, audit fields. Binary content never in PostgreSQL.
- FR-003: Signed-URL upload flow per `PRD.md` s.33: request upload permission, receive a signed
  upload URL, upload directly to object storage, finalize metadata.
- FR-004: Server-side validation before issuing a signed URL: authorization (feature 04),
  maximum size, allowed MIME types, campaign ownership.
- FR-005: Post-upload finalization verifying declared size and checksum. An unfinalized upload
  is not visible as an attachment and is garbage-collected.
- FR-006: MVP accepts PDF, JPEG, PNG, and WebP files up to 25 MB each. SVG, audio, video,
  Markdown, text, and other types are rejected at validation, not at render time.
- FR-007: Download and view through authorized, expiring signed read URLs. Visibility from
  feature 04 decides access.
- FR-008: Untrusted content is never rendered as executable HTML in the application origin
  (`PRD.md` s.33, s.75). Documents render sandboxed or as inert content.
- FR-009: Offline availability states per `PRD.md` s.77: cloud only, cached, pinned offline,
  downloading, unavailable.
- FR-010: Make campaign available offline (`PRD.md` s.77), with a size estimate before confirming
  and progress while downloading.
- FR-011: A previously pinned attachment opens with no network (`PRD.md` s.76).
- FR-012: Attachment deletion is a soft delete on metadata with tombstone; object removal follows
  a retention window rather than happening inline, so a synchronized peer does not see a broken reference.
- FR-013: A published module API for attaching, listing, and resolving attachments, consumed by
  features 16, 17, 18, and any later feature.
- FR-014: `ExportableModule` implementation contributing the attachment manifest to feature 07.

### P1 — Important

- FR-101: Image thumbnails generated server-side, so a list of portraits does not download full images.
- FR-102: Per-attachment pin and unpin, rather than whole-campaign only.
- FR-103: Storage usage view per campaign.

### P2 — Later

- FR-201: Virus and malware scanning on upload.
- FR-202: Alternative storage providers exercised in production (`PRD.md` s.32 lists S3 and R2).

## Behavioral Constraints

- Uploads go client to object storage directly. Binary content does not stream through the API.
- No signed URL is issued without an authorization decision from feature 04.
- Size and MIME limits are enforced server-side. A client-side check is a convenience only.
- Read URLs expire and are not shareable indefinitely; a leaked URL must age out.
- Offline attachment availability is explicit. Nothing downloads a full campaign of media without
  the user asking (`PRD.md` s.77).
- Attachment metadata synchronizes through feature 03 like any entity. Binary content does not.
- A missing local binary degrades to a clear unavailable state, never to a broken session.

## Data and Privacy Considerations

- Uploaded files may contain purchased material and personal content. Access is decided by
  feature 04 and never by URL obscurity alone.
- Pinning places files on a user device permanently until unpinned; only files the actor may see
  are ever pinned.
- Filenames can leak information (a file named for a secret NPC). Filenames follow the visibility
  of their attachment.
- Deleting a campaign must eventually remove its objects; retention window and deletion guarantees
  need to be stated, since object storage deletion is not transactional with PostgreSQL.
- Export in feature 07 emits an attachment manifest; whether binaries are included is a decision
  recorded there.

## Success Signals

- A GM attaches a map and reaches a working preview in under 30 seconds on a normal connection.
- A pinned campaign opens every pinned attachment with the network disabled.
- Zero attachments served without an authorization decision, asserted by test.
- Zero uploaded documents rendered in the application origin with script execution.
- Offline size estimate is within a stated tolerance of actual downloaded bytes.

## Rollout

Wave 4, Track A. Features 16, 17, and 18 build against the `AttachmentRef` contract and fixture
attachments until it ships. Object storage runs locally from wave 0 (feature 00 FR-010), so
integration is not the first time MinIO is started.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Uploaded content executed in the application origin | Cross-site scripting with campaign data and session access | Serve untrusted content inert or from a separate origin; never inline into the application document (FR-008) |
| Signed URLs leaked or long-lived | Unauthorized access to private campaign material | Short expiry, authorization before issue, no permanent public URLs |
| Object storage and database deletion diverge | Orphaned objects or broken references | Soft delete plus retention window (FR-012); reconciliation job |
| Offline pinning fills the device | User cannot use the application at all | Size estimate before confirming (FR-010); per-attachment control in P1 |
| MinIO specifics leak into the domain | Provider replacement becomes a rewrite | `ObjectStorage` abstraction (FR-001); architecture guard from feature 00 FR-009 |
| Large video uploads treated like images | Timeouts, memory pressure, poor experience | Explicit size limits per type; multipart upload if limits require it |

## ADR Candidates

- Direct-to-storage signed upload versus proxying uploads through the API (`PRD.md` s.33).
- Serving untrusted user content from a separate origin versus sandboxed rendering in place.

## Open Questions

- Maximum size is 25 MB per file. Allowed MIME types are `application/pdf`, `image/jpeg`,
  `image/png`, and `image/webp`. SVG is excluded because it can contain active or external content.
- TODO: Whether feature 07 export includes binaries or only the manifest (`PRD.md` s.65 lists
  `attachments-manifest/`, which suggests manifest only).
- TODO: Object retention window after campaign deletion.
