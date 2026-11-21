CREATE TABLE "rules_section_marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"bookmarked" boolean DEFAULT false NOT NULL,
	"bookmark_changed_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"visibility_mode" text DEFAULT 'players' NOT NULL,
	"visibility_targets" jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "rules_section_marks_section_check" CHECK (char_length("rules_section_marks"."section_id") BETWEEN 1 AND 64),
	CONSTRAINT "rules_section_marks_bookmark_check" CHECK ((NOT "rules_section_marks"."bookmarked" OR "rules_section_marks"."bookmark_changed_at" IS NOT NULL)
        AND ("rules_section_marks"."bookmark_changed_at" IS NOT NULL OR "rules_section_marks"."viewed_at" IS NOT NULL)),
	CONSTRAINT "rules_section_marks_visibility_check" CHECK ("rules_section_marks"."visibility_mode" = 'players'
        AND "rules_section_marks"."visibility_targets" = jsonb_build_array("rules_section_marks"."user_id"::text)),
	CONSTRAINT "rules_section_marks_version_check" CHECK ("rules_section_marks"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rules_section_marks_owner_section_idx" ON "rules_section_marks" USING btree ("campaign_id","user_id","section_id");--> statement-breakpoint
CREATE INDEX "rules_section_marks_campaign_idx" ON "rules_section_marks" USING btree ("campaign_id");--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."rules_section_marks";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."rules_section_marks" TO "powersync_replicator";