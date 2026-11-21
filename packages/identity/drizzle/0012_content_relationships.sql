CREATE TABLE "content_entity_relationships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"visibility_mode" text NOT NULL,
	"visibility_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "content_entity_relationships_self_link_check" CHECK ("content_entity_relationships"."source_entity_id" <> "content_entity_relationships"."target_entity_id"),
	CONSTRAINT "content_entity_relationships_kind_check" CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "content_entity_relationships_visibility_mode_check" CHECK ("content_entity_relationships"."visibility_mode" IN ('gm_only', 'everyone', 'party', 'players')),
	CONSTRAINT "content_entity_relationships_visibility_targets_check" CHECK (CASE WHEN NOT content_visibility_targets_valid("content_entity_relationships"."visibility_targets") THEN false
        WHEN "content_entity_relationships"."visibility_mode" IN ('gm_only', 'everyone')
          THEN "content_entity_relationships"."visibility_targets" = '[]'::jsonb
        ELSE jsonb_array_length("content_entity_relationships"."visibility_targets") > 0 END),
	CONSTRAINT "content_entity_relationships_version_check" CHECK ("content_entity_relationships"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "content_entity_relationships" ADD CONSTRAINT "content_entity_relationships_source_fk" FOREIGN KEY ("campaign_id","source_entity_id") REFERENCES "public"."content_entities"("campaign_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_entity_relationships" ADD CONSTRAINT "content_entity_relationships_target_fk" FOREIGN KEY ("campaign_id","target_entity_id") REFERENCES "public"."content_entities"("campaign_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_entity_relationships_live_unique" ON "content_entity_relationships" USING btree ("campaign_id","source_entity_id","target_entity_id","kind") WHERE "content_entity_relationships"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "content_entity_relationships_source_idx" ON "content_entity_relationships" USING btree ("campaign_id","source_entity_id");--> statement-breakpoint
CREATE INDEX "content_entity_relationships_target_idx" ON "content_entity_relationships" USING btree ("campaign_id","target_entity_id");--> statement-breakpoint
-- Streams through `authorized_content` (compiled from the `entity_relationship` Resource Policy).
-- The provider reads it through the publication and the least-privilege replication role.
ALTER PUBLICATION "powersync" ADD TABLE "public"."content_entity_relationships";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."content_entity_relationships" TO "powersync_replicator";
