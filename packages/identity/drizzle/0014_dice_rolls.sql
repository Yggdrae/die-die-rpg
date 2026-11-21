-- Feature 09: recorded rolls (`_db.md`). Feature 04 Visibility targets validation, owned here: a JSON
-- array of sorted (COLLATE "C"), unique, lowercase UUID strings. Created before the table's CHECKs.
CREATE FUNCTION "dice_visibility_targets_valid"(targets jsonb) RETURNS boolean
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
CREATE TABLE "dice_rolls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_ref" text,
	"target_ref" text,
	"action" text,
	"session_id" uuid,
	"expression" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"natural_result" integer NOT NULL,
	"modified_result" integer NOT NULL,
	"roll_visibility" text NOT NULL,
	"visibility_mode" text NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"rolled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dice_rolls_version_check" CHECK ("dice_rolls"."version" = 1),
	CONSTRAINT "dice_rolls_expression_check" CHECK (char_length("dice_rolls"."expression") BETWEEN 1 AND 200),
	CONSTRAINT "dice_rolls_inputs_check" CHECK (jsonb_typeof("dice_rolls"."inputs") = 'object'),
	CONSTRAINT "dice_rolls_result_check" CHECK (jsonb_typeof("dice_rolls"."result") = 'object'),
	CONSTRAINT "dice_rolls_references_check" CHECK (("dice_rolls"."actor_ref" IS NULL OR char_length("dice_rolls"."actor_ref") BETWEEN 1 AND 128)
        AND ("dice_rolls"."target_ref" IS NULL OR char_length("dice_rolls"."target_ref") BETWEEN 1 AND 128)
        AND ("dice_rolls"."action" IS NULL OR char_length("dice_rolls"."action") BETWEEN 1 AND 128)),
	CONSTRAINT "dice_rolls_visibility_mode_check" CHECK ("dice_rolls"."visibility_mode" IN ('gm_only', 'everyone', 'party', 'players')),
	CONSTRAINT "dice_rolls_visibility_targets_check" CHECK (dice_visibility_targets_valid("dice_rolls"."visibility_targets")),
	CONSTRAINT "dice_rolls_visibility_check" CHECK (CASE "dice_rolls"."roll_visibility"
        WHEN 'public' THEN "dice_rolls"."visibility_mode" = 'everyone'
          AND "dice_rolls"."visibility_targets" = '[]'::jsonb
        WHEN 'gm_only' THEN "dice_rolls"."visibility_mode" = 'gm_only'
          AND "dice_rolls"."visibility_targets" = '[]'::jsonb
        WHEN 'blind' THEN "dice_rolls"."visibility_mode" = 'gm_only'
          AND "dice_rolls"."visibility_targets" = '[]'::jsonb
        WHEN 'player_only' THEN "dice_rolls"."visibility_mode" = 'players'
          AND "dice_rolls"."visibility_targets" = jsonb_build_array("dice_rolls"."actor_user_id"::text)
        WHEN 'whisper' THEN "dice_rolls"."visibility_mode" = 'players'
          AND "dice_rolls"."visibility_targets" @> jsonb_build_array("dice_rolls"."actor_user_id"::text)
          AND jsonb_array_length("dice_rolls"."visibility_targets") >= 2
        ELSE false END)
);
--> statement-breakpoint
CREATE INDEX "dice_rolls_campaign_rolled_idx" ON "dice_rolls" USING btree ("campaign_id","rolled_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dice_rolls_session_idx" ON "dice_rolls" USING btree ("campaign_id","session_id","rolled_at") WHERE "dice_rolls"."session_id" IS NOT NULL;--> statement-breakpoint
ALTER PUBLICATION "powersync" ADD TABLE "public"."dice_rolls";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."dice_rolls" TO "powersync_replicator";
