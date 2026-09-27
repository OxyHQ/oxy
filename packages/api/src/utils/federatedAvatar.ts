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
import { and, eq, sql, type SQL } from 'drizzle-orm';
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
  return sql<string | null>`case when ${users.avatar} ~ ${sql.raw(`'${AVATAR_FILE_ID_SQL_PATTERN}'`)} then ${users.avatar} else null end`;
}

export type FederatedAvatarWrite =
  /** A mirror just stored in Oxy Cloud. */
  | { fileId: string }
  /** The mirror failed: keep the previous file id, else NULL. */
  | 'keep_previous_mirror';

/**
 * Persist a federated user's avatar — the ONLY writer of that column after
 * registration. Throws {@link FederatedAvatarWriteRefused} before touching the
 * database when handed anything but a file id.
 *
 * @param extra - Other columns written in the same statement (fetch clock,
 *   validators). `avatar` in it is ignored.
 * @param expectedCurrent - Write only while the row still holds this value
 *   (compare-and-set for the repair pass). Returns false when it did not.
 */
export async function persistFederatedAvatar(
  userId: string,
  avatar: FederatedAvatarWrite,
  extra: Partial<Omit<typeof users.$inferInsert, 'avatar'>> = {},
  expectedCurrent?: string,
): Promise<boolean> {
  if (avatar !== 'keep_previous_mirror' && !isAvatarFileId(avatar.fileId)) {
    throw new FederatedAvatarWriteRefused();
  }
  const { avatar: _ignored, ...rest } = extra as typeof extra & { avatar?: unknown };
  const where = expectedCurrent === undefined
    ? eq(users.id, userId)
    : and(eq(users.id, userId), eq(users.avatar, expectedCurrent));
  const written = await getDb().update(users)
    .set({ ...rest, avatar: avatar === 'keep_previous_mirror' ? avatarKeepingMirror() : avatar.fileId })
    .where(where)
    .returning({ id: users.id });
  return written.length > 0;
}
