-- oxy:deploy-phase=pre
CREATE TABLE "postal_addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"recipient_name" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region" text,
	"postal_code" text NOT NULL,
	"country" text NOT NULL,
	"phone" text,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "postal_addresses_country_check" CHECK ("postal_addresses"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "postal_addresses" ADD CONSTRAINT "postal_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "postal_addresses_user_id_idx" ON "postal_addresses" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "postal_addresses_user_default_key" ON "postal_addresses" USING btree ("user_id") WHERE "postal_addresses"."is_default";