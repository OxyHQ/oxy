-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

CREATE TABLE "auth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"operated_by_user_id" text,
	"application_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text,
	"code_challenge_method" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"device_id" text,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_codes_code_hash_key" UNIQUE("code_hash"),
	CONSTRAINT "auth_codes_code_challenge_method_check" CHECK ("auth_codes"."code_challenge_method" in ('S256')),
	CONSTRAINT "auth_codes_pkce_pair_check" CHECK (("auth_codes"."code_challenge" is null) = ("auth_codes"."code_challenge_method" is null))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_token" text NOT NULL,
	"authorize_code" text,
	"bound_origin" text,
	"origin_verified" boolean DEFAULT false NOT NULL,
	"requester_label" text,
	"challenge_nonce" text,
	"application_id" text NOT NULL,
	"device_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"purpose" text DEFAULT 'device_sign_in' NOT NULL,
	"oauth_redirect_uri" text,
	"oauth_code_challenge" text,
	"oauth_code_challenge_method" text,
	"oauth_scopes" text[],
	"oauth_subject_account_id" text,
	"finalized_auth_code_id" text,
	"denied_reason" text,
	"authorized_by" text,
	"authorized_user_id" text,
	"authorized_session_id" text,
	"push_sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_session_token_key" UNIQUE("session_token"),
	CONSTRAINT "auth_sessions_authorize_code_key" UNIQUE("authorize_code"),
	CONSTRAINT "auth_sessions_status_check" CHECK ("auth_sessions"."status" in ('pending', 'authorized', 'consumed', 'expired', 'cancelled')),
	CONSTRAINT "auth_sessions_purpose_check" CHECK ("auth_sessions"."purpose" in ('device_sign_in', 'oauth_authorization')),
	CONSTRAINT "auth_sessions_denied_reason_check" CHECK ("auth_sessions"."denied_reason" in ('declined', 'not_me')),
	CONSTRAINT "auth_sessions_oauth_code_challenge_method_check" CHECK ("auth_sessions"."oauth_code_challenge_method" in ('S256')),
	CONSTRAINT "auth_sessions_oauth_binding_check" CHECK (("auth_sessions"."oauth_redirect_uri" is null and "auth_sessions"."oauth_code_challenge" is null and "auth_sessions"."oauth_code_challenge_method" is null and "auth_sessions"."oauth_scopes" is null)
        or ("auth_sessions"."oauth_redirect_uri" is not null and "auth_sessions"."oauth_code_challenge" is not null and "auth_sessions"."oauth_code_challenge_method" is not null and "auth_sessions"."oauth_scopes" is not null)),
	CONSTRAINT "auth_sessions_oauth_purpose_check" CHECK (("auth_sessions"."purpose" = 'oauth_authorization') = ("auth_sessions"."oauth_redirect_uri" is not null)),
	CONSTRAINT "auth_sessions_oauth_subject_requires_binding_check" CHECK ("auth_sessions"."oauth_subject_account_id" is null or "auth_sessions"."oauth_redirect_uri" is not null),
	CONSTRAINT "auth_sessions_requester_label_length_check" CHECK ("auth_sessions"."requester_label" is null or char_length("auth_sessions"."requester_label") <= 64)
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"plan_name" text NOT NULL,
	"plan_credits_per_month" bigint NOT NULL,
	"plan_price_minor_units" bigint NOT NULL,
	"plan_currency" text DEFAULT 'usd' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_stripe_subscription_id_key" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "billing_subscriptions_status_check" CHECK ("billing_subscriptions"."status" in ('active', 'canceled', 'past_due', 'unpaid', 'trialing'))
);
--> statement-breakpoint
CREATE TABLE "billing_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_payment_intent_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_period_start" timestamp with time zone,
	"type" text NOT NULL,
	"amount_minor_units" bigint NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"credits" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_transactions_type_check" CHECK ("billing_transactions"."type" in ('credit_purchase', 'subscription_payment', 'refund')),
	CONSTRAINT "billing_transactions_status_check" CHECK ("billing_transactions"."status" in ('pending', 'completed', 'failed', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "civic_nonces" (
	"id" text PRIMARY KEY NOT NULL,
	"nonce_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"subject_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "civic_nonces_nonce_hash_key" UNIQUE("nonce_hash")
);
--> statement-breakpoint
CREATE TABLE "conduct_strikes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"decision_revision" integer NOT NULL,
	"application_id" text,
	"effect_type" text NOT NULL,
	"severity" text NOT NULL,
	"risk_points" double precision NOT NULL,
	"family" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"policy_version" text NOT NULL,
	"transaction_id" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conduct_strikes_incident_id_user_id_effect_type_revision_key" UNIQUE("incident_id","user_id","effect_type","decision_revision"),
	CONSTRAINT "conduct_strikes_effect_type_check" CHECK ("conduct_strikes"."effect_type" in ('conduct_penalty', 'report_abuse_penalty', 'review_abuse_penalty')),
	CONSTRAINT "conduct_strikes_severity_check" CHECK ("conduct_strikes"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "conduct_strikes_status_check" CHECK ("conduct_strikes"."status" in ('active', 'expired', 'reversed')),
	CONSTRAINT "conduct_strikes_decision_revision_check" CHECK ("conduct_strikes"."decision_revision" >= 0),
	CONSTRAINT "conduct_strikes_resolution_complete_check" CHECK (("conduct_strikes"."status" = 'active') = ("conduct_strikes"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "device_pairing_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"pairing_id" text NOT NULL,
	"new_device_ephemeral_public_key" text NOT NULL,
	"new_device_label" text,
	"old_device_ephemeral_public_key" text,
	"ciphertext" text,
	"nonce" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairing_sessions_pairing_id_key" UNIQUE("pairing_id"),
	CONSTRAINT "device_pairing_sessions_status_check" CHECK ("device_pairing_sessions"."status" in ('pending', 'approved', 'denied', 'expired')),
	CONSTRAINT "device_pairing_sessions_sealed_payload_check" CHECK (("device_pairing_sessions"."old_device_ephemeral_public_key" is null and "device_pairing_sessions"."ciphertext" is null and "device_pairing_sessions"."nonce" is null)
        or ("device_pairing_sessions"."old_device_ephemeral_public_key" is not null and "device_pairing_sessions"."ciphertext" is not null and "device_pairing_sessions"."nonce" is not null))
);
--> statement-breakpoint
CREATE TABLE "device_session_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"device_session_id" text NOT NULL,
	"account_id" text NOT NULL,
	"session_id" text NOT NULL,
	"authuser" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operated_by_user_id" text,
	CONSTRAINT "device_session_accounts_device_session_id_account_id_key" UNIQUE("device_session_id","account_id"),
	CONSTRAINT "device_session_accounts_authuser_check" CHECK ("device_session_accounts"."authuser" >= 0)
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"active_account_id" text,
	"secret_hash" text,
	"prev_secret_hash" text,
	"prev_secret_expires_at" timestamp with time zone,
	"background_secret_hash" text,
	"background_secret_account_id" text,
	"background_secret_expires_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_sessions_device_id_key" UNIQUE("device_id"),
	CONSTRAINT "device_sessions_secret_hash_key" UNIQUE("secret_hash")
);
--> statement-breakpoint
CREATE TABLE "domain_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"lookup_id_hash" text NOT NULL,
	"public_key_hint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"algorithm" text NOT NULL,
	"kdf_info" text NOT NULL,
	"version" integer NOT NULL,
	"client_created_at" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_backups_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "identity_backups_lookup_id_hash_key" UNIQUE("lookup_id_hash")
);
--> statement-breakpoint
CREATE TABLE "identity_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"local_principal_id" text NOT NULL,
	"binding_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credential_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_bindings_binding_type_check" CHECK ("identity_bindings"."binding_type" in ('oauth_grant', 'session_proof', 'commons_signature', 'federated_actor')),
	CONSTRAINT "identity_bindings_status_check" CHECK ("identity_bindings"."status" in ('active', 'revoked')),
	CONSTRAINT "identity_bindings_revoked_at_check" CHECK (("identity_bindings"."status" = 'revoked') = ("identity_bindings"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "moderation_effects" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"case_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"decision_revision" integer NOT NULL,
	"principal_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"application_id" text NOT NULL,
	"credential_id" text,
	"effect_type" text NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"points" double precision NOT NULL,
	"active_risk" double precision NOT NULL,
	"severity" text NOT NULL,
	"family" text NOT NULL,
	"repetition_multiplier" double precision NOT NULL,
	"multi_finding_multiplier" double precision NOT NULL,
	"idempotency_key" text NOT NULL,
	"transaction_id" text NOT NULL,
	"strike_id" text,
	"reversal_transaction_id" text,
	"policy_version_universal" text NOT NULL,
	"policy_version_application" text NOT NULL,
	"policy_version_oxy_conduct" text NOT NULL,
	"proof_hash" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_effects_incident_principal_type_revision_key" UNIQUE("incident_id","principal_id","effect_type","decision_revision"),
	CONSTRAINT "moderation_effects_event_id_key" UNIQUE("event_id"),
	CONSTRAINT "moderation_effects_effect_type_check" CHECK ("moderation_effects"."effect_type" in ('conduct_penalty', 'report_abuse_penalty', 'review_abuse_penalty')),
	CONSTRAINT "moderation_effects_status_check" CHECK ("moderation_effects"."status" in ('applied', 'reversed')),
	CONSTRAINT "moderation_effects_severity_check" CHECK ("moderation_effects"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "moderation_effects_decision_revision_check" CHECK ("moderation_effects"."decision_revision" >= 0),
	CONSTRAINT "moderation_effects_reversal_complete_check" CHECK (("moderation_effects"."status" = 'reversed') = ("moderation_effects"."reversed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "moderation_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"conduct_families" text[] NOT NULL,
	"repetition_multipliers" double precision[] NOT NULL,
	"repetition_window_days" integer NOT NULL,
	"multi_finding_secondary_share" double precision NOT NULL,
	"multi_finding_cap" double precision NOT NULL,
	"provisional_effects_allowed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_policies_policy_version_key" UNIQUE("policy_version"),
	CONSTRAINT "moderation_policies_status_check" CHECK ("moderation_policies"."status" in ('active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "moderation_policy_severity_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"severity" text NOT NULL,
	"points" double precision NOT NULL,
	"risk_points" double precision NOT NULL,
	"risk_expiry_days" integer,
	CONSTRAINT "moderation_policy_severity_rules_policy_id_severity_key" UNIQUE("policy_id","severity"),
	CONSTRAINT "moderation_policy_severity_rules_severity_check" CHECK ("moderation_policy_severity_rules"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "moderation_policy_severity_rules_risk_expiry_days_check" CHECK ("moderation_policy_severity_rules"."risk_expiry_days" is null or "moderation_policy_severity_rules"."risk_expiry_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "moderation_policy_standing_thresholds" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"standing" text NOT NULL,
	"min_risk" double precision NOT NULL,
	CONSTRAINT "moderation_policy_standing_thresholds_policy_id_standing_key" UNIQUE("policy_id","standing"),
	CONSTRAINT "moderation_policy_standing_thresholds_standing_check" CHECK ("moderation_policy_standing_thresholds"."standing" in ('good', 'watch', 'limited', 'restricted')),
	CONSTRAINT "moderation_policy_standing_thresholds_min_risk_check" CHECK ("moderation_policy_standing_thresholds"."min_risk" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_recipient_id_actor_id_type_entity_id_key" UNIQUE("recipient_id","actor_id","type","entity_id"),
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('like', 'reply', 'mention', 'follow', 'repost', 'quote', 'welcome')),
	CONSTRAINT "notifications_entity_type_check" CHECK ("notifications"."entity_type" in ('post', 'reply', 'profile'))
);
--> statement-breakpoint
CREATE TABLE "reporter_reputation_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"confirmed" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"duplicate" integer DEFAULT 0 NOT NULL,
	"malicious" integer DEFAULT 0 NOT NULL,
	"confirmed_by_family" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rejected_by_family" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reliability" double precision DEFAULT 0.5 NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"last_outcome_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reporter_reputation_profiles_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "reporter_reputation_profiles_confirmed_by_family_object_check" CHECK (jsonb_typeof("reporter_reputation_profiles"."confirmed_by_family") = 'object'),
	CONSTRAINT "reporter_reputation_profiles_rejected_by_family_object_check" CHECK (jsonb_typeof("reporter_reputation_profiles"."rejected_by_family") = 'object'),
	CONSTRAINT "reporter_reputation_profiles_counts_check" CHECK ("reporter_reputation_profiles"."confirmed" >= 0 and "reporter_reputation_profiles"."rejected" >= 0 and "reporter_reputation_profiles"."duplicate" >= 0 and "reporter_reputation_profiles"."malicious" >= 0),
	CONSTRAINT "reporter_reputation_profiles_reliability_check" CHECK ("reporter_reputation_profiles"."reliability" >= 0 and "reporter_reputation_profiles"."reliability" <= 1),
	CONSTRAINT "reporter_reputation_profiles_confidence_check" CHECK ("reporter_reputation_profiles"."confidence" >= 0 and "reporter_reputation_profiles"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "restrictions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"restricted_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restrictions_user_id_restricted_id_key" UNIQUE("user_id","restricted_id")
);
--> statement-breakpoint
CREATE TABLE "reviewer_reputation_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"agreements" integer DEFAULT 0 NOT NULL,
	"disagreements" integer DEFAULT 0 NOT NULL,
	"gold_passed" integer DEFAULT 0 NOT NULL,
	"gold_failed" integer DEFAULT 0 NOT NULL,
	"overturned" integer DEFAULT 0 NOT NULL,
	"global_reliability" double precision DEFAULT 0.5 NOT NULL,
	"category_reliability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language_reliability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unlocked_categories" text[] DEFAULT '{}' NOT NULL,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"seed_weight" double precision DEFAULT 0 NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewer_reputation_profiles_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "reviewer_reputation_profiles_status_check" CHECK ("reviewer_reputation_profiles"."status" in ('active', 'probation', 'suspended')),
	CONSTRAINT "reviewer_reputation_profiles_category_reliability_object_check" CHECK (jsonb_typeof("reviewer_reputation_profiles"."category_reliability") = 'object'),
	CONSTRAINT "reviewer_reputation_profiles_language_reliability_object_check" CHECK (jsonb_typeof("reviewer_reputation_profiles"."language_reliability") = 'object'),
	CONSTRAINT "reviewer_reputation_profiles_counts_check" CHECK ("reviewer_reputation_profiles"."agreements" >= 0 and "reviewer_reputation_profiles"."disagreements" >= 0 and "reviewer_reputation_profiles"."gold_passed" >= 0 and "reviewer_reputation_profiles"."gold_failed" >= 0 and "reviewer_reputation_profiles"."overturned" >= 0),
	CONSTRAINT "reviewer_reputation_profiles_global_reliability_check" CHECK ("reviewer_reputation_profiles"."global_reliability" >= 0 and "reviewer_reputation_profiles"."global_reliability" <= 1)
);
--> statement-breakpoint
CREATE TABLE "security_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"user_agent" text,
	"device_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"severity" text DEFAULT 'low' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_activities_event_type_check" CHECK ("security_activities"."event_type" in ('sign_in', 'sign_out', 'email_changed', 'profile_updated', 'device_added', 'device_removed', 'account_recovery', 'security_settings_changed', 'private_key_exported', 'backup_created', 'suspicious_activity')),
	CONSTRAINT "security_activities_severity_check" CHECK ("security_activities"."severity" in ('low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"device_name" text,
	"device_type" text NOT NULL,
	"platform" text NOT NULL,
	"browser" text,
	"os" text,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"device_fingerprint" text,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"previous_refresh_token" text,
	"token_rotated_at" timestamp with time zone,
	"operated_by_user_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_refresh" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_session_id_key" UNIQUE("session_id"),
	CONSTRAINT "sessions_access_token_key" UNIQUE("access_token"),
	CONSTRAINT "sessions_refresh_token_key" UNIQUE("refresh_token")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plan" text DEFAULT 'basic' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"start_date" timestamp with time zone DEFAULT now() NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"payment_method" text,
	"latest_invoice" text,
	"feature_analytics" boolean DEFAULT false NOT NULL,
	"feature_premium_badge" boolean DEFAULT false NOT NULL,
	"feature_unlimited_following" boolean DEFAULT false NOT NULL,
	"feature_higher_upload_limits" boolean DEFAULT false NOT NULL,
	"feature_promoted_posts" boolean DEFAULT false NOT NULL,
	"feature_business_tools" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_plan_check" CHECK ("subscriptions"."plan" in ('basic', 'pro', 'business')),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('active', 'canceled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"parent_topic_id" text,
	"icon" text,
	"image" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"translations" jsonb,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(name, '')), 'A') || setweight(to_tsvector('english', coalesce(display_name, '')), 'B') || setweight(to_tsvector('english', replace(array_to_tsvector(coalesce(aliases, '{}'::text[]))::text, '''', ' ')), 'C') || setweight(to_tsvector('english', coalesce(description, '')), 'D')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_name_key" UNIQUE("name"),
	CONSTRAINT "topics_slug_key" UNIQUE("slug"),
	CONSTRAINT "topics_type_check" CHECK ("topics"."type" in ('category', 'topic', 'entity')),
	CONSTRAINT "topics_source_check" CHECK ("topics"."source" in ('seed', 'ai', 'manual', 'system')),
	CONSTRAINT "topics_translations_object_check" CHECK ("topics"."translations" is null or jsonb_typeof("topics"."translations") = 'object'),
	CONSTRAINT "topics_parent_topic_id_not_self_check" CHECK ("topics"."parent_topic_id" <> "topics"."id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(38, 8) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text,
	"recipient_id" text,
	"item_id" text,
	"item_type" text,
	"external_reference" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_type_check" CHECK ("transactions"."type" in ('deposit', 'withdrawal', 'transfer', 'purchase')),
	CONSTRAINT "transactions_status_check" CHECK ("transactions"."status" in ('pending', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "transactions_amount_check" CHECK ("transactions"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_analytics" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"post_views" integer DEFAULT 0 NOT NULL,
	"profile_views" integer DEFAULT 0 NOT NULL,
	"engagement_likes" integer DEFAULT 0 NOT NULL,
	"engagement_replies" integer DEFAULT 0 NOT NULL,
	"engagement_reposts" integer DEFAULT 0 NOT NULL,
	"engagement_quotes" integer DEFAULT 0 NOT NULL,
	"engagement_bookmarks" integer DEFAULT 0 NOT NULL,
	"reach_impressions" integer DEFAULT 0 NOT NULL,
	"reach_unique_viewers" integer DEFAULT 0 NOT NULL,
	"demographics_countries" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"demographics_languages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"peak_activity_hour" integer DEFAULT 0 NOT NULL,
	"peak_activity_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_analytics_user_id_period_date_key" UNIQUE("user_id","period","date"),
	CONSTRAINT "user_analytics_period_check" CHECK ("user_analytics"."period" in ('daily', 'weekly', 'monthly', 'yearly')),
	CONSTRAINT "user_analytics_peak_activity_hour_check" CHECK ("user_analytics"."peak_activity_hour" >= 0 and "user_analytics"."peak_activity_hour" < 24),
	CONSTRAINT "user_analytics_demographics_countries_object_check" CHECK (jsonb_typeof("user_analytics"."demographics_countries") = 'object'),
	CONSTRAINT "user_analytics_demographics_languages_object_check" CHECK (jsonb_typeof("user_analytics"."demographics_languages") = 'object')
);
--> statement-breakpoint
CREATE TABLE "user_app_data" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_app_data_user_id_namespace_key_key" UNIQUE("user_id","namespace","key"),
	CONSTRAINT "user_app_data_namespace_check" CHECK ("user_app_data"."namespace" ~ '^[a-z0-9_-]{1,64}$'),
	CONSTRAINT "user_app_data_key_check" CHECK ("user_app_data"."key" ~ '^[a-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "user_credits" (
	"user_id" text PRIMARY KEY NOT NULL,
	"credits_free" bigint DEFAULT 1000 NOT NULL,
	"credits_free_limit" bigint DEFAULT 1000 NOT NULL,
	"credits_daily_refresh" bigint DEFAULT 300 NOT NULL,
	"credits_last_refresh" timestamp with time zone DEFAULT now() NOT NULL,
	"credits_paid" bigint DEFAULT 0 NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_credits_credits_free_check" CHECK ("user_credits"."credits_free" >= 0),
	CONSTRAINT "user_credits_credits_paid_check" CHECK ("user_credits"."credits_paid" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_follows" (
	"id" text PRIMARY KEY NOT NULL,
	"follower_id" text NOT NULL,
	"followed_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_follows_follower_id_followed_id_key" UNIQUE("follower_id","followed_id"),
	CONSTRAINT "user_follows_not_self_check" CHECK ("user_follows"."follower_id" <> "user_follows"."followed_id")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"balance" numeric(38, 8) DEFAULT '0' NOT NULL,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "wallets_balance_check" CHECK ("wallets"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"type" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webauthn_challenges_challenge_key" UNIQUE("challenge"),
	CONSTRAINT "webauthn_challenges_type_check" CHECK ("webauthn_challenges"."type" in ('registration', 'authentication'))
);
--> statement-breakpoint
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_operated_by_user_id_users_id_fk" FOREIGN KEY ("operated_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_oauth_subject_account_id_users_id_fk" FOREIGN KEY ("oauth_subject_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_authorized_user_id_users_id_fk" FOREIGN KEY ("authorized_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "civic_nonces" ADD CONSTRAINT "civic_nonces_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conduct_strikes" ADD CONSTRAINT "conduct_strikes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conduct_strikes" ADD CONSTRAINT "conduct_strikes_policy_version_fk" FOREIGN KEY ("policy_version") REFERENCES "public"."moderation_policies"("policy_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairing_sessions" ADD CONSTRAINT "device_pairing_sessions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_session_accounts" ADD CONSTRAINT "device_session_accounts_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_session_accounts" ADD CONSTRAINT "device_session_accounts_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_session_accounts" ADD CONSTRAINT "device_session_accounts_operated_by_user_id_users_id_fk" FOREIGN KEY ("operated_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_active_account_id_users_id_fk" FOREIGN KEY ("active_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_background_secret_account_id_users_id_fk" FOREIGN KEY ("background_secret_account_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_verifications" ADD CONSTRAINT "domain_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_backups" ADD CONSTRAINT "identity_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_bindings" ADD CONSTRAINT "identity_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_effects" ADD CONSTRAINT "moderation_effects_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_effects" ADD CONSTRAINT "moderation_effects_binding_id_identity_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."identity_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_effects" ADD CONSTRAINT "moderation_effects_strike_id_conduct_strikes_id_fk" FOREIGN KEY ("strike_id") REFERENCES "public"."conduct_strikes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_effects" ADD CONSTRAINT "moderation_effects_policy_version_oxy_conduct_fk" FOREIGN KEY ("policy_version_oxy_conduct") REFERENCES "public"."moderation_policies"("policy_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_policy_severity_rules" ADD CONSTRAINT "moderation_policy_severity_rules_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."moderation_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_policy_standing_thresholds" ADD CONSTRAINT "moderation_policy_standing_thresholds_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."moderation_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reporter_reputation_profiles" ADD CONSTRAINT "reporter_reputation_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restrictions" ADD CONSTRAINT "restrictions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restrictions" ADD CONSTRAINT "restrictions_restricted_id_users_id_fk" FOREIGN KEY ("restricted_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_reputation_profiles" ADD CONSTRAINT "reviewer_reputation_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_activities" ADD CONSTRAINT "security_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_operated_by_user_id_users_id_fk" FOREIGN KEY ("operated_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_topic_id_topics_id_fk" FOREIGN KEY ("parent_topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_analytics" ADD CONSTRAINT "user_analytics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_app_data" ADD CONSTRAINT "user_app_data_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credits" ADD CONSTRAINT "user_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_followed_id_users_id_fk" FOREIGN KEY ("followed_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_codes_user_id_idx" ON "auth_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_codes_application_id_idx" ON "auth_codes" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "auth_codes_expires_at_idx" ON "auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_application_id_idx" ON "auth_sessions" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_user_id_status_idx" ON "billing_subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_transactions_subscription_period_key" ON "billing_transactions" USING btree ("stripe_subscription_id","stripe_subscription_period_start","type") WHERE "billing_transactions"."type" = 'subscription_payment' and "billing_transactions"."stripe_subscription_id" is not null and "billing_transactions"."stripe_subscription_period_start" is not null;--> statement-breakpoint
CREATE INDEX "billing_transactions_user_id_created_at_idx" ON "billing_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "civic_nonces_expires_at_idx" ON "civic_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "conduct_strikes_user_id_status_idx" ON "conduct_strikes" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "conduct_strikes_user_id_family_created_at_idx" ON "conduct_strikes" USING btree ("user_id","family","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conduct_strikes_decision_id_decision_revision_idx" ON "conduct_strikes" USING btree ("decision_id","decision_revision");--> statement-breakpoint
CREATE INDEX "conduct_strikes_expires_at_idx" ON "conduct_strikes" USING btree ("expires_at") WHERE "conduct_strikes"."status" = 'active' and "conduct_strikes"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "device_pairing_sessions_expires_at_idx" ON "device_pairing_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "device_session_accounts_account_id_idx" ON "device_session_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "device_session_accounts_operated_by_user_id_idx" ON "device_session_accounts" USING btree ("operated_by_user_id") WHERE "device_session_accounts"."operated_by_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_verifications_user_id_lower_domain_key" ON "domain_verifications" USING btree ("user_id",lower("domain"));--> statement-breakpoint
CREATE INDEX "domain_verifications_expires_at_idx" ON "domain_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_bindings_application_id_local_principal_id_active_key" ON "identity_bindings" USING btree ("application_id","local_principal_id") WHERE "identity_bindings"."status" = 'active';--> statement-breakpoint
CREATE INDEX "identity_bindings_application_id_user_id_status_idx" ON "identity_bindings" USING btree ("application_id","user_id","status");--> statement-breakpoint
CREATE INDEX "identity_bindings_user_id_idx" ON "identity_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "moderation_effects_decision_id_decision_revision_idx" ON "moderation_effects" USING btree ("decision_id","decision_revision");--> statement-breakpoint
CREATE INDEX "moderation_effects_incident_id_decision_revision_idx" ON "moderation_effects" USING btree ("incident_id","decision_revision");--> statement-breakpoint
CREATE INDEX "moderation_effects_principal_id_applied_at_idx" ON "moderation_effects" USING btree ("principal_id","applied_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "moderation_policies_status_idx" ON "moderation_policies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifications_recipient_id_created_at_idx" ON "notifications" USING btree ("recipient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviewer_reputation_profiles_status_idx" ON "reviewer_reputation_profiles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "security_activities_user_id_occurred_at_idx" ON "security_activities" USING btree ("user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_activities_user_id_event_type_occurred_at_idx" ON "security_activities" USING btree ("user_id","event_type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_activities_user_id_device_id_occurred_at_idx" ON "security_activities" USING btree ("user_id","device_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_activities_occurred_at_idx" ON "security_activities" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_device_id_idx" ON "sessions" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_is_active_expires_at_idx" ON "sessions" USING btree ("user_id","is_active","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_device_id_is_active_expires_at_idx" ON "sessions" USING btree ("device_id","is_active","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_previous_refresh_token_rotated_at_idx" ON "sessions" USING btree ("previous_refresh_token","token_rotated_at") WHERE "sessions"."previous_refresh_token" is not null;--> statement-breakpoint
CREATE INDEX "sessions_device_fingerprint_is_active_expires_at_idx" ON "sessions" USING btree ("device_fingerprint","is_active","expires_at") WHERE "sessions"."device_fingerprint" is not null;--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "subscriptions_active_end_date_idx" ON "subscriptions" USING btree ("end_date") WHERE "subscriptions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "topics_is_active_type_idx" ON "topics" USING btree ("is_active","type");--> statement-breakpoint
CREATE INDEX "topics_parent_topic_id_idx" ON "topics" USING btree ("parent_topic_id") WHERE "topics"."parent_topic_id" is not null;--> statement-breakpoint
CREATE INDEX "topics_search_vector_idx" ON "topics" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_recipient_id_created_at_idx" ON "transactions" USING btree ("recipient_id","created_at") WHERE "transactions"."recipient_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_credits_stripe_customer_id_key" ON "user_credits" USING btree ("stripe_customer_id") WHERE "user_credits"."stripe_customer_id" is not null;--> statement-breakpoint
CREATE INDEX "user_follows_followed_id_created_at_id_idx" ON "user_follows" USING btree ("followed_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "user_follows_created_at_id_idx" ON "user_follows" USING btree ("created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "webauthn_challenges" USING btree ("expires_at");