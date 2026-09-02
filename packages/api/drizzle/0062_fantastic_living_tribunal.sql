-- oxy:deploy-phase=post
-- Audit messages and raw idempotency keys were accepted by the first agency
-- schema. They are not needed to interpret the decision, so remove them before
-- installing the invariant. This is an explicit one-way data minimisation, not
-- a guessed translation into another field.
UPDATE "capability_audit_events"
SET "event" = jsonb_set(
  jsonb_set("event", '{result}', coalesce("event" -> 'result', '{}'::jsonb) - 'message'),
  '{correlation}', coalesce("event" -> 'correlation', '{}'::jsonb) - 'idempotencyKey'
)
WHERE ("event" -> 'result' ? 'message')
   OR ("event" -> 'correlation' ? 'idempotencyKey');--> statement-breakpoint
-- Existing string/array limits cannot be converted to scalar policy bounds
-- without changing their meaning. Revoke the affected authority before deleting
-- the unsafe value: preserving a grant while silently widening it would be an
-- authorization escalation.
UPDATE "delegation_grants"
SET "revoked_at" = coalesce("revoked_at", now()), "updated_at" = now()
WHERE "id" IN (
  SELECT "grant_id" FROM "delegation_limits"
  WHERE jsonb_typeof("value") NOT IN ('number', 'boolean')
);--> statement-breakpoint
DELETE FROM "delegation_limits"
WHERE jsonb_typeof("value") NOT IN ('number', 'boolean');--> statement-breakpoint
-- Execution authorizations are short-lived, so revoke malformed legacy rows and
-- remove their unsafe JSON instead of trying to reinterpret it.
UPDATE "capability_execution_authorizations"
SET "revoked_at" = coalesce("revoked_at", now()), "limits" = '[]'::jsonb, "updated_at" = now()
WHERE jsonb_typeof("limits") <> 'array'
   OR jsonb_path_exists("limits", '$[*] ? (@.type() != "object" || !exists(@.tool) || @.tool.type() != "string" || !exists(@.key) || @.key.type() != "string" || !exists(@.value) || (@.value.type() != "number" && @.value.type() != "boolean"))')
   OR jsonb_path_exists("limits", '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "tool" && @.key != "key" && @.key != "value")');--> statement-breakpoint
-- Refuse the DDL only if the explicit cleanup above failed to leave a state the
-- new binaries can interpret exactly.
DO $$
DECLARE invalid_delegation_limits bigint;
DECLARE invalid_authorization_limits bigint;
DECLARE invalid_audit_events bigint;
BEGIN
  SELECT count(*) INTO invalid_delegation_limits
  FROM "delegation_limits"
  WHERE jsonb_typeof("value") NOT IN ('number', 'boolean');

  SELECT count(*) INTO invalid_authorization_limits
  FROM "capability_execution_authorizations"
  WHERE jsonb_typeof("limits") <> 'array'
     OR jsonb_path_exists("limits", '$[*] ? (@.type() != "object" || !exists(@.tool) || @.tool.type() != "string" || !exists(@.key) || @.key.type() != "string" || !exists(@.value) || (@.value.type() != "number" && @.value.type() != "boolean"))')
     OR jsonb_path_exists("limits", '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "tool" && @.key != "key" && @.key != "value")');

  SELECT count(*) INTO invalid_audit_events
  FROM "capability_audit_events"
  WHERE jsonb_typeof("event") <> 'object'
     OR jsonb_typeof("event" -> 'result') <> 'object'
     OR ("event" -> 'result' ? 'message')
     OR jsonb_typeof("event" -> 'correlation') <> 'object'
     OR ("event" -> 'correlation' ? 'idempotencyKey')
     OR ("event" #>> '{correlation,idempotencyKeyHash}' IS NOT NULL
       AND "event" #>> '{correlation,idempotencyKeyHash}' !~ '^[a-f0-9]{64}$')
     OR jsonb_path_exists("event", '$.** ? (@.type() == "object").keyvalue() ? (@.key == "prompt" || @.key == "completion" || @.key == "payload" || @.key == "toolArguments" || @.key == "toolInput" || @.key == "toolOutput" || @.key == "rawRequest" || @.key == "rawResponse" || @.key == "messageBody" || @.key == "messageContent" || @.key == "modelOutput")');

  IF invalid_delegation_limits > 0 OR invalid_authorization_limits > 0 OR invalid_audit_events > 0 THEN
    RAISE EXCEPTION
      'agency payload-bound migration refused: delegation_limits=%, authorization_limits=%, audit_events=%',
      invalid_delegation_limits, invalid_authorization_limits, invalid_audit_events;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "capability_audit_events" ADD CONSTRAINT "capability_audit_events_bounded_event_check" CHECK (jsonb_typeof("capability_audit_events"."event") = 'object'
        and jsonb_typeof("capability_audit_events"."event" -> 'result') = 'object'
        and not ("capability_audit_events"."event" -> 'result' ? 'message')
        and jsonb_typeof("capability_audit_events"."event" -> 'correlation') = 'object'
        and not ("capability_audit_events"."event" -> 'correlation' ? 'idempotencyKey')
        and ("capability_audit_events"."event" #>> '{correlation,idempotencyKeyHash}' is null or "capability_audit_events"."event" #>> '{correlation,idempotencyKeyHash}' ~ '^[a-f0-9]{64}$')
        and not jsonb_path_exists("capability_audit_events"."event", '$.** ? (@.type() == "object").keyvalue() ? (@.key == "prompt" || @.key == "completion" || @.key == "payload" || @.key == "toolArguments" || @.key == "toolInput" || @.key == "toolOutput" || @.key == "rawRequest" || @.key == "rawResponse" || @.key == "messageBody" || @.key == "messageContent" || @.key == "modelOutput")'));--> statement-breakpoint
ALTER TABLE "capability_execution_authorizations" ADD CONSTRAINT "capability_execution_authorizations_limits_check" CHECK (jsonb_typeof("capability_execution_authorizations"."limits") = 'array'
        and not jsonb_path_exists("capability_execution_authorizations"."limits", '$[*] ? (@.type() != "object" || !exists(@.tool) || @.tool.type() != "string" || !exists(@.key) || @.key.type() != "string" || !exists(@.value) || (@.value.type() != "number" && @.value.type() != "boolean"))')
        and not jsonb_path_exists("capability_execution_authorizations"."limits", '$[*] ? (@.type() == "object").keyvalue() ? (@.key != "tool" && @.key != "key" && @.key != "value")'));--> statement-breakpoint
ALTER TABLE "delegation_limits" ADD CONSTRAINT "delegation_limits_scalar_value_check" CHECK (jsonb_typeof("delegation_limits"."value") in ('number', 'boolean'));
