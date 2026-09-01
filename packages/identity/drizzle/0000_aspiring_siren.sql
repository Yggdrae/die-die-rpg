CREATE TABLE "identity_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_bindings_provider_kind_check" CHECK ("identity_bindings"."provider_kind" = 'local')
);
--> statement-breakpoint
CREATE TABLE "identity_password_credentials" (
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_password_credentials_user_id_pk" PRIMARY KEY("user_id")
);
--> statement-breakpoint
CREATE TABLE "identity_recovery_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_digest" bytea NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"operator_reference" text,
	CONSTRAINT "identity_recovery_tokens_digest_length_check" CHECK (octet_length("identity_recovery_tokens"."token_digest") = 32),
	CONSTRAINT "identity_recovery_tokens_expiry_check" CHECK ("identity_recovery_tokens"."expires_at" = "identity_recovery_tokens"."issued_at" + interval '30 minutes'),
	CONSTRAINT "identity_recovery_tokens_operator_reference_check" CHECK ("identity_recovery_tokens"."operator_reference" IS NULL OR (octet_length("identity_recovery_tokens"."operator_reference") BETWEEN 1 AND 64 AND "identity_recovery_tokens"."operator_reference" COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'))
);
--> statement-breakpoint
CREATE TABLE "identity_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_digest" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "identity_sessions_credential_digest_length_check" CHECK (octet_length("identity_sessions"."credential_digest") = 32),
	CONSTRAINT "identity_sessions_expiry_check" CHECK ("identity_sessions"."expires_at" = "identity_sessions"."created_at" + interval '30 days')
);
--> statement-breakpoint
CREATE TABLE "identity_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username_display" text NOT NULL,
	"username_normalized" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_users_username_display_check" CHECK (octet_length("identity_users"."username_display") BETWEEN 3 AND 32 AND "identity_users"."username_display" COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$'),
	CONSTRAINT "identity_users_username_normalized_check" CHECK (octet_length("identity_users"."username_normalized") BETWEEN 3 AND 32 AND "identity_users"."username_normalized" COLLATE "C" ~ '^[a-z0-9][a-z0-9_-]{2,31}$' AND "identity_users"."username_normalized" = lower("identity_users"."username_display"))
);
--> statement-breakpoint
ALTER TABLE "identity_bindings" ADD CONSTRAINT "identity_bindings_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_password_credentials" ADD CONSTRAINT "identity_password_credentials_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_recovery_tokens" ADD CONSTRAINT "identity_recovery_tokens_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_bindings_provider_subject_uidx" ON "identity_bindings" USING btree ("provider_kind","provider_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_bindings_user_provider_uidx" ON "identity_bindings" USING btree ("user_id","provider_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_recovery_tokens_digest_uidx" ON "identity_recovery_tokens" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "identity_recovery_tokens_user_issued_idx" ON "identity_recovery_tokens" USING btree ("user_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "identity_recovery_tokens_expiry_idx" ON "identity_recovery_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_sessions_credential_digest_uidx" ON "identity_sessions" USING btree ("credential_digest");--> statement-breakpoint
CREATE INDEX "identity_sessions_user_expiry_idx" ON "identity_sessions" USING btree ("user_id","expires_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "identity_sessions_active_cleanup_idx" ON "identity_sessions" USING btree ("expires_at") WHERE "identity_sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_username_normalized_uidx" ON "identity_users" USING btree ("username_normalized");
