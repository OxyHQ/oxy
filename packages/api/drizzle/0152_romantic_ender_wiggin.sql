-- oxy:deploy-phase=pre
CREATE TABLE "email_unsubscribed_senders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sender_address" text NOT NULL,
	"method" text NOT NULL,
	"unsubscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "email_unsubscribed_senders_user_id_sender_address_key" UNIQUE("user_id","sender_address"),
	CONSTRAINT "email_unsubscribed_senders_method_check" CHECK ("email_unsubscribed_senders"."method" in ('one-click', 'http', 'mailto', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "email_unsubscribed_senders" ADD CONSTRAINT "email_unsubscribed_senders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;