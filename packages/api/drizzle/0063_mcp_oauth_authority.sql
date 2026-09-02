-- oxy:deploy-phase=pre
CREATE TABLE "mcp_oauth_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"jti" text NOT NULL,
	"grant_id" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mcp_oauth_access_tokens_jti_key" UNIQUE("jti")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_authorization_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"grant_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mcp_oauth_authorization_codes_hash_key" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"grant_types" text[] NOT NULL,
	"response_types" text[] NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"client_uri" text,
	"logo_uri" text,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mcp_oauth_clients_client_id_key" UNIQUE("client_id"),
	CONSTRAINT "mcp_oauth_clients_status_check" CHECK ("mcp_oauth_clients"."status" in ('active', 'revoked')),
	CONSTRAINT "mcp_oauth_clients_revoked_at_check" CHECK (("mcp_oauth_clients"."status" = 'revoked') = ("mcp_oauth_clients"."revoked_at" is not null)),
	CONSTRAINT "mcp_oauth_clients_grant_types_check" CHECK ("mcp_oauth_clients"."grant_types" <@ array['authorization_code', 'refresh_token']::text[]
        and "mcp_oauth_clients"."grant_types" @> array['authorization_code']::text[]),
	CONSTRAINT "mcp_oauth_clients_response_types_check" CHECK ("mcp_oauth_clients"."response_types" = array['code']::text[]),
	CONSTRAINT "mcp_oauth_clients_redirect_uris_check" CHECK (cardinality("mcp_oauth_clients"."redirect_uris") > 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_user_id" text NOT NULL,
	"effective_account_id" text NOT NULL,
	"client_record_id" text NOT NULL,
	"app_slug" text NOT NULL,
	"resource" text NOT NULL,
	"audience" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"grant_id" text NOT NULL,
	"family_key" text NOT NULL,
	"parent_token_id" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mcp_oauth_refresh_tokens_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_tokens" ADD CONSTRAINT "mcp_oauth_access_tokens_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorization_codes" ADD CONSTRAINT "mcp_oauth_authorization_codes_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_principal_user_id_users_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_effective_account_id_users_id_fk" FOREIGN KEY ("effective_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_client_record_id_mcp_oauth_clients_id_fk" FOREIGN KEY ("client_record_id") REFERENCES "public"."mcp_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_refresh_tokens" ADD CONSTRAINT "mcp_oauth_refresh_tokens_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_refresh_tokens" ADD CONSTRAINT "mcp_oauth_refresh_tokens_parent_token_id_mcp_oauth_refresh_tokens_id_fk" FOREIGN KEY ("parent_token_id") REFERENCES "public"."mcp_oauth_refresh_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_tokens_expiry_idx" ON "mcp_oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_tokens_grant_idx" ON "mcp_oauth_access_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorization_codes_expiry_idx" ON "mcp_oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorization_codes_grant_idx" ON "mcp_oauth_authorization_codes" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_grants_active_key" ON "mcp_oauth_grants" USING btree ("principal_user_id","effective_account_id","client_record_id","resource") WHERE "mcp_oauth_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_account_idx" ON "mcp_oauth_grants" USING btree ("effective_account_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_client_idx" ON "mcp_oauth_grants" USING btree ("client_record_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_tokens_family_idx" ON "mcp_oauth_refresh_tokens" USING btree ("family_key");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_tokens_expiry_idx" ON "mcp_oauth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_tokens_grant_idx" ON "mcp_oauth_refresh_tokens" USING btree ("grant_id");
