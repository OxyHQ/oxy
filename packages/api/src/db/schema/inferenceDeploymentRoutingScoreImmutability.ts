/**
 * Database enforcement for the routing scorecard audit trail.
 *
 * Schema support, not a table: import directly and never export from the schema
 * barrel. Drizzle cannot emit triggers, so this is the authoritative copy used
 * to review and test the hand-written DDL in migration 0063.
 */

export const ROUTING_SCORE_EVENT_TABLE = 'inference_deployment_routing_score_events';
export const ROUTING_SCORE_EVENT_TRIGGER =
  'inference_deployment_routing_score_events_immutable';
export const ROUTING_SCORE_EVENT_FUNCTION = 'inference_routing_score_event_immutable';
export const ROUTING_SCORE_EVENT_IMMUTABLE_MESSAGE =
  `${ROUTING_SCORE_EVENT_TABLE} is append-only: a routing score change is recorded by a new event, never by update`;

export const ROUTING_SCORE_EVENT_IMMUTABILITY_DDL = `CREATE OR REPLACE FUNCTION ${ROUTING_SCORE_EVENT_FUNCTION}() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: a routing score change is recorded by a new event, never by %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '23514';
END;
$$;`;

export const ROUTING_SCORE_EVENT_IMMUTABILITY_TRIGGER_DDL = `CREATE TRIGGER ${ROUTING_SCORE_EVENT_TRIGGER}
BEFORE UPDATE OR DELETE ON ${ROUTING_SCORE_EVENT_TABLE}
FOR EACH ROW EXECUTE FUNCTION ${ROUTING_SCORE_EVENT_FUNCTION}();`;
