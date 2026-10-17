import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { createAuthorityCache } from '../utils/authorityCache';
import { isTrustedApplication } from '../utils/trustedApplication';

/**
 * Whether an application is active AND in the trusted (first-party) set — the
 * question `/internal` asks on every request.
 *
 * Read through a 5 s per-task authority cache (`utils/authorityCache.ts`): the
 * same few application ids are asked thousands of times a minute, and on
 * 2026-10-16 that uncached read was 12.5 of the 16 AAS that piled up behind a
 * migration's lock on `applications`. Every write that can change the answer
 * (status, type, official/internal flags, deletion) calls
 * {@link invalidateApplicationTrust}, which reaches every task through Redis;
 * the TTL bounds the rest. A failed read is never cached.
 */
const applicationTrustCache = createAuthorityCache<boolean>('application-trust');

export function isActiveTrustedApplication(applicationId: string): Promise<boolean> {
  return applicationTrustCache.get(applicationId, async () => {
    const [app] = await getDb()
      .select({
        type: applications.type,
        isOfficial: applications.isOfficial,
        isInternal: applications.isInternal,
      })
      .from(applications)
      .where(and(eq(applications.id, applicationId), eq(applications.status, 'active')))
      .limit(1);
    return !!app && isTrustedApplication(app);
  });
}

/** Call after any write to an application's status, type or trust flags. */
export function invalidateApplicationTrust(applicationId: string): void {
  applicationTrustCache.invalidate(applicationId);
}
