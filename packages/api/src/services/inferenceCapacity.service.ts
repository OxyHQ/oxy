import { executeRows, type SqlExecutor } from '@oxy.so/db';
import type { InferenceEnvironment } from '@oxy.so/contracts';
import { sql } from 'drizzle-orm';
import { inferenceMeteredUsage } from '../db/schema/inferenceMeteredUsage';

/**
 * The endpoint every realtime session's usage row is recorded under. A session
 * holds its slot for its whole life, so it is counted apart from one-shot
 * requests: against the application's session limits, never against an
 * internal relationship's request concurrency (Alia ADR 0017 §5).
 */
export const REALTIME_SESSION_ENDPOINT = '/v1/realtime';

/** Read the exact admission population; the caller decides whether to lock it. */
export async function readMeteredCapacity(
  executor: SqlExecutor,
  applicationId: string,
  environment: InferenceEnvironment,
  relationshipId?: string,
  delegatedUserId?: string,
): Promise<{ activeAdmissions: number; dailyAdmissions: number; userDailyAdmissions: number }> {
  const [counts] = await executeRows<{ in_flight: string; today: string; user_today: string }>(
    executor,
    sql`
      select
        count(*) filter (where ${inferenceMeteredUsage.status} = 'admitted'
          and ${inferenceMeteredUsage.expiresAt} > now()
          and ${inferenceMeteredUsage.endpoint} <> ${REALTIME_SESSION_ENDPOINT})::text as in_flight,
        count(*) filter (where ${inferenceMeteredUsage.createdAt}
          >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc'))::text as today,
        count(*) filter (where ${inferenceMeteredUsage.createdAt}
          >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
          and ${inferenceMeteredUsage.delegatedUserId} = ${delegatedUserId ?? null})::text as user_today
      from ${inferenceMeteredUsage}
      where ${inferenceMeteredUsage.applicationId} = ${applicationId}
        and ${inferenceMeteredUsage.environment} = ${environment}
        and ${relationshipId === undefined ? sql`true` : sql`${inferenceMeteredUsage.economicRelationshipId} = ${relationshipId}`}
        and ${inferenceMeteredUsage.status} <> 'refused'
        and ${inferenceMeteredUsage.createdAt} >= now() - interval '2 days'
    `,
  );
  return {
    activeAdmissions: Number(counts?.in_flight ?? 0),
    dailyAdmissions: Number(counts?.today ?? 0),
    userDailyAdmissions: Number(counts?.user_today ?? 0),
  };
}
