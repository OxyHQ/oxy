-- oxy:deploy-phase=pre
--
-- PRE: adding constraints that every existing row already satisfies. The
-- previous image writes only values from these sets, so nothing it does starts
-- failing — and doing it before the new image means the new image never runs
-- against an unconstrained table.
--
-- WHY THIS EXISTS. This repo's convention for a closed value set is `text` plus
-- a CHECK derived from the same tuple the TypeScript enum comes from (see
-- `account_credentials` in 0006, which does it for three columns on one table).
-- 0016 created five follow tables and applied it to none of their enum columns,
-- so drizzle's `text({ enum: … })` was doing all the work — and that is a
-- COMPILE-TIME claim only. Nothing stopped a repair script, a migration, or a
-- future service from writing `follow_events.type = 'follow.oops'`, which every
-- consumer would then have to survive at runtime.
--
-- Found while building the outbox worker (#819), whose handler registry has to
-- treat an unknown event type as reachable precisely because the database did
-- not rule it out. That defence stays — a worker should survive a value it does
-- not know however it arrived — but it should not be the ONLY thing standing
-- between the enum and the table.
--
-- Each list below is the same tuple as the `as const` array in the schema file
-- named beside it. Adding a value means editing both, which is the point: the
-- database refusing an unmigrated value is how the two are kept in step.

-- src/db/schema/followEvents.ts → FOLLOW_EVENT_TYPES
ALTER TABLE "follow_events" ADD CONSTRAINT "follow_events_type_check"
  CHECK ("follow_events"."type" in (
    'follow.created', 'follow.removed', 'follow.requested', 'follow.accepted',
    'follow.rejected', 'follow.context_enabled', 'follow.context_disabled'
  ));--> statement-breakpoint

-- src/db/schema/followEvents.ts → FOLLOW_EVENT_CAUSES
ALTER TABLE "follow_events" ADD CONSTRAINT "follow_events_cause_check"
  CHECK ("follow_events"."cause" in (
    'user_action', 'expired', 'federation_inbound', 'reconciliation', 'migration'
  ));--> statement-breakpoint

-- src/db/schema/followRelationships.ts → FOLLOW_RELATIONSHIP_STATES
ALTER TABLE "follow_relationships" ADD CONSTRAINT "follow_relationships_state_check"
  CHECK ("follow_relationships"."state" in ('requested', 'active', 'rejected'));--> statement-breakpoint

-- src/db/schema/followRelationships.ts → FOLLOW_SOURCES
ALTER TABLE "follow_relationships" ADD CONSTRAINT "follow_relationships_source_check"
  CHECK ("follow_relationships"."source" in ('app', 'federation_inbound', 'migration', 'system'));--> statement-breakpoint

-- src/db/schema/followApplicationOverrides.ts → FOLLOW_OVERRIDE_MODES
--
-- Note what is NOT here: `inherit`. It is a real mode in the API and in the
-- client, and it is deliberately not a stored value — inheriting means having
-- no override row at all. A CHECK admitting it would make "inherit" storable
-- and give the same state two representations, which is the shape that makes a
-- later "why does this row say inherit" bug possible.
ALTER TABLE "follow_application_overrides" ADD CONSTRAINT "follow_application_overrides_mode_check"
  CHECK ("follow_application_overrides"."mode" in ('enabled', 'disabled'));
