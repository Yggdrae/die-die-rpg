CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"owner_resource_class" text NOT NULL,
	"owner_resource_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"verified_size" bigint,
	"declared_checksum" "bytea" NOT NULL,
	"verified_checksum" "bytea",
	"object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"visibility_mode" text NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"finalized_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	CONSTRAINT "attachments_owner_class_check" CHECK ("attachments"."owner_resource_class" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "attachments_filename_check" CHECK (char_length("attachments"."filename") BETWEEN 1 AND 255
        AND "attachments"."filename" !~ '[\x01-\x1f\x7f-\x9f/\\]'
        AND btrim("attachments"."filename") <> ''
        AND "attachments"."filename" NOT IN ('.', '..')),
	CONSTRAINT "attachments_mime_check" CHECK ("attachments"."mime_type" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "attachments_declared_size_check" CHECK ("attachments"."declared_size" BETWEEN 1 AND 26214400),
	CONSTRAINT "attachments_verified_size_check" CHECK ("attachments"."verified_size" IS NULL OR "attachments"."verified_size" = "attachments"."declared_size"),
	CONSTRAINT "attachments_declared_checksum_check" CHECK (octet_length("attachments"."declared_checksum") = 32),
	CONSTRAINT "attachments_verified_checksum_check" CHECK ("attachments"."verified_checksum" IS NULL OR "attachments"."verified_checksum" = "attachments"."declared_checksum"),
	CONSTRAINT "attachments_object_key_check" CHECK (object_key ~ '^campaigns/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "attachments_status_check" CHECK ("attachments"."status" IN ('pending', 'ready', 'failed')),
	CONSTRAINT "attachments_lifecycle_check" CHECK (("attachments"."status" = 'ready') = ("attachments"."verified_size" IS NOT NULL AND "attachments"."verified_checksum" IS NOT NULL AND "attachments"."finalized_at" IS NOT NULL)
        AND ("attachments"."status" = 'failed') = ("attachments"."failed_at" IS NOT NULL)),
	CONSTRAINT "attachments_deletion_check" CHECK (("attachments"."deleted_at" IS NULL OR "attachments"."status" = 'ready')
        AND ("attachments"."deleted_at" IS NULL) = ("attachments"."purge_after" IS NULL)),
	CONSTRAINT "attachments_visibility_mode_check" CHECK ("attachments"."visibility_mode" IN ('gm_only', 'everyone', 'party', 'players')),
	CONSTRAINT "attachments_visibility_targets_check" CHECK (jsonb_typeof("attachments"."visibility_targets") = 'array' AND (
        ("attachments"."visibility_mode" IN ('gm_only', 'everyone') AND "attachments"."visibility_targets" = '[]'::jsonb)
        OR ("attachments"."visibility_mode" IN ('party', 'players') AND jsonb_array_length("attachments"."visibility_targets") > 0)
      )),
	CONSTRAINT "attachments_version_check" CHECK ("attachments"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_object_key_unique" ON "attachments" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "attachments_owner_idx" ON "attachments" USING btree ("campaign_id","owner_resource_class","owner_resource_id");--> statement-breakpoint
CREATE INDEX "attachments_pending_created_idx" ON "attachments" USING btree ("created_at") WHERE "attachments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "attachments_ready_campaign_idx" ON "attachments" USING btree ("campaign_id") WHERE "attachments"."status" = 'ready' AND "attachments"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "attachments_purge_idx" ON "attachments" USING btree ("purge_after") WHERE "attachments"."deleted_at" IS NOT NULL;