CREATE TABLE "audit_account_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_account_events_account_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subject_user_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"actor_reference" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"client_recorded_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"origin_mutation_id" uuid NOT NULL,
	"renderer_version" integer NOT NULL,
	CONSTRAINT "audit_account_events_sequence_unique" UNIQUE("account_sequence"),
	CONSTRAINT "audit_account_events_origin_unique" UNIQUE("origin_mutation_id"),
	CONSTRAINT "audit_account_events_actor_check" CHECK ("audit_account_events"."actor_kind" IN ('operator', 'user')),
	CONSTRAINT "audit_account_events_actor_shape_check" CHECK (("audit_account_events"."actor_kind" = 'user') = ("audit_account_events"."actor_user_id" IS NOT NULL)),
	CONSTRAINT "audit_account_events_renderer_check" CHECK ("audit_account_events"."renderer_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_campaign_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"session_id" uuid,
	"campaign_sequence" bigint NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_visibility" jsonb NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"client_recorded_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"origin_mutation_id" uuid NOT NULL,
	"renderer_version" integer NOT NULL,
	CONSTRAINT "audit_campaign_events_sequence_unique" UNIQUE("campaign_id","campaign_sequence"),
	CONSTRAINT "audit_campaign_events_origin_unique" UNIQUE("origin_mutation_id"),
	CONSTRAINT "audit_campaign_events_sequence_check" CHECK ("audit_campaign_events"."campaign_sequence" >= 1),
	CONSTRAINT "audit_campaign_events_renderer_check" CHECK ("audit_campaign_events"."renderer_version" >= 0),
	CONSTRAINT "audit_campaign_events_role_check" CHECK ("audit_campaign_events"."actor_role" IN ('owner', 'gm', 'assistant_gm', 'player', 'observer'))
);
--> statement-breakpoint
CREATE TABLE "audit_campaign_sequences" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"last_sequence" bigint NOT NULL,
	CONSTRAINT "audit_campaign_sequences_check" CHECK ("audit_campaign_sequences"."last_sequence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "audit_private_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"session_id" uuid,
	"campaign_sequence" bigint NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_visibility" jsonb NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"client_recorded_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"origin_mutation_id" uuid NOT NULL,
	"renderer_version" integer NOT NULL,
	CONSTRAINT "audit_private_events_sequence_unique" UNIQUE("campaign_id","campaign_sequence"),
	CONSTRAINT "audit_private_events_origin_unique" UNIQUE("origin_mutation_id"),
	CONSTRAINT "audit_private_events_sequence_check" CHECK ("audit_private_events"."campaign_sequence" >= 1),
	CONSTRAINT "audit_private_events_renderer_check" CHECK ("audit_private_events"."renderer_version" >= 0),
	CONSTRAINT "audit_private_events_role_check" CHECK ("audit_private_events"."actor_role" IN ('owner', 'gm', 'assistant_gm', 'player', 'observer'))
);
--> statement-breakpoint
CREATE TABLE "audit_private_sequences" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"last_sequence" bigint NOT NULL,
	CONSTRAINT "audit_private_sequences_check" CHECK ("audit_private_sequences"."last_sequence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "audit_repair_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"store" text NOT NULL,
	"origin_mutation_id" uuid NOT NULL,
	"campaign_id" uuid,
	"envelope" jsonb NOT NULL,
	"state" text NOT NULL,
	"failure_code" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "audit_repair_outbox_store_check" CHECK ("audit_repair_outbox"."store" IN ('campaign', 'private', 'account')),
	CONSTRAINT "audit_repair_outbox_state_check" CHECK ("audit_repair_outbox"."state" IN ('pending', 'dead', 'repaired')),
	CONSTRAINT "audit_repair_outbox_attempt_check" CHECK ("audit_repair_outbox"."attempt_count" >= 1)
);
--> statement-breakpoint
CREATE INDEX "audit_account_events_subject_idx" ON "audit_account_events" USING btree ("subject_user_id","account_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_campaign_events_session_idx" ON "audit_campaign_events" USING btree ("session_id","campaign_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_campaign_events_actor_idx" ON "audit_campaign_events" USING btree ("campaign_id","actor_user_id","campaign_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_campaign_events_target_idx" ON "audit_campaign_events" USING btree ("campaign_id","target_type","target_id","campaign_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_private_events_session_idx" ON "audit_private_events" USING btree ("session_id","campaign_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_private_events_actor_idx" ON "audit_private_events" USING btree ("campaign_id","actor_user_id","campaign_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_private_events_target_idx" ON "audit_private_events" USING btree ("campaign_id","target_type","target_id","campaign_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_repair_outbox_due_idx" ON "audit_repair_outbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
-- Feature 06 task 01 (hand-written tail): append-only privileges and guard triggers.
-- Application code is granted INSERT/SELECT only; retention runs as `rpg_audit_maintenance`
-- with `rpg.audit_retention = on` and may delete only rows older than 365 days. Triggers are
-- defense in depth, so a connection that owns the tables still cannot rewrite history.
-- None of these tables is in the `powersync` publication.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rpg_audit_writer') THEN
    CREATE ROLE rpg_audit_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rpg_audit_maintenance') THEN
    CREATE ROLE rpg_audit_maintenance NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
REVOKE ALL ON "audit_campaign_events", "audit_private_events", "audit_account_events",
  "audit_campaign_sequences", "audit_private_sequences", "audit_repair_outbox" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_campaign_events", "audit_private_events", "audit_account_events"
  TO rpg_audit_writer;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "audit_account_events_account_sequence_seq" TO rpg_audit_writer;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "audit_campaign_sequences", "audit_private_sequences",
  "audit_repair_outbox" TO rpg_audit_writer;--> statement-breakpoint
GRANT SELECT, DELETE ON "audit_campaign_events", "audit_private_events", "audit_account_events"
  TO rpg_audit_maintenance;--> statement-breakpoint
CREATE FUNCTION "audit_guard_history"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('rpg.audit_retention', true) = 'on'
     AND pg_has_role(current_user, 'rpg_audit_maintenance', 'MEMBER')
     AND OLD.accepted_at < now() - interval '365 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_history_immutable' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE FUNCTION "audit_guard_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_history_immutable' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE FUNCTION "audit_guard_sequence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.campaign_id = OLD.campaign_id
     AND NEW.last_sequence > OLD.last_sequence THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_sequence_monotonic' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_campaign_events_guard" BEFORE UPDATE OR DELETE ON "audit_campaign_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_guard_history"();--> statement-breakpoint
CREATE TRIGGER "audit_private_events_guard" BEFORE UPDATE OR DELETE ON "audit_private_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_guard_history"();--> statement-breakpoint
CREATE TRIGGER "audit_account_events_guard" BEFORE UPDATE OR DELETE ON "audit_account_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_guard_history"();--> statement-breakpoint
CREATE TRIGGER "audit_campaign_events_truncate_guard" BEFORE TRUNCATE ON "audit_campaign_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_guard_truncate"();--> statement-breakpoint
CREATE TRIGGER "audit_private_events_truncate_guard" BEFORE TRUNCATE ON "audit_private_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_guard_truncate"();--> statement-breakpoint
CREATE TRIGGER "audit_account_events_truncate_guard" BEFORE TRUNCATE ON "audit_account_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_guard_truncate"();--> statement-breakpoint
CREATE TRIGGER "audit_campaign_sequences_guard" BEFORE UPDATE OR DELETE ON "audit_campaign_sequences"
  FOR EACH ROW EXECUTE FUNCTION "audit_guard_sequence"();--> statement-breakpoint
CREATE TRIGGER "audit_private_sequences_guard" BEFORE UPDATE OR DELETE ON "audit_private_sequences"
  FOR EACH ROW EXECUTE FUNCTION "audit_guard_sequence"();--> statement-breakpoint
CREATE TRIGGER "audit_campaign_sequences_truncate_guard" BEFORE TRUNCATE ON "audit_campaign_sequences"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_guard_truncate"();--> statement-breakpoint
CREATE TRIGGER "audit_private_sequences_truncate_guard" BEFORE TRUNCATE ON "audit_private_sequences"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_guard_truncate"();
