-- Fixture statements for `live-sync.e2e.ts` (feature 03 tasks 04/07/08). Test data only: random
-- ids, committed to the real tables the PowerSync publication streams, deleted by `cleanup_*`.
-- One statement per `-- name:` block; parameters are positional.

-- name: seed_user
INSERT INTO identity_users (id, username_display, username_normalized) VALUES ($1, $2, $3);

-- name: seed_campaign
INSERT INTO campaigns (id, name, game_mode, created_by) VALUES ($1, $2, 'standard', $3);

-- name: seed_membership
INSERT INTO identity_campaign_memberships (campaign_id, user_id, role) VALUES ($1, $2, $3);

-- name: seed_setting
INSERT INTO campaign_settings (campaign_id, namespace, value, member_visible, updated_by)
VALUES ($1, $2, $3::jsonb, $4, $5);

-- name: membership_active
SELECT count(*)::int AS count FROM identity_campaign_memberships
WHERE campaign_id = $1 AND user_id = $2 AND removed_at IS NULL;

-- name: revoke_membership
UPDATE identity_campaign_memberships
SET removed_at = now(), updated_at = now(), version = version + 1
WHERE campaign_id = $1 AND user_id = $2 AND removed_at IS NULL;

-- name: campaign_details
SELECT name, version::int AS version FROM campaigns WHERE id = $1;

-- name: rename_campaign
UPDATE campaigns SET name = $2, version = version + 1, updated_at = now()
WHERE id = $1 AND version = $3 AND deleted_at IS NULL
RETURNING version::int AS version;

-- name: cleanup_settings
DELETE FROM campaign_settings WHERE campaign_id = ANY($1::uuid[]);

-- name: cleanup_memberships
DELETE FROM identity_campaign_memberships WHERE campaign_id = ANY($1::uuid[]);

-- name: cleanup_campaigns
DELETE FROM campaigns WHERE id = ANY($1::uuid[]);

-- name: cleanup_users
DELETE FROM identity_users WHERE id = ANY($1::uuid[]);

-- name: seed_audit_campaign
-- Feature 06 task 04. Audit stores are append-only: these rows stay after cleanup (their campaign
-- and members are removed, so no stream delivers them).
INSERT INTO audit_campaign_events (id, campaign_id, campaign_sequence, actor_user_id, actor_role,
  action, target_type, target_id, target_visibility, before_value, after_value, client_recorded_at,
  origin_mutation_id, renderer_version)
VALUES ($1, $2, $3, $4, 'owner', 'campaign.details_updated', 'campaign', $2, $5::text::jsonb,
  '{"name":"Before"}', '{"name":"After"}', now(), gen_random_uuid(), 1);

-- name: seed_audit_private
INSERT INTO audit_private_events (id, campaign_id, campaign_sequence, actor_user_id, actor_role,
  action, target_type, target_id, target_visibility, client_recorded_at, origin_mutation_id,
  renderer_version)
VALUES ($1, $2, $3, $4, 'owner', 'campaign.details_updated', 'campaign', $2, $5::text::jsonb,
  now(), gen_random_uuid(), 1);
