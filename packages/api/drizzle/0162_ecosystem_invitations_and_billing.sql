-- oxy:deploy-phase=pre
CREATE TABLE "account_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"inherit" boolean DEFAULT true NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_invitations_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "account_invitations_role_check" CHECK ("account_invitations"."role" in ('admin', 'editor', 'developer', 'billing', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "access_grants" DROP CONSTRAINT "access_grants_segment_benefit_key";--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" DROP CONSTRAINT "personal_checkout_price";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preference_display_currency" text;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "renewal_source_id" text;--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD COLUMN "billing_interval" text DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_invitations_account_id_idx" ON "account_invitations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_invitations_expires_at_idx" ON "account_invitations" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_plan_checkout_intents_renewal_source_id_access_subscription_sources_id_fk" FOREIGN KEY ("renewal_source_id") REFERENCES "public"."access_subscription_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_segment_benefit_key" UNIQUE("source_segment_id","benefit_index","period_start");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_display_currency_check" CHECK ("users"."preference_display_currency" IN ('USD', 'EUR', 'FAIR'));--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_checkout_interval" CHECK ("personal_plan_checkout_intents"."billing_interval" IN ('month', 'year') AND ("personal_plan_checkout_intents"."price_kind" <> 'oxy_one' OR "personal_plan_checkout_intents"."billing_interval" = 'month'));--> statement-breakpoint
ALTER TABLE "personal_plan_checkout_intents" ADD CONSTRAINT "personal_checkout_price" CHECK ((("personal_plan_checkout_intents"."offer_kind" = 'bundle' and "personal_plan_checkout_intents"."price_kind" = 'oxy_one') or ("personal_plan_checkout_intents"."offer_kind" = 'individual' and "personal_plan_checkout_intents"."price_kind" = 'existing_product')) and "personal_plan_checkout_intents"."price_provider" in ('stripe', 'peable') and "personal_plan_checkout_intents"."currency" ~ '^[a-z]{3}$' and "personal_plan_checkout_intents"."amount_minor_units" > 0 and ("personal_plan_checkout_intents"."price_valid_until" is null or "personal_plan_checkout_intents"."price_valid_until" > "personal_plan_checkout_intents"."price_valid_from"));