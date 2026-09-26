-- oxy:deploy-phase=pre
-- Recovery email codes and their one-use tickets (ADR 0029 D3). A new table the
-- image that sends codes reads and writes; created before that image serves.
CREATE TABLE "email_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"email_hash" text NOT NULL,
	"user_id" text,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"ticket_hash" text,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "email_verifications_ticket_hash_key" UNIQUE("ticket_hash"),
	CONSTRAINT "email_verifications_purpose_check" CHECK ("email_verifications"."purpose" in ('signup', 'recovery')),
	CONSTRAINT "email_verifications_ticket_check" CHECK ("email_verifications"."ticket_hash" is null or "email_verifications"."confirmed_at" is not null),
	CONSTRAINT "email_verifications_used_check" CHECK ("email_verifications"."used_at" is null or "email_verifications"."ticket_hash" is not null),
	CONSTRAINT "email_verifications_attempts_check" CHECK ("email_verifications"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_verifications_email_hash_created_at_idx" ON "email_verifications" USING btree ("email_hash","created_at");--> statement-breakpoint
CREATE INDEX "email_verifications_expires_at_idx" ON "email_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "email_verifications_user_id_idx" ON "email_verifications" USING btree ("user_id");