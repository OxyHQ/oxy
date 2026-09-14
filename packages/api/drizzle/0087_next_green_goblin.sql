-- oxy:deploy-phase=pre
--
-- PRE: one new nullable column plus a best-effort backfill. Nothing is
-- dropped, renamed or narrowed, and the new column carries no default and no
-- NOT NULL, so an INSERT issued by the previous image (which does not name
-- it) still succeeds unchanged.
--
-- `users.birthday` is free-form text ported verbatim from Mongo (see its own
-- comment in `db/schema/users.ts`) — never validated, never parsed, and real
-- rows can hold anything from a clean ISO date to a typo to an empty string.
-- `users.date_of_birth` is the new structured `date` column every write path
-- should prefer going forward (`user.service.ts`'s `updateUserProfile`).
--
-- `users.birthday` IS DELIBERATELY LEFT IN PLACE. Dropping it is explicitly
-- OUT OF SCOPE for this migration — existing readers still consume it, and
-- retiring it (once every reader has moved to `date_of_birth`) is its own
-- later migration, the same deferred-drop shape `0013_users_account_categories`
-- used for `organization_category`.
--
-- ===========================================================================
-- THE BACKFILL — parsing free text with confidence, or not at all
-- ===========================================================================
--
-- A wrong date is worse than a missing one: `date_of_birth` unlocks an
-- age-gate signal (`isAdult`, computed in `user.service.ts`), so a
-- mis-parsed birthday could misreport someone's age. Every format below is
-- therefore accepted ONLY when it is unambiguous, and anything else is left
-- NULL for the account holder to fill in themselves through the Accounts app.
--
-- Five formats, tried in this priority order, first match wins per row:
--
--   1. ISO 8601, `YYYY-MM-DD`, optionally followed by a time/zone component
--      (`T...` or a space). The leading four-digit group can only be a year,
--      so this is unambiguous by construction, and it is the single most
--      likely shape for anything not hand-typed — a `<input type="date">`,
--      a JS `.toISOString()`, or any prior "do this right" write.
--   2. The same year-first shape with a slash separator (`YYYY/MM/DD`).
--      Equally unambiguous, for the identical reason; less common than the
--      dash form but seen from some locales and exports.
--   3. A NAMED month, month-first — "March 4, 1990", "Mar 4 1990", "Jan. 4th
--      1990". Unambiguous because the month is a word, not a number, and
--      this is the shape a person typing a birthday into a free-text field
--      is most likely to produce when they do not use digits-only.
--   4. A NAMED month, day-first — "4 March 1990", "4th Mar, 1990". Same
--      reasoning as (3), reversed order (the common non-US convention).
--   5. ALL-NUMERIC, year LAST — `A<sep>B<sep>YYYY` with `/`, `-` or `.` as the
--      separator (matched identically on both sides). This is the one
--      genuinely ambiguous shape — it could be `MM/DD/YYYY` or `DD/MM/YYYY` —
--      so it is accepted ONLY when exactly one reading is possible (one of
--      `A`/`B` is over 12, so it can only be the day) or both readings agree
--      (`A = B`). `03/04/2005` — both 3 and 4 are valid months AND valid
--      days, and they disagree — is rejected outright: picking one would
--      fabricate a plausible-looking WRONG birthday.
--
-- Explicitly NOT attempted: two-digit years (which century?), a bare year
-- with no month/day, and JS `Date.prototype.toString()`'s locale-dependent
-- long form ("Mon May 14 1990 00:00:00 GMT+0000 (...)")  — none of these is
-- among the MOST PLAUSIBLE shapes a free-text birthday field holds, and
-- guessing wrong on any of them is exactly the failure mode this backfill
-- exists to avoid. All three fall through to NULL, same as any other
-- unrecognised value.
--
-- Every candidate, regardless of which format produced it, passes through
-- ONE shared validity check (`validated` below) before being written: a real
-- Gregorian day-of-month (leap years included, so `2024-02-29` is accepted
-- and `2023-02-29` is not) and a year between 1900 and the current one — the
-- same bounds `dateOfBirthSchema` (`@oxy.so/contracts`) enforces on every
-- live write, so a value this backfill would reject is also a value the API
-- would reject if submitted today.
--
-- Proven against a seeded corpus of realistic messy values, executed
-- VERBATIM out of this file, in
-- `schema/__tests__/dateOfBirthBackfill.test.ts` — see that file for the
-- corpus and the exact expected outcome of each entry.
--
ALTER TABLE "users" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
WITH "source" AS (
  SELECT "id", btrim("birthday") AS "raw"
    FROM "users"
   WHERE "date_of_birth" IS NULL
     AND "birthday" IS NOT NULL
     AND btrim("birthday") <> ''
),
"iso_dash" AS (
  SELECT "s"."id", ("m"[1])::int AS "year", ("m"[2])::int AS "month", ("m"[3])::int AS "day"
    FROM "source" "s",
         regexp_matches("s"."raw", '^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ].*)?$') AS "m"
),
"iso_slash" AS (
  SELECT "s"."id", ("m"[1])::int AS "year", ("m"[2])::int AS "month", ("m"[3])::int AS "day"
    FROM "source" "s",
         regexp_matches("s"."raw", '^([0-9]{4})/([0-9]{2})/([0-9]{2})$') AS "m"
   WHERE "s"."id" NOT IN (SELECT "id" FROM "iso_dash")
),
"month_name_first" AS (
  SELECT "s"."id",
         ("m"[3])::int AS "year",
         CASE lower(left("m"[1], 3))
           WHEN 'jan' THEN 1 WHEN 'feb' THEN 2 WHEN 'mar' THEN 3 WHEN 'apr' THEN 4
           WHEN 'may' THEN 5 WHEN 'jun' THEN 6 WHEN 'jul' THEN 7 WHEN 'aug' THEN 8
           WHEN 'sep' THEN 9 WHEN 'oct' THEN 10 WHEN 'nov' THEN 11 WHEN 'dec' THEN 12
         END AS "month",
         ("m"[2])::int AS "day"
    FROM "source" "s",
         regexp_matches(
           "s"."raw",
           '^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[.\s]+([0-9]{1,2})(?:st|nd|rd|th)?,?\s*([0-9]{4})$',
           'i'
         ) AS "m"
   WHERE "s"."id" NOT IN (SELECT "id" FROM "iso_dash")
     AND "s"."id" NOT IN (SELECT "id" FROM "iso_slash")
),
"month_name_last" AS (
  SELECT "s"."id",
         ("m"[3])::int AS "year",
         CASE lower(left("m"[2], 3))
           WHEN 'jan' THEN 1 WHEN 'feb' THEN 2 WHEN 'mar' THEN 3 WHEN 'apr' THEN 4
           WHEN 'may' THEN 5 WHEN 'jun' THEN 6 WHEN 'jul' THEN 7 WHEN 'aug' THEN 8
           WHEN 'sep' THEN 9 WHEN 'oct' THEN 10 WHEN 'nov' THEN 11 WHEN 'dec' THEN 12
         END AS "month",
         ("m"[1])::int AS "day"
    FROM "source" "s",
         regexp_matches(
           "s"."raw",
           '^([0-9]{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?),?\s*([0-9]{4})$',
           'i'
         ) AS "m"
   WHERE "s"."id" NOT IN (SELECT "id" FROM "iso_dash")
     AND "s"."id" NOT IN (SELECT "id" FROM "iso_slash")
     AND "s"."id" NOT IN (SELECT "id" FROM "month_name_first")
),
"numeric_year_last" AS (
  SELECT "s"."id",
         ("m"[4])::int AS "year",
         CASE
           WHEN ("m"[1])::int <= 12 AND ("m"[3])::int <= 12 AND ("m"[1])::int <> ("m"[3])::int THEN NULL
           WHEN ("m"[1])::int <= 12 THEN ("m"[1])::int
           WHEN ("m"[3])::int <= 12 THEN ("m"[3])::int
           ELSE NULL
         END AS "month",
         CASE
           WHEN ("m"[1])::int <= 12 AND ("m"[3])::int <= 12 AND ("m"[1])::int <> ("m"[3])::int THEN NULL
           WHEN ("m"[1])::int <= 12 THEN ("m"[3])::int
           WHEN ("m"[3])::int <= 12 THEN ("m"[1])::int
           ELSE NULL
         END AS "day"
    FROM "source" "s",
         regexp_matches("s"."raw", '^([0-9]{1,2})([/.-])([0-9]{1,2})\2([0-9]{4})$') AS "m"
   WHERE "s"."id" NOT IN (SELECT "id" FROM "iso_dash")
     AND "s"."id" NOT IN (SELECT "id" FROM "iso_slash")
     AND "s"."id" NOT IN (SELECT "id" FROM "month_name_first")
     AND "s"."id" NOT IN (SELECT "id" FROM "month_name_last")
),
"candidates" AS (
  SELECT * FROM "iso_dash"
  UNION ALL SELECT * FROM "iso_slash"
  UNION ALL SELECT * FROM "month_name_first"
  UNION ALL SELECT * FROM "month_name_last"
  UNION ALL SELECT * FROM "numeric_year_last"
),
"validated" AS (
  SELECT "id", "year", "month", "day"
    FROM "candidates"
   WHERE "year" BETWEEN 1900 AND date_part('year', now())::int
     AND "month" BETWEEN 1 AND 12
     AND "day" BETWEEN 1 AND (
       CASE "month"
         WHEN 2 THEN CASE WHEN ("year" % 4 = 0 AND "year" % 100 <> 0) OR "year" % 400 = 0 THEN 29 ELSE 28 END
         WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
         ELSE 31
       END
     )
)
UPDATE "users"
   SET "date_of_birth" = to_date(
     lpad("v"."year"::text, 4, '0') || '-' || lpad("v"."month"::text, 2, '0') || '-' || lpad("v"."day"::text, 2, '0'),
     'YYYY-MM-DD'
   )
  FROM "validated" "v"
 WHERE "users"."id" = "v"."id";
