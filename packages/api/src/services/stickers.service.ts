/**
 * The sticker catalogue and each person's installed packs.
 *
 * The schema file (`db/schema/stickers.ts`) explains the model; this is where
 * its two promises are kept:
 *
 * - **A sticker that was ever published keeps resolving.** Only `draft` packs
 *   are invisible to readers. An `archived` pack drops out of the shop and can
 *   no longer be installed, but `resolveStickers` still answers for it, and a
 *   published sticker cannot be removed — only a draft's can.
 * - **Every URL is the CDN's.** A sticker's files are public, content-addressed
 *   `files` rows, so the URL is derived from the storage key and needs no S3
 *   probe; the `sha256` handed out is the file row's own.
 */

import { and, asc, count, desc, eq, inArray, max, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  STICKER_MAX_INSTALLED_PACKS,
  STICKER_PACK_MAX_STICKERS,
  type InstalledStickerPack,
  type Sticker,
  type StickerPack,
  type StickerPackSummary,
} from '@oxy.so/contracts';
import { isUniqueViolation } from '@oxy.so/db';
import { getDb } from '../config/postgres';
import { cdnUrlForStorageKey } from '../config/cdn';
import { files } from '../db/schema/files';
import {
  stickerPacks,
  stickers,
  userStickerPacks,
  type StickerPackStatus,
} from '../db/schema/stickers';
import { assetService } from './assetServiceSingleton';
import { renderStickerFallback } from './stickerRender';
import { normalizeStickerAnimation, validateStickerFallback } from './stickerValidation';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/error';

const animationFiles = alias(files, 'animation_files');
const fallbackFiles = alias(files, 'fallback_files');

/** The statuses a reader may see. A draft exists only for staff. */
const READABLE_PACK_STATUSES: StickerPackStatus[] = ['published', 'archived'];

// ============================================================================
// Reading stickers
// ============================================================================

const stickerColumns = {
  id: stickers.id,
  packId: stickers.packId,
  emoji: stickers.emoji,
  keywords: stickers.keywords,
  size: stickers.size,
  durationMs: stickers.durationMs,
  animationKey: animationFiles.storageKey,
  animationSha256: animationFiles.sha256,
  animationMime: animationFiles.mime,
  animationBytes: animationFiles.size,
  fallbackKey: fallbackFiles.storageKey,
  fallbackSha256: fallbackFiles.sha256,
  fallbackMime: fallbackFiles.mime,
  fallbackBytes: fallbackFiles.size,
};

type StickerRow = {
  id: string;
  packId: string;
  emoji: string[];
  keywords: string[];
  size: number;
  durationMs: number;
  animationKey: string;
  animationSha256: string;
  animationMime: string;
  animationBytes: number;
  fallbackKey: string;
  fallbackSha256: string;
  fallbackMime: string;
  fallbackBytes: number;
};

function toSticker(row: StickerRow): Sticker {
  return {
    id: row.id,
    packId: row.packId,
    emoji: row.emoji,
    keywords: row.keywords,
    size: row.size,
    durationMs: row.durationMs,
    animation: {
      url: cdnUrlForStorageKey(row.animationKey),
      sha256: row.animationSha256,
      mime: row.animationMime,
      bytes: row.animationBytes,
    },
    fallback: {
      url: cdnUrlForStorageKey(row.fallbackKey),
      sha256: row.fallbackSha256,
      mime: row.fallbackMime,
      bytes: row.fallbackBytes,
    },
  };
}

/** Stickers matching `where`, with both files joined, in pack order. */
async function selectStickers(where: SQL | undefined, limit?: number): Promise<Sticker[]> {
  const query = getDb()
    .select(stickerColumns)
    .from(stickers)
    .innerJoin(stickerPacks, eq(stickerPacks.id, stickers.packId))
    .innerJoin(animationFiles, eq(animationFiles.id, stickers.lottieFileId))
    .innerJoin(fallbackFiles, eq(fallbackFiles.id, stickers.fallbackFileId))
    .where(where)
    .orderBy(asc(stickers.packId), asc(stickers.position), asc(stickers.id));
  const rows = limit === undefined ? await query : await query.limit(limit);
  return rows.map(toSticker);
}

/** Every sticker of each pack, grouped by pack id, in ONE query. */
async function stickersByPack(packIds: string[]): Promise<Map<string, Sticker[]>> {
  const grouped = new Map<string, Sticker[]>();
  if (packIds.length === 0) return grouped;
  for (const sticker of await selectStickers(inArray(stickers.packId, packIds))) {
    const list = grouped.get(sticker.packId) ?? [];
    list.push(sticker);
    grouped.set(sticker.packId, list);
  }
  return grouped;
}

/**
 * The cover (first sticker) and sticker count of each pack, in two queries
 * rather than a pack's worth of stickers per card.
 */
async function coversFor(packIds: string[]): Promise<Map<string, { cover: Sticker; count: number }>> {
  const result = new Map<string, { cover: Sticker; count: number }>();
  if (packIds.length === 0) return result;
  const db = getDb();

  const [coverRows, counts] = await Promise.all([
    db
      .selectDistinctOn([stickers.packId], stickerColumns)
      .from(stickers)
      .innerJoin(animationFiles, eq(animationFiles.id, stickers.lottieFileId))
      .innerJoin(fallbackFiles, eq(fallbackFiles.id, stickers.fallbackFileId))
      .where(inArray(stickers.packId, packIds))
      .orderBy(asc(stickers.packId), asc(stickers.position), asc(stickers.id)),
    db
      .select({ packId: stickers.packId, total: count() })
      .from(stickers)
      .where(inArray(stickers.packId, packIds))
      .groupBy(stickers.packId),
  ]);

  const totals = new Map(counts.map((row) => [row.packId, Number(row.total)]));
  for (const row of coverRows) {
    result.set(row.packId, { cover: toSticker(row), count: totals.get(row.packId) ?? 0 });
  }
  return result;
}

type PackRow = typeof stickerPacks.$inferSelect;

function toSummary(pack: PackRow, cover: { cover: Sticker; count: number } | undefined): StickerPackSummary {
  return {
    id: pack.id,
    slug: pack.slug,
    title: pack.title,
    description: pack.description,
    author: pack.author,
    status: pack.status,
    publishedAt: pack.publishedAt ? pack.publishedAt.toISOString() : null,
    stickerCount: cover?.count ?? 0,
    cover: cover?.cover ?? null,
  };
}

async function summaries(packs: PackRow[]): Promise<StickerPackSummary[]> {
  const covers = await coversFor(packs.map((pack) => pack.id));
  return packs.map((pack) => toSummary(pack, covers.get(pack.id)));
}

async function withStickers(pack: PackRow): Promise<StickerPack> {
  const list = (await stickersByPack([pack.id])).get(pack.id) ?? [];
  return {
    ...toSummary(pack, list[0] ? { cover: list[0], count: list.length } : undefined),
    stickers: list,
  };
}

// ============================================================================
// Public reads
// ============================================================================

/** The shop: published packs, newest first. */
export async function listPublishedPacks(options: {
  limit: number;
  offset: number;
}): Promise<{ items: StickerPackSummary[]; total: number }> {
  const db = getDb();
  const where = eq(stickerPacks.status, 'published');
  const [packs, [totals]] = await Promise.all([
    db
      .select()
      .from(stickerPacks)
      .where(where)
      .orderBy(desc(stickerPacks.publishedAt), asc(stickerPacks.id))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ value: count() }).from(stickerPacks).where(where),
  ]);
  return { items: await summaries(packs), total: Number(totals?.value ?? 0) };
}

/**
 * One pack with every sticker. Archived packs are served too — a link from an
 * old message must still open — and carry their status so the client can say
 * the pack is no longer offered.
 */
export async function getPackBySlug(slug: string): Promise<StickerPack | null> {
  const [pack] = await getDb()
    .select()
    .from(stickerPacks)
    .where(and(eq(stickerPacks.slug, slug), inArray(stickerPacks.status, READABLE_PACK_STATUSES)))
    .limit(1);
  return pack ? withStickers(pack) : null;
}

/** Stickers by id. Unknown and draft ids are simply absent. */
export async function resolveStickers(ids: string[]): Promise<Sticker[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return selectStickers(
    and(inArray(stickers.id, unique), inArray(stickerPacks.status, READABLE_PACK_STATUSES))
  );
}

/**
 * Stickers from published packs matching an emoji or a keyword. Keywords are
 * stored lower-cased (see `addSticker`), so the term is too.
 */
export async function searchStickers(options: {
  emoji?: string;
  q?: string;
  limit: number;
}): Promise<Sticker[]> {
  const filters: SQL[] = [eq(stickerPacks.status, 'published')];
  if (options.emoji) {
    filters.push(sql`${stickers.emoji} @> array[${options.emoji}]::text[]`);
  }
  if (options.q) {
    filters.push(sql`${stickers.keywords} @> array[${options.q.toLowerCase()}]::text[]`);
  }
  return selectStickers(and(...filters), options.limit);
}

// ============================================================================
// A person's installed packs
// ============================================================================

export async function listInstalledPacks(userId: string): Promise<InstalledStickerPack[]> {
  const rows = await getDb()
    .select({ pack: stickerPacks, installedAt: userStickerPacks.installedAt })
    .from(userStickerPacks)
    .innerJoin(stickerPacks, eq(stickerPacks.id, userStickerPacks.packId))
    .where(eq(userStickerPacks.userId, userId))
    .orderBy(asc(userStickerPacks.position), asc(userStickerPacks.installedAt));

  const grouped = await stickersByPack(rows.map((row) => row.pack.id));
  return rows.map(({ pack, installedAt }) => {
    const list = grouped.get(pack.id) ?? [];
    return {
      ...toSummary(pack, list[0] ? { cover: list[0], count: list.length } : undefined),
      stickers: list,
      installedAt: installedAt.toISOString(),
    };
  });
}

/**
 * Install a published pack at the end of the person's picker. Installing one
 * that is already there changes nothing — the primary key makes the second
 * insert a no-op rather than an error.
 */
export async function installPack(userId: string, packId: string): Promise<void> {
  const db = getDb();
  const [pack] = await db
    .select({ status: stickerPacks.status })
    .from(stickerPacks)
    .where(eq(stickerPacks.id, packId))
    .limit(1);
  if (!pack || pack.status === 'draft') throw new NotFoundError('Sticker pack not found');
  if (pack.status !== 'published') throw new ConflictError('This sticker pack is no longer offered');

  await db.transaction(async (tx) => {
    // Serialises one person's installs, so the cap and the next position are
    // read and written without another install landing between them.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`user_sticker_packs:${userId}`}))`);

    const [state] = await tx
      .select({ total: count(), last: max(userStickerPacks.position) })
      .from(userStickerPacks)
      .where(eq(userStickerPacks.userId, userId));
    const [existing] = await tx
      .select({ packId: userStickerPacks.packId })
      .from(userStickerPacks)
      .where(and(eq(userStickerPacks.userId, userId), eq(userStickerPacks.packId, packId)))
      .limit(1);
    if (existing) return;
    if (Number(state?.total ?? 0) >= STICKER_MAX_INSTALLED_PACKS) {
      throw new ConflictError(`At most ${STICKER_MAX_INSTALLED_PACKS} sticker packs can be installed`);
    }

    await tx
      .insert(userStickerPacks)
      .values({ userId, packId, position: (state?.last ?? -1) + 1 })
      .onConflictDoNothing();
  });
}

export async function uninstallPack(userId: string, packId: string): Promise<void> {
  await getDb()
    .delete(userStickerPacks)
    .where(and(eq(userStickerPacks.userId, userId), eq(userStickerPacks.packId, packId)));
}

/**
 * Rewrite the picker order. The list must be exactly the installed set: a
 * missing id would leave that pack with a stale position, and an extra one
 * would silently install nothing.
 */
export async function reorderInstalledPacks(userId: string, packIds: string[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`user_sticker_packs:${userId}`}))`);
    const installed = await tx
      .select({ packId: userStickerPacks.packId })
      .from(userStickerPacks)
      .where(eq(userStickerPacks.userId, userId));

    const requested = new Set(packIds);
    const sameSet =
      requested.size === packIds.length &&
      requested.size === installed.length &&
      installed.every((row) => requested.has(row.packId));
    if (!sameSet) throw new BadRequestError('packIds must list every installed pack exactly once');

    for (const [position, packId] of packIds.entries()) {
      await tx
        .update(userStickerPacks)
        .set({ position })
        .where(and(eq(userStickerPacks.userId, userId), eq(userStickerPacks.packId, packId)));
    }
  });
}

// ============================================================================
// Staff: building the catalogue
// ============================================================================

async function requirePack(packId: string): Promise<PackRow> {
  const [pack] = await getDb().select().from(stickerPacks).where(eq(stickerPacks.id, packId)).limit(1);
  if (!pack) throw new NotFoundError('Sticker pack not found');
  return pack;
}

/** Every pack in any status, newest first — the staff view. */
export async function listAllPacks(options: {
  limit: number;
  offset: number;
}): Promise<{ items: StickerPackSummary[]; total: number }> {
  const db = getDb();
  const [packs, [totals]] = await Promise.all([
    db
      .select()
      .from(stickerPacks)
      .orderBy(desc(stickerPacks.createdAt), asc(stickerPacks.id))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ value: count() }).from(stickerPacks),
  ]);
  return { items: await summaries(packs), total: Number(totals?.value ?? 0) };
}

export async function getPackForStaff(packId: string): Promise<StickerPack> {
  return withStickers(await requirePack(packId));
}

export async function createPack(input: {
  slug: string;
  title: string;
  description?: string | null;
  author?: string | null;
}): Promise<StickerPack> {
  try {
    const [pack] = await getDb()
      .insert(stickerPacks)
      .values({
        slug: input.slug,
        title: input.title,
        description: input.description ?? null,
        author: input.author ?? null,
      })
      .returning();
    return withStickers(pack);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('A sticker pack with that slug already exists');
    throw error;
  }
}

export async function updatePack(
  packId: string,
  patch: { title?: string; description?: string | null; author?: string | null }
): Promise<StickerPack> {
  await requirePack(packId);
  const [pack] = await getDb()
    .update(stickerPacks)
    .set(patch)
    .where(eq(stickerPacks.id, packId))
    .returning();
  return withStickers(pack);
}

/**
 * Add a sticker at the end of a pack. The animation is normalized and the
 * fallback validated — or rendered, when none is supplied — before either file
 * is stored, so a rejected upload leaves nothing behind.
 */
export async function addSticker(input: {
  packId: string;
  animation: Buffer;
  fallback?: { buffer: Buffer; mime: string };
  emoji: string[];
  keywords: string[];
}): Promise<Sticker> {
  const pack = await requirePack(input.packId);
  if (pack.status === 'archived') throw new ConflictError('An archived pack cannot gain stickers');

  const animation = normalizeStickerAnimation(input.animation);
  const fallback = input.fallback
    ? { buffer: input.fallback.buffer, mime: await validateStickerFallback(input.fallback.buffer, input.fallback.mime) }
    : { buffer: await renderStickerFallback(animation.json, animation.size), mime: 'image/webp' };

  const [animationFile, fallbackFile] = await Promise.all([
    assetService.uploadStickerFile(animation.json, 'application/json', `${pack.slug}.json`),
    assetService.uploadStickerFile(fallback.buffer, fallback.mime, `${pack.slug}.${fallback.mime.slice('image/'.length)}`),
  ]);

  const id = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stickers:${pack.id}`}))`);
    const [state] = await tx
      .select({ total: count(), last: max(stickers.position) })
      .from(stickers)
      .where(eq(stickers.packId, pack.id));
    if (Number(state?.total ?? 0) >= STICKER_PACK_MAX_STICKERS) {
      throw new ConflictError(`A pack holds at most ${STICKER_PACK_MAX_STICKERS} stickers`);
    }
    const [row] = await tx
      .insert(stickers)
      .values({
        packId: pack.id,
        position: (state?.last ?? -1) + 1,
        emoji: input.emoji,
        keywords: [...new Set(input.keywords.map((keyword) => keyword.toLowerCase()))],
        lottieFileId: animationFile.id,
        fallbackFileId: fallbackFile.id,
        size: animation.size,
        durationMs: animation.durationMs,
      })
      .returning({ id: stickers.id });
    return row.id;
  });

  const [sticker] = await selectStickers(eq(stickers.id, id));
  return sticker;
}

/** Only a draft's stickers can be removed: a published one may be in someone's messages. */
export async function removeSticker(packId: string, stickerId: string): Promise<void> {
  const pack = await requirePack(packId);
  if (pack.status !== 'draft') {
    throw new ConflictError('Stickers can only be removed from a draft pack');
  }
  const removed = await getDb()
    .delete(stickers)
    .where(and(eq(stickers.id, stickerId), eq(stickers.packId, packId)))
    .returning({ id: stickers.id });
  if (removed.length === 0) throw new NotFoundError('Sticker not found');
}

export async function publishPack(packId: string): Promise<StickerPack> {
  const pack = await requirePack(packId);
  const [{ value }] = await getDb()
    .select({ value: count() })
    .from(stickers)
    .where(eq(stickers.packId, packId));
  if (Number(value) === 0) throw new ConflictError('An empty pack cannot be published');

  const [updated] = await getDb()
    .update(stickerPacks)
    .set({ status: 'published', publishedAt: pack.publishedAt ?? new Date() })
    .where(eq(stickerPacks.id, packId))
    .returning();
  return withStickers(updated);
}

/**
 * Take a pack out of the shop. It stays installed for whoever has it — their
 * picker still works — and every sticker keeps resolving.
 */
export async function archivePack(packId: string): Promise<StickerPack> {
  await requirePack(packId);
  const [updated] = await getDb()
    .update(stickerPacks)
    .set({ status: 'archived' })
    .where(eq(stickerPacks.id, packId))
    .returning();
  return withStickers(updated);
}

/** Delete a pack that was never published. Anything else is archived instead. */
export async function deleteDraftPack(packId: string): Promise<void> {
  const deleted = await getDb()
    .delete(stickerPacks)
    .where(
      and(eq(stickerPacks.id, packId), eq(stickerPacks.status, 'draft'), sql`${stickerPacks.publishedAt} is null`)
    )
    .returning({ id: stickerPacks.id });
  if (deleted.length === 0) {
    await requirePack(packId);
    throw new ConflictError('Only a never-published draft can be deleted; archive it instead');
  }
}
