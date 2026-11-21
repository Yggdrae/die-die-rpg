CREATE TABLE "sync_access_revocations" (
	"delivery_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"membership_version" bigint NOT NULL,
	"reason" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_access_revocations_event_unique" UNIQUE("campaign_id","user_id","membership_version","reason"),
	CONSTRAINT "sync_access_revocations_state_check" CHECK ("sync_access_revocations"."state" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "sync_access_revocations_reason_check" CHECK ("sync_access_revocations"."reason" in ('removed', 'role_changed', 'ownership_transferred', 'signed_out')),
	CONSTRAINT "sync_access_revocations_attempts_check" CHECK ("sync_access_revocations"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sync_replica_subscriptions" (
	"campaign_id" uuid NOT NULL,
	"replica_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sync_replica_subscriptions_campaign_id_replica_id_pk" PRIMARY KEY("campaign_id","replica_id")
);
--> statement-breakpoint
ALTER TABLE "sync_replica_watermarks" ADD COLUMN "pending_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_access_revocations_due_idx" ON "sync_access_revocations" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "sync_replica_subscriptions_user_idx" ON "sync_replica_subscriptions" USING btree ("campaign_id","user_id");