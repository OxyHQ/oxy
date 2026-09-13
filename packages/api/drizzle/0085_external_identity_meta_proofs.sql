-- oxy:deploy-phase=pre
CREATE TABLE "external_identity_meta_proofs" (
	"instagram_actor_uri" text NOT NULL,
	"threads_actor_uri" text NOT NULL,
	"instagram_acct" text NOT NULL,
	"threads_acct" text NOT NULL,
	"instagram_pk" text NOT NULL,
	"instagram_graph_id" text NOT NULL,
	"threads_web_pk" text NOT NULL,
	"instagram_profile_url" text NOT NULL,
	"threads_profile_url" text NOT NULL,
	"policy_version" text NOT NULL,
	"instagram_document_hash" text NOT NULL,
	"threads_document_hash" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"method" text DEFAULT 'meta-public-profile-v1' NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "external_identity_meta_proofs_instagram_actor_uri_threads_actor_uri_pk" PRIMARY KEY("instagram_actor_uri","threads_actor_uri"),
	CONSTRAINT "external_identity_meta_proofs_state_check" CHECK ("external_identity_meta_proofs"."state" in ('verified', 'pending', 'revoked')),
	CONSTRAINT "external_identity_meta_proofs_method_check" CHECK ("external_identity_meta_proofs"."method" = 'meta-public-profile-v1'),
	CONSTRAINT "external_identity_meta_proofs_bounds_check" CHECK (length("external_identity_meta_proofs"."instagram_actor_uri") <= 2048 and length("external_identity_meta_proofs"."threads_actor_uri") <= 2048
    and length("external_identity_meta_proofs"."instagram_acct") <= 320 and length("external_identity_meta_proofs"."threads_acct") <= 320
    and "external_identity_meta_proofs"."instagram_pk" ~ '^[0-9]{1,32}$' and "external_identity_meta_proofs"."instagram_graph_id" ~ '^[0-9]{1,32}$' and "external_identity_meta_proofs"."threads_web_pk" ~ '^[0-9]{1,32}$'
    and length("external_identity_meta_proofs"."instagram_profile_url") <= 2048 and length("external_identity_meta_proofs"."threads_profile_url") <= 2048
    and "external_identity_meta_proofs"."policy_version" = 'meta-profile-badges-2026-09-13-v1'
    and "external_identity_meta_proofs"."instagram_document_hash" ~ '^[a-f0-9]{64}$' and "external_identity_meta_proofs"."threads_document_hash" ~ '^[a-f0-9]{64}$'
    and "external_identity_meta_proofs"."evidence_digest" ~ '^[a-f0-9]{64}$' and length("external_identity_meta_proofs"."revocation_reason") <= 80
    and "external_identity_meta_proofs"."expires_at" > "external_identity_meta_proofs"."verified_at" and "external_identity_meta_proofs"."expires_at" <= "external_identity_meta_proofs"."verified_at" + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "external_identities" ADD COLUMN "meta_proof_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_identity_meta_proofs" ADD CONSTRAINT "external_identity_meta_proofs_instagram_actor_uri_external_identity_actors_actor_uri_fk" FOREIGN KEY ("instagram_actor_uri") REFERENCES "public"."external_identity_actors"("actor_uri") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identity_meta_proofs" ADD CONSTRAINT "external_identity_meta_proofs_threads_actor_uri_external_identity_actors_actor_uri_fk" FOREIGN KEY ("threads_actor_uri") REFERENCES "public"."external_identity_actors"("actor_uri") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_identity_meta_proofs_instagram_acct_idx" ON "external_identity_meta_proofs" USING btree ("instagram_acct");--> statement-breakpoint
CREATE INDEX "external_identity_meta_proofs_threads_acct_idx" ON "external_identity_meta_proofs" USING btree ("threads_acct");