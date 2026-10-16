-- oxy:deploy-phase=pre
--
-- ADR 0043 stage 4a: content claims and the takedown (D10).
--
--  * content_claims, content_claim_claimants (the claimant's identity and
--    statement, sealed, erased three years after the claim closes),
--    content_claim_targets, content_claim_events (append-only: the trigger at
--    the end refuses an UPDATE), content_claim_notifications (the email
--    outbox) and blocked_content_hashes (the blocklist) — all new.
--  * files.status gains `blocked`, and `blocked` holds a live claim on its
--    bytes: the three per-owner live uniques are rebuilt with it in their
--    predicate, and a partial index serves the lifecycle sweep's new
--    `purgeBlocked` step (an application's blocked file nobody uses, once no
--    open claim holds its bytes).
--  * users.staff_capabilities admits `content:claims`, the capability that
--    reads and acts on the claim queue.
--
-- PRE. Every statement is correct against BOTH images: the tables are new and
-- the image still serving never touches them; the two CHECKs only widen; no
-- row is `blocked` until this image blocks one, so the rebuilt uniques admit
-- exactly the rows the old ones did while the previous image serves; and that
-- image serves nothing but `active` (ADR 0043 stage 2), so a row this one
-- blocks is refused by both.
--
-- ## LOCKS
--
-- One transaction (the migrator runs every pending migration in one), as 0169
-- explains: CONCURRENTLY and a separate VALIDATE are unavailable here.
--
--  * CREATE TABLE: the foreign keys take SHARE ROW EXCLUSIVE on `users` and
--    `files` for the instant the constraint is added (the new tables are empty).
--  * files_status_check and users_staff_capabilities_check are re-added NOT
--    VALID, as 0169 did: enforced on every write from here on, without the
--    full-table scan a validating ADD runs under ACCESS EXCLUSIVE. Safe
--    because each only WIDENS, so every existing row, which passed the old
--    one, passes it. `VALIDATE CONSTRAINT` can be run later, out of band.
--  * The three live uniques are rebuilt (DROP + CREATE UNIQUE INDEX), which
--    holds SHARE on `files` for each build — reads continue, uploads, deletes
--    and visibility writes BLOCK for a time proportional to the table. On a
--    large `files`, build them OUT OF BAND first and swap each in with a
--    momentary lock; the guard below then finds the predicate already names
--    `blocked` and skips the rebuild —
--
--   CREATE UNIQUE INDEX CONCURRENTLY files_sha256_owner_user_live_key_next ON files USING btree (sha256, owner_user_id) WHERE status in ('active', 'trash', 'blocked') and owner_user_id is not null;
--   CREATE UNIQUE INDEX CONCURRENTLY files_sha256_system_owner_live_key_next ON files USING btree (sha256, system_owner) WHERE status in ('active', 'trash', 'blocked') and system_owner is not null;
--   CREATE UNIQUE INDEX CONCURRENTLY files_owner_application_id_sha256_live_key_next ON files USING btree (owner_application_id, sha256) WHERE status in ('active', 'trash', 'blocked') and owner_application_id is not null;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS files_application_blocked_unreferenced_since_idx ON files USING btree (unreferenced_since) WHERE owner_application_id is not null and status = 'blocked';
--   -- then, for each of the three (a catalogue change, ACCESS EXCLUSIVE for an instant):
--   BEGIN; DROP INDEX files_sha256_owner_user_live_key; ALTER INDEX files_sha256_owner_user_live_key_next RENAME TO files_sha256_owner_user_live_key; COMMIT;
--
-- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index; the guard at the
-- end refuses one under any of these names.
CREATE TABLE "blocked_content_hashes" (
	"sha256" text NOT NULL,
	"claim_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "blocked_content_hashes_pkey" PRIMARY KEY("sha256","claim_id"),
	CONSTRAINT "blocked_content_hashes_sha256_check" CHECK ("blocked_content_hashes"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "content_claim_claimants" (
	"claim_id" text PRIMARY KEY NOT NULL,
	"name_ciphertext" text NOT NULL,
	"email_ciphertext" text NOT NULL,
	"organization_ciphertext" text,
	"signature_ciphertext" text NOT NULL,
	"description_ciphertext" text NOT NULL,
	"original_work_url_ciphertext" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_claim_events" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text,
	"from_state" text,
	"to_state" text,
	"note" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "content_claim_events_action_check" CHECK ("content_claim_events"."action" in ('submitted', 'review_started', 'targets_attached', 'targets_blocked', 'rejected', 'counter_notice_recorded', 'reinstated', 'upheld', 'note_added')),
	CONSTRAINT "content_claim_events_state_check" CHECK (("content_claim_events"."from_state" is null or "content_claim_events"."from_state" in ('received', 'reviewing', 'actioned', 'rejected', 'counter_noticed', 'reinstated', 'upheld')) and ("content_claim_events"."to_state" is null or "content_claim_events"."to_state" in ('received', 'reviewing', 'actioned', 'rejected', 'counter_noticed', 'reinstated', 'upheld')))
);
--> statement-breakpoint
CREATE TABLE "content_claim_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"recipient_user_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "content_claim_notifications_kind_check" CHECK ("content_claim_notifications"."kind" in ('claim_received', 'claim_actioned', 'claim_rejected', 'claim_counter_noticed', 'claim_reinstated', 'claim_upheld', 'content_blocked', 'content_reinstated', 'content_upheld')),
	CONSTRAINT "content_claim_notifications_recipient_check" CHECK ("content_claim_notifications"."recipient" in ('claimant', 'account')),
	CONSTRAINT "content_claim_notifications_recipient_user_check" CHECK (("content_claim_notifications"."recipient" = 'account') = ("content_claim_notifications"."recipient_user_id" is not null)),
	CONSTRAINT "content_claim_notifications_attempts_check" CHECK ("content_claim_notifications"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "content_claim_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"resolution" text NOT NULL,
	"file_id" text,
	"sha256" text,
	"blocked_at" timestamp with time zone,
	"unblocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "content_claim_targets_source_check" CHECK ("content_claim_targets"."source" in ('claimant', 'staff')),
	CONSTRAINT "content_claim_targets_resolution_check" CHECK ("content_claim_targets"."resolution" in ('file', 'unresolved')),
	CONSTRAINT "content_claim_targets_url_check" CHECK ("content_claim_targets"."source" <> 'claimant' or "content_claim_targets"."url" is not null),
	CONSTRAINT "content_claim_targets_resolved_check" CHECK (("content_claim_targets"."resolution" = 'file') = ("content_claim_targets"."sha256" is not null)),
	CONSTRAINT "content_claim_targets_sha256_check" CHECK ("content_claim_targets"."sha256" is null or "content_claim_targets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_claim_targets_unblocked_check" CHECK ("content_claim_targets"."unblocked_at" is null or "content_claim_targets"."blocked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "content_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"relationship" text NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"submitted_by_user_id" text,
	"deadline_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "content_claims_kind_check" CHECK ("content_claims"."kind" in ('copyright', 'trademark', 'privacy', 'illegal_content', 'other')),
	CONSTRAINT "content_claims_relationship_check" CHECK ("content_claims"."relationship" in ('rights_holder', 'authorized_agent', 'affected_person', 'other')),
	CONSTRAINT "content_claims_state_check" CHECK ("content_claims"."state" in ('received', 'reviewing', 'actioned', 'rejected', 'counter_noticed', 'reinstated', 'upheld')),
	CONSTRAINT "content_claims_deadline_check" CHECK (("content_claims"."kind" = 'privacy' and "content_claims"."relationship" = 'affected_person') = ("content_claims"."deadline_at" is not null)),
	CONSTRAINT "content_claims_closed_check" CHECK (("content_claims"."state" in ('rejected', 'reinstated', 'upheld')) = ("content_claims"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_status_check";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_staff_capabilities_check";--> statement-breakpoint
ALTER TABLE "blocked_content_hashes" ADD CONSTRAINT "blocked_content_hashes_claim_id_content_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."content_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claim_claimants" ADD CONSTRAINT "content_claim_claimants_claim_id_content_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."content_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claim_events" ADD CONSTRAINT "content_claim_events_claim_id_content_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."content_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claim_notifications" ADD CONSTRAINT "content_claim_notifications_claim_id_content_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."content_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claim_notifications" ADD CONSTRAINT "content_claim_notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claim_targets" ADD CONSTRAINT "content_claim_targets_claim_id_content_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."content_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claim_targets" ADD CONSTRAINT "content_claim_targets_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_claims" ADD CONSTRAINT "content_claims_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocked_content_hashes_claim_id_idx" ON "blocked_content_hashes" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "content_claim_claimants_expires_at_idx" ON "content_claim_claimants" USING btree ("expires_at") WHERE "content_claim_claimants"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "content_claim_events_claim_id_created_at_idx" ON "content_claim_events" USING btree ("claim_id","created_at","id");--> statement-breakpoint
CREATE INDEX "content_claim_notifications_due_idx" ON "content_claim_notifications" USING btree ("next_attempt_at") WHERE "content_claim_notifications"."sent_at" is null and "content_claim_notifications"."failed_at" is null;--> statement-breakpoint
CREATE INDEX "content_claim_notifications_claim_id_idx" ON "content_claim_notifications" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "content_claim_notifications_recipient_user_id_idx" ON "content_claim_notifications" USING btree ("recipient_user_id") WHERE "content_claim_notifications"."recipient_user_id" is not null;--> statement-breakpoint
CREATE INDEX "content_claim_notifications_created_at_idx" ON "content_claim_notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "content_claim_targets_claim_id_idx" ON "content_claim_targets" USING btree ("claim_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_claim_targets_claim_id_file_id_key" ON "content_claim_targets" USING btree ("claim_id","file_id") WHERE "content_claim_targets"."file_id" is not null;--> statement-breakpoint
CREATE INDEX "content_claim_targets_sha256_idx" ON "content_claim_targets" USING btree ("sha256") WHERE "content_claim_targets"."sha256" is not null;--> statement-breakpoint
CREATE INDEX "content_claim_targets_file_id_idx" ON "content_claim_targets" USING btree ("file_id") WHERE "content_claim_targets"."file_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "content_claims_reference_key" ON "content_claims" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "content_claims_state_created_at_idx" ON "content_claims" USING btree ("state","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "content_claims_created_at_idx" ON "content_claims" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "content_claims_open_deadline_idx" ON "content_claims" USING btree ("deadline_at") WHERE "content_claims"."deadline_at" is not null and "content_claims"."state" in ('received', 'reviewing', 'actioned', 'counter_noticed');--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_status_check" CHECK ("files"."status" in ('active', 'trash', 'blocked', 'deleted')) NOT VALID;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_staff_capabilities_check" CHECK ("users"."staff_capabilities" <@ array['inference:catalogue:publish', 'billing:adjust', 'billing:cost_centers', 'content:claims']::text[]) NOT VALID;--> statement-breakpoint
-- The three live uniques, rebuilt with `blocked` in their predicate unless the
-- out-of-band route above already did it.
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('files_sha256_owner_user_live_key',
     'CREATE UNIQUE INDEX "files_sha256_owner_user_live_key" ON "files" USING btree ("sha256","owner_user_id") WHERE "files"."status" in (''active'', ''trash'', ''blocked'') and "files"."owner_user_id" is not null'),
    ('files_sha256_system_owner_live_key',
     'CREATE UNIQUE INDEX "files_sha256_system_owner_live_key" ON "files" USING btree ("sha256","system_owner") WHERE "files"."status" in (''active'', ''trash'', ''blocked'') and "files"."system_owner" is not null'),
    ('files_owner_application_id_sha256_live_key',
     'CREATE UNIQUE INDEX "files_owner_application_id_sha256_live_key" ON "files" USING btree ("owner_application_id","sha256") WHERE "files"."status" in (''active'', ''trash'', ''blocked'') and "files"."owner_application_id" is not null')
  ) AS s(name, ddl)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = spec.name AND indexdef LIKE '%''blocked''%'
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP INDEX IF EXISTS %I', spec.name);
    EXECUTE spec.ddl;
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_application_blocked_unreferenced_since_idx" ON "files" USING btree ("unreferenced_since") WHERE "files"."owner_application_id" is not null and "files"."status" = 'blocked';--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname IN ('files_sha256_owner_user_live_key', 'files_sha256_system_owner_live_key', 'files_owner_application_id_sha256_live_key', 'files_application_blocked_unreferenced_since_idx')
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'files takedown index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;--> statement-breakpoint
-- The audit trail is append-only: an entry that can be edited is not one. Only
-- UPDATE is refused — a row goes with its claim (CASCADE), and claims are
-- never deleted. 23514 so `isCheckViolation` reads it like any CHECK.
CREATE FUNCTION content_claim_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'content_claim_events is append-only: record a new event instead of editing one'
    USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER content_claim_events_immutable BEFORE UPDATE ON content_claim_events
  FOR EACH ROW EXECUTE FUNCTION content_claim_event_immutable();
