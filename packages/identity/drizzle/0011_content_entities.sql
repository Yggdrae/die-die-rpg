-- Feature 16 task 02: campaign entities (every configured type) and player personal notes.
-- Shared feature 04 Visibility targets validation: a JSON array of sorted (COLLATE "C"), unique,
-- lowercase UUID strings. Created before the tables whose CHECKs call it.
CREATE FUNCTION "content_visibility_targets_valid"(targets jsonb) RETURNS boolean
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
CREATE TABLE "content_entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility_mode" text NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "content_entities_campaign_id_unique" UNIQUE("campaign_id","id"),
	CONSTRAINT "content_entities_type_check" CHECK (type ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "content_entities_name_check" CHECK (char_length("content_entities"."name") BETWEEN 1 AND 200 AND "content_entities"."name" = btrim("content_entities"."name")
        AND "content_entities"."name" ~ '[^[:space:]]'),
	CONSTRAINT "content_entities_summary_check" CHECK (char_length("content_entities"."summary") <= 280),
	CONSTRAINT "content_entities_description_check" CHECK (char_length("content_entities"."description") <= 50000),
	CONSTRAINT "content_entities_tags_check" CHECK (CASE WHEN jsonb_typeof("content_entities"."tags") = 'array'
        THEN jsonb_array_length("content_entities"."tags") <= 32 ELSE false END),
	CONSTRAINT "content_entities_fields_check" CHECK (jsonb_typeof("content_entities"."fields") = 'object'),
	CONSTRAINT "content_entities_metadata_check" CHECK (jsonb_typeof("content_entities"."metadata") = 'object'),
	CONSTRAINT "content_entities_visibility_mode_check" CHECK ("content_entities"."visibility_mode" IN ('gm_only', 'everyone', 'party', 'players')),
	CONSTRAINT "content_entities_visibility_targets_check" CHECK (CASE WHEN NOT content_visibility_targets_valid("content_entities"."visibility_targets") THEN false
        WHEN "content_entities"."visibility_mode" IN ('gm_only', 'everyone')
          THEN "content_entities"."visibility_targets" = '[]'::jsonb
        ELSE jsonb_array_length("content_entities"."visibility_targets") > 0 END),
	CONSTRAINT "content_entities_version_check" CHECK ("content_entities"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "content_personal_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility_mode" text NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "content_personal_notes_name_check" CHECK (char_length("content_personal_notes"."name") BETWEEN 1 AND 200 AND "content_personal_notes"."name" = btrim("content_personal_notes"."name")
        AND "content_personal_notes"."name" ~ '[^[:space:]]'),
	CONSTRAINT "content_personal_notes_body_check" CHECK (char_length("content_personal_notes"."body") <= 50000),
	CONSTRAINT "content_personal_notes_tags_check" CHECK (CASE WHEN jsonb_typeof("content_personal_notes"."tags") = 'array'
        THEN jsonb_array_length("content_personal_notes"."tags") <= 32 ELSE false END),
	CONSTRAINT "content_personal_notes_metadata_check" CHECK (jsonb_typeof("content_personal_notes"."metadata") = 'object'),
	CONSTRAINT "content_personal_notes_author_check" CHECK ("content_personal_notes"."author_user_id" = "content_personal_notes"."created_by"),
	CONSTRAINT "content_personal_notes_visibility_check" CHECK ("content_personal_notes"."visibility_mode" = 'players'
        AND "content_personal_notes"."visibility_targets" = jsonb_build_array("content_personal_notes"."author_user_id"::text)),
	CONSTRAINT "content_personal_notes_version_check" CHECK ("content_personal_notes"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "content_entities_campaign_type_idx" ON "content_entities" USING btree ("campaign_id","type") WHERE "content_entities"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "content_entities_campaign_updated_idx" ON "content_entities" USING btree ("campaign_id","updated_at" DESC NULLS LAST) WHERE "content_entities"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "content_personal_notes_author_idx" ON "content_personal_notes" USING btree ("campaign_id","author_user_id");--> statement-breakpoint
-- Both tables stream through `authorized_content` (`infra/powersync/sync-config.yaml`, compiled
-- from the `campaign_entity` and `personal_note` Resource Policies). The provider reads them through
-- the publication and the least-privilege replication role (0003, 0006 contracts).
ALTER PUBLICATION "powersync" ADD TABLE
  "public"."content_entities",
  "public"."content_personal_notes";--> statement-breakpoint
GRANT SELECT ON TABLE
  "public"."content_entities",
  "public"."content_personal_notes"
TO "powersync_replicator";
