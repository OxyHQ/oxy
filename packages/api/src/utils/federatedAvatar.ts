/**
 * The write boundary for a FEDERATED user's `users.avatar`.
 *
 * Invariant (every protocol — activitypub, atproto, instagram-graph): the column
 * holds an Oxy Cloud file id or NULL. Never the source's picture URL, whatever
 * its host (fbcdn, cdninstagram, cdn.bsky.app, a Mastodon media host): a remote
 * URL is not Oxy storage, expires or disappears, and was served verbatim — the
 * ibaillanos@instagram.com broken avatar. Every federated avatar write goes
 * through {@link persistFederatedAvatar}, which refuses anything else.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { users } from '../db/schema/users';

/**
 * An Oxy file id: a uuid, a legacy Mongo ObjectId, or another bare token. No
 * scheme, no slash, no dot — so no URL, data URI or path can pass.
 */
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The same rule, as a Postgres regex, for predicates and in-UPDATE guards. */
export const AVATAR_FILE_ID_SQL_PATTERN = '^[A-Za-z0-9_-]{1,128}$';

export function isAvatarFileId(value: unknown): value is string {
  return typeof value === 'string' && FILE_ID.test(value);
}

export class FederatedAvatarWriteRefused extends Error {
  constructor() {
    super('A federated avatar must be an Oxy file id');
    this.name = 'FederatedAvatarWriteRefused';
  }
}

/**
 * `users.avatar` keeping a stored file id and dropping anything else. Computed
 * inside the UPDATE, so a file id a concurrent mirror just stored is kept.
 */
export function avatarKeepingMirror(): SQL<string | null> {
  return sql<
    string | null
  >`case when ${users.avatar} ~ ${sql.raw(`'${AVATAR_FILE_ID_SQL_PATTERN}'`)} then ${users.avatar} else null end`;
}

export type FederatedAvatarWrite =
  /** A mirror just stored in Oxy Cloud. Clears any owed retry. */
  | { fileId: string }
  /**
   * The mirror failed: keep the previous file id, else NULL — and when that
   * leaves the user with NO stored picture, owe a retry (backing off per attempt)
   * that the retry sweep honours by re-deriving the source picture.
   */
  | { failed: string; permanent: boolean }
  /** The source has no picture: keep the previous file id, else NULL; nothing owed. */
  | 'no_source_picture';

/** Backoff for a transient failure: 5 min × 3^attempts, capped at 6 h. */
export const TRANSIENT_RETRY_BASE_SECONDS = 5 * 60;
export const TRANSIENT_RETRY_MAX_SECONDS = 6 * 60 * 60;
/** A permanent failure (dead URL, not an image) is retried daily: the source may change its picture. */
export const PERMANENT_RETRY_SECONDS = 24 * 60 * 60;

function retryState(write: Exclude<FederatedAvatarWrite, { fileId: string }>) {
  const kept = avatarKeepingMirror();
  if (write === 'no_source_picture') {
    return {
      avatar: kept,
      federationAvatarRetryAt: null,
      federationAvatarAttempts: 0,
      federationAvatarFailure: null,
    };
  }
  // `attempts` in the expressions is the value BEFORE this failure.
  const delay = write.permanent
    ? sql`make_interval(secs => ${sql.raw(String(PERMANENT_RETRY_SECONDS))})`
    : sql`make_interval(secs => least(${sql.raw(String(TRANSIENT_RETRY_BASE_SECONDS))} * power(3, least(${users.federationAvatarAttempts}, 10)), ${sql.raw(String(TRANSIENT_RETRY_MAX_SECONDS))}))`;
  return {
    avatar: kept,
    federationAvatarAttempts: sql`${users.federationAvatarAttempts} + 1`,
    federationAvatarFailure: write.failed.slice(0, 64),
    federationAvatarRetryAt: sql`case when (${kept}) is null then now() + ${delay} else null end`,
  };
}

/**
 * Persist a federated user's avatar — the ONLY writer of that column after
 * registration — together with its retry state. Throws
 * {@link FederatedAvatarWriteRefused} before touching the database when handed
 * anything but a file id.
 *
 * @param extra - Other columns written in the same statement (fetch clock,
 *   validators). `avatar` and the retry columns in it are ignored.
 * @param expectedCurrent - Write only while the row still holds this avatar
 *   value (compare-and-set for the repair pass; `null` matches NULL). Returns
 *   false when it did not.
 */
export async function persistFederatedAvatar(
  userId: string,
  write: FederatedAvatarWrite,
  extra: Partial<Omit<typeof users.$inferInsert, 'avatar'>> = {},
  expectedCurrent?: string | null,
): Promise<boolean> {
  const isFile = typeof write === 'object' && 'fileId' in write;
  if (isFile && !isAvatarFileId(write.fileId)) {
    throw new FederatedAvatarWriteRefused();
  }
  const {
    avatar: _avatar,
    federationAvatarRetryAt: _retryAt,
    federationAvatarAttempts: _attempts,
    federationAvatarFailure: _failure,
    ...rest
  } = extra as typeof extra & { avatar?: unknown };
  const state = isFile
    ? {
        avatar: write.fileId,
        federationAvatarRetryAt: null,
        federationAvatarAttempts: 0,
        federationAvatarFailure: null,
      }
    : retryState(write as Exclude<FederatedAvatarWrite, { fileId: string }>);
  const where =
    expectedCurrent === undefined
      ? eq(users.id, userId)
      : and(
          eq(users.id, userId),
          expectedCurrent === null ? isNull(users.avatar) : eq(users.avatar, expectedCurrent),
        );
  const written = await getDb()
    .update(users)
    .set({ ...rest, ...state })
    .where(where)
    .returning({ id: users.id });
  return written.length > 0;
}
