import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applications, fileRenditionRequests } from '../db/schema';
import { VIDEO_RENDITION_PROFILE } from '../services/video-renditions';
import { logger } from '../utils/logger';

type Candidate = {
  file_id: string;
  sha256: string;
  visibility: string;
  orientation_rank: number;
};

/** One application, one representative per content/spelling, bounded pages into the existing backlog. */
export async function seedVideoRenditionBacklog(options: {
  applicationId: string;
  dryRun?: boolean;
  limit?: number;
  maxGroups?: number;
  after?: string;
}) {
  const { applicationId, dryRun = true, limit = 1_000, maxGroups = 1_000, after } = options;
  if (!applicationId) throw new Error('An application ID is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
    throw new Error('limit must be 1–1000');
  if (!Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > 100_000)
    throw new Error('maxGroups must be 1–100000');
  if (after && !/^[01]:[0-9a-f]{64}:(public|private|unlisted)$/.test(after))
    throw new Error('Invalid backlog cursor');
  const db = getDb();
  const [application] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.status, 'active')))
    .limit(1);
  if (!application) throw new Error('Application is not active');

  let nextCursor = after;
  let considered = 0;
  let inserted = 0;
  let promoted = 0;
  let exhausted = false;
  while (considered < maxGroups) {
    const [rank, hash, visibility] = nextCursor?.split(':') ?? [];
    const cursorPredicate = nextCursor
      ? sql`(orientation_rank, sha256, visibility) > (${Number(rank)}, ${hash}, ${visibility})`
      : sql`true`;
    const candidates = await db.execute<Candidate>(sql`
      with candidates as (
        select min(f.id) as file_id, f.sha256, f.visibility,
          min(case when jsonb_typeof(f.metadata->'media'->'width') = 'number'
            and jsonb_typeof(f.metadata->'media'->'height') = 'number'
            and f.metadata->'media'->'height' > f.metadata->'media'->'width'
            then 0 else 1 end)::int as orientation_rank
        from files f
        where f.status = 'active' and f.mime like 'video/%'
          and (f.owner_application_id = ${applicationId} or exists (
            select 1 from file_references r
            where r.file_id = f.id and r.application_id = ${applicationId}))
          and not exists (select 1 from file_variants v where v.file_id = f.id
            and v.type = 'hls_master' and v.ready_at is not null
            and v.metadata->>'encodingProfile' = ${VIDEO_RENDITION_PROFILE})
        group by f.sha256, f.visibility
      ) select * from candidates where ${cursorPredicate}
      order by orientation_rank, sha256, visibility
      limit ${Math.min(limit, maxGroups - considered)}`);
    if (candidates.length === 0) {
      exhausted = true;
      break;
    }
    // Separate portrait/other pages: normal request timestamps put portraits
    // ahead without inventing dates or changing the scheduler's upload priority.
    const page = candidates.filter(
      (row) => row.orientation_rank === candidates[0].orientation_rank,
    );
    if (!dryRun) {
      await db.transaction(async (tx) => {
        const written = await tx
          .insert(fileRenditionRequests)
          .values(
            page.map((row) => ({
              fileId: row.file_id,
              lane: 'repair' as const,
              requestedAt: sql`date_trunc('milliseconds', now())`,
            })),
          )
          .onConflictDoNothing()
          .returning({ fileId: fileRenditionRequests.fileId });
        // An already requested legacy file must join the repair lane too. Keep
        // its timestamp/lease intact, and never demote a user's fresh request.
        const moved = await tx
          .update(fileRenditionRequests)
          .set({ lane: 'repair' })
          .where(
            and(
              inArray(
                fileRenditionRequests.fileId,
                page.map((row) => row.file_id),
              ),
              eq(fileRenditionRequests.lane, 'bulk'),
            ),
          )
          .returning({ fileId: fileRenditionRequests.fileId });
        inserted += written.length;
        promoted += moved.length;
      });
    }
    considered += page.length;
    const last = page[page.length - 1];
    nextCursor = `${last.orientation_rank}:${last.sha256}:${last.visibility}`;
    logger.info('Video rendition backlog page', {
      applicationId,
      dryRun,
      considered,
      inserted,
      promoted,
      nextCursor,
    });
  }
  return {
    applicationId,
    dryRun,
    considered,
    inserted,
    promoted,
    alreadyPending: dryRun ? 0 : considered - inserted,
    nextCursor,
    reachedLimit: !exhausted && considered === maxGroups,
  };
}
