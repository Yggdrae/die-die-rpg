-- Feature 11: effect applications (`_db.md`). Feature 04 Visibility targets validation, owned here.
CREATE FUNCTION "effect_visibility_targets_valid"(targets jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(targets) <> 'array' THEN false ELSE NOT EXISTS (
    SELECT 1 FROM (
      SELECT element, lag(element) OVER (ORDER BY position) AS previous
      FROM jsonb_array_elements(targets) WITH ORDINALITY AS item(element, position)
    ) AS ordered
    WHERE jsonb_typeof(element) <> 'string'
      OR (element #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (previous IS NOT NULL
        AND (element #>> '{}') COLLATE "C" <= (previous #>> '{}') COLLATE "C")
  ) END
$$;--> statement-breakpoint
CREATE TABLE "effect_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"target_class" text NOT NULL,
	"target_id" uuid NOT NULL,
	"action" text,
	"outcome" text,
	"roll_id" uuid,
	"session_id" uuid,
	"operations" jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"visibility_mode" text NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "effect_applications_version_check" CHECK ("effect_applications"."version" = 1),
	CONSTRAINT "effect_applications_target_class_check" CHECK (target_class ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "effect_applications_operations_check" CHECK (CASE WHEN jsonb_typeof("effect_applications"."operations") = 'array'
        THEN jsonb_array_length("effect_applications"."operations") BETWEEN 1 AND 64 ELSE false END),
	CONSTRAINT "effect_applications_changes_check" CHECK (jsonb_typeof("effect_applications"."changes") = 'array'),
	CONSTRAINT "effect_applications_references_check" CHECK (("effect_applications"."action" IS NULL OR char_length("effect_applications"."action") BETWEEN 1 AND 128)
        AND ("effect_applications"."outcome" IS NULL OR char_length("effect_applications"."outcome") BETWEEN 1 AND 128)),
	CONSTRAINT "effect_applications_visibility_mode_check" CHECK ("effect_applications"."visibility_mode" IN ('gm_only', 'everyone', 'party', 'players')),
	CONSTRAINT "effect_applications_visibility_targets_check" CHECK (CASE WHEN NOT effect_visibility_targets_valid("effect_applications"."visibility_targets") THEN false
        WHEN "effect_applications"."visibility_mode" IN ('gm_only', 'everyone')
          THEN "effect_applications"."visibility_targets" = '[]'::jsonb
        ELSE jsonb_array_length("effect_applications"."visibility_targets") > 0 END)
);
--> statement-breakpoint
CREATE INDEX "effect_applications_target_idx" ON "effect_applications" USING btree ("campaign_id","target_class","target_id","applied_at");--> statement-breakpoint
CREATE INDEX "effect_applications_session_idx" ON "effect_applications" USING btree ("campaign_id","session_id","applied_at") WHERE "effect_applications"."session_id" IS NOT NULL;--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."effect_applications";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."effect_applications" TO "powersync_replicator";
