-- oxy:deploy-phase=pre
CREATE TABLE "organization_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"claimant_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_reference" text NOT NULL,
	"reviewed_by_user_id" text,
	"review_evidence_reference" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "organization_claims_status_check" CHECK ("organization_claims"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "organization_directory_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"actor_user_id" text,
	"actor_application_id" text,
	"action" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"related_account_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_external_ids" (
	"namespace" text NOT NULL,
	"external_id" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "organization_external_ids_namespace_external_id_pk" PRIMARY KEY("namespace","external_id")
);
--> statement-breakpoint
CREATE TABLE "organization_profiles" (
	"account_id" text PRIMARY KEY NOT NULL,
	"organization_type" text DEFAULT 'other' NOT NULL,
	"legal_name" text,
	"website_url" text,
	"country_code" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claim_status" text DEFAULT 'unclaimed' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_account_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "organization_profiles_type_check" CHECK ("organization_profiles"."organization_type" in ('business', 'nonprofit', 'public_body', 'community', 'other')),
	CONSTRAINT "organization_profiles_status_check" CHECK ("organization_profiles"."status" in ('active', 'inactive', 'merged', 'suppressed')),
	CONSTRAINT "organization_profiles_claim_status_check" CHECK ("organization_profiles"."claim_status" in ('unclaimed', 'claimed')),
	CONSTRAINT "organization_profiles_country_code_check" CHECK ("organization_profiles"."country_code" is null or "organization_profiles"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "organization_profiles_merge_check" CHECK (("organization_profiles"."status" = 'merged') = ("organization_profiles"."merged_into_account_id" is not null) and "organization_profiles"."account_id" is distinct from "organization_profiles"."merged_into_account_id")
);
--> statement-breakpoint
CREATE TABLE "organization_search_terms" (
	"account_id" text NOT NULL,
	"term" text NOT NULL,
	CONSTRAINT "organization_search_terms_account_id_term_pk" PRIMARY KEY("account_id","term")
);
--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_workload_identities" DROP CONSTRAINT "application_workload_identities_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "organization_claims" ADD CONSTRAINT "organization_claims_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_claims" ADD CONSTRAINT "organization_claims_claimant_user_id_users_id_fk" FOREIGN KEY ("claimant_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_claims" ADD CONSTRAINT "organization_claims_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_external_ids" ADD CONSTRAINT "organization_external_ids_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_profiles" ADD CONSTRAINT "organization_profiles_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_profiles" ADD CONSTRAINT "organization_profiles_merged_into_account_id_users_id_fk" FOREIGN KEY ("merged_into_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_search_terms" ADD CONSTRAINT "organization_search_terms_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_claims_account_status_idx" ON "organization_claims" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "organization_claims_claimant_id_idx" ON "organization_claims" USING btree ("claimant_user_id","id");--> statement-breakpoint
CREATE INDEX "organization_claims_status_id_idx" ON "organization_claims" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_claims_pending_claimant_key" ON "organization_claims" USING btree ("account_id","claimant_user_id") WHERE "organization_claims"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "organization_external_ids_account_idx" ON "organization_external_ids" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "organization_profiles_type_status_account_idx" ON "organization_profiles" USING btree ("organization_type","status","account_id");--> statement-breakpoint
CREATE INDEX "organization_profiles_merge_idx" ON "organization_profiles" USING btree ("merged_into_account_id");--> statement-breakpoint
CREATE INDEX "organization_search_terms_prefix_idx" ON "organization_search_terms" USING btree ("term" text_pattern_ops);--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch']::text[]);--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_scopes_check" CHECK ("application_workload_identities"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch']::text[]);
--> statement-breakpoint
-- Existing organizations keep their real authority; topical categories never establish it.
INSERT INTO organization_profiles(account_id, claim_status)
SELECT u.id, CASE WHEN EXISTS (
  SELECT 1 FROM account_members m
  WHERE m.status = 'active' AND m.role = 'owner' AND
    (m.account_id = u.id OR (m.inherit AND m.account_id IN
      (SELECT ancestor_id FROM user_ancestors WHERE user_id = u.id)))
) THEN 'claimed' ELSE 'unclaimed' END
FROM users u WHERE u.kind = 'organization';
--> statement-breakpoint
-- Historical login and app authority without a real owner must fail closed.
UPDATE sessions SET is_active=false WHERE user_id IN (SELECT account_id FROM organization_profiles WHERE claim_status='unclaimed');
--> statement-breakpoint
UPDATE applications SET status='suspended' WHERE owner_account_id IN (SELECT account_id FROM organization_profiles WHERE claim_status='unclaimed') AND status='active';
--> statement-breakpoint
-- Every later authority attachment checks the same locked directory row.
CREATE FUNCTION guard_organization_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id text; state record;
BEGIN
  -- Revoking existing membership is always allowed, including disabled organizations.
  IF TG_TABLE_NAME = 'account_members' AND TG_OP = 'UPDATE' THEN
    IF NEW.status = 'removed' AND NEW.account_id = OLD.account_id AND NEW.member_user_id = OLD.member_user_id THEN RETURN NEW; END IF;
  END IF;
  target_id := to_jsonb(NEW) ->> TG_ARGV[0];
  IF target_id IS NULL THEN RETURN NEW; END IF;
  SELECT claim_status, status INTO state FROM organization_profiles WHERE account_id = target_id FOR SHARE;
  IF FOUND AND (state.claim_status <> 'claimed' OR state.status <> 'active') THEN
    RAISE EXCEPTION 'organization has no operating authority' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organization_member_authority BEFORE INSERT OR UPDATE ON account_members FOR EACH ROW EXECUTE FUNCTION guard_organization_authority('account_id');
--> statement-breakpoint
CREATE TRIGGER organization_application_authority BEFORE INSERT OR UPDATE OF owner_account_id ON applications FOR EACH ROW EXECUTE FUNCTION guard_organization_authority('owner_account_id');
--> statement-breakpoint
CREATE TRIGGER organization_billing_authority BEFORE INSERT OR UPDATE OF account_id ON billing_profiles FOR EACH ROW EXECUTE FUNCTION guard_organization_authority('account_id');
--> statement-breakpoint
CREATE TRIGGER organization_session_authority BEFORE INSERT OR UPDATE OF user_id ON sessions FOR EACH ROW EXECUTE FUNCTION guard_organization_authority('user_id');
--> statement-breakpoint
CREATE TRIGGER organization_context_authority BEFORE INSERT OR UPDATE OF account_id ON device_account_contexts FOR EACH ROW EXECUTE FUNCTION guard_organization_authority('account_id');
--> statement-breakpoint
CREATE TRIGGER organization_password_authority BEFORE INSERT OR UPDATE OF user_id ON user_passwords FOR EACH ROW EXECUTE FUNCTION guard_organization_authority('user_id');
--> statement-breakpoint
CREATE TRIGGER organization_key_authority BEFORE INSERT OR UPDATE OF user_id ON user_auth_methods FOR EACH ROW EXECUTE FUNCTION guard_organization_authority('user_id');
--> statement-breakpoint
CREATE TRIGGER organization_child_authority BEFORE INSERT OR UPDATE OF parent_account_id ON users FOR EACH ROW EXECUTE FUNCTION guard_organization_authority('parent_account_id');
--> statement-breakpoint
CREATE FUNCTION guard_organization_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state record;
BEGIN
  SELECT claim_status, status INTO state FROM organization_profiles WHERE account_id = NEW.id FOR SHARE;
  IF FOUND THEN
    IF NEW.kind <> 'organization' THEN RAISE EXCEPTION 'directory organization kind is immutable' USING ERRCODE = '23514'; END IF;
    IF (state.claim_status <> 'claimed' OR state.status <> 'active') AND
      (NEW.parent_account_id IS DISTINCT FROM OLD.parent_account_id OR NEW.root_account_id IS DISTINCT FROM OLD.root_account_id OR
       NEW.public_key IS DISTINCT FROM OLD.public_key OR NEW.email IS DISTINCT FROM OLD.email OR NEW.is_staff IS DISTINCT FROM OLD.is_staff) THEN
      RAISE EXCEPTION 'unclaimed organization cannot acquire account authority' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organization_identity_authority BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION guard_organization_identity();
--> statement-breakpoint
CREATE FUNCTION guard_organization_profile_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.account_id AND kind = 'organization') THEN
    RAISE EXCEPTION 'organization profile requires organization account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organization_profile_kind BEFORE INSERT OR UPDATE OF account_id ON organization_profiles FOR EACH ROW EXECUTE FUNCTION guard_organization_profile_kind();

--> statement-breakpoint
-- Compatibility with the existing managed-account creation transaction and old images.
CREATE FUNCTION ensure_owned_organization_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.role = 'owner' AND EXISTS (SELECT 1 FROM users WHERE id = NEW.account_id AND kind = 'organization') THEN
    INSERT INTO organization_profiles(account_id, claim_status) VALUES (NEW.account_id, 'claimed') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organization_owner_profile AFTER INSERT OR UPDATE ON account_members FOR EACH ROW EXECUTE FUNCTION ensure_owned_organization_profile();

--> statement-breakpoint
CREATE FUNCTION refresh_organization_search_terms(target_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM organization_search_terms WHERE account_id = target_id;
  INSERT INTO organization_search_terms(account_id,term)
  SELECT target_id,lower(trim(term)) FROM (
    SELECT u.name_display AS term FROM users u JOIN organization_profiles p ON p.account_id=u.id WHERE u.id=target_id
    UNION SELECT u.username FROM users u JOIN organization_profiles p ON p.account_id=u.id WHERE u.id=target_id
    UNION SELECT p.legal_name FROM organization_profiles p WHERE p.account_id=target_id
    UNION SELECT a->>'alias' FROM organization_profiles p CROSS JOIN LATERAL jsonb_array_elements(p.aliases) a WHERE p.account_id=target_id
  ) terms WHERE term IS NOT NULL AND trim(term) <> '' ON CONFLICT DO NOTHING;
END $$;
--> statement-breakpoint
CREATE FUNCTION sync_organization_search_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_organization_search_terms(to_jsonb(NEW)->>TG_ARGV[0]);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organization_identity_search AFTER INSERT OR UPDATE OF name_display,username ON users FOR EACH ROW WHEN (NEW.kind='organization') EXECUTE FUNCTION sync_organization_search_terms('id');
--> statement-breakpoint
CREATE TRIGGER organization_profile_search AFTER INSERT OR UPDATE OF legal_name,aliases ON organization_profiles FOR EACH ROW EXECUTE FUNCTION sync_organization_search_terms('account_id');
--> statement-breakpoint
SELECT refresh_organization_search_terms(account_id) FROM organization_profiles;

--> statement-breakpoint
CREATE FUNCTION require_organization_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM users WHERE id=NEW.id AND kind='organization') AND NOT EXISTS(SELECT 1 FROM organization_profiles WHERE account_id=NEW.id) THEN
    RAISE EXCEPTION 'organization account requires a directory profile in the same transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER organization_directory_required AFTER INSERT OR UPDATE OF kind ON users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_organization_profile();
