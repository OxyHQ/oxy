/**
 * Guaranteed retry of federated avatar mirrors that failed.
 *
 * A failed mirror that leaves a federated user without a stored picture sets
 * `users.federation_avatar_retry_at` (see `persistFederatedAvatar`). This sweep
 * claims the due rows, re-derives each user's CURRENT picture URL from its
 * source profile (the stored URL may be stale or expired — that is how
 * ibaillanos@instagram.com broke), and mirrors it. Every outcome goes back
 * through `persistFederatedAvatar`, which clears the debt on success or
 * reschedules it with backoff.
 *
 * Politeness in bulk: bounded concurrency, the cluster-wide per-origin request
 * gap for both the source-profile fetch (`actor` namespace) and the picture
 * download (`avatar` namespace), and the 429 cooldown the downloader records.
 */
import { and, asc, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { logger } from '../../utils/logger';
import userCache from '../../utils/userCache';
import { persistFederatedAvatar } from '../../utils/federatedAvatar';
import { federationService, storedAvatarFileId, type AvatarDownloadResult } from '../federation.service';
import { acquireAvatarOriginLease } from './avatarFetchBackpressure';
import { fetchInstagramGraphProfile, instagramGraphUserIdFromActorUri } from './instagramGraph';

/** A claimed row is re-claimable after this if the process dies mid-retry. */
const CLAIM_LEASE_MINUTES = 30;
/** Longest a source-profile fetch waits for its origin's request gap. */
const SOURCE_ORIGIN_MAX_WAIT_MS = 30_000;

export type AvatarRetryOutcome =
  | { state: 'mirrored'; source: 'remote' | 'instagram_graph' | undefined; host: string }
  | { state: 'no_source_picture' }
  | { state: 'failed'; permanent: boolean; reason: string; host?: string; httpStatus?: number }
  | { state: 'skipped'; reason: 'not_federated' | 'archived' | 'already_mirrored' };

export interface AvatarRetrySweepSummary {
  claimed: number;
  mirrored: number;
  mirroredFromGraph: number;
  noSourcePicture: number;
  failedTransient: number;
  failedPermanent: number;
  skipped: number;
  byReason: Record<string, number>;
  byHost: Record<string, number>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

async function waitForSourceOrigin(url: string): Promise<boolean> {
  if (!/^https:\/\//.test(url)) return true;
  const deadline = Date.now() + SOURCE_ORIGIN_MAX_WAIT_MS;
  for (;;) {
    const waitMs = await acquireAvatarOriginLease(url, 'actor');
    if (waitMs <= 0) return true;
    if (Date.now() + waitMs > deadline) return false;
    await sleep(waitMs + Math.floor(Math.random() * 250));
  }
}

/** The user's current source picture URL, re-read from its source profile. */
async function currentSourcePicture(actorUri: string, username: string | null): Promise<{ ok: true; url?: string } | { ok: false }> {
  const graphUserId = instagramGraphUserIdFromActorUri(actorUri);
  if (graphUserId) {
    const lookup = await fetchInstagramGraphProfile(username ?? '');
    if (!lookup.ok || lookup.profile.actorUri !== actorUri) return { ok: false };
    return { ok: true, url: lookup.profile.avatarUrl };
  }
  if (actorUri.startsWith('did:')) {
    const profile = await federationService.fetchAtprotoProfile(actorUri);
    return profile ? { ok: true, url: profile.avatarUrl } : { ok: false };
  }
  if (!(await waitForSourceOrigin(actorUri))) return { ok: false };
  const profile = await federationService.fetchActorProfile(actorUri, username ?? undefined);
  if (!profile || profile.actorUri !== actorUri) return { ok: false };
  return { ok: true, url: profile.avatarUrl };
}

/**
 * Re-derive one federated user's source picture and mirror it, persisting the
 * outcome (success clears the debt; failure reschedules it with backoff).
 */
export async function retryFederatedAvatar(userId: string): Promise<AvatarRetryOutcome> {
  const [user] = await getDb().select({
    type: users.type, accountStatus: users.accountStatus, username: users.username, actorUri: users.federationActorUri,
    avatar: users.avatar, etag: users.federationAvatarETag, lastModified: users.federationAvatarLastModified,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.type !== 'federated' || !user.actorUri) {
    if (user) await getDb().update(users).set({ federationAvatarRetryAt: null }).where(eq(users.id, userId));
    return { state: 'skipped', reason: 'not_federated' };
  }
  if (user.accountStatus === 'archived') {
    await getDb().update(users).set({ federationAvatarRetryAt: null }).where(eq(users.id, userId));
    return { state: 'skipped', reason: 'archived' };
  }

  const source = await currentSourcePicture(user.actorUri, user.username);
  const now = new Date();
  if (!source.ok) {
    await persistFederatedAvatar(userId, { failed: 'source_unavailable', permanent: false });
    return { state: 'failed', permanent: false, reason: 'source_unavailable', host: hostOf(user.actorUri) };
  }
  if (!source.url) {
    await persistFederatedAvatar(userId, 'no_source_picture');
    userCache.invalidate(userId);
    return { state: 'no_source_picture' };
  }

  const existing = storedAvatarFileId(user.avatar);
  const stored: AvatarDownloadResult = await federationService.mirrorFederatedAvatar(userId, source.url, existing, existing
    ? { etag: user.etag ?? undefined, lastModified: user.lastModified ?? undefined }
    : undefined);
  const host = hostOf(source.url);
  if (stored.notModified && existing) {
    // Our stored file is current: the debt is settled.
    await persistFederatedAvatar(userId, { fileId: existing }, { federationLastAvatarFetchedAt: now });
    return { state: 'skipped', reason: 'already_mirrored' };
  }
  if (stored.fileId) {
    await persistFederatedAvatar(userId, { fileId: stored.fileId }, {
      federationLastAvatarFetchedAt: now,
      federationAvatarETag: stored.etag ?? null,
      federationAvatarLastModified: stored.lastModified ?? null,
    });
    userCache.invalidate(userId);
    return { state: 'mirrored', source: stored.source, host: host ?? '' };
  }
  const reason = stored.reason ?? 'unexpected';
  const permanent = stored.failure === 'permanent';
  await persistFederatedAvatar(userId, { failed: reason, permanent }, { federationLastAvatarFetchedAt: now });
  return { state: 'failed', permanent, reason, host, httpStatus: stored.httpStatus };
}

/**
 * Claim up to `limit` due rows, pushing their `retry_at` forward by a lease so a
 * concurrent sweep (another replica) skips them and a crash re-offers them.
 */
export async function claimDueAvatarRetries(limit: number): Promise<string[]> {
  const due = getDb().select({ id: users.id }).from(users)
    .where(and(isNotNull(users.federationAvatarRetryAt), lte(users.federationAvatarRetryAt, sql`now()`),
      eq(users.type, 'federated'), ne(users.accountStatus, 'archived')))
    .orderBy(asc(users.federationAvatarRetryAt))
    .limit(limit)
    .for('update', { skipLocked: true });
  const claimed = await getDb().update(users)
    .set({ federationAvatarRetryAt: sql`now() + make_interval(mins => ${sql.raw(String(CLAIM_LEASE_MINUTES))})` })
    .where(inArray(users.id, due))
    .returning({ id: users.id });
  return claimed.map((row) => row.id);
}

function tally(summary: AvatarRetrySweepSummary, outcome: AvatarRetryOutcome): void {
  if (outcome.state === 'mirrored') {
    summary.mirrored += 1;
    if (outcome.source === 'instagram_graph') summary.mirroredFromGraph += 1;
  } else if (outcome.state === 'no_source_picture') {
    summary.noSourcePicture += 1;
  } else if (outcome.state === 'skipped') {
    summary.skipped += 1;
  } else {
    if (outcome.permanent) summary.failedPermanent += 1; else summary.failedTransient += 1;
    const key = outcome.httpStatus ? `${outcome.reason}:${outcome.httpStatus}` : outcome.reason;
    summary.byReason[key] = (summary.byReason[key] ?? 0) + 1;
    if (outcome.host) summary.byHost[outcome.host] = (summary.byHost[outcome.host] ?? 0) + 1;
  }
}

export function emptySweepSummary(): AvatarRetrySweepSummary {
  return { claimed: 0, mirrored: 0, mirroredFromGraph: 0, noSourcePicture: 0, failedTransient: 0, failedPermanent: 0,
    skipped: 0, byReason: {}, byHost: {} };
}

/**
 * One sweep: claim due rows in batches and retry them with bounded concurrency,
 * until nothing is due or `maxUsers` have been processed.
 */
export async function runFederatedAvatarRetrySweep(opts: {
  maxUsers?: number; batchSize?: number; concurrency?: number;
  log?: (line: string) => void; summary?: AvatarRetrySweepSummary;
} = {}): Promise<AvatarRetrySweepSummary> {
  const maxUsers = opts.maxUsers ?? 200;
  const batchSize = Math.min(opts.batchSize ?? 50, maxUsers);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 16));
  const summary = opts.summary ?? emptySweepSummary();
  let processed = 0;
  while (processed < maxUsers) {
    const ids = await claimDueAvatarRetries(Math.min(batchSize, maxUsers - processed));
    if (ids.length === 0) break;
    summary.claimed += ids.length;
    processed += ids.length;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      while (next < ids.length) {
        const userId = ids[next++];
        let outcome: AvatarRetryOutcome;
        try {
          outcome = await retryFederatedAvatar(userId);
        } catch (err) {
          logger.warn('Federated avatar retry threw', { userId, error: err instanceof Error ? err.message : String(err) });
          outcome = { state: 'failed', permanent: false, reason: 'unexpected' };
        }
        tally(summary, outcome);
        opts.log?.(JSON.stringify({ userId, ...outcome }));
      }
    }));
  }
  return summary;
}

/**
 * Owe a retry, due now, to every federated user left WITHOUT a stored picture by
 * a mirror attempt (the fetch clock is set only by an attempt). The recovery
 * entry point for rows cleared before retries were durable. Returns the count.
 */
export async function queueRecoveryForAvatarlessFederatedUsers(apply: boolean): Promise<number> {
  const owed = and(eq(users.type, 'federated'), ne(users.accountStatus, 'archived'),
    sql`${users.avatar} is null`, isNotNull(users.federationLastAvatarFetchedAt));
  if (!apply) {
    const [row] = await getDb().select({ count: sql<number>`count(*)::int` }).from(users).where(owed);
    return row?.count ?? 0;
  }
  const queued = await getDb().update(users)
    .set({ federationAvatarRetryAt: sql`now()`, federationAvatarAttempts: 0 })
    .where(owed)
    .returning({ id: users.id });
  return queued.length;
}
