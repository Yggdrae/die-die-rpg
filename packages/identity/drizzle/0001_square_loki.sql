CREATE TABLE "identity_campaign_memberships" (
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "identity_campaign_memberships_campaign_id_user_id_pk" PRIMARY KEY("campaign_id","user_id"),
	CONSTRAINT "identity_campaign_memberships_role_check" CHECK ("identity_campaign_memberships"."role" IN ('owner', 'gm', 'assistant_gm', 'player')),
	CONSTRAINT "identity_campaign_memberships_version_check" CHECK ("identity_campaign_memberships"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "identity_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"target_role" text NOT NULL,
	"token_digest" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "identity_invitations_role_check" CHECK ("identity_invitations"."target_role" IN ('gm', 'assistant_gm', 'player')),
	CONSTRAINT "identity_invitations_digest_length_check" CHECK (octet_length("identity_invitations"."token_digest") = 32),
	CONSTRAINT "identity_invitations_acceptance_check" CHECK (("identity_invitations"."used_at" IS NULL) = ("identity_invitations"."accepted_by_user_id" IS NULL)),
	CONSTRAINT "identity_invitations_expiry_check" CHECK ("identity_invitations"."expires_at" >= "identity_invitations"."created_at" + interval '5 minutes' AND "identity_invitations"."expires_at" <= "identity_invitations"."created_at" + interval '30 days')
);
--> statement-breakpoint
CREATE TABLE "campaign_module_pins" (
	"campaign_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"module_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_module_pins_campaign_id_module_id_pk" PRIMARY KEY("campaign_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_settings" (
	"campaign_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"value" jsonb NOT NULL,
	"member_visible" boolean NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "campaign_settings_campaign_id_namespace_pk" PRIMARY KEY("campaign_id","namespace"),
	CONSTRAINT "campaign_settings_namespace_check" CHECK (octet_length("campaign_settings"."namespace") BETWEEN 1 AND 100 AND "campaign_settings"."namespace" COLLATE "C" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
	CONSTRAINT "campaign_settings_version_check" CHECK ("campaign_settings"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "campaign_system_pins" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"system_id" text NOT NULL,
	"system_version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"game_mode" text NOT NULL,
	"created_by" uuid NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "campaigns_name_check" CHECK (char_length(btrim("campaigns"."name")) BETWEEN 1 AND 120 AND "campaigns"."name" = btrim("campaigns"."name")),
	CONSTRAINT "campaigns_description_check" CHECK (char_length("campaigns"."description") <= 10000),
	CONSTRAINT "campaigns_game_mode_check" CHECK (char_length("campaigns"."game_mode") >= 1),
	CONSTRAINT "campaigns_version_check" CHECK ("campaigns"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "identity_campaign_memberships" ADD CONSTRAINT "identity_campaign_memberships_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_invitations" ADD CONSTRAINT "identity_invitations_created_by_user_id_identity_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_invitations" ADD CONSTRAINT "identity_invitations_accepted_by_user_id_identity_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_invitations" ADD CONSTRAINT "identity_invitations_revoked_by_user_id_identity_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_module_pins" ADD CONSTRAINT "campaign_module_pins_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_settings" ADD CONSTRAINT "campaign_settings_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_system_pins" ADD CONSTRAINT "campaign_system_pins_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_identity_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_campaign_memberships" ADD CONSTRAINT "identity_campaign_memberships_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_invitations" ADD CONSTRAINT "identity_invitations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_campaign_memberships_active_owner_uidx" ON "identity_campaign_memberships" USING btree ("campaign_id") WHERE "identity_campaign_memberships"."role" = 'owner' AND "identity_campaign_memberships"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "identity_campaign_memberships_user_active_idx" ON "identity_campaign_memberships" USING btree ("user_id","campaign_id") WHERE "identity_campaign_memberships"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "identity_campaign_memberships_campaign_role_idx" ON "identity_campaign_memberships" USING btree ("campaign_id","role") WHERE "identity_campaign_memberships"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_invitations_digest_uidx" ON "identity_invitations" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "identity_invitations_campaign_created_idx" ON "identity_invitations" USING btree ("campaign_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "identity_invitations_expiry_idx" ON "identity_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "campaigns_active_updated_idx" ON "campaigns" USING btree ("updated_at" DESC NULLS LAST) WHERE "campaigns"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "campaigns_created_by_idx" ON "campaigns" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "campaigns_deleted_idx" ON "campaigns" USING btree ("deleted_at");--> statement-breakpoint
CREATE FUNCTION enforce_campaign_exactly_one_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  checked_campaign_id uuid;
  campaign_deleted_at timestamptz;
  active_owner_count integer;
BEGIN
  IF TG_TABLE_NAME = 'campaigns' THEN
    checked_campaign_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    checked_campaign_id := CASE
      WHEN TG_OP = 'DELETE' THEN OLD.campaign_id
      ELSE NEW.campaign_id
    END;
  END IF;

  SELECT deleted_at INTO campaign_deleted_at
  FROM campaigns
  WHERE id = checked_campaign_id;

  IF NOT FOUND OR campaign_deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer INTO active_owner_count
  FROM identity_campaign_memberships
  WHERE campaign_id = checked_campaign_id
    AND role = 'owner'
    AND removed_at IS NULL;

  IF active_owner_count <> 1 THEN
    RAISE EXCEPTION 'campaign % must have exactly one active owner', checked_campaign_id
      USING ERRCODE = '23514', CONSTRAINT = 'campaigns_exactly_one_active_owner';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER campaigns_exactly_one_owner
AFTER INSERT OR UPDATE OR DELETE ON campaigns
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_campaign_exactly_one_owner();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER memberships_exactly_one_owner
AFTER INSERT OR UPDATE OR DELETE ON identity_campaign_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_campaign_exactly_one_owner();
