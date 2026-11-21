-- Feature 18: sessions, GM notes, and log entries (`_db.md`).
CREATE TABLE "campaign_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"current_scene_id" uuid,
	"participant_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility_mode" text DEFAULT 'everyone' NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "campaign_sessions_number_check" CHECK ("campaign_sessions"."number" >= 1),
	CONSTRAINT "campaign_sessions_status_check" CHECK ("campaign_sessions"."status" IN ('active', 'paused', 'ended')),
	CONSTRAINT "campaign_sessions_ended_check" CHECK (("campaign_sessions"."status" = 'ended') = ("campaign_sessions"."ended_at" IS NOT NULL)
        AND ("campaign_sessions"."ended_at" IS NULL OR "campaign_sessions"."ended_at" >= "campaign_sessions"."started_at")),
	CONSTRAINT "campaign_sessions_participants_check" CHECK (jsonb_typeof("campaign_sessions"."participant_user_ids") = 'array'
        AND jsonb_array_length("campaign_sessions"."participant_user_ids") <= 64),
	CONSTRAINT "campaign_sessions_visibility_check" CHECK ("campaign_sessions"."visibility_mode" = 'everyone' AND "campaign_sessions"."visibility_targets" = '[]'::jsonb),
	CONSTRAINT "campaign_sessions_version_check" CHECK ("campaign_sessions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "session_gm_notes" (
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
	CONSTRAINT "session_gm_notes_body_check" CHECK (char_length("session_gm_notes"."body") <= 20000),
	CONSTRAINT "session_gm_notes_visibility_check" CHECK ("session_gm_notes"."visibility_mode" = 'gm_only' AND "session_gm_notes"."visibility_targets" = '[]'::jsonb),
	CONSTRAINT "session_gm_notes_version_check" CHECK ("session_gm_notes"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "session_log_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"subject_id" uuid,
	"visibility_mode" text NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "session_log_entries_kind_check" CHECK (("session_log_entries"."kind" = 'note' AND char_length("session_log_entries"."text") BETWEEN 1 AND 500
          AND "session_log_entries"."subject_id" IS NULL)
        OR ("session_log_entries"."kind" = 'scene' AND "session_log_entries"."text" = '' AND "session_log_entries"."subject_id" IS NOT NULL
          AND "session_log_entries"."visibility_mode" = 'everyone')
        OR ("session_log_entries"."kind" = 'status' AND "session_log_entries"."text" IN ('started', 'paused', 'resumed', 'ended')
          AND "session_log_entries"."subject_id" IS NULL AND "session_log_entries"."visibility_mode" = 'everyone')
        OR ("session_log_entries"."kind" = 'reveal' AND "session_log_entries"."text" = '' AND "session_log_entries"."subject_id" IS NOT NULL
          AND "session_log_entries"."visibility_mode" = 'gm_only')),
	CONSTRAINT "session_log_entries_visibility_check" CHECK ("session_log_entries"."visibility_mode" IN ('gm_only', 'everyone')
        AND "session_log_entries"."visibility_targets" = '[]'::jsonb),
	CONSTRAINT "session_log_entries_version_check" CHECK ("session_log_entries"."version" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sessions_number_idx" ON "campaign_sessions" USING btree ("campaign_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sessions_open_idx" ON "campaign_sessions" USING btree ("campaign_id") WHERE "campaign_sessions"."status" <> 'ended' AND "campaign_sessions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "session_gm_notes_campaign_idx" ON "session_gm_notes" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "session_log_entries_session_idx" ON "session_log_entries" USING btree ("campaign_id","session_id");--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."campaign_sessions";--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."session_gm_notes";--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."session_log_entries";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."campaign_sessions" TO "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."session_gm_notes" TO "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."session_log_entries" TO "powersync_replicator";