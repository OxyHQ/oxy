/**
 * A federated account's profile colour, taken from its avatar.
 *
 * A federated account cannot pick its own colour, so the one it gets is the seed
 * Bloom's colour engine extracts from its picture: the same ranking Bloom uses
 * for "theme from your photo", stored as `#rrggbb`. Clients already resolve a
 * hex `users.color` to an exact seed (`resolveProfileColor`).
 */
import sharp from 'sharp';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { hexFromArgb, seedsFromRgbBytes } from '@oxy.so/bloom/color-engine';
import { getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { AVATAR_FILE_ID_SQL_PATTERN } from '../../utils/federatedAvatar';

/** The image is reduced to this edge before quantizing; colour needs no detail. */
const SAMPLE_EDGE_PX = 64;
/** Returned by the scorer when no colour qualifies; never an opaque pixel. */
const NO_SEED = 0;

/**
 * The seed colour of an avatar as `#rrggbb`, or null when the picture has none
 * worth theming (greyscale, near-white or near-black) or cannot be decoded.
 * Transparency is flattened onto white, which the scorer ignores.
 */
export async function avatarSeedColor(image: Buffer): Promise<string | null> {
  try {
    const pixels = await sharp(image)
      .flatten({ background: '#ffffff' })
      .resize(SAMPLE_EDGE_PX, SAMPLE_EDGE_PX, { fit: 'cover' })
      .raw()
      .toBuffer();
    const [seed] = seedsFromRgbBytes(pixels, 3, { desired: 1, fallbackColorARGB: NO_SEED });
    return seed === undefined || seed === NO_SEED ? null : hexFromArgb(seed);
  } catch {
    return null;
  }
}

export interface AvatarColorBackfillResult {
  apply: boolean;
  /** Federated users with a stored avatar still on a preset colour. */
  scanned: number;
  /** Given their avatar's colour (on a dry run: would be). */
  colored: number;
  /** The avatar has no colour worth theming; the preset stays. */
  noColor: number;
  /** The stored avatar file could not be read. */
  unreadable: number;
  /** The avatar changed between read and write; its own mirror sets the colour. */
  changedConcurrently: number;
  /** Resume cursor: the last user id visited. */
  after: string;
  /** True when `deadline` stopped the pass before the end. */
  stopped: boolean;
}

/**
 * One-shot backfill: give every federated user that has a stored avatar but
 * still wears a preset the seed colour of that avatar. Reads the mirrored file,
 * never the remote source. A user already on a hex colour is skipped, so a
 * re-run resumes where the last one ended. Each write is conditional on the row
 * still holding the avatar it read.
 */
export async function backfillFederatedAvatarColors(opts: {
  apply: boolean;
  readAvatar: (fileId: string) => Promise<Buffer | null>;
  onWritten?: (userId: string) => void;
  batchSize?: number;
  concurrency?: number;
  after?: string;
  deadline?: number;
  log?: (line: string) => void;
}): Promise<AvatarColorBackfillResult> {
  const batchSize = opts.batchSize ?? 200;
  const concurrency = opts.concurrency ?? 8;
  const result: AvatarColorBackfillResult = {
    apply: opts.apply,
    scanned: 0,
    colored: 0,
    noColor: 0,
    unreadable: 0,
    changedConcurrently: 0,
    after: opts.after ?? '',
    stopped: false,
  };

  const colorOne = async (row: { id: string; avatar: string }) => {
    const bytes = await opts.readAvatar(row.avatar).catch(() => null);
    if (!bytes) {
      result.unreadable += 1;
      return;
    }
    const color = await avatarSeedColor(bytes);
    if (!color) {
      result.noColor += 1;
      return;
    }
    if (!opts.apply) {
      result.colored += 1;
      return;
    }
    const written = await getDb()
      .update(users)
      .set({ color })
      .where(and(eq(users.id, row.id), eq(users.avatar, row.avatar)))
      .returning({ id: users.id });
    if (written.length === 0) {
      result.changedConcurrently += 1;
      return;
    }
    result.colored += 1;
    opts.onWritten?.(row.id);
  };

  for (;;) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) {
      result.stopped = true;
      break;
    }
    const rows = await getDb()
      .select({ id: users.id, avatar: users.avatar })
      .from(users)
      .where(
        and(
          eq(users.type, 'federated'),
          sql`${users.avatar} ~ ${sql.raw(`'${AVATAR_FILE_ID_SQL_PATTERN}'`)}`,
          sql`${users.color} !~ '^#'`,
          result.after ? gt(users.id, result.after) : undefined,
        ),
      )
      .orderBy(asc(users.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (let i = 0; i < rows.length; i += concurrency) {
      await Promise.all(
        rows
          .slice(i, i + concurrency)
          .flatMap((row) => (row.avatar ? [colorOne({ id: row.id, avatar: row.avatar })] : [])),
      );
    }
    result.scanned += rows.length;
    result.after = rows[rows.length - 1].id;
    opts.log?.(JSON.stringify({ progress: result }));
  }
  return result;
}
