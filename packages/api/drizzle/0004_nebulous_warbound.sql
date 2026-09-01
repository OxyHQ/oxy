-- oxy:deploy-phase=pre
-- Additive; safe while the previous image serves. See src/db/migrationPhases.ts.

CREATE TABLE "bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text DEFAULT 'folder-outline' NOT NULL,
	"color" text DEFAULT '#5F6368' NOT NULL,
	"match_labels" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"collapsed" boolean DEFAULT true NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text,
	"notes" text,
	"starred" boolean DEFAULT false NOT NULL,
	"auto_collected" boolean DEFAULT false NOT NULL,
	"last_contacted_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(email, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_filter_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"filter_id" text NOT NULL,
	"ord" integer NOT NULL,
	"type" text NOT NULL,
	"value" text,
	CONSTRAINT "email_filter_actions_filter_id_ord_key" UNIQUE("filter_id","ord"),
	CONSTRAINT "email_filter_actions_type_check" CHECK ("email_filter_actions"."type" in ('move', 'label', 'star', 'mark-read', 'archive', 'delete', 'forward')),
	CONSTRAINT "email_filter_actions_ord_check" CHECK ("email_filter_actions"."ord" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_filter_conditions" (
	"id" text PRIMARY KEY NOT NULL,
	"filter_id" text NOT NULL,
	"ord" integer NOT NULL,
	"field" text NOT NULL,
	"operator" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "email_filter_conditions_filter_id_ord_key" UNIQUE("filter_id","ord"),
	CONSTRAINT "email_filter_conditions_field_check" CHECK ("email_filter_conditions"."field" in ('from', 'to', 'subject', 'has-attachment', 'size')),
	CONSTRAINT "email_filter_conditions_operator_check" CHECK ("email_filter_conditions"."operator" in ('contains', 'equals', 'not-contains', 'starts-with', 'ends-with', 'greater-than', 'less-than')),
	CONSTRAINT "email_filter_conditions_ord_check" CHECK ("email_filter_conditions"."ord" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_filters" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match_all" boolean DEFAULT true NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_links" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"app" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_by" text NOT NULL,
	"webhook_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_links_file_id_app_entity_key" UNIQUE("file_id","app","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "file_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"width" integer,
	"height" integer,
	"ready_at" timestamp with time zone,
	"size" bigint,
	"metadata" jsonb,
	CONSTRAINT "file_variants_size_check" CHECK ("file_variants"."size" is null or "file_variants"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"mime" text NOT NULL,
	"ext" text NOT NULL,
	"owner_user_id" text,
	"system_owner" text,
	"status" text DEFAULT 'active' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"purpose" text DEFAULT 'user' NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_status_check" CHECK ("files"."status" in ('active', 'trash', 'deleted')),
	CONSTRAINT "files_visibility_check" CHECK ("files"."visibility" in ('private', 'public', 'unlisted')),
	CONSTRAINT "files_purpose_check" CHECK ("files"."purpose" in ('user', 'federation-media-cache', 'link-preview')),
	CONSTRAINT "files_system_owner_check" CHECK ("files"."system_owner" is null or "files"."system_owner" in ('__federation__', '__federation_media_cache__', '__link_preview_cache__')),
	CONSTRAINT "files_owner_exclusive_check" CHECK (("files"."owner_user_id" is null) <> ("files"."system_owner" is null)),
	CONSTRAINT "files_size_check" CHECK ("files"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"special_use" text,
	"retention_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"ord" integer NOT NULL,
	"file_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"content_id" text,
	"is_inline" boolean DEFAULT false NOT NULL,
	CONSTRAINT "message_attachments_message_id_ord_key" UNIQUE("message_id","ord"),
	CONSTRAINT "message_attachments_size_check" CHECK ("message_attachments"."size" >= 0),
	CONSTRAINT "message_attachments_ord_check" CHECK ("message_attachments"."ord" >= 0)
);
--> statement-breakpoint
CREATE TABLE "message_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"kind" text NOT NULL,
	"ord" integer NOT NULL,
	"name" text,
	"address" text NOT NULL,
	CONSTRAINT "message_recipients_message_id_kind_ord_key" UNIQUE("message_id","kind","ord"),
	CONSTRAINT "message_recipients_kind_check" CHECK ("message_recipients"."kind" in ('to', 'cc', 'bcc')),
	CONSTRAINT "message_recipients_ord_check" CHECK ("message_recipients"."ord" >= 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"message_id" text NOT NULL,
	"from_name" text,
	"from_address" text NOT NULL,
	"reply_to_name" text,
	"reply_to_address" text,
	"subject" text NOT NULL,
	"text" text,
	"html" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_body" text,
	"seen" boolean DEFAULT false NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"forwarded" boolean DEFAULT false NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"card_type" text,
	"card_data" jsonb,
	"card_confidence" double precision,
	"card_extracted_at" timestamp with time zone,
	"highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"spam_score" double precision,
	"spam_action" text,
	"size" bigint NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"alias_tag" text,
	"snoozed_until" timestamp with time zone,
	"snoozed_from_mailbox" text,
	"scheduled_at" timestamp with time zone,
	"read_receipt_requested" boolean DEFAULT false NOT NULL,
	"read_receipt_sent" boolean DEFAULT false NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(subject, '')), 'A') || setweight(to_tsvector('english', coalesce("text", '')), 'D')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_card_type_check" CHECK ("messages"."card_type" is null or "messages"."card_type" in ('trip', 'purchase', 'event', 'bill', 'package')),
	CONSTRAINT "messages_card_complete_check" CHECK ("messages"."card_type" is not null or ("messages"."card_data" is null and "messages"."card_confidence" is null and "messages"."card_extracted_at" is null)),
	CONSTRAINT "messages_size_check" CHECK ("messages"."size" >= 0),
	CONSTRAINT "messages_reply_to_complete_check" CHECK ("messages"."reply_to_address" is not null or "messages"."reply_to_name" is null)
);
--> statement-breakpoint
CREATE TABLE "node_ingest_witnesses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"record_id" text NOT NULL,
	"witness_signature" text NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_ingest_witnesses_recordId_unique" UNIQUE("record_id")
);
--> statement-breakpoint
CREATE TABLE "personhood_statuses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"is_real_person" boolean DEFAULT false NOT NULL,
	"vouch_count" integer DEFAULT 0 NOT NULL,
	"real_life_count" integer DEFAULT 0 NOT NULL,
	"biometric_bound" boolean DEFAULT false NOT NULL,
	"sybil_penalty" double precision DEFAULT 0 NOT NULL,
	"breakdown_vouch_signal" double precision DEFAULT 0 NOT NULL,
	"breakdown_real_life_signal" double precision DEFAULT 0 NOT NULL,
	"breakdown_biometric_signal" double precision DEFAULT 0 NOT NULL,
	"breakdown_evidence" double precision DEFAULT 0 NOT NULL,
	"breakdown_sybil_penalty" double precision DEFAULT 0 NOT NULL,
	"breakdown_seed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personhood_statuses_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "personhood_statuses_counts_check" CHECK ("personhood_statuses"."vouch_count" >= 0 and "personhood_statuses"."real_life_count" >= 0),
	CONSTRAINT "personhood_statuses_signals_check" CHECK ("personhood_statuses"."score" between 0 and 1 and "personhood_statuses"."sybil_penalty" between 0 and 1 and "personhood_statuses"."breakdown_vouch_signal" between 0 and 1 and "personhood_statuses"."breakdown_real_life_signal" between 0 and 1 and "personhood_statuses"."breakdown_biometric_signal" between 0 and 1 and "personhood_statuses"."breakdown_evidence" between 0 and 1 and "personhood_statuses"."breakdown_sybil_penalty" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "personhood_vouches" (
	"id" text PRIMARY KEY NOT NULL,
	"voucher_user_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"stake_amount" integer NOT NULL,
	"record_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personhood_vouches_status_check" CHECK ("personhood_vouches"."status" in ('active', 'slashed', 'withdrawn')),
	CONSTRAINT "personhood_vouches_stake_check" CHECK ("personhood_vouches"."stake_amount" >= 0),
	CONSTRAINT "personhood_vouches_not_self_check" CHECK ("personhood_vouches"."voucher_user_id" <> "personhood_vouches"."subject_user_id")
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"snoozed_until" timestamp with time zone,
	"related_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_heads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"subject_did" text NOT NULL,
	"seq" integer NOT NULL,
	"head_record_id" text NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_heads_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "repo_heads_seq_check" CHECK ("repo_heads"."seq" >= 0),
	CONSTRAINT "repo_heads_record_count_check" CHECK ("repo_heads"."record_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reputation_balances" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"positive" integer DEFAULT 0 NOT NULL,
	"negative" integer DEFAULT 0 NOT NULL,
	"breakdown_content" integer DEFAULT 0 NOT NULL,
	"breakdown_social" integer DEFAULT 0 NOT NULL,
	"breakdown_trust" integer DEFAULT 0 NOT NULL,
	"breakdown_moderation" integer DEFAULT 0 NOT NULL,
	"breakdown_physical" integer DEFAULT 0 NOT NULL,
	"breakdown_penalties" integer DEFAULT 0 NOT NULL,
	"trust_tier" text DEFAULT 'new' NOT NULL,
	"influence_default_weight" double precision DEFAULT 0 NOT NULL,
	"influence_report_weight" double precision DEFAULT 0 NOT NULL,
	"influence_moderation_weight" double precision DEFAULT 0 NOT NULL,
	"influence_ranking_feedback_weight" double precision DEFAULT 0 NOT NULL,
	"reliability_accurate_reports" integer DEFAULT 0 NOT NULL,
	"reliability_rejected_reports" integer DEFAULT 0 NOT NULL,
	"reliability_report_accuracy_score" double precision DEFAULT 0 NOT NULL,
	"reliability_abuse_score" double precision DEFAULT 0 NOT NULL,
	"personhood_status" text DEFAULT 'unknown' NOT NULL,
	"personhood_score" double precision DEFAULT 0 NOT NULL,
	"contribution_points" integer DEFAULT 0 NOT NULL,
	"contribution_tier" text DEFAULT 'new' NOT NULL,
	"conduct_standing" text DEFAULT 'good' NOT NULL,
	"conduct_active_risk" double precision DEFAULT 0 NOT NULL,
	"conduct_active_strikes" integer DEFAULT 0 NOT NULL,
	"conduct_next_expiry_at" timestamp with time zone,
	"reporting_reliability" double precision DEFAULT 0.5 NOT NULL,
	"reporting_confidence" double precision DEFAULT 0 NOT NULL,
	"reporting_confirmed" integer DEFAULT 0 NOT NULL,
	"reporting_rejected" integer DEFAULT 0 NOT NULL,
	"reporting_malicious" integer DEFAULT 0 NOT NULL,
	"reviewing_global_reliability" double precision DEFAULT 0.5 NOT NULL,
	"contextual_report_priority_weight" double precision DEFAULT 0 NOT NULL,
	"contextual_review_selection_weight" double precision DEFAULT 0 NOT NULL,
	"contextual_ranking_weight" double precision DEFAULT 0 NOT NULL,
	"last_transaction_id" text,
	"recalculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reputation_balances_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "reputation_balances_trust_tier_check" CHECK ("reputation_balances"."trust_tier" in ('restricted', 'new', 'trusted', 'high_trust', 'verified')),
	CONSTRAINT "reputation_balances_personhood_status_check" CHECK ("reputation_balances"."personhood_status" in ('unknown', 'probable', 'verified')),
	CONSTRAINT "reputation_balances_contribution_tier_check" CHECK ("reputation_balances"."contribution_tier" in ('new', 'trusted', 'high_trust')),
	CONSTRAINT "reputation_balances_conduct_standing_check" CHECK ("reputation_balances"."conduct_standing" in ('good', 'watch', 'limited', 'restricted')),
	CONSTRAINT "reputation_balances_positive_check" CHECK ("reputation_balances"."positive" >= 0),
	CONSTRAINT "reputation_balances_negative_check" CHECK ("reputation_balances"."negative" <= 0),
	CONSTRAINT "reputation_balances_penalties_check" CHECK ("reputation_balances"."breakdown_penalties" >= 0),
	CONSTRAINT "reputation_balances_contribution_points_check" CHECK ("reputation_balances"."contribution_points" >= 0),
	CONSTRAINT "reputation_balances_reliability_counts_check" CHECK ("reputation_balances"."reliability_accurate_reports" >= 0 and "reputation_balances"."reliability_rejected_reports" >= 0),
	CONSTRAINT "reputation_balances_reporting_counts_check" CHECK ("reputation_balances"."reporting_confirmed" >= 0 and "reputation_balances"."reporting_rejected" >= 0 and "reputation_balances"."reporting_malicious" >= 0),
	CONSTRAINT "reputation_balances_conduct_check" CHECK ("reputation_balances"."conduct_active_risk" >= 0 and "reputation_balances"."conduct_active_strikes" >= 0),
	CONSTRAINT "reputation_balances_scores_check" CHECK ("reputation_balances"."reliability_report_accuracy_score" between 0 and 1 and "reputation_balances"."reliability_abuse_score" between 0 and 1 and "reputation_balances"."personhood_score" between 0 and 1 and "reputation_balances"."reporting_reliability" between 0 and 1 and "reputation_balances"."reporting_confidence" between 0 and 1 and "reputation_balances"."reviewing_global_reliability" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "reputation_reviewing_reliability" (
	"balance_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"reliability" double precision NOT NULL,
	CONSTRAINT "reputation_reviewing_reliability_pkey" PRIMARY KEY("balance_id","scope","key"),
	CONSTRAINT "reputation_reviewing_reliability_scope_check" CHECK ("reputation_reviewing_reliability"."scope" in ('category', 'language')),
	CONSTRAINT "reputation_reviewing_reliability_value_check" CHECK ("reputation_reviewing_reliability"."reliability" between 0 and 1),
	CONSTRAINT "reputation_reviewing_reliability_key_check" CHECK (length("reputation_reviewing_reliability"."key") > 0)
);
--> statement-breakpoint
CREATE TABLE "reputation_disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"evidence" text[],
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reputation_disputes_status_check" CHECK ("reputation_disputes"."status" in ('open', 'accepted', 'rejected', 'needs_review')),
	CONSTRAINT "reputation_disputes_resolution_check" CHECK (("reputation_disputes"."status" in ('open', 'needs_review') and "reputation_disputes"."resolved_at" is null) or ("reputation_disputes"."status" in ('accepted', 'rejected') and "reputation_disputes"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "reputation_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"action_type" text NOT NULL,
	"points" integer NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"cooldown_in_minutes" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reputation_rules_actionType_unique" UNIQUE("action_type"),
	CONSTRAINT "reputation_rules_category_check" CHECK ("reputation_rules"."category" in ('content', 'social', 'trust', 'moderation', 'physical', 'penalty', 'other')),
	CONSTRAINT "reputation_rules_cooldown_check" CHECK ("reputation_rules"."cooldown_in_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reputation_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"points" integer NOT NULL,
	"action_type" text NOT NULL,
	"category" text NOT NULL,
	"application_id" text,
	"credential_id" text,
	"source_action_id" text,
	"source_action_type" text,
	"target_entity_id" text,
	"target_entity_type" text,
	"status" text DEFAULT 'active' NOT NULL,
	"reversed_transaction_id" text,
	"reason" text,
	"metadata" jsonb,
	"created_by_user_id" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reputation_transactions_category_check" CHECK ("reputation_transactions"."category" in ('content', 'social', 'trust', 'moderation', 'physical', 'penalty', 'other')),
	CONSTRAINT "reputation_transactions_status_check" CHECK ("reputation_transactions"."status" in ('active', 'disputed', 'reversed', 'voided')),
	CONSTRAINT "reputation_transactions_target_entity_type_check" CHECK ("reputation_transactions"."target_entity_type" is null or "reputation_transactions"."target_entity_type" in ('post', 'comment', 'report', 'purchase', 'event', 'check_in', 'manual_review', 'user', 'other')),
	CONSTRAINT "reputation_transactions_reversal_not_self_check" CHECK ("reputation_transactions"."reversed_transaction_id" is null or "reputation_transactions"."reversed_transaction_id" <> "reputation_transactions"."id")
);
--> statement-breakpoint
CREATE TABLE "sender_avatars" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"avatar_path" text,
	"source" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sender_avatars_source_check" CHECK ("sender_avatars"."source" in ('oxy', 'bimi', 'gravatar', 'favicon', 'none'))
);
--> statement-breakpoint
CREATE TABLE "signed_records" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_did" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"public_key" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"seq" integer,
	"prev" text,
	"record_id" text,
	"nsid" text,
	"rkey" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signed_records_recordId_unique" UNIQUE("record_id"),
	CONSTRAINT "signed_records_type_check" CHECK ("signed_records"."type" in ('identity', 'profile', 'reputation_attestation', 'real_life_attestation', 'validation_verdict', 'personhood_vouch', 'credential', 'node')),
	CONSTRAINT "signed_records_seq_check" CHECK ("signed_records"."seq" is null or "signed_records"."seq" >= 0),
	CONSTRAINT "signed_records_chain_completeness_check" CHECK (("signed_records"."seq" is null and "signed_records"."record_id" is null and "signed_records"."nsid" is null and "signed_records"."rkey" is null) or ("signed_records"."seq" is not null and "signed_records"."record_id" is not null and "signed_records"."nsid" is not null and "signed_records"."rkey" is not null)),
	CONSTRAINT "signed_records_prev_not_self_check" CHECK ("signed_records"."prev" is null or "signed_records"."prev" <> "signed_records"."record_id")
);
--> statement-breakpoint
CREATE TABLE "transparency_checkpoint_anchors" (
	"id" text PRIMARY KEY NOT NULL,
	"checkpoint_id" text NOT NULL,
	"network" text NOT NULL,
	"txid" text NOT NULL,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"anchored_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transparency_checkpoint_anchors_confirmations_check" CHECK ("transparency_checkpoint_anchors"."confirmations" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transparency_checkpoint_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"checkpoint_id" text NOT NULL,
	"position" integer NOT NULL,
	"public_key" text NOT NULL,
	"alg" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transparency_checkpoint_signatures_alg_check" CHECK ("transparency_checkpoint_signatures"."alg" in ('ES256K-DER-SHA256')),
	CONSTRAINT "transparency_checkpoint_signatures_position_check" CHECK ("transparency_checkpoint_signatures"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transparency_checkpoint_snapshot_entries" (
	"checkpoint_id" text NOT NULL,
	"leaf_index" integer NOT NULL,
	"subject_did" text NOT NULL,
	"seq" integer NOT NULL,
	"head_record_id" text NOT NULL,
	CONSTRAINT "transparency_checkpoint_snapshot_entries_pkey" PRIMARY KEY("checkpoint_id","leaf_index"),
	CONSTRAINT "transparency_checkpoint_snapshot_entries_leaf_index_check" CHECK ("transparency_checkpoint_snapshot_entries"."leaf_index" >= 0),
	CONSTRAINT "transparency_checkpoint_snapshot_entries_seq_check" CHECK ("transparency_checkpoint_snapshot_entries"."seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transparency_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"index" integer NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"tree_size" integer NOT NULL,
	"root" text NOT NULL,
	"prev_checkpoint_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transparency_checkpoints_index_unique" UNIQUE("index"),
	CONSTRAINT "transparency_checkpoints_index_check" CHECK ("transparency_checkpoints"."index" >= 0),
	CONSTRAINT "transparency_checkpoints_tree_size_check" CHECK ("transparency_checkpoints"."tree_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"node_did" text,
	"endpoint" text NOT NULL,
	"node_public_key" text NOT NULL,
	"mode" text DEFAULT 'pull' NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"controller" text DEFAULT 'self' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_probe_at" timestamp with time zone,
	"last_error" text,
	"cursor" integer,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_nodes_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "user_nodes_mode_check" CHECK ("user_nodes"."mode" in ('pull', 'push')),
	CONSTRAINT "user_nodes_controller_check" CHECK ("user_nodes"."controller" in ('self', 'oxy')),
	CONSTRAINT "user_nodes_status_check" CHECK ("user_nodes"."status" in ('active', 'unreachable', 'revoked')),
	CONSTRAINT "user_nodes_cursor_check" CHECK ("user_nodes"."cursor" is null or "user_nodes"."cursor" >= 0),
	CONSTRAINT "user_nodes_managed_controller_check" CHECK (("user_nodes"."managed" = true and "user_nodes"."controller" = 'oxy') or ("user_nodes"."managed" = false and "user_nodes"."controller" = 'self'))
);
--> statement-breakpoint
CREATE TABLE "validation_request_validators" (
	"request_id" text NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "validation_request_validators_pkey" PRIMARY KEY("request_id","user_id"),
	CONSTRAINT "validation_request_validators_position_check" CHECK ("validation_request_validators"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "validation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_user_id" text NOT NULL,
	"action_type" text NOT NULL,
	"application_id" text,
	"source_action_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"quorum" integer NOT NULL,
	"threshold" integer NOT NULL,
	"high_value" boolean DEFAULT false NOT NULL,
	"rng_seed" text NOT NULL,
	"candidate_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"resolved_txn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_requests_status_check" CHECK ("validation_requests"."status" in ('pending', 'quorum_met', 'validated', 'rejected', 'expired')),
	CONSTRAINT "validation_requests_outcome_check" CHECK ("validation_requests"."outcome" is null or "validation_requests"."outcome" in ('validated', 'rejected')),
	CONSTRAINT "validation_requests_quorum_check" CHECK ("validation_requests"."quorum" > 0),
	CONSTRAINT "validation_requests_threshold_check" CHECK ("validation_requests"."threshold" >= "validation_requests"."quorum"),
	CONSTRAINT "validation_requests_terminal_check" CHECK (("validation_requests"."status" in ('validated', 'rejected') and "validation_requests"."outcome" is not null and "validation_requests"."status" = "validation_requests"."outcome") or ("validation_requests"."status" in ('pending', 'quorum_met', 'expired') and "validation_requests"."outcome" is null))
);
--> statement-breakpoint
CREATE TABLE "validation_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"validator_user_id" text NOT NULL,
	"verdict" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"public_key" text NOT NULL,
	"record_id" text NOT NULL,
	"stake_weight" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_votes_verdict_check" CHECK ("validation_votes"."verdict" in ('valid', 'invalid', 'abstain')),
	CONSTRAINT "validation_votes_stake_weight_check" CHECK ("validation_votes"."stake_weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "validator_affinities" (
	"id" text PRIMARY KEY NOT NULL,
	"validator_a" text NOT NULL,
	"validator_b" text NOT NULL,
	"co_vote_count" integer DEFAULT 0 NOT NULL,
	"last_co_vote_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validator_affinities_co_vote_count_check" CHECK ("validator_affinities"."co_vote_count" >= 0),
	CONSTRAINT "validator_affinities_canonical_pair_check" CHECK ("validator_affinities"."validator_a" < "validator_affinities"."validator_b")
);
--> statement-breakpoint
CREATE TABLE "verifiable_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"holder_user_id" text NOT NULL,
	"holder_did" text NOT NULL,
	"issuer_user_id" text,
	"issuer_did" text NOT NULL,
	"types" text[] NOT NULL,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"record_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verifiable_credentials_recordId_unique" UNIQUE("record_id"),
	CONSTRAINT "verifiable_credentials_status_check" CHECK ("verifiable_credentials"."status" in ('active', 'revoked', 'expired')),
	CONSTRAINT "verifiable_credentials_revocation_check" CHECK (("verifiable_credentials"."status" = 'revoked' and "verifiable_credentials"."revoked_at" is not null) or ("verifiable_credentials"."status" <> 'revoked' and "verifiable_credentials"."revoked_at" is null)),
	CONSTRAINT "verifiable_credentials_expiry_check" CHECK ("verifiable_credentials"."expires_at" is null or "verifiable_credentials"."expires_at" > "verifiable_credentials"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_filter_actions" ADD CONSTRAINT "email_filter_actions_filter_id_email_filters_id_fk" FOREIGN KEY ("filter_id") REFERENCES "public"."email_filters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_filter_conditions" ADD CONSTRAINT "email_filter_conditions_filter_id_email_filters_id_fk" FOREIGN KEY ("filter_id") REFERENCES "public"."email_filters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_filters" ADD CONSTRAINT "email_filters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_variants" ADD CONSTRAINT "file_variants_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_recipients" ADD CONSTRAINT "message_recipients_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_snoozed_from_mailbox_mailboxes_id_fk" FOREIGN KEY ("snoozed_from_mailbox") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_ingest_witnesses" ADD CONSTRAINT "node_ingest_witnesses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_ingest_witnesses" ADD CONSTRAINT "node_ingest_witnesses_record_id_signed_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."signed_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personhood_statuses" ADD CONSTRAINT "personhood_statuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personhood_vouches" ADD CONSTRAINT "personhood_vouches_voucher_user_id_users_id_fk" FOREIGN KEY ("voucher_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personhood_vouches" ADD CONSTRAINT "personhood_vouches_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personhood_vouches" ADD CONSTRAINT "personhood_vouches_record_id_signed_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."signed_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_related_message_id_messages_id_fk" FOREIGN KEY ("related_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_heads" ADD CONSTRAINT "repo_heads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_heads" ADD CONSTRAINT "repo_heads_head_record_id_signed_records_record_id_fk" FOREIGN KEY ("head_record_id") REFERENCES "public"."signed_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_balances" ADD CONSTRAINT "reputation_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_balances" ADD CONSTRAINT "reputation_balances_last_transaction_id_reputation_transactions_id_fk" FOREIGN KEY ("last_transaction_id") REFERENCES "public"."reputation_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_reviewing_reliability" ADD CONSTRAINT "reputation_reviewing_reliability_balance_id_reputation_balances_id_fk" FOREIGN KEY ("balance_id") REFERENCES "public"."reputation_balances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_disputes" ADD CONSTRAINT "reputation_disputes_transaction_id_reputation_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."reputation_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_disputes" ADD CONSTRAINT "reputation_disputes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_disputes" ADD CONSTRAINT "reputation_disputes_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_transactions" ADD CONSTRAINT "reputation_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_transactions" ADD CONSTRAINT "reputation_transactions_reversed_transaction_id_reputation_transactions_id_fk" FOREIGN KEY ("reversed_transaction_id") REFERENCES "public"."reputation_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_transactions" ADD CONSTRAINT "reputation_transactions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_transactions" ADD CONSTRAINT "reputation_transactions_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_records" ADD CONSTRAINT "signed_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_records" ADD CONSTRAINT "signed_records_prev_signed_records_record_id_fk" FOREIGN KEY ("prev") REFERENCES "public"."signed_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transparency_checkpoint_anchors" ADD CONSTRAINT "transparency_checkpoint_anchors_checkpoint_id_transparency_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."transparency_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transparency_checkpoint_signatures" ADD CONSTRAINT "transparency_checkpoint_signatures_checkpoint_id_transparency_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."transparency_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transparency_checkpoint_snapshot_entries" ADD CONSTRAINT "transparency_checkpoint_snapshot_entries_checkpoint_id_transparency_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."transparency_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_nodes" ADD CONSTRAINT "user_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_request_validators" ADD CONSTRAINT "validation_request_validators_request_id_validation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."validation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_request_validators" ADD CONSTRAINT "validation_request_validators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_requests" ADD CONSTRAINT "validation_requests_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_requests" ADD CONSTRAINT "validation_requests_resolved_txn_id_reputation_transactions_id_fk" FOREIGN KEY ("resolved_txn_id") REFERENCES "public"."reputation_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_votes" ADD CONSTRAINT "validation_votes_request_id_validation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."validation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_votes" ADD CONSTRAINT "validation_votes_validator_user_id_users_id_fk" FOREIGN KEY ("validator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_votes" ADD CONSTRAINT "validation_votes_record_id_signed_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."signed_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_affinities" ADD CONSTRAINT "validator_affinities_validator_a_users_id_fk" FOREIGN KEY ("validator_a") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_affinities" ADD CONSTRAINT "validator_affinities_validator_b_users_id_fk" FOREIGN KEY ("validator_b") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifiable_credentials" ADD CONSTRAINT "verifiable_credentials_holder_user_id_users_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifiable_credentials" ADD CONSTRAINT "verifiable_credentials_issuer_user_id_users_id_fk" FOREIGN KEY ("issuer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifiable_credentials" ADD CONSTRAINT "verifiable_credentials_record_id_signed_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."signed_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bundles_user_id_lower_name_key" ON "bundles" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_id_email_key" ON "contacts" USING btree ("user_id","email");--> statement-breakpoint
CREATE INDEX "contacts_search_vector_idx" ON "contacts" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "contacts_starred_idx" ON "contacts" USING btree ("user_id") WHERE "contacts"."starred";--> statement-breakpoint
CREATE INDEX "email_filters_user_id_enabled_order_idx" ON "email_filters" USING btree ("user_id","enabled","order");--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_user_id_lower_name_key" ON "email_templates" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "file_links_app_entity_type_entity_id_created_by_idx" ON "file_links" USING btree ("app","entity_type","entity_id","created_by");--> statement-breakpoint
CREATE INDEX "file_links_created_by_idx" ON "file_links" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "file_variants_file_id_type_idx" ON "file_variants" USING btree ("file_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "files_sha256_live_key" ON "files" USING btree ("sha256") WHERE "files"."status" in ('active', 'trash');--> statement-breakpoint
CREATE INDEX "files_owner_user_id_status_idx" ON "files" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "files_owner_user_id_visibility_status_idx" ON "files" USING btree ("owner_user_id","visibility","status");--> statement-breakpoint
CREATE INDEX "files_visibility_status_idx" ON "files" USING btree ("visibility","status");--> statement-breakpoint
CREATE INDEX "files_sha256_status_idx" ON "files" USING btree ("sha256","status");--> statement-breakpoint
CREATE INDEX "files_purpose_owner_user_id_status_idx" ON "files" USING btree ("purpose","owner_user_id","status");--> statement-breakpoint
CREATE INDEX "files_created_at_idx" ON "files" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_user_id_path_key" ON "mailboxes" USING btree ("user_id","path");--> statement-breakpoint
CREATE INDEX "mailboxes_user_id_special_use_idx" ON "mailboxes" USING btree ("user_id","special_use");--> statement-breakpoint
CREATE INDEX "message_attachments_file_id_idx" ON "message_attachments" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "message_recipients_address_idx" ON "message_recipients" USING btree ("address");--> statement-breakpoint
CREATE INDEX "messages_user_id_mailbox_id_pinned_date_idx" ON "messages" USING btree ("user_id","mailbox_id","pinned" DESC NULLS LAST,"date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_user_id_message_id_idx" ON "messages" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "messages_user_id_in_reply_to_idx" ON "messages" USING btree ("user_id","in_reply_to");--> statement-breakpoint
CREATE INDEX "messages_references_idx" ON "messages" USING gin ("references");--> statement-breakpoint
CREATE INDEX "messages_unseen_idx" ON "messages" USING btree ("user_id","mailbox_id","pinned" DESC NULLS LAST,"date" DESC NULLS LAST) WHERE not "messages"."seen";--> statement-breakpoint
CREATE INDEX "messages_starred_idx" ON "messages" USING btree ("user_id","pinned" DESC NULLS LAST,"date" DESC NULLS LAST) WHERE "messages"."starred";--> statement-breakpoint
CREATE INDEX "messages_search_vector_idx" ON "messages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "messages_labels_idx" ON "messages" USING gin ("labels");--> statement-breakpoint
CREATE INDEX "messages_user_id_alias_tag_idx" ON "messages" USING btree ("user_id","alias_tag");--> statement-breakpoint
CREATE INDEX "messages_user_id_from_address_date_idx" ON "messages" USING btree ("user_id","from_address","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_user_id_pinned_date_idx" ON "messages" USING btree ("user_id","pinned" DESC NULLS LAST,"date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_snoozed_until_idx" ON "messages" USING btree ("snoozed_until") WHERE "messages"."snoozed_until" is not null;--> statement-breakpoint
CREATE INDEX "messages_scheduled_at_idx" ON "messages" USING btree ("scheduled_at") WHERE "messages"."scheduled_at" is not null;--> statement-breakpoint
CREATE INDEX "messages_mailbox_id_received_at_idx" ON "messages" USING btree ("mailbox_id","received_at");--> statement-breakpoint
CREATE INDEX "node_ingest_witnesses_user_id_created_at_idx" ON "node_ingest_witnesses" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "personhood_statuses_score_idx" ON "personhood_statuses" USING btree ("score");--> statement-breakpoint
CREATE INDEX "personhood_statuses_is_real_person_idx" ON "personhood_statuses" USING btree ("is_real_person");--> statement-breakpoint
CREATE UNIQUE INDEX "personhood_vouches_active_pair_key" ON "personhood_vouches" USING btree ("voucher_user_id","subject_user_id") WHERE "personhood_vouches"."status" = 'active';--> statement-breakpoint
CREATE INDEX "personhood_vouches_subject_id_status_idx" ON "personhood_vouches" USING btree ("subject_user_id","status");--> statement-breakpoint
CREATE INDEX "reminders_user_id_completed_remind_at_idx" ON "reminders" USING btree ("user_id","completed","remind_at");--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("remind_at") WHERE not "reminders"."completed";--> statement-breakpoint
CREATE INDEX "reputation_balances_total_idx" ON "reputation_balances" USING btree ("total" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reputation_balances_trust_tier_idx" ON "reputation_balances" USING btree ("trust_tier");--> statement-breakpoint
CREATE INDEX "reputation_balances_conduct_standing_idx" ON "reputation_balances" USING btree ("conduct_standing");--> statement-breakpoint
CREATE INDEX "reputation_disputes_user_id_status_idx" ON "reputation_disputes" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "reputation_disputes_status_idx" ON "reputation_disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reputation_disputes_transaction_id_idx" ON "reputation_disputes" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "reputation_transactions_user_id_status_idx" ON "reputation_transactions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "reputation_transactions_user_id_created_at_idx" ON "reputation_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reputation_transactions_application_id_idx" ON "reputation_transactions" USING btree ("application_id") WHERE "reputation_transactions"."application_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reputation_transactions_source_action_key" ON "reputation_transactions" USING btree ("application_id","source_action_id");--> statement-breakpoint
CREATE INDEX "reputation_transactions_status_idx" ON "reputation_transactions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sender_avatars_email_key" ON "sender_avatars" USING btree ("email");--> statement-breakpoint
CREATE INDEX "sender_avatars_expires_at_idx" ON "sender_avatars" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "signed_records_subject_did_idx" ON "signed_records" USING btree ("subject_did");--> statement-breakpoint
CREATE INDEX "signed_records_user_id_type_created_at_idx" ON "signed_records" USING btree ("user_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "signed_records_user_id_seq_key" ON "signed_records" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "signed_records_user_id_nsid_rkey_created_at_idx" ON "signed_records" USING btree ("user_id","nsid","rkey","created_at" DESC NULLS LAST) WHERE "signed_records"."nsid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transparency_checkpoint_anchors_txid_key" ON "transparency_checkpoint_anchors" USING btree ("checkpoint_id","network","txid");--> statement-breakpoint
CREATE UNIQUE INDEX "transparency_checkpoint_signatures_position_key" ON "transparency_checkpoint_signatures" USING btree ("checkpoint_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "transparency_checkpoint_signatures_signer_key" ON "transparency_checkpoint_signatures" USING btree ("checkpoint_id","public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "transparency_checkpoint_snapshot_entries_subject_key" ON "transparency_checkpoint_snapshot_entries" USING btree ("checkpoint_id","subject_did");--> statement-breakpoint
CREATE INDEX "user_nodes_status_idx" ON "user_nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "validation_request_validators_user_id_idx" ON "validation_request_validators" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "validation_request_validators_position_key" ON "validation_request_validators" USING btree ("request_id","position");--> statement-breakpoint
CREATE INDEX "validation_requests_subject_user_id_idx" ON "validation_requests" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "validation_requests_status_expires_at_idx" ON "validation_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "validation_requests_open_source_action_key" ON "validation_requests" USING btree ("source_action_id") WHERE "validation_requests"."status" in ('pending', 'quorum_met');--> statement-breakpoint
CREATE UNIQUE INDEX "validation_votes_request_validator_key" ON "validation_votes" USING btree ("request_id","validator_user_id");--> statement-breakpoint
CREATE INDEX "validation_votes_validator_user_id_idx" ON "validation_votes" USING btree ("validator_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "validator_affinities_pair_key" ON "validator_affinities" USING btree ("validator_a","validator_b");--> statement-breakpoint
CREATE INDEX "verifiable_credentials_holder_status_idx" ON "verifiable_credentials" USING btree ("holder_user_id","status");--> statement-breakpoint
CREATE INDEX "verifiable_credentials_issuer_did_idx" ON "verifiable_credentials" USING btree ("issuer_did");--> statement-breakpoint
ALTER TABLE "conduct_strikes" ADD CONSTRAINT "conduct_strikes_transaction_id_reputation_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."reputation_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_effects" ADD CONSTRAINT "moderation_effects_transaction_id_reputation_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."reputation_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_effects" ADD CONSTRAINT "moderation_effects_reversal_transaction_id_reputation_transactions_id_fk" FOREIGN KEY ("reversal_transaction_id") REFERENCES "public"."reputation_transactions"("id") ON DELETE restrict ON UPDATE no action;