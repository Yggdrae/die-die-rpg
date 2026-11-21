CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"requested_by" uuid NOT NULL,
	"source_manifest_checksum" "bytea",
	"state" text DEFAULT 'running' NOT NULL,
	"campaign_id" uuid,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_jobs_state_check" CHECK ("import_jobs"."state" IN ('running', 'completed', 'failed')),
	CONSTRAINT "import_jobs_lifecycle_check" CHECK (("import_jobs"."state" IN ('completed', 'failed')) = ("import_jobs"."completed_at" IS NOT NULL)
        AND ("import_jobs"."state" = 'completed') = ("import_jobs"."campaign_id" IS NOT NULL)
        AND ("import_jobs"."state" = 'failed') = ("import_jobs"."error_code" IS NOT NULL)),
	CONSTRAINT "import_jobs_manifest_checksum_check" CHECK ("import_jobs"."source_manifest_checksum" IS NULL OR octet_length("import_jobs"."source_manifest_checksum") = 32),
	CONSTRAINT "import_jobs_error_code_check" CHECK ("import_jobs"."error_code" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "import_jobs_report_check" CHECK (jsonb_typeof("import_jobs"."report") = 'object')
);
--> statement-breakpoint
CREATE TABLE "import_preserved_chunks" (
	"campaign_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"chunk_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_checksum" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_preserved_chunks_campaign_id_module_id_chunk_version_pk" PRIMARY KEY("campaign_id","module_id","chunk_version"),
	CONSTRAINT "import_preserved_chunks_module_id_check" CHECK ("import_preserved_chunks"."module_id" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "import_preserved_chunks_chunk_version_check" CHECK ("import_preserved_chunks"."chunk_version" ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$'),
	CONSTRAINT "import_preserved_chunks_checksum_check" CHECK (octet_length("import_preserved_chunks"."payload_checksum") = 32)
);
--> statement-breakpoint
CREATE INDEX "import_jobs_created_idx" ON "import_jobs" USING btree ("created_at");