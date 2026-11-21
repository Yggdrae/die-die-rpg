-- Feature 03 task 04: dedicated least-privilege PostgreSQL role for the sync provider (PowerSync).
-- Before this migration the provider connected as the database owner. The role below can log in,
-- open a logical replication connection, and SELECT only the tables in the `powersync`
-- publication (the snapshot reads them). It owns nothing and cannot write, read any other table
-- (credentials, sessions, recovery tokens, invitations, audit stores, receipts), or create objects.
--
-- No password is set here and none is ever stored in a migration. Until a password is set the role
-- cannot authenticate over the network. The deploy sets it from a secret:
--   ALTER ROLE powersync_replicator PASSWORD '<secret>';
-- Local development: the `powersync-replication-role` service in `compose.yaml` does this from
-- `POWERSYNC_REPLICATION_PASSWORD` (dev default in `.env.example`).
--
-- Adding a streamed table later needs a forward migration that does both
-- `ALTER PUBLICATION powersync ADD TABLE ...` and `GRANT SELECT ON ... TO powersync_replicator`;
-- `replication-role.integration.test.ts` fails if the two lists diverge.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync_replicator') THEN
    CREATE ROLE "powersync_replicator" LOGIN REPLICATION;
  END IF;
END
$$;--> statement-breakpoint
ALTER ROLE "powersync_replicator" WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE
  "public"."campaigns",
  "public"."campaign_settings",
  "public"."identity_campaign_memberships",
  "public"."sync_long_text_holds"
TO "powersync_replicator";
