#!/usr/bin/env bun
/**
 * One-time repair: federated users whose `users.avatar` is anything but an Oxy
 * Cloud file id — a raw remote URL (any host, any protocol) or another
 * non-file-id value.
 *
 * Why it exists:
 *   `registerExternalIdentity` used to seed the source picture URL as an
 *   "interim" avatar and rely on a background download to replace it. When that
 *   download failed the URL stayed — and was served — forever. Signed Meta CDN
 *   URLs make that fatal: kilogram served ibaillanos@instagram.com a picture URL
 *   signed with `oe=6869EA02` (2025-07-06), which answers 403, so Mention showed
 *   a broken avatar. The registry no longer writes remote URLs; this script
 *   repairs the rows it already wrote.
 *
 * Behavior (per row, `type = 'federated' and avatar is not null and avatar !~ '^[A-Za-z0-9_-]{1,128}$'`):
 *   - Dry run (DEFAULT): writes nothing; reports how many rows, by host, and how
 *     many are Meta CDN URLs already past their signed expiry.
 *   - Apply: re-runs the corrected mirror (`FederationService.mirrorFederatedAvatar`)
 *     — the stored URL when it is still fetchable, else, for instagram.com, a
 *     fresh Business Discovery picture when the Graph fallback is enabled. A
 *     mirrored file id replaces the URL; otherwise the URL is cleared to NULL so
 *     clients show the default avatar, and the next resolve of that user
 *     schedules a mirror of its CURRENT source picture.
 *   - Every write is conditional on the row still holding the URL it read, so a
 *     concurrent mirror is never overwritten, and a second pass finds nothing:
 *     the script is idempotent. Each write invalidates the user cache, which
 *     broadcasts to consuming apps (Mention) when REDIS_URL is set.
 *
 * Recovery mode (`--recover` / MODE=recover): for every federated user left
 * WITHOUT an avatar by a failed mirror, re-fetch its source profile, take the
 * CURRENT picture URL and mirror it, draining the durable retry queue with
 * bounded concurrency (CONCURRENCY, default 4), the per-origin request gap and
 * 429 backoff. Failures stay queued with backoff for the server's retry sweep.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/src/scripts/repair-federated-remote-avatars.ts            # dry run
 *   bun run packages/api/src/scripts/repair-federated-remote-avatars.ts --apply
 *
 * Env:
 *   DATABASE_URL   Postgres (required)
 *   DRY_RUN=false  Same as --apply (the workflow's switch); anything else is a dry run
 *   BATCH_SIZE     Rows per batch (default 200)
 *   AFTER          Resume after this user id (also `--after=<id>`)
 *   REDIS_URL      Optional; enables the cross-app cache invalidation broadcast
 *   AWS_*          Required with --apply (the mirror uploads to Oxy Cloud)
 *   INSTAGRAM_GRAPH_FALLBACK_ENABLED / META_*  Optional Graph fallback config
 */

import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { closeRedis, getRedisClient } from '../config/redis';
import { users } from '../db/schema/users';
import { federationService, isExpiredSignedAvatarUrl } from '../services/federation.service';
import { AVATAR_FILE_ID_SQL_PATTERN, persistFederatedAvatar } from '../utils/federatedAvatar';
import userCache from '../utils/userCache';
import { queueRecoveryForAvatarlessFederatedUsers, runFederatedAvatarRetrySweep } from '../services/federation/avatarRetry';

export interface RepairFederatedAvatarsResult {
  apply: boolean;
  scanned: number;
  /** Rows whose URL is a Meta CDN URL already past its signed `oe` expiry. */
  expiredSigned: number;
  byHost: Record<string, number>;
  mirrored: number;
  mirroredFromGraph: number;
  cleared: number;
  /** Cleared rows by `<failure>:<reason>[:<http status>]`; every one of them is owed a retry. */
  byReason: Record<string, number>;
  /** Rows another writer changed between read and write; left as they are. */
  changedConcurrently: number;
  /** Resume cursor: the last user id visited. */
  after: string;
}

export interface RepairFederatedAvatarsOptions {
  apply?: boolean;
  batchSize?: number;
  after?: string;
  log?: (line: string) => void;
}

/** Everything the write boundary would refuse: the rows owed a repair. */
const NOT_A_FILE_ID = and(isNotNull(users.avatar), sql`${users.avatar} !~ ${sql.raw(`'${AVATAR_FILE_ID_SQL_PATTERN}'`)}`);

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return '(unparseable)'; }
}

export async function repairFederatedRemoteAvatars(
  opts: RepairFederatedAvatarsOptions = {},
): Promise<RepairFederatedAvatarsResult> {
  const apply = opts.apply === true;
  const batchSize = opts.batchSize ?? 200;
  const log = opts.log ?? (() => undefined);
  const result: RepairFederatedAvatarsResult = {
    apply, scanned: 0, expiredSigned: 0, byHost: {}, mirrored: 0, mirroredFromGraph: 0,
    cleared: 0, byReason: {}, changedConcurrently: 0, after: opts.after ?? '',
  };

  for (;;) {
    const rows = await getDb()
      .select({ id: users.id, username: users.username, avatar: users.avatar })
      .from(users)
      .where(and(eq(users.type, 'federated'), NOT_A_FILE_ID, result.after ? gt(users.id, result.after) : undefined))
      .orderBy(asc(users.id))
      .limit(batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      result.after = row.id;
      const remoteUrl = row.avatar;
      if (remoteUrl === null) continue;
      result.scanned += 1;
      const host = hostOf(remoteUrl);
      result.byHost[host] = (result.byHost[host] ?? 0) + 1;
      const expired = isExpiredSignedAvatarUrl(remoteUrl);
      if (expired) result.expiredSigned += 1;
      if (!apply) {
        log(JSON.stringify({ userId: row.id, username: row.username, host, expiredSigned: expired, action: 'would_repair' }));
        continue;
      }

      // Only an https URL can be mirrored; any other value is simply cleared.
      const stored = remoteUrl.startsWith('https://')
        ? await federationService.mirrorFederatedAvatar(row.id, remoteUrl)
        : { fileId: null, notModified: false, failure: 'permanent' as const, reason: 'not_https' as const, source: undefined, etag: undefined, lastModified: undefined, httpStatus: undefined };
      const now = new Date();
      const written = stored.fileId
        ? await persistFederatedAvatar(row.id, { fileId: stored.fileId }, {
          federationLastAvatarFetchedAt: now,
          federationAvatarETag: stored.etag ?? null,
          federationAvatarLastModified: stored.lastModified ?? null,
        }, remoteUrl)
        // A failure clears the URL AND owes a retry (the sweep re-derives the
        // source picture), so a transient failure is never a lost avatar.
        : await persistFederatedAvatar(row.id, { failed: stored.reason ?? 'unexpected', permanent: stored.failure === 'permanent' },
          { federationLastAvatarFetchedAt: now }, remoteUrl);

      if (!written) {
        result.changedConcurrently += 1;
        log(JSON.stringify({ userId: row.id, host, action: 'changed_concurrently' }));
        continue;
      }
      userCache.invalidate(row.id);
      if (stored.fileId) {
        result.mirrored += 1;
        if (stored.source === 'instagram_graph') result.mirroredFromGraph += 1;
        log(JSON.stringify({ userId: row.id, host, action: 'mirrored', source: stored.source }));
      } else {
        result.cleared += 1;
        const key = `${stored.failure ?? 'transient'}:${stored.reason ?? 'unexpected'}${stored.httpStatus ? `:${stored.httpStatus}` : ''}`;
        result.byReason[key] = (result.byReason[key] ?? 0) + 1;
        log(JSON.stringify({ userId: row.id, host, action: 'cleared_retry_owed', failure: stored.failure, reason: stored.reason, httpStatus: stored.httpStatus }));
      }
    }
  }
  return result;
}

/** Wait (bounded) for the shared Redis client, so invalidations are broadcast. */
async function redisReady(timeoutMs = 10_000): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;
  const deadline = Date.now() + timeoutMs;
  while (redis.status !== 'ready' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return redis.status === 'ready';
}

/** The report IS the output of this one-shot: one JSON line per row, then a summary. */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply') || (process.env.DRY_RUN ?? '').trim().toLowerCase() === 'false';
  const afterArg = argv.find((value) => value.startsWith('--after='))?.slice('--after='.length);
  const batchSize = Number.parseInt(process.env.BATCH_SIZE ?? '', 10);
  await connectPostgres();
  try {
    const broadcasting = apply ? await redisReady() : false;
    if (apply && !broadcasting) {
      print(JSON.stringify({ warning: 'redis_unavailable', effect: 'consumer caches expire by TTL instead of an immediate eviction' }));
    }
    if (argv.includes('--recover') || (process.env.MODE ?? '').trim() === 'recover') {
      // Recovery: re-derive the CURRENT source picture of every federated user
      // left without an avatar by a failed mirror, and mirror it. Dry run
      // reports how many are owed; apply queues them all as due now and drains
      // the retry sweep (bounded concurrency, per-origin gap, 429 backoff).
      const owed = await queueRecoveryForAvatarlessFederatedUsers(apply);
      print(JSON.stringify({ mode: 'recover', apply, owed }));
      if (apply) {
        const concurrency = Number.parseInt(process.env.CONCURRENCY ?? '', 10);
        const summary = await runFederatedAvatarRetrySweep({
          maxUsers: Number.MAX_SAFE_INTEGER,
          batchSize: Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 50,
          concurrency: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 4,
          log: print,
        });
        print(JSON.stringify({ summary: { mode: 'recover', owed, ...summary } }));
      }
      return;
    }
    const result = await repairFederatedRemoteAvatars({
      apply,
      batchSize: Number.isInteger(batchSize) && batchSize > 0 ? batchSize : undefined,
      after: afterArg ?? process.env.AFTER ?? undefined,
      log: print,
    });
    print(JSON.stringify({ summary: result }));
  } finally {
    try { await closePostgres(); } finally { await closeRedis(); }
  }
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error(`Federated avatar repair failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }).then(async () => {
    await Promise.all([process.stdout, process.stderr].map((stream) =>
      new Promise<void>((resolve) => { stream.write('', () => resolve()); })));
    process.exit(process.exitCode ?? 0);
  });
}
