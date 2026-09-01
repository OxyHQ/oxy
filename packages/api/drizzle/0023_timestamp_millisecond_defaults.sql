-- oxy:deploy-phase=pre
--
-- Every `created_at` / `updated_at` default moves from `now()` to
-- `date_trunc('milliseconds', now())`.
--
-- WHY. `timestamptz` stores microseconds; a JavaScript `Date` holds
-- milliseconds. A row written at `…179527` therefore reads back as `…179`, and
-- a keyset cursor built from that read compares against a value SMALLER than
-- the row it came from: an ASC page re-matches its own anchor and never
-- advances, a DESC page silently skips every row sharing the anchor's
-- millisecond. `@oxyhq/db`'s `createdAt()` / `updatedAt()` builders state the
-- full argument, including why it is fixed at the source rather than at each
-- cursor.
--
-- THIS FILE IS WHAT MAKES THAT CHANGE REAL. Drizzle omits a defaulted column
-- from its INSERT and lets Postgres apply the catalogue default, so the
-- TypeScript change alone changes nothing about what gets stored — without
-- this migration the schema would claim a precision the database does not
-- have, and the bug would stay fixed only in the source.
--
-- PRE, and this one is not a judgement call. `ALTER COLUMN … SET DEFAULT`
-- rewrites one `pg_attrdef` row per column: no table rewrite, no scan, no lock
-- escalation, and it is correct against BOTH images either side of the
-- rollout. Neither the image still serving nor the one arriving names these
-- columns on insert, so both simply receive a value truncated one step
-- earlier — which is the fixed behaviour, not a new one to tolerate. Existing
-- rows are untouched; a default applies only to future inserts.
--
-- WHY THE LOCK TIMEOUT BELOW. Each statement takes ACCESS EXCLUSIVE on its
-- table, and drizzle wraps every pending migration in ONE transaction
-- (`PgDialect.migrate`), so all ~103 locks are held until commit. The work is
-- milliseconds of catalogue writes, but ACQUISITION queues behind any
-- long-running query or idle-in-transaction session on a table this has not
-- reached yet — and Postgres lock queues are FIFO, so from that moment every
-- later query on that table waits behind this migration too. The pre-deploy
-- one-shot allows it up to `MAX_WAIT_SECS` (1200), and the deploy role cannot
-- call `ecs:StopTask`, so the unbounded case is twenty minutes of blocked
-- production traffic with no kill switch in the pipeline.
--
-- Three seconds turns that into a failed migration, which is the outcome
-- `deploy-ecs-image.sh` says it wants: the previous image keeps serving, the
-- deploy goes red, and nothing was applied. Retry when the blocking session is
-- gone.
--
-- `SET LOCAL` scopes it to the transaction, not the session — but note that a
-- run applying SEVERAL pending migrations shares one transaction, so anything
-- after this file in the same run inherits the 3s ceiling. That is the right
-- default for the DDL this schema has, and it is deliberate rather than
-- incidental; a future migration that genuinely needs to wait longer should
-- raise it in its own first statement.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "account_credentials" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "account_credentials" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "account_members" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "account_members" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "api_key_usage_events" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_affinity_edges" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_affinity_edges" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_affinity_seen_events" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_endorsement_edges" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_endorsement_edges" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_grants" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_grants" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_updates" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_updates" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_user_signals" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "app_user_signals" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "application_credentials" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "application_credentials" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "application_moderation_trust" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "application_moderation_trust" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "auth_challenges" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "auth_challenges" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "auth_codes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "auth_codes" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "auth_sessions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "auth_sessions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "billing_transactions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "billing_transactions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "blocks" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "bookmarks" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "bookmarks" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "bundles" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "bundles" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "civic_nonces" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "conduct_strikes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "conduct_strikes" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "developer_api_keys" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "developer_api_keys" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "device_pairing_sessions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "device_pairing_sessions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "device_sessions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "device_sessions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "domain_verifications" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "email_filters" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "email_filters" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "email_templates" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "email_templates" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federation_key_pairs" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "federation_key_pairs" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "file_links" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_namespaces" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_target_kinds" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_target_kinds" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_targets" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_targets" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_relationships" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_relationships" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_application_overrides" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_application_overrides" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "follow_events" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "identity_backups" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "identity_bindings" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "identity_bindings" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "labels" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "labels" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "link_previews" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "link_previews" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mailboxes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "mailboxes" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_effects" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_effects" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_policies" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "moderation_policies" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "node_ingest_witnesses" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "personhood_statuses" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "personhood_statuses" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "personhood_vouches" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "personhood_vouches" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "push_tokens" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "push_tokens" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reminders" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "repo_heads" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "repo_heads" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reporter_reputation_profiles" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reporter_reputation_profiles" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reputation_balances" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reputation_balances" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reputation_disputes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reputation_disputes" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reputation_rules" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reputation_rules" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reputation_transactions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reputation_transactions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "restrictions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reviewer_reputation_profiles" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "reviewer_reputation_profiles" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "security_activities" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "security_activities" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "signed_records" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "transparency_checkpoint_anchors" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "transparency_checkpoint_anchors" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "transparency_checkpoint_signatures" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "transparency_checkpoints" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "transparency_checkpoints" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "update_assets" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "update_assets" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "update_channels" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "update_channels" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_analytics" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_analytics" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_app_data" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_app_data" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_auth_methods" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_credits" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_credits" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_follows" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_follows" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_link_metadata" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_link_metadata" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_locations" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_locations" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_nodes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_nodes" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "user_verified_domains" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "validation_requests" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "validation_requests" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "validation_votes" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "verifiable_credentials" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "verifiable_credentials" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "wallets" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "wallets" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());