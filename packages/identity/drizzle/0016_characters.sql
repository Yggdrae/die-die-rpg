-- Feature 15: characters and their GM-only half (`_db.md`).
CREATE TABLE "character_secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"visibility_mode" text DEFAULT 'gm_only' NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "character_secrets_state_check" CHECK (jsonb_typeof("character_secrets"."state") = 'object'),
	CONSTRAINT "character_secrets_version_check" CHECK ("character_secrets"."version" >= 1),
	CONSTRAINT "character_secrets_visibility_check" CHECK ("character_secrets"."visibility_mode" = 'gm_only' AND "character_secrets"."visibility_targets" = '[]'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"system_id" text NOT NULL,
	"system_version" text NOT NULL,
	"state" jsonb NOT NULL,
	"visibility_mode" text NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "characters_owner_check" CHECK ("characters"."owner_user_id" = "characters"."created_by"),
	CONSTRAINT "characters_state_check" CHECK (jsonb_typeof("characters"."state") = 'object'),
	CONSTRAINT "characters_version_check" CHECK ("characters"."version" >= 1),
	CONSTRAINT "characters_visibility_check" CHECK ("characters"."visibility_mode" = 'players'
        AND "characters"."visibility_targets" = jsonb_build_array("characters"."owner_user_id"::text))
);
--> statement-breakpoint
CREATE INDEX "character_secrets_campaign_idx" ON "character_secrets" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "characters_campaign_idx" ON "characters" USING btree ("campaign_id") WHERE "characters"."deleted_at" IS NULL;--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."characters";--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."character_secrets";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."characters" TO "powersync_replicator";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."character_secrets" TO "powersync_replicator";
