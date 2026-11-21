-- Feature 06 task 04: the campaign-visible and GM-private audit stores replicate through their own
-- streams (`campaign_audit`, `gm_private_audit` in `infra/powersync/sync-config.yaml`). Each
-- stream's query applies the target's current rule, the stored snapshot, and (private store) the
-- GM reading roles, so a row reaches only a replica that may read it. The provider reads the
-- tables (snapshot and WAL); no other audit table is published: `audit_account_events`, the
-- sequence allocators, and the repair outbox never leave the authority.
ALTER PUBLICATION "powersync" ADD TABLE
  "public"."audit_campaign_events",
  "public"."audit_private_events";--> statement-breakpoint
GRANT SELECT ON TABLE
  "public"."audit_campaign_events",
  "public"."audit_private_events"
TO "powersync_replicator";
