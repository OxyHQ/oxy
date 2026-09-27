#!/usr/bin/env bun
/**
 * One-time repair: federated users whose `users.avatar` is a raw remote URL
 * instead of an Oxy Cloud file id.
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
 * Behavior (per row, `type = 'federated' and avatar ~* '^https?://'`):
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

import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { closeRedis, getRedisClient } from '../config/redis';
import { users } from '../db/schema/users';
import { federationService, isExpiredSignedAvatarUrl } from '../services/federation.service';
import userCache from '../utils/userCache';

export interface RepairFederatedAvatarsResult {
  apply: boolean;
  scanned: number;
  /** Rows whose URL is a Meta CDN URL already past its signed `oe` expiry. */
  expiredSigned: number;
  byHost: Record<string, number>;
  mirrored: number;
  mirroredFromGraph: number;
  cleared: number;
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

const REMOTE_AVATAR = sql`${users.avatar} ~* '^https?://'`;

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
    cleared: 0, changedConcurrently: 0, after: opts.after ?? '',
  };

  for (;;) {
    const rows = await getDb()
      .select({ id: users.id, username: users.username, avatar: users.avatar })
      .from(users)
      .where(and(eq(users.type, 'federated'), REMOTE_AVATAR, result.after ? gt(users.id, result.after) : undefined))
      .orderBy(asc(users.id))
      .limit(batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      result.after = row.id;
      const remoteUrl = row.avatar;
      if (!remoteUrl) continue;
      result.scanned += 1;
      const host = hostOf(remoteUrl);
      result.byHost[host] = (result.byHost[host] ?? 0) + 1;
      const expired = isExpiredSignedAvatarUrl(remoteUrl);
      if (expired) result.expiredSigned += 1;
      if (!apply) {
        log(JSON.stringify({ userId: row.id, username: row.username, host, expiredSigned: expired, action: 'would_repair' }));
        continue;
      }

      const stored = await federationService.mirrorFederatedAvatar(row.id, remoteUrl);
      const now = new Date();
      const written = stored.fileId
        ? await getDb().update(users).set({
          avatar: stored.fileId,
          federationLastAvatarFetchedAt: now,
          federationAvatarETag: stored.etag ?? null,
          federationAvatarLastModified: stored.lastModified ?? null,
        }).where(and(eq(users.id, row.id), eq(users.avatar, remoteUrl))).returning({ id: users.id })
        : await getDb().update(users).set({ avatar: null, federationLastAvatarFetchedAt: now })
          .where(and(eq(users.id, row.id), eq(users.avatar, remoteUrl))).returning({ id: users.id });

      if (written.length === 0) {
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
        log(JSON.stringify({ userId: row.id, host, action: 'cleared', failure: stored.failure }));
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
