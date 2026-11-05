/**
 * Registered-account aggregate for one first-party deployment.
 *
 * A federated product (Mention's NodeInfo `usage.users.total`) needs "how many
 * people registered on THIS deployment". Oxy accounts are global, so the
 * deployment registers the accounts it provisions and Oxy answers with a bounded
 * aggregate. Both calls are made by the deployment's own workload; the
 * application is the workload's, never a request field, so a managed instance
 * and the main deployment never see each other's rows or counts.
 */

import { z } from 'zod';

/** Most account ids one registration call accepts. */
export const APPLICATION_ACCOUNT_REGISTRATION_BATCH_MAX = 500;

/** Seconds a total is considered fresh; a later `computedAt` is served `stale: true`. */
export const APPLICATION_ACCOUNT_TOTAL_MAX_AGE_SECONDS = 300;

export const applicationAccountRegistrationRequestSchema = z.strictObject({
  accountIds: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(APPLICATION_ACCOUNT_REGISTRATION_BATCH_MAX),
});
export type ApplicationAccountRegistrationRequest = z.infer<
  typeof applicationAccountRegistrationRequestSchema
>;

/**
 * Aggregate only. `registered` is how many ids became newly registered; ids that
 * were already registered, unknown or ineligible are not distinguished.
 */
export const applicationAccountRegistrationResponseSchema = z.strictObject({
  registered: z.number().int().nonnegative(),
});
export type ApplicationAccountRegistrationResponse = z.infer<
  typeof applicationAccountRegistrationResponseSchema
>;

/**
 * The eligible registered-account total.
 *
 * - `total`: registered accounts that are local, personal, active and not being
 *   closed, as of `computedAt`. Unknown is an error response, never `0`.
 * - `exact`: `true` when `total` is an exact count of the ledger at
 *   `computedAt`; `false` would mark an estimate. This version always counts
 *   exactly, so it is `true`; clients must still read the flag.
 * - `stale`: `computedAt` is older than `maxAgeSeconds`. A refresh is in flight
 *   or has failed; the number is the last good one, not a fabricated zero.
 */
export const applicationAccountTotalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  applicationId: z.string().min(1),
  total: z.number().int().nonnegative(),
  exact: z.boolean(),
  computedAt: z.string().datetime(),
  maxAgeSeconds: z.number().int().positive(),
  stale: z.boolean(),
});
export type ApplicationAccountTotal = z.infer<typeof applicationAccountTotalSchema>;
