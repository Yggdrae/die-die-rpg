-- Feature 19: encounters, GM notes, participants, and instance states (`_db.md`).
CREATE TABLE "encounter_gm_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"body" text NOT NULL,
	"visibility_mode" text DEFAULT 'gm_only' NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "encounter_gm_notes_body_check" CHECK (char_length("encounter_gm_notes"."body") <= 5000),
	CONSTRAINT "encounter_gm_notes_visibility_check" CHECK ("encounter_gm_notes"."visibility_mode" = 'gm_only' AND "encounter_gm_notes"."visibility_targets" = '[]'::jsonb),
	CONSTRAINT "encounter_gm_notes_version_check" CHECK ("encounter_gm_notes"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "encounter_participant_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"visibility_mode" text DEFAULT 'gm_only' NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "encounter_participant_states_state_check" CHECK (jsonb_typeof("encounter_participant_states"."state") = 'object' AND octet_length("encounter_participant_states"."state"::text) <= 65536),
	CONSTRAINT "encounter_participant_states_visibility_check" CHECK ("encounter_participant_states"."visibility_mode" = 'gm_only' AND "encounter_participant_states"."visibility_targets" = '[]'::jsonb),
	CONSTRAINT "encounter_participant_states_version_check" CHECK ("encounter_participant_states"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "encounter_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"label" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility_mode" text NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "encounter_participants_label_check" CHECK (char_length("encounter_participants"."label") BETWEEN 1 AND 120),
	CONSTRAINT "encounter_participants_source_check" CHECK ("encounter_participants"."source_kind" IN ('character', 'entity')
        AND ("encounter_participants"."source_kind" = 'entity' OR "encounter_participants"."conditions" = '{}'::jsonb)),
	CONSTRAINT "encounter_participants_position_check" CHECK ("encounter_participants"."position" >= 0),
	CONSTRAINT "encounter_participants_conditions_check" CHECK (jsonb_typeof("encounter_participants"."conditions") = 'object'),
	CONSTRAINT "encounter_participants_visibility_check" CHECK ("encounter_participants"."visibility_mode" IN ('everyone', 'gm_only')
        AND "encounter_participants"."visibility_targets" = '[]'::jsonb),
	CONSTRAINT "encounter_participants_version_check" CHECK ("encounter_participants"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "encounters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"session_id" uuid,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"environment" text DEFAULT '' NOT NULL,
	"location_id" uuid,
	"visibility_mode" text DEFAULT 'everyone' NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "encounters_name_check" CHECK (char_length("encounters"."name") BETWEEN 1 AND 120),
	CONSTRAINT "encounters_status_check" CHECK ("encounters"."status" IN ('active', 'ended')),
	CONSTRAINT "encounters_ended_check" CHECK (("encounters"."status" = 'ended') = ("encounters"."ended_at" IS NOT NULL)
        AND ("encounters"."ended_at" IS NULL OR "encounters"."ended_at" >= "encounters"."started_at")),
	CONSTRAINT "encounters_environment_check" CHECK (char_length("encounters"."environment") <= 2000),
	CONSTRAINT "encounters_visibility_check" CHECK ("encounters"."visibility_mode" = 'everyone' AND "encounters"."visibility_targets" = '[]'::jsonb),
	CONSTRAINT "encounters_version_check" CHECK ("encounters"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "encounter_gm_notes_campaign_idx" ON "encounter_gm_notes" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "encounter_participant_states_campaign_idx" ON "encounter_participant_states" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "encounter_participants_encounter_idx" ON "encounter_participants" USING btree ("campaign_id","encounter_id");--> statement-breakpoint
CREATE INDEX "encounters_campaign_idx" ON "encounters" USING btree ("campaign_id");--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."encounters";--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."encounter_gm_notes";--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."encounter_participants";--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."encounter_participant_states";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."encounters" TO "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."encounter_gm_notes" TO "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."encounter_participants" TO "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."encounter_participant_states" TO "powersync_replicator";