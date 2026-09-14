-- oxy:deploy-phase=pre
CREATE TABLE "canonical_user_redirects" (
	"user_id" text PRIMARY KEY NOT NULL,
	"canonical_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_user_redirects_not_self_check" CHECK ("canonical_user_redirects"."user_id" <> "canonical_user_redirects"."canonical_user_id")
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"canonical_acct" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"network" text NOT NULL,
	"stable_id" text,
	"evidence_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_identity_actors" (
	"actor_uri" text PRIMARY KEY NOT NULL,
	"canonical_acct" text NOT NULL,
	"transport_acct" text NOT NULL,
	"protocol" text NOT NULL,
	"evidence_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_identity_claims" (
	"actor_uri" text NOT NULL,
	"target_acct" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "external_identity_claims_actor_uri_target_acct_pk" PRIMARY KEY("actor_uri","target_acct"),
	CONSTRAINT "external_identity_claims_state_check" CHECK ("external_identity_claims"."state" in ('pending', 'linked', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "canonical_user_redirects" ADD CONSTRAINT "canonical_user_redirects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_user_redirects" ADD CONSTRAINT "canonical_user_redirects_canonical_user_id_users_id_fk" FOREIGN KEY ("canonical_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identity_actors" ADD CONSTRAINT "external_identity_actors_canonical_acct_external_identities_canonical_acct_fk" FOREIGN KEY ("canonical_acct") REFERENCES "public"."external_identities"("canonical_acct") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identity_claims" ADD CONSTRAINT "external_identity_claims_actor_uri_external_identity_actors_actor_uri_fk" FOREIGN KEY ("actor_uri") REFERENCES "public"."external_identity_actors"("actor_uri") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canonical_user_redirects_canonical_user_id_idx" ON "canonical_user_redirects" USING btree ("canonical_user_id");--> statement-breakpoint
CREATE INDEX "external_identities_user_id_idx" ON "external_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "external_identity_actors_canonical_acct_idx" ON "external_identity_actors" USING btree ("canonical_acct");--> statement-breakpoint
-- Preserve legacy actor references without guessing source-network equivalence.
-- A subsequent authenticated discovery promotes transport keys to canonical accounts.
INSERT INTO external_identities (canonical_acct, user_id, network)
SELECT lower(ltrim(btrim(username), '@')), id, coalesce(federation_domain, '')
FROM users WHERE type = 'federated' AND federation_actor_uri IS NOT NULL AND username IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO external_identity_actors (actor_uri, canonical_acct, transport_acct, protocol, updated_at)
SELECT federation_actor_uri, lower(ltrim(btrim(username), '@')), lower(ltrim(btrim(username), '@')), case when federation_actor_uri like 'did:%' then 'atproto' else 'activitypub' end, 'epoch'::timestamptz
FROM users WHERE type = 'federated' AND federation_actor_uri IS NOT NULL AND username IS NOT NULL
ON CONFLICT DO NOTHING;
