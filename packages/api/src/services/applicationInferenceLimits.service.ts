/**
 * Read and write the inference limits an application's owner sets in Console
 * (`application_inference_limits`, Alia ADR 0017 §5). The grant API applies
 * them; nothing else reads them.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applicationInferenceLimits } from '../db/schema/applicationInferenceLimits';

/** Every limit, `null` where the application set none. */
export interface ApplicationInferenceLimits {
  readonly maxConcurrentRealtimeSessions: number | null;
  readonly maxConcurrentRealtimeSessionsPerCredential: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly maxRequestsPerUtcDay: number | null;
}

export const NO_APPLICATION_INFERENCE_LIMITS: ApplicationInferenceLimits = {
  maxConcurrentRealtimeSessions: null,
  maxConcurrentRealtimeSessionsPerCredential: null,
  maxConcurrentRequests: null,
  maxRequestsPerUtcDay: null,
};

export async function readApplicationInferenceLimits(
  applicationId: string,
): Promise<ApplicationInferenceLimits> {
  const [row] = await getDb()
    .select({
      maxConcurrentRealtimeSessions: applicationInferenceLimits.maxConcurrentRealtimeSessions,
      maxConcurrentRealtimeSessionsPerCredential:
        applicationInferenceLimits.maxConcurrentRealtimeSessionsPerCredential,
      maxConcurrentRequests: applicationInferenceLimits.maxConcurrentRequests,
      maxRequestsPerUtcDay: applicationInferenceLimits.maxRequestsPerUtcDay,
    })
    .from(applicationInferenceLimits)
    .where(eq(applicationInferenceLimits.applicationId, applicationId))
    .limit(1);
  return row ?? NO_APPLICATION_INFERENCE_LIMITS;
}

/**
 * Replace an application's limits whole. A field sent as `null` clears that
 * limit; the database's CHECKs (range, per-credential ≤ per-application) are
 * the last word, and the route validates the same rules first so a caller gets
 * a 400 rather than a constraint error.
 */
export async function writeApplicationInferenceLimits(
  applicationId: string,
  limits: ApplicationInferenceLimits,
  updatedByAccountId: string,
): Promise<ApplicationInferenceLimits> {
  const values = { ...limits, updatedByAccountId, updatedAt: new Date() };
  await getDb()
    .insert(applicationInferenceLimits)
    .values({ applicationId, ...values })
    .onConflictDoUpdate({ target: applicationInferenceLimits.applicationId, set: values });
  return readApplicationInferenceLimits(applicationId);
}
