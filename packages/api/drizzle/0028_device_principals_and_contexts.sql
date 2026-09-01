-- oxy:deploy-phase=pre
--
-- PRE: three new tables, one new nullable column, and a backfill. Nothing is
-- dropped, renamed or narrowed and no existing statement changes shape, so the
-- image still serving goes on writing `device_session_accounts` exactly as it
-- does today while this lands.
--
-- ISSUE #937, ADR 0001. A device stops holding a flat set of accounts and
-- starts holding PEOPLE, each of whom acts as one or more accounts:
--
--   device_principals        one human who authenticated on this device
--   device_account_contexts  one principal acting as one account
--
-- The flat `device_session_accounts` row collapsed four different facts into
-- one shape — a person, that person's own account, an organization, and the
-- person a delegated account is operated through — and its
-- `UNIQUE(device_session_id, account_id)` therefore made an ordinary state
-- unrepresentable: `Nate -> The Oxy Collective` and `Alice -> The Oxy
-- Collective` could not both exist on one device, even though those are
-- different sessions with different permissions, different audit actors and
-- different revocation paths.
--
-- `device_sessions.active_context_id` becomes the authority for what is
-- selected. `active_account_id` stays, derived from it at one write site, for
-- as long as the flat wire contract has consumers.
--
-- WHAT `authuser` MEANS NOW. It is the signed-in-HUMAN slot and it belongs to
-- the principal. On the flat table it was allocated per ACCOUNT, so adding an
-- organization consumed one and the number stopped meaning what its name says.
-- The backfill preserves every existing value that maps to a person; the slots
-- that named organizations are simply released.
--
-- WHY THE BACKFILL IS IN THIS FILE, not a script. The new tables become the
-- read authority the moment the new image starts, so a copy produced at any
-- other time would be describing different data — and a script nobody remembers
-- to run reports nothing at all, indistinguishably from a clean backfill.
--
-- THE ROLLING-DEPLOY WINDOW, stated rather than hidden. Between this migration
-- and the last old task draining, the previous image keeps writing
-- `device_session_accounts` and not these tables, so an account added in that
-- window is missing from the new authority. It is not lost: the client
-- re-registers its restored session on every reload, and that re-register
-- creates the principal and the context. The observable cost is one reload.
--
-- CONFLICTS ARE RECORDED, NEVER DROPPED. `device_principal_backfill_conflicts`
-- holds one row per thing this copy could not translate cleanly — see that
-- table's own module for what each class means and why the report is a table
-- rather than a log line.
--
-- IDS. Rows inserted by raw SQL get no `$defaultFn`, so each `id` below is a
-- uuid v7 built in SQL from the source row's OWN timestamp: the same shape
-- `generatedId()` emits and `isLiveEntityId` accepts (a v4 would be rejected on
-- a route as a malformed id). The 48-bit millisecond prefix comes from
-- `added_at`; the 74 random bits come from `gen_random_uuid()`, which is core
-- Postgres — this schema installs no pgcrypto, so `gen_random_bytes` is not
-- available. The expression is repeated rather than wrapped in a function: a
-- function would be DDL to install and remove in every environment, for two
-- call sites.
--
CREATE TABLE "device_account_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"device_session_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"account_id" text NOT NULL,
	"session_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_account_contexts_device_principal_account_key" UNIQUE("device_session_id","principal_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "device_principal_backfill_conflicts" (
	"device_id" text NOT NULL,
	"conflict" text NOT NULL,
	"subject_id" text NOT NULL,
	"detail" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_principal_backfill_conflicts_pkey" PRIMARY KEY("device_id","conflict","subject_id"),
	CONSTRAINT "device_principal_backfill_conflicts_conflict_check" CHECK ("device_principal_backfill_conflicts"."conflict" in ('authuser_collapsed', 'principal_without_personal_context', 'active_account_without_context', 'non_personal_principal', 'duplicate_principal_account', 'orphan_operator'))
);
--> statement-breakpoint
CREATE TABLE "device_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"device_session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"authuser" integer NOT NULL,
	"personal_session_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_authenticated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_principals_device_session_id_user_id_key" UNIQUE("device_session_id","user_id"),
	CONSTRAINT "device_principals_device_session_id_authuser_key" UNIQUE("device_session_id","authuser"),
	CONSTRAINT "device_principals_authuser_check" CHECK ("device_principals"."authuser" >= 0)
);
--> statement-breakpoint
ALTER TABLE "device_sessions" ADD COLUMN "active_context_id" text;--> statement-breakpoint
ALTER TABLE "device_account_contexts" ADD CONSTRAINT "device_account_contexts_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_account_contexts" ADD CONSTRAINT "device_account_contexts_principal_id_device_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."device_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_account_contexts" ADD CONSTRAINT "device_account_contexts_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_principals" ADD CONSTRAINT "device_principals_device_session_id_device_sessions_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_principals" ADD CONSTRAINT "device_principals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_account_contexts_account_id_idx" ON "device_account_contexts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "device_account_contexts_principal_id_idx" ON "device_account_contexts" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "device_principals_user_id_idx" ON "device_principals" USING btree ("user_id");--> statement-breakpoint
-- The second half of a CYCLE: `device_account_contexts.device_session_id`
-- points here, and this points back. Both constraints have to survive
-- generation — a column-level circular reference has been silently dropped from
-- a migration and its snapshot before now, with nothing failing — so
-- `schema/__tests__/devicePrincipals.test.ts` reads both out of `pg_constraint`
-- rather than trusting this file.
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_active_context_id_device_account_contexts_id_fk" FOREIGN KEY ("active_context_id") REFERENCES "public"."device_account_contexts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ===========================================================================
-- BACKFILL — every `device_session_accounts` row becomes a principal and a
-- context, per ADR 0001:
--
--   operated_by_user_id IS NULL      -> principal(user_id = account_id)
--                                       + PERSONAL context
--   operated_by_user_id IS NOT NULL  -> principal(user_id = operated_by_user_id)
--                                       + DELEGATED context
--
-- The two checks that run FIRST are for states the flat table's own constraints
-- make impossible. They are here anyway, and deliberately: the constraints that
-- make them impossible are the ones being retired, and a check whose answer is
-- known is still the positive control that says the query ran. If either ever
-- fires, the copy immediately below aborts on a foreign key or a unique — the
-- correct fail-closed outcome for genuinely corrupt data, and the reason
-- reporting them cannot be left until after the copy.
-- ===========================================================================
INSERT INTO "device_principal_backfill_conflicts" ("device_id", "conflict", "subject_id", "detail")
SELECT ds."device_id",
       'orphan_operator',
       a."operated_by_user_id",
       'Delegated entry for account ' || a."account_id" || ' names an operator with no users row. '
         || 'Impossible while device_session_accounts_operated_by_user_id_users_id_fk exists.'
  FROM "device_session_accounts" a
  JOIN "device_sessions" ds ON ds."id" = a."device_session_id"
 WHERE a."operated_by_user_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = a."operated_by_user_id")
    ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "device_principal_backfill_conflicts" ("device_id", "conflict", "subject_id", "detail")
SELECT ds."device_id",
       'duplicate_principal_account',
       d."account_id",
       d."n" || ' entries map to the same (principal, account) pair. '
         || 'Impossible while device_session_accounts_device_session_id_account_id_key exists.'
  FROM (SELECT a."device_session_id",
               COALESCE(a."operated_by_user_id", a."account_id") AS "principal_user_id",
               a."account_id",
               count(*) AS "n"
          FROM "device_session_accounts" a
         GROUP BY 1, 2, 3
        HAVING count(*) > 1) d
  JOIN "device_sessions" ds ON ds."id" = d."device_session_id"
    ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Principals. One row per PERSON per device.
--
-- `preferred` is the slot the flat table already gave this person: their own
-- personal entry's `authuser` when they have one, otherwise the lowest slot
-- among the delegated entries they operate. Preserving it rather than
-- renumbering densely is deliberate — `authuser` is a value clients put in URLs,
-- and a device with no organizations on it must come through unchanged.
--
-- `dup_rank` and the bump above `max_preferred` exist for the one case that
-- cannot be preserved: two people claiming one slot. The flat table never had a
-- `UNIQUE(device, authuser)`, so two concurrent adds could both allocate the
-- same "lowest free" number. The earlier arrival keeps the slot; each later one
-- is pushed above every preferred value on the device, where it can collide
-- with nothing. Both are reported.
INSERT INTO "device_principals"
  ("id", "device_session_id", "user_id", "authuser", "personal_session_id", "added_at", "last_authenticated_at")
SELECT gen."id",
       s."device_session_id",
       s."principal_user_id",
       CASE WHEN s."dup_rank" = 1 THEN s."preferred" ELSE s."max_preferred" + s."dup_running" END,
       s."personal_session_id",
       s."added_at",
       s."added_at"
  FROM (SELECT r.*,
               max(r."preferred") OVER (PARTITION BY r."device_session_id") AS "max_preferred",
               r."dup_seq" AS "dup_rank",
               sum(CASE WHEN r."dup_seq" > 1 THEN 1 ELSE 0 END)
                 OVER (PARTITION BY r."device_session_id"
                           ORDER BY r."preferred", r."added_at", r."principal_user_id"
                       ROWS UNBOUNDED PRECEDING) AS "dup_running"
          FROM (SELECT g.*,
                       row_number() OVER (PARTITION BY g."device_session_id", g."preferred"
                                              ORDER BY g."added_at", g."principal_user_id") AS "dup_seq"
                  FROM (SELECT a."device_session_id",
                               COALESCE(a."operated_by_user_id", a."account_id") AS "principal_user_id",
                               COALESCE(
                                 min(a."authuser") FILTER (WHERE a."operated_by_user_id" IS NULL),
                                 min(a."authuser")
                               ) AS "preferred",
                               max(a."session_id") FILTER (WHERE a."operated_by_user_id" IS NULL)
                                 AS "personal_session_id",
                               min(a."added_at") AS "added_at"
                          FROM "device_session_accounts" a
                         GROUP BY 1, 2) g) r) s
  CROSS JOIN LATERAL (
    SELECT substring(x."t" FROM 1 FOR 8) || '-' || substring(x."t" FROM 9 FOR 4) || '-7'
        || substring(x."u" FROM 16 FOR 3) || '-' || substring(x."u" FROM 20 FOR 4) || '-'
        || substring(x."u" FROM 25 FOR 12) AS "id"
      FROM (SELECT lpad(to_hex((extract(epoch FROM s."added_at") * 1000)::bigint), 12, '0') AS "t",
                   gen_random_uuid()::text AS "u") x
  ) gen;--> statement-breakpoint

-- The slot this person actually got, versus the one the flat table gave them.
INSERT INTO "device_principal_backfill_conflicts" ("device_id", "conflict", "subject_id", "detail")
WITH "pref" AS (
  SELECT a."device_session_id",
         COALESCE(a."operated_by_user_id", a."account_id") AS "principal_user_id",
         COALESCE(
           min(a."authuser") FILTER (WHERE a."operated_by_user_id" IS NULL),
           min(a."authuser")
         ) AS "preferred"
    FROM "device_session_accounts" a
   GROUP BY 1, 2
)
SELECT ds."device_id",
       'authuser_collapsed',
       p."user_id",
       'Two principals claimed authuser ' || pref."preferred" || ' on this device; this one was moved to '
         || p."authuser" || '. The slot number is display metadata, so nothing but the number is lost.'
  FROM "device_principals" p
  JOIN "device_sessions" ds ON ds."id" = p."device_session_id"
  JOIN "pref" ON pref."device_session_id" = p."device_session_id"
             AND pref."principal_user_id" = p."user_id"
 WHERE p."authuser" <> pref."preferred"
    ON CONFLICT DO NOTHING;--> statement-breakpoint

-- A person who is on this device ONLY as somebody else's operator. ADR 0001
-- requires a live principal to have a personal context; these legacy rows do
-- not, and one is NOT invented for them — the flat table never said this person
-- was signed in here as themselves, and a fabricated row would assert it.
INSERT INTO "device_principal_backfill_conflicts" ("device_id", "conflict", "subject_id", "detail")
SELECT ds."device_id",
       'principal_without_personal_context',
       p."user_id",
       'No personal entry on this device, so authuser ' || p."authuser"
         || ' was inherited from a delegated entry and no personal context exists.'
  FROM "device_principals" p
  JOIN "device_sessions" ds ON ds."id" = p."device_session_id"
 WHERE p."personal_session_id" IS NULL
    ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Contexts. One per flat entry, carrying its `session_id` and `added_at`
-- verbatim. `last_used_at` stays NULL: the flat table never recorded it, and
-- deriving one from `active_account_id` would make a guess look measured.
INSERT INTO "device_account_contexts"
  ("id", "device_session_id", "principal_id", "account_id", "session_id", "added_at")
SELECT gen."id",
       a."device_session_id",
       p."id",
       a."account_id",
       a."session_id",
       a."added_at"
  FROM "device_session_accounts" a
  JOIN "device_principals" p
    ON p."device_session_id" = a."device_session_id"
   AND p."user_id" = COALESCE(a."operated_by_user_id", a."account_id")
  CROSS JOIN LATERAL (
    SELECT substring(x."t" FROM 1 FOR 8) || '-' || substring(x."t" FROM 9 FOR 4) || '-7'
        || substring(x."u" FROM 16 FOR 3) || '-' || substring(x."u" FROM 20 FOR 4) || '-'
        || substring(x."u" FROM 25 FOR 12) AS "id"
      FROM (SELECT lpad(to_hex((extract(epoch FROM a."added_at") * 1000)::bigint), 12, '0') AS "t",
                   gen_random_uuid()::text AS "u") x
  ) gen;--> statement-breakpoint

-- A principal that is not a person. ADR 0001's central invariant says an
-- organization, project, bot or channel is a SUBJECT, never a principal — but a
-- legacy entry with no `operated_by_user_id` on a non-personal account maps to
-- exactly that. It is copied faithfully: dropping it would sign a real device
-- out of a real account, and preserving somebody's session beats enforcing an
-- invariant on data that predates it.
INSERT INTO "device_principal_backfill_conflicts" ("device_id", "conflict", "subject_id", "detail")
SELECT ds."device_id",
       'non_personal_principal',
       p."user_id",
       'Principal is a ' || u."kind" || ' account, not a person. The legacy entry carried no '
         || 'operated_by_user_id, so there is nobody to attribute it to.'
  FROM "device_principals" p
  JOIN "device_sessions" ds ON ds."id" = p."device_session_id"
  JOIN "users" u ON u."id" = p."user_id"
 WHERE u."kind" <> 'personal'
    ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The active selection. `active_account_id` names an account; the context it
-- becomes is that account's entry together with the operator recorded on it.
UPDATE "device_sessions" ds
   SET "active_context_id" = c."id"
  FROM "device_session_accounts" a
  JOIN "device_principals" p
    ON p."device_session_id" = a."device_session_id"
   AND p."user_id" = COALESCE(a."operated_by_user_id", a."account_id")
  JOIN "device_account_contexts" c
    ON c."principal_id" = p."id"
   AND c."account_id" = a."account_id"
 WHERE a."device_session_id" = ds."id"
   AND a."account_id" = ds."active_account_id";--> statement-breakpoint

-- An active account with nothing to point at. `active_context_id` stays NULL,
-- which is the first-class "signed in, nothing selected" state and exactly what
-- `healActiveAccount` re-elects from on the next read — so this is reported
-- rather than repaired here.
INSERT INTO "device_principal_backfill_conflicts" ("device_id", "conflict", "subject_id", "detail")
SELECT ds."device_id",
       'active_account_without_context',
       ds."active_account_id",
       'active_account_id names an account with no entry in this device''s set, so no context '
         || 'could be elected. active_context_id left NULL.'
  FROM "device_sessions" ds
 WHERE ds."active_account_id" IS NOT NULL
   AND ds."active_context_id" IS NULL
    ON CONFLICT DO NOTHING;
