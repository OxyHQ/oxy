-- oxy:deploy-phase=pre
--
-- PRE: a new table with no writer in the live image, so the arriving image finds
-- it already there and the outgoing one never touches it. Purely additive.
--
-- `service_acting_as_revocations` records a user's standing refusal to let one
-- application act as them from its own backend. It exists because offline
-- delegation is AUTOMATIC for platform-trusted applications, which by design
-- have no `app_grants` row — so "delete the grant" is not a revocation anyone
-- can perform for exactly the applications with the most authority.
--
-- A marker table rather than a column on `app_grants`, because absence has to
-- keep meaning "nothing recorded": a user who never connected anything has no
-- row and must not read as refusing, and a revocation row living in the GRANT
-- table would be a row whose presence means the opposite of every other row
-- there — one `followCapability` already reads as consent.
--
-- Ordering note for whoever changes this next: this table can only ever REMOVE
-- authority. That is why a second place to say NO is safe where a second place
-- to say YES would not be, and why the verify path checks it FIRST.

CREATE TABLE "service_acting_as_revocations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "service_acting_as_revocations_user_id_application_id_key" UNIQUE("user_id","application_id")
);
--> statement-breakpoint
ALTER TABLE "service_acting_as_revocations" ADD CONSTRAINT "service_acting_as_revocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_acting_as_revocations" ADD CONSTRAINT "service_acting_as_revocations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_acting_as_revocations_application_id_idx" ON "service_acting_as_revocations" USING btree ("application_id");