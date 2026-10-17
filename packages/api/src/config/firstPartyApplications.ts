/**
 * Exact ids of first-party applications whose authority Oxy's own routes
 * check by id.
 *
 * An id here is a database authority, not a label: a route that admits one
 * application compares these bytes, and `scripts/seedOxyApplicationsSpecs.ts`
 * registers the application under the same id, so a re-seed can never move
 * the authority to another row.
 */

/** Clarity's public, signed-in client (clarity.surf and the Clarity apps). */
export const CLARITY_APPLICATION_ID = '01a0646a-2382-74a3-a795-788924d55722';

/**
 * Clarity's BACKEND application: the internal service Clarity's API attests
 * as (ADR 0026, role `oxy-clarity-task`). It is the only caller of Oxy's
 * resource-authority endpoints (`routes/resourceIntrospection.ts`) and the
 * consumer of the `clarity-kaana` metered relationship.
 */
export const CLARITY_BACKEND_APPLICATION_ID = '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e';
