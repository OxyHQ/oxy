-- oxy:deploy-phase=pre
CREATE TABLE "supervision_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"child_account_id" text NOT NULL,
	"actor_account_id" text,
	"application_id" text,
	"action" text NOT NULL,
	"related_account_id" text,
	"resource_id" text,
	"evidence_reference" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supervision_contacts" (
	"child_account_id" text NOT NULL,
	"contact_account_id" text NOT NULL,
	"approved_by_account_id" text,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supervision_contacts_child_account_id_contact_account_id_pk" PRIMARY KEY("child_account_id","contact_account_id")
);
--> statement-breakpoint
CREATE TABLE "supervision_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"child_account_id" text NOT NULL,
	"guardian_account_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"consent_version" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supervision_invitations_status_check" CHECK ("supervision_invitations"."status" in ('pending', 'accepted', 'cancelled')),
	CONSTRAINT "supervision_invitations_distinct_accounts_check" CHECK ("supervision_invitations"."child_account_id" <> "supervision_invitations"."guardian_account_id")
);
--> statement-breakpoint
CREATE TABLE "supervision_profiles" (
	"child_account_id" text PRIMARY KEY NOT NULL,
	"guardian_account_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"consent_version" text NOT NULL,
	"sessions_valid_after" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supervision_profiles_status_check" CHECK ("supervision_profiles"."status" in ('active', 'orphaned', 'ended')),
	CONSTRAINT "supervision_profiles_distinct_guardian_check" CHECK ("supervision_profiles"."child_account_id" is distinct from "supervision_profiles"."guardian_account_id")
);
--> statement-breakpoint
CREATE TABLE "supervision_purchase_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"child_account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"cart_fingerprint" text NOT NULL,
	"summary" text NOT NULL,
	"shipping_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"rounding_adjustment_minor" bigint NOT NULL,
	"evidence_sealed" boolean DEFAULT false NOT NULL,
	"merchant_account_ids" text[] NOT NULL,
	"payment_fingerprint" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_account_id" text,
	"reviewed_at" timestamp with time zone,
	"reserved_at" timestamp with time zone,
	"receipt_reference" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supervision_purchase_approvals_merchants_check" CHECK (cardinality("supervision_purchase_approvals"."merchant_account_ids") between 1 and 100),
	CONSTRAINT "supervision_purchase_approvals_status_check" CHECK ("supervision_purchase_approvals"."status" in ('pending', 'approved', 'rejected', 'reserved', 'confirmed', 'cancelled')),
	CONSTRAINT "supervision_purchase_approvals_amount_check" CHECK ("supervision_purchase_approvals"."amount_minor" between 0 and 9007199254740991),
	CONSTRAINT "supervision_purchase_approvals_currency_check" CHECK ("supervision_purchase_approvals"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "supervision_purchase_lines" (
	"approval_id" text NOT NULL,
	"position" integer NOT NULL,
	"item_reference" text NOT NULL,
	"title" text NOT NULL,
	"options_text" text NOT NULL,
	"merchant_account_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_amount_minor" bigint NOT NULL,
	"line_amount_minor" bigint NOT NULL,
	CONSTRAINT "supervision_purchase_lines_approval_id_position_pk" PRIMARY KEY("approval_id","position"),
	CONSTRAINT "supervision_purchase_lines_position_check" CHECK ("supervision_purchase_lines"."position" between 0 and 199),
	CONSTRAINT "supervision_purchase_lines_quantity_check" CHECK ("supervision_purchase_lines"."quantity" between 1 and 1000000),
	CONSTRAINT "supervision_purchase_lines_amounts_check" CHECK ("supervision_purchase_lines"."unit_amount_minor" between 0 and 9007199254740991 and "supervision_purchase_lines"."line_amount_minor" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "application_credentials" DROP CONSTRAINT "application_credentials_scopes_check";--> statement-breakpoint
ALTER TABLE "application_workload_identities" DROP CONSTRAINT "application_workload_identities_scopes_check";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_scopes_check";--> statement-breakpoint
ALTER TABLE "email_verifications" DROP CONSTRAINT "email_verifications_reauth_action_check";--> statement-breakpoint
ALTER TABLE "supervision_audit" ADD CONSTRAINT "supervision_audit_child_account_id_users_id_fk" FOREIGN KEY ("child_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_audit" ADD CONSTRAINT "supervision_audit_actor_account_id_users_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_audit" ADD CONSTRAINT "supervision_audit_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_contacts" ADD CONSTRAINT "supervision_contacts_child_account_id_supervision_profiles_child_account_id_fk" FOREIGN KEY ("child_account_id") REFERENCES "public"."supervision_profiles"("child_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_contacts" ADD CONSTRAINT "supervision_contacts_contact_account_id_users_id_fk" FOREIGN KEY ("contact_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_contacts" ADD CONSTRAINT "supervision_contacts_approved_by_account_id_users_id_fk" FOREIGN KEY ("approved_by_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_invitations" ADD CONSTRAINT "supervision_invitations_child_account_id_users_id_fk" FOREIGN KEY ("child_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_invitations" ADD CONSTRAINT "supervision_invitations_guardian_account_id_users_id_fk" FOREIGN KEY ("guardian_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_profiles" ADD CONSTRAINT "supervision_profiles_child_account_id_users_id_fk" FOREIGN KEY ("child_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_profiles" ADD CONSTRAINT "supervision_profiles_guardian_account_id_users_id_fk" FOREIGN KEY ("guardian_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_purchase_approvals" ADD CONSTRAINT "supervision_purchase_approvals_child_account_id_users_id_fk" FOREIGN KEY ("child_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_purchase_approvals" ADD CONSTRAINT "supervision_purchase_approvals_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_purchase_approvals" ADD CONSTRAINT "supervision_purchase_approvals_reviewed_by_account_id_users_id_fk" FOREIGN KEY ("reviewed_by_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_purchase_lines" ADD CONSTRAINT "supervision_purchase_lines_approval_id_supervision_purchase_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."supervision_purchase_approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supervision_audit_child_idx" ON "supervision_audit" USING btree ("child_account_id","id");--> statement-breakpoint
CREATE INDEX "supervision_contacts_contact_idx" ON "supervision_contacts" USING btree ("contact_account_id");--> statement-breakpoint
CREATE INDEX "supervision_invitations_guardian_idx" ON "supervision_invitations" USING btree ("guardian_account_id","status","id");--> statement-breakpoint
CREATE INDEX "supervision_invitations_child_idx" ON "supervision_invitations" USING btree ("child_account_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supervision_invitations_pending_key" ON "supervision_invitations" USING btree ("child_account_id","guardian_account_id") WHERE "supervision_invitations"."status"='pending';--> statement-breakpoint
CREATE INDEX "supervision_profiles_guardian_idx" ON "supervision_profiles" USING btree ("guardian_account_id","child_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supervision_purchase_approvals_operation_key" ON "supervision_purchase_approvals" USING btree ("application_id","operation_id");--> statement-breakpoint
CREATE INDEX "supervision_purchase_approvals_child_id_idx" ON "supervision_purchase_approvals" USING btree ("child_account_id","id");--> statement-breakpoint
ALTER TABLE "application_credentials" ADD CONSTRAINT "application_credentials_scopes_check" CHECK ("application_credentials"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'safety:decide', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'accounts:membership:read', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch']::text[]);--> statement-breakpoint
ALTER TABLE "application_workload_identities" ADD CONSTRAINT "application_workload_identities_scopes_check" CHECK ("application_workload_identities"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'safety:decide', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'accounts:membership:read', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch']::text[]);--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_scopes_check" CHECK ("applications"."scopes" <@ array['files:read', 'files:linked:read', 'files:write', 'files:delete', 'user:read', 'webhooks:receive', 'inference:invoke', 'alia:chat', 'inference:models:read', 'inference:usage:read', 'inference:routing:read', 'inference:routing:write', 'inference:providers:read', 'inference:providers:write', 'inference:byok:validate', 'clarity:search', 'clarity:index', 'clarity:sites:manage', 'clarity:usage:read', 'updates:publish', 'federation:write', 'signals:write', 'reputation:write', 'reputation:lease:write', 'reputation:moderation:apply', 'reputation:binding:register', 'notifications:write', 'capabilities:read', 'catalogs:write', 'capability-tickets:issue', 'capability-audit:write', 'capability-events:publish', 'payments:read', 'payments:write', 'follows:read', 'follows:write', 'follows:context:write', 'follows:manage', 'follows:events', 'follow-targets:register', 'chains:write', 'organizations:import', 'safety:decide', 'chains:read', 'acting-as:offline', 'accounts:act-as-session', 'accounts:membership:read', 'podcasts:write', 'linked-accounts:read', 'files:user-media:write', 'federation:identities:resolve', 'federation:instance-fetch']::text[]);--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_reauth_action_check" CHECK (("email_verifications"."purpose" = 'reauth') = ("email_verifications"."reauth_action" is not null) and ("email_verifications"."reauth_action" is null or "email_verifications"."reauth_action" in ('change_password', 'totp', 'link_commons', 'delete_account', 'credentials_manage', 'supervision', 'supervision_purchase')));
--> statement-breakpoint
CREATE FUNCTION supervision_private_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.privacy_is_private_account AND EXISTS (
    SELECT 1 FROM supervision_profiles WHERE child_account_id=NEW.id AND status<>'ended'
  ) THEN RAISE EXCEPTION 'supervised account privacy cannot be weakened' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Only a private-to-public change can weaken policy (an active supervision
-- already requires a private account), so ordinary user writes skip the call.
CREATE TRIGGER supervision_private_profile BEFORE UPDATE OF privacy_is_private_account ON users FOR EACH ROW WHEN (OLD.privacy_is_private_account AND NOT NEW.privacy_is_private_account) EXECUTE FUNCTION supervision_private_profile_guard();
--> statement-breakpoint
CREATE FUNCTION supervision_profile_integrity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child users%ROWTYPE; guardian users%ROWTYPE;
BEGIN
  IF NEW.status='ended' THEN RETURN NEW; END IF;
  SELECT * INTO child FROM users WHERE id=NEW.child_account_id;
  IF child.kind<>'personal' OR NOT child.privacy_is_private_account THEN
    RAISE EXCEPTION 'supervision requires a private personal identity' USING ERRCODE='23514';
  END IF;
  IF NEW.guardian_account_id IS NOT NULL THEN
    SELECT * INTO guardian FROM users WHERE id=NEW.guardian_account_id;
    IF guardian.kind<>'personal' OR EXISTS (
      SELECT 1 FROM supervision_profiles WHERE child_account_id=NEW.guardian_account_id AND status<>'ended'
    ) OR EXISTS (
      SELECT 1 FROM supervision_profiles WHERE guardian_account_id=NEW.child_account_id AND status<>'ended'
    ) THEN RAISE EXCEPTION 'supervision guardian relationship is not eligible' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER supervision_profile_integrity AFTER INSERT OR UPDATE ON supervision_profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supervision_profile_integrity_guard();
--> statement-breakpoint
CREATE FUNCTION supervision_asset_visibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS NOT NULL AND NEW.visibility<>'private' AND EXISTS (
    SELECT 1 FROM supervision_profiles WHERE child_account_id=NEW.owner_user_id AND status<>'ended'
  ) THEN
    IF TG_OP='INSERT' THEN
      RAISE EXCEPTION 'supervised assets must remain private' USING ERRCODE='23514';
    ELSIF NEW.visibility IS DISTINCT FROM OLD.visibility OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
      RAISE EXCEPTION 'supervised assets must remain private' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER supervision_asset_visibility BEFORE INSERT OR UPDATE ON files FOR EACH ROW WHEN (NEW.owner_user_id IS NOT NULL AND NEW.visibility<>'private') EXECUTE FUNCTION supervision_asset_visibility_guard();
--> statement-breakpoint
CREATE FUNCTION supervision_operated_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active AND NEW.operated_by_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM supervision_profiles WHERE child_account_id IN (NEW.user_id,NEW.operated_by_user_id) AND status<>'ended'
  ) THEN RAISE EXCEPTION 'supervised managed-account sessions are unsupported' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER supervision_operated_session BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW WHEN (NEW.is_active AND NEW.operated_by_user_id IS NOT NULL) EXECUTE FUNCTION supervision_operated_session_guard();
--> statement-breakpoint
CREATE FUNCTION supervision_purchase_effects_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.child_account_id,NEW.application_id,NEW.operation_id,NEW.resource_id,NEW.cart_fingerprint,NEW.summary,NEW.shipping_minor,NEW.tax_minor,NEW.discount_minor,NEW.rounding_adjustment_minor,NEW.merchant_account_ids,NEW.payment_fingerprint,NEW.amount_minor,NEW.currency,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.child_account_id,OLD.application_id,OLD.operation_id,OLD.resource_id,OLD.cart_fingerprint,OLD.summary,OLD.shipping_minor,OLD.tax_minor,OLD.discount_minor,OLD.rounding_adjustment_minor,OLD.merchant_account_ids,OLD.payment_fingerprint,OLD.amount_minor,OLD.currency,OLD.expires_at)
  THEN RAISE EXCEPTION 'purchase approval effects are immutable' USING ERRCODE='23514'; END IF;
  IF OLD.evidence_sealed AND NOT NEW.evidence_sealed THEN RAISE EXCEPTION 'approval evidence cannot be reopened' USING ERRCODE='23514'; END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='pending' AND NEW.status IN ('approved','rejected','cancelled')) OR
    (OLD.status='approved' AND NEW.status IN ('reserved','cancelled')) OR
    (OLD.status='reserved' AND NEW.status IN ('confirmed','cancelled'))
  ) THEN RAISE EXCEPTION 'purchase approval transition is not permitted' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER supervision_purchase_effects BEFORE UPDATE ON supervision_purchase_approvals FOR EACH ROW EXECUTE FUNCTION supervision_purchase_effects_guard();
--> statement-breakpoint
CREATE FUNCTION supervision_purchase_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM supervision_purchase_approvals WHERE id=OLD.approval_id) THEN
      RAISE EXCEPTION 'approval evidence lines are immutable' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'approval evidence lines are immutable' USING ERRCODE='23514'; END IF;
  SELECT evidence_sealed INTO sealed FROM supervision_purchase_approvals WHERE id=NEW.approval_id FOR KEY SHARE;
  IF sealed IS DISTINCT FROM false THEN RAISE EXCEPTION 'approval evidence is sealed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER supervision_purchase_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON supervision_purchase_lines FOR EACH ROW EXECUTE FUNCTION supervision_purchase_line_guard();
--> statement-breakpoint
CREATE FUNCTION supervision_purchase_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approval supervision_purchase_approvals%ROWTYPE; line_count bigint; line_total numeric;
BEGIN
  SELECT * INTO approval FROM supervision_purchase_approvals WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT count(*),sum(line_amount_minor) INTO line_count,line_total FROM supervision_purchase_lines WHERE approval_id=NEW.id;
  IF NOT approval.evidence_sealed OR line_count NOT BETWEEN 1 AND 200 OR
     line_total + approval.shipping_minor + approval.tax_minor - approval.discount_minor + approval.rounding_adjustment_minor <> approval.amount_minor
  THEN RAISE EXCEPTION 'complete immutable approval evidence must equal payment total' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM supervision_purchase_lines WHERE approval_id=NEW.id AND NOT merchant_account_id=ANY(approval.merchant_account_ids))
     OR EXISTS (SELECT 1 FROM unnest(approval.merchant_account_ids) merchant WHERE NOT EXISTS (SELECT 1 FROM supervision_purchase_lines WHERE approval_id=NEW.id AND merchant_account_id=merchant))
  THEN RAISE EXCEPTION 'approval merchants must match evidence lines' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER supervision_purchase_evidence AFTER INSERT OR UPDATE ON supervision_purchase_approvals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supervision_purchase_evidence_guard();
