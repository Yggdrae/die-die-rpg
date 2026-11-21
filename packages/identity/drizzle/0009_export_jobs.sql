CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"manifest_checksum" "bytea",
	"contributor_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "export_jobs_state_check" CHECK ("export_jobs"."state" IN ('requested', 'running', 'completed', 'failed')),
	CONSTRAINT "export_jobs_lifecycle_check" CHECK (("export_jobs"."state" IN ('completed', 'failed')) = ("export_jobs"."completed_at" IS NOT NULL)
        AND ("export_jobs"."state" = 'completed') = ("export_jobs"."manifest_checksum" IS NOT NULL)
        AND ("export_jobs"."state" = 'failed') = ("export_jobs"."error_code" IS NOT NULL)),
	CONSTRAINT "export_jobs_manifest_checksum_check" CHECK ("export_jobs"."manifest_checksum" IS NULL OR octet_length("export_jobs"."manifest_checksum") = 32),
	CONSTRAINT "export_jobs_error_code_check" CHECK ("export_jobs"."error_code" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "export_jobs_summary_check" CHECK (jsonb_typeof("export_jobs"."contributor_summary") = 'array')
);
--> statement-breakpoint
CREATE INDEX "export_jobs_created_idx" ON "export_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "export_jobs_active_campaign_idx" ON "export_jobs" USING btree ("campaign_id") WHERE "export_jobs"."state" IN ('requested', 'running');