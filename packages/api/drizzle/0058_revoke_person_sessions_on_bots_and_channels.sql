-- oxy:deploy-phase=post
--
-- POST, and the phase is the whole point: this must run AFTER the image that
-- refuses new bot switches is serving. Run as `pre`, it would evict whoever is
-- inside while the OLD image is still handing out the door key, and the same
-- person could walk straight back in between the two steps. `post` is the only
-- side on which "close, then clear" is what actually happens.
--
-- WHAT THIS REPAIRS, AS OPPOSED TO WHAT THE CODE PREVENTS
--
-- Splitting `isActAsEligibleKind` stops a person from switching INTO a bot or a
-- channel. It does nothing about a session that already exists: closing a door
-- does not remove whoever is already through it. Measured in production on
-- 2026-08-25, one did — `community-maestro` held a live session on a device that
-- also carried its owner's personal and organization sessions, so it came from
-- the account switcher rather than from a service.
--
-- Those are two different properties and they need two different things. The
-- predicate split is the prevention; this is the repair, and without it the fix
-- is only a fix for the next person.
--
-- SCOPED BY THE RULE, NOT BY THE ROW COUNT
--
-- `kind in ('bot','channel')` is exactly what the new `isOperatorSwitchTargetKind`
-- refuses, written as the rule rather than as the one account that happens to
-- hold a session today. `channel` contributes zero rows right now — it has been
-- refused since before this change — and it is named anyway, because a channel
-- minted next month must not slip through a statement that was tuned to today's
-- census.
--
-- It touches no other kind. A `personal` session is somebody's login and an
-- `organization` / `project` session is a switch that remains legitimate.
--
-- IDEMPOTENT BY CONSTRUCTION
--
-- `and s."is_active"` means a second run matches nothing: the first pass leaves
-- no active row for the predicate to find. Re-running is a no-op rather than a
-- second write, so a replay, a re-deploy, or a manual dispatch is safe.
--
-- REVOCATION HERE MEANS WHAT IT MEANS EVERYWHERE ELSE
--
-- `is_active = false` is precisely what `session.service.ts` sets when it revokes
-- a session, and every authenticated request re-reads the row through
-- `validateSession`, which filters `is_active = true`. So this ends access on the
-- next request rather than merely marking a row — no new column, no second
-- notion of "revoked" for anything to drift against.
--
-- `updated_at` is set explicitly: drizzle's `$onUpdate` fires in the query
-- builder, not in raw SQL, so without this the rows would carry no record of WHEN
-- they were revoked. That timestamp plus this file plus the ledger row is the
-- audit trail.

UPDATE "sessions" AS s
SET "is_active" = false,
    "updated_at" = now()
FROM "users" AS u
WHERE u."id" = s."user_id"
  AND u."kind" IN ('bot', 'channel')
  AND s."is_active";
