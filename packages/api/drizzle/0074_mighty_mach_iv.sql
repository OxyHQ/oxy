-- oxy:deploy-phase=pre
CREATE TABLE "mcp_oauth_account_link_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"requested_by_grant_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"approved_grant_id" text,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mcp_oauth_account_link_intents_secret_key" UNIQUE("secret_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_connection_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"is_origin" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"origin_grant_id" text NOT NULL,
	"active_account_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mcp_oauth_connections_origin_grant_key" UNIQUE("origin_grant_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_account_link_intents" ADD CONSTRAINT "mcp_oauth_account_link_intents_connection_id_mcp_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_account_link_intents" ADD CONSTRAINT "mcp_oauth_account_link_intents_requested_by_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("requested_by_grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_account_link_intents" ADD CONSTRAINT "mcp_oauth_account_link_intents_approved_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("approved_grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_connection_accounts" ADD CONSTRAINT "mcp_oauth_connection_accounts_connection_id_mcp_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_connection_accounts" ADD CONSTRAINT "mcp_oauth_connection_accounts_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_connection_accounts" ADD CONSTRAINT "mcp_oauth_connection_accounts_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_connections" ADD CONSTRAINT "mcp_oauth_connections_origin_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("origin_grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_connections" ADD CONSTRAINT "mcp_oauth_connections_active_account_id_users_id_fk" FOREIGN KEY ("active_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_oauth_account_link_intents_expiry_idx" ON "mcp_oauth_account_link_intents" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_account_link_intents_connection_idx" ON "mcp_oauth_account_link_intents" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_connection_accounts_live_key" ON "mcp_oauth_connection_accounts" USING btree ("connection_id","account_id") WHERE "mcp_oauth_connection_accounts"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "mcp_oauth_connection_accounts_connection_idx" ON "mcp_oauth_connection_accounts" USING btree ("connection_id","revoked_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_connection_accounts_grant_idx" ON "mcp_oauth_connection_accounts" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_connections_active_account_idx" ON "mcp_oauth_connections" USING btree ("active_account_id");