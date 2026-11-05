-- oxy:deploy-phase=pre
CREATE TABLE "account_acquisition" (
	"user_id" text PRIMARY KEY NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"fbclid" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_acquisition_labels_bounded" CHECK (
      char_length("account_acquisition"."utm_source") <= 256 and char_length("account_acquisition"."utm_medium") <= 256
      and char_length("account_acquisition"."utm_campaign") <= 256 and char_length("account_acquisition"."utm_content") <= 256
      and char_length("account_acquisition"."utm_term") <= 256 and char_length("account_acquisition"."fbclid") <= 1024
    )
);
--> statement-breakpoint
ALTER TABLE "account_acquisition" ADD CONSTRAINT "account_acquisition_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_acquisition_campaign_idx" ON "account_acquisition" USING btree ("created_at","utm_source","utm_campaign");