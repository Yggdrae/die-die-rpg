-- Feature 03 task 04: least-privilege logical-replication publication for the sync provider.
-- The provider (PowerSync) reads only the publication named `powersync`. It lists exactly the
-- tables `infra/powersync/sync-config.yaml` streams. Credential, session, recovery, invitation,
-- binding, user, and sync bookkeeping tables are never published. A `FOR ALL TABLES` publication
-- cannot be narrowed with ALTER, so it is replaced. Adding a streamed table later requires a new
-- forward migration (`ALTER PUBLICATION powersync ADD TABLE ...`); the publication test enforces it.
DROP PUBLICATION IF EXISTS "powersync";--> statement-breakpoint
CREATE PUBLICATION "powersync" FOR TABLE
  "public"."campaigns",
  "public"."campaign_settings",
  "public"."identity_campaign_memberships",
  "public"."sync_long_text_holds";
