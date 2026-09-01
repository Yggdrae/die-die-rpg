CREATE TABLE "sync_long_text_holds" (
	"campaign_id" uuid NOT NULL,
	"resource_class" text NOT NULL,
	"record_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"holder_user_id" uuid NOT NULL,
	"holder_session_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"version" bigint NOT NULL,
	CONSTRAINT "sync_long_text_holds_campaign_id_resource_class_record_id_field_path_pk" PRIMARY KEY("campaign_id","resource_class","record_id","field_path"),
	CONSTRAINT "sync_long_text_holds_version_check" CHECK ("sync_long_text_holds"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sync_mutation_receipts" (
	"mutation_id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"outcome" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_replica_watermarks" (
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"replica_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"acknowledged_sequence" bigint DEFAULT 0 NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sync_replica_watermarks_campaign_id_replica_id_table_name_pk" PRIMARY KEY("campaign_id","replica_id","table_name"),
	CONSTRAINT "sync_replica_watermarks_sequence_check" CHECK ("sync_replica_watermarks"."acknowledged_sequence" >= 0)
);
