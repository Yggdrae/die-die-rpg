# BDD: Attachments and Object Storage

Source: `_prd.md`, `../00-platform-foundation/_techspec.md`,
`../03-offline-sync-platform/_bdd.md`, `../04-visibility-and-authorization/_prd.md`.

These scenarios describe observable attachment behavior. They do not name an object-storage
vendor: FR-001 requires provider choice to remain behind the module boundary. "Authorized" and
"visible" below mean that feature 04 returned an allow decision for the actor, campaign,
resource class, operation, and attachment visibility.

The MVP file policy is settled by the PRD:

- accepted MIME types: `application/pdf`, `image/jpeg`, `image/png`, and `image/webp`;
- maximum declared file size: 25 MB per file;
- SVG, audio, video, Markdown, text, and every unlisted type are rejected.

---

## Attaching Files

### Scenario Outline: A GM attaches a supported file to a supported entity

**Given** a GM may update a `<entity>` in their campaign  
**And** the GM selected a file no larger than 25 MB with an allowed MIME type  
**When** the GM requests permission, uploads the file, and finalizes the upload  
**Then** exactly one attachment is listed on the `<entity>`  
**And** its filename, MIME type, size, checksum, visibility, and audit fields are available as metadata  
**And** it can be resolved through the published attachment module API

| entity |
| --- |
| NPC |
| location |
| note |

### Scenario: Binary content goes directly to the granted upload destination

**Given** an authorized GM has received upload permission  
**When** the GM uploads a file  
**Then** the binary bytes are sent to the granted object-storage destination  
**And** no attachment API request or response carries the binary content

### Scenario: An upload is not visible before finalization

**Given** an authorized GM has uploaded binary content  
**And** the upload has not been finalized  
**When** any authorized member lists or resolves attachments  
**Then** the pending upload is absent  
**And** no read URL is issued for it

### Scenario: A valid finalization makes one attachment visible

**Given** an authorized GM uploaded a file using granted upload permission  
**And** the stored size and checksum match the values submitted for finalization  
**When** the GM finalizes the upload  
**Then** the upload status becomes finalized  
**And** exactly one attachment is listed on its owner entity  
**And** an authorized viewer can resolve it

### Scenario: Retrying finalization is idempotent

**Given** an upload was finalized successfully  
**When** the same actor repeats finalization with the same size and checksum  
**Then** the result identifies the same attachment  
**And** no duplicate metadata record or attachment listing is created

### Scenario Outline: A stored-file mismatch prevents finalization

**Given** an authorized GM uploaded binary content  
**And** the stored `<property>` differs from the value submitted for finalization  
**When** the GM finalizes the upload  
**Then** finalization is rejected with a clear `<property>` mismatch error  
**And** the upload remains absent from attachment listings  
**And** no read URL is issued for it

| property |
| --- |
| size |
| checksum |

### Scenario: An abandoned upload is collected

**Given** binary content was uploaded but never finalized  
**When** the configured unfinalized-upload lifetime elapses  
**Then** the binary content is removed from object storage  
**And** the upload remains absent from attachment listings

---

## Upload Authorization and File Policy

### Scenario: Upload permission requires an authorization decision

**Given** a user requests permission to attach a file  
**When** no authorization decision is available  
**Then** the request fails closed  
**And** no signed upload URL is issued

### Scenario Outline: An unauthorized actor receives no upload destination

**Given** `<condition>`  
**When** the actor requests permission to upload a valid file to an entity  
**Then** the request is denied using the consistent API error shape  
**And** no signed upload URL is issued  
**And** the response does not reveal whether a hidden target entity exists

| condition |
| --- |
| a player cannot update the target entity |
| the actor is not a member of the target campaign |
| the target entity belongs to another campaign |
| the resource class or visibility value is unknown |

### Scenario Outline: Every MVP MIME type is accepted at the policy boundary

**Given** an authorized GM requests an upload for a file no larger than 25 MB  
**And** the declared MIME type is `<mime>`  
**When** server-side upload validation runs  
**Then** validation accepts the file policy  
**And** upload permission may be issued

| mime |
| --- |
| `application/pdf` |
| `image/jpeg` |
| `image/png` |
| `image/webp` |

### Scenario Outline: Every unlisted MIME type is rejected before upload

**Given** an authorized GM requests an upload  
**And** the declared MIME type is `<mime>`  
**When** server-side upload validation runs  
**Then** validation rejects the request as an unsupported file type  
**And** no signed upload URL is issued

| mime |
| --- |
| `image/svg+xml` |
| `audio/mpeg` |
| `video/mp4` |
| `text/markdown` |
| `text/plain` |
| `application/octet-stream` |

### Scenario: A file exactly at the size limit is accepted

**Given** an authorized GM requests an upload for an allowed MIME type  
**And** the declared size is exactly 25 MB  
**When** server-side upload validation runs  
**Then** validation accepts the file policy  
**And** upload permission may be issued

### Scenario: A file over the size limit is rejected before upload

**Given** an authorized GM requests an upload for an allowed MIME type  
**And** the declared size is greater than 25 MB  
**When** server-side upload validation runs  
**Then** validation rejects the request as too large  
**And** the response states the 25 MB limit  
**And** no signed upload URL is issued

### Scenario: Client acceptance cannot bypass server validation

**Given** a modified client reports that an oversized or unsupported file is acceptable  
**When** it requests upload permission  
**Then** the server independently rejects the request  
**And** no signed upload URL is issued

---

## Authorized Reading and Safe Rendering

### Scenario: An authorized viewer receives a temporary read destination

**Given** a finalized attachment is visible to an actor  
**When** the actor resolves the attachment  
**Then** the actor receives an expiring signed read URL  
**And** the URL resolves the attachment binary before it expires  
**And** the attachment is not made permanently public

### Scenario: A read request requires a fresh authorization decision

**Given** an actor requests a read URL for a finalized attachment  
**When** no authorization decision is available  
**Then** the request fails closed  
**And** no signed read URL is issued

### Scenario: A hidden attachment does not leak through resolution

**Given** an attachment exists but is not visible to a player  
**When** the player tries to resolve its identifier  
**Then** no signed read URL is issued  
**And** the error has the same public status and shape as resolving an unknown attachment  
**And** the filename and all other metadata are absent from the response

### Scenario: A leaked read URL ages out

**Given** a signed read URL was issued after an allow decision  
**When** its declared expiry has passed  
**Then** object storage refuses the URL  
**And** obtaining another URL requires another authorization decision

### Scenario Outline: Uploaded content cannot execute in the application origin

**Given** an authorized actor opens an uploaded `<kind>` containing active or malformed content  
**When** the application displays or downloads it  
**Then** it is treated as inert content or rendered in a sandbox outside the application origin  
**And** its content cannot execute script in the application origin  
**And** it cannot read the application's campaign data or session credentials

| kind |
| --- |
| PDF |
| JPEG image |
| PNG image |
| WebP image |

---

## Offline Availability

### Scenario: Campaign pinning requires an explicit confirmation

**Given** a campaign contains attachments that the actor may see  
**And** those attachments are not pinned on this device  
**When** the actor asks to make the campaign available offline  
**Then** the application shows an estimated download size before any full attachment download begins  
**And** the attachments remain cloud only until the actor confirms

### Scenario: Dismissing the estimate downloads nothing

**Given** the application is showing the estimated size for making a campaign available offline  
**When** the actor dismisses the confirmation  
**Then** no cloud-only attachment begins downloading  
**And** its availability state remains cloud only

### Scenario: Confirming campaign pinning reports progress

**Given** the actor confirmed the displayed offline size estimate  
**When** authorized attachments download  
**Then** each in-progress attachment has the downloading state  
**And** aggregate progress is visible  
**And** each completed attachment has the pinned-offline state

### Scenario: Only currently visible attachments are pinned

**Given** a campaign contains attachments with different visibility  
**When** an actor confirms making the campaign available offline  
**Then** only attachments allowed by an authorization decision are requested  
**And** hidden filenames, metadata, and binary content are not stored on the device

### Scenario: Repeating campaign pinning does not duplicate local content

**Given** every visible attachment in a campaign is already pinned on the device  
**When** the actor again confirms making the campaign available offline  
**Then** the attachments remain pinned offline  
**And** no second local copy of any unchanged binary is created  
**And** the reported storage cost does not increase for unchanged binaries

### Scenario: A pinned attachment opens without a network

**Given** an attachment reached the pinned-offline state on this device  
**When** the network is unavailable and the actor opens it  
**Then** the attachment opens from local content  
**And** no network request is required

### Scenario: Cached content opens without becoming permanently pinned

**Given** an attachment has the cached state on this device  
**When** the network is unavailable and the actor opens it before eviction  
**Then** the attachment opens from local content  
**And** its state remains cached rather than pinned offline

### Scenario: Missing local content degrades clearly

**Given** attachment metadata is available locally  
**And** its binary content is not available locally  
**And** the network is unavailable  
**When** the actor opens the attachment  
**Then** no broken or blank viewer is shown  
**And** the attachment reports unavailable  
**And** the campaign remains usable

### Scenario Outline: Availability state reflects the observed condition

**Given** an attachment is known to the device  
**When** its local condition is `<condition>`  
**Then** its availability state is `<state>`

| condition | state |
| --- | --- |
| metadata exists but the binary has never been downloaded | cloud only |
| an evictable local binary exists | cached |
| a retained local binary exists by explicit request | pinned offline |
| an explicitly requested binary is in progress | downloading |
| the binary is missing locally and cannot currently be fetched | unavailable |

---

## Deletion and Retention

### Scenario: Deleting an attachment publishes a tombstone

**Given** a finalized attachment is synchronized to two devices  
**When** an authorized actor deletes it and both devices synchronize  
**Then** the attachment is absent from default listings on both devices  
**And** neither device resolves a new read URL for it  
**And** the deletion tombstone prevents it from reappearing

### Scenario: Deleting metadata does not remove the object inline

**Given** an authorized actor deletes a finalized attachment  
**When** the deletion is accepted  
**Then** the attachment becomes deleted without waiting for object removal  
**And** the object is not removed before the configured retention window elapses

### Scenario: A retained object is eventually removed

**Given** an attachment metadata tombstone has remained past the configured retention window  
**And** no retained reference requires the object  
**When** retention cleanup completes  
**Then** the attachment object is absent from object storage  
**And** a later reconciliation does not restore the attachment

### Scenario: Repeating deletion is idempotent

**Given** an attachment is already tombstoned  
**When** the same authorized delete request is retried  
**Then** the attachment remains represented by one tombstone  
**And** no new read URL is issued  
**And** the configured retention deadline is unchanged

---

## Published Module and Export

### Scenario: Consumers attach, list, and resolve without storage-provider knowledge

**Given** a consuming feature holds an `AttachmentRef` for campaign content  
**When** it uses the published attachment module to attach, list, or resolve  
**Then** the operation has the same authorization, validation, and visibility behavior described above  
**And** its observable request and result do not require a storage-provider identifier

### Scenario: Export receives an attachment manifest contribution

**Given** a campaign contains finalized attachments  
**When** feature 07 invokes every registered exportable module  
**Then** the attachment module contributes one manifest entry per export-eligible attachment  
**And** each entry carries the attachment identifier, MIME type, size, and checksum  
**And** the manifest preserves attachment visibility

---

## P1 Behavior

### Scenario: An image listing uses a thumbnail instead of the full image

**Given** a finalized JPEG, PNG, or WebP attachment has a generated thumbnail  
**When** an authorized actor views an attachment listing  
**Then** the listing resolves the thumbnail  
**And** it does not download the full image unless the actor opens it

### Scenario: A PDF does not require an image thumbnail

**Given** a finalized PDF attachment is listed  
**When** an authorized actor views the attachment listing  
**Then** the PDF is represented without downloading the full document  
**And** the absence of an image thumbnail does not make the attachment unavailable

### Scenario: A visible attachment can be pinned individually

**Given** an actor may see a cloud-only attachment  
**When** the actor requests that attachment offline and confirms its size  
**Then** it progresses through downloading to pinned offline  
**And** other cloud-only attachments do not begin downloading

### Scenario: Unpinning removes the permanence guarantee

**Given** an attachment is pinned offline  
**When** the actor unpins it  
**Then** it no longer has the pinned-offline state  
**And** the application may retain it only as evictable cached content  
**And** other pinned attachments are unchanged

### Scenario: Campaign storage usage is visible

**Given** a campaign has cloud-only, cached, and pinned attachments  
**When** an authorized actor opens campaign storage usage  
**Then** the view reports the campaign's attachment bytes stored on this device  
**And** pinned and evictable cached usage can be distinguished  
**And** the reported total equals the measured local attachment bytes

---

## Success-Signal Scenarios

### Scenario: A normal map upload reaches preview within the target

**Given** the agreed normal-connection test profile  
**And** a GM selects an allowed map image within the size limit  
**When** upload permission is requested  
**Then** successful upload, finalization, and working preview complete within 30 seconds

### Scenario: A pinned campaign survives network loss

**Given** campaign pinning reported every selected attachment as pinned offline  
**When** the network is disabled  
**Then** every selected attachment opens successfully

### Scenario: The offline estimate stays within its declared tolerance

**Given** an actor confirmed a displayed campaign offline-size estimate  
**When** every selected attachment reaches pinned offline  
**Then** the difference between the estimate and actual downloaded bytes is within the declared tolerance

---

## Traceability

| PRD | Scenarios |
| --- | --- |
| Goal: attach files to entities | A GM attaches a supported file to a supported entity |
| Goal: offline attachments | Campaign pinning requires an explicit confirmation; A pinned attachment opens without a network; Missing local content degrades clearly |
| Goal: untrusted content is inert | Uploaded content cannot execute in the application origin |
| FR-001 provider-neutral object storage | Consumers attach, list, and resolve without storage-provider knowledge; no scenario names a provider |
| FR-002 metadata separate from binary | A GM attaches a supported file to a supported entity; Binary content goes directly to the granted upload destination |
| FR-003 signed-URL upload flow | Binary content goes directly to the granted upload destination; A valid finalization makes one attachment visible |
| FR-004 pre-upload validation | Upload permission requires an authorization decision; An unauthorized actor receives no upload destination; MIME and size policy scenarios |
| FR-005 verified finalization and garbage collection | An upload is not visible before finalization; A stored-file mismatch prevents finalization; An abandoned upload is collected; Retrying finalization is idempotent |
| FR-006 MVP file policy | Every MVP MIME type is accepted; Every unlisted MIME type is rejected; size-boundary scenarios |
| FR-007 authorized signed reads | An authorized viewer receives a temporary read destination; A read request requires a fresh authorization decision; A hidden attachment does not leak; A leaked read URL ages out |
| FR-008 safe rendering | Uploaded content cannot execute in the application origin |
| FR-009 availability states | Availability state reflects the observed condition; Missing local content degrades clearly |
| FR-010 campaign offline flow | Campaign pinning requires an explicit confirmation; Dismissing the estimate downloads nothing; Confirming campaign pinning reports progress; Only currently visible attachments are pinned |
| FR-011 offline opening | A pinned attachment opens without a network; A pinned campaign survives network loss |
| FR-012 tombstone and delayed object removal | All Deletion and Retention scenarios |
| FR-013 published module API | A GM attaches a supported file to a supported entity; Consumers attach, list, and resolve without storage-provider knowledge |
| FR-014 export manifest | Export receives an attachment manifest contribution |
| FR-101 thumbnails | An image listing uses a thumbnail instead of the full image; A PDF does not require an image thumbnail |
| FR-102 individual pinning | A visible attachment can be pinned individually; Unpinning removes the permanence guarantee |
| FR-103 storage usage | Campaign storage usage is visible |
| Success: preview under 30 seconds | A normal map upload reaches preview within the target |
| Success: no unauthorized serving | Upload permission requires an authorization decision; A read request requires a fresh authorization decision; A hidden attachment does not leak |
| Success: estimate accuracy | The offline estimate stays within its declared tolerance |

## Not Covered Here

- Handout reveal semantics, owned by feature 17. This feature only enforces the visibility decision
  supplied by feature 04 when a handout consumer requests attachment access.
- Image editing, cropping, map tooling, media streaming, and collaborative document editing.
- Malware scanning (FR-201) and production exercise of alternative providers (FR-202), both P2.
- Exact role and resource-class permissions. Feature 04 owns the authorization matrix; these
  scenarios assert that an allow or deny decision is always obtained and enforced.
- Relational schema, object keys, storage SDKs, and provider implementation details. Those are
  technical and persistence specification concerns rather than observable product behavior.

## Downstream Decisions and Remaining Profile Work

`_db.md` and `_techspec.md` settle the storage behavior: pending uploads expire after 24 hours;
ready objects retain 30 days after deletion; purge also waits for sync watermark and retained job
references; estimate tolerance is max(1 MiB, 1%) of payload bytes; revocation aborts downloads and
deletes local bytes on observed sync; finalization verifies file signatures; signed read URLs last
five minutes; and P0 export is manifest-only.

Task 01 must still evidence the S3/MinIO/browser-isolation configuration, and task 07 must define the
normal-connection reference profile used for the 30-second acceptance measurement.
