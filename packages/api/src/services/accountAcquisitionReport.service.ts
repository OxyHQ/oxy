import { sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';

/** Bounded UTC interval; aggregate reporting never returns account or click IDs. */
export function validateAcquisitionReportRange(from: string, to: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const start = new Date(from);
  const end = new Date(to);
  if (
    !date.test(from) ||
    !date.test(to) ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start.toISOString().slice(0, 10) !== from ||
    end.toISOString().slice(0, 10) !== to ||
    end <= start ||
    end.getTime() - start.getTime() > 366 * 86_400_000
  )
    throw new Error('Expected a valid UTC date interval of at most 366 days');
  return { from: start, to: end };
}

/** Operator-only read model. No HTTP endpoint or user-profile projection. */
export async function reportAccountAcquisition(from: string, to: string) {
  const range = validateAcquisitionReportRange(from, to);
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`set local statement_timeout = '15s'`);
    return tx.execute<{
      day: string;
      source: string | null;
      medium: string | null;
      campaign: string | null;
      signups: number;
    }>(sql`
      select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
        utm_source as source, utm_medium as medium, utm_campaign as campaign,
        count(*)::int as signups
      from account_acquisition
      where created_at >= ${range.from.toISOString()} and created_at < ${range.to.toISOString()}
      group by day, utm_source, utm_medium, utm_campaign
      order by day, source nulls last, medium nulls last, campaign nulls last
    `);
  });
}
