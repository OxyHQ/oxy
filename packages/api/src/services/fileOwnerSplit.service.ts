import { withStorageQuota } from './storageQuota.service';
/**
 * Split the cross-owner shares the one-live-row-per-hash model left behind.
 *
 * Until `files_sha256_live_key` was replaced by per-owner uniques
 * (migration 0124), the upload paths handed the ONE live row for a content hash
 * to any other account uploading the same bytes. That account then used the
 * other owner's id: it linked it (`file_links.created_by` ≠ the file's owner),
 * attached it to mail, and — invisible here — stored it in other apps' records
 * (a Mention post's media id, a Mercaria storage key).
 *
 * This works off the part Oxy can see: `file_links` rows whose creator is not
 * the file's owner. For each (file, linking account) pair it can:
 *
 *  - `report`: list the pair — what a split would do. Writes nothing.
 *  - `create-rows`: give the linking account its OWN live row for the same
 *    bytes — sharing the stored object and renditions, carrying no application
 *    metadata of the original — or reuse the one it already holds. Additive:
 *    nothing that references the original changes, so it is safe at any time.
 *    Emits the `(sourceFileId, ownerUserId) -> fileId` mapping consuming apps
 *    need to rewrite the ids THEY store.
 *  - `repoint-links`: create-rows, then move that account's links from the
 *    original to its own row.
 *
 * Why repointing is a separate, later step: the id a consuming app stored is
 * the ORIGINAL's. While a link by another account sits on the original, the
 * federated delete refuses it (`in_use`) and a user delete needs `force`, which
 * is what keeps that app's reference working. Moving the link first would drop
 * that protection while the app still points at the original. So repoint only
 * the links whose app has switched to the new id (`--app=<name>`).
 *
 * Idempotent: the per-owner unique makes "the linking account's row for these
 * bytes" a single row, reused on every run; a link already moved is no longer a
 * cross-owner link and is not seen again. Batched by keyset on `file_links.id`.
 */

import { and, asc, eq, gt, isNotNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { fileLinks, files, fileVariants, messageAttachments, messages } from '../db/schema';
import type { FileRecord } from '../types/file.types';
import { withContentHashLock } from './contentHashLock';
import { findFileById, findLiveFileBySha256ForOwner, insertFile } from './fileRepository';

export type FileOwnerSplitMode = 'report' | 'create-rows' | 'repoint-links';

export interface FileOwnerSplitOptions {
  mode: FileOwnerSplitMode;
  batchSize: number;
  /** Resume after this `file_links.id`. */
  after?: string;
  /** Only links of this application (required to repoint: see the header). */
  app?: string;
  /** Stop after this many batches (a bounded run); unbounded when omitted. */
  maxBatches?: number;
  /** One JSON-serialisable record per pair. */
  emit: (record: FileOwnerSplitRecord) => void;
}

export interface FileOwnerSplitRecord {
  sourceFileId: string;
  sha256: string;
  sourceOwner: string;
  ownerUserId: string;
  /** The linking account's own row: `null` in `report` mode. */
  fileId: string | null;
  created: boolean;
  links: Array<{ app: string; entityType: string; entityId: string }>;
  linksRepointed: number;
}

export interface FileOwnerSplitSummary {
  mode: FileOwnerSplitMode;
  linksScanned: number;
  pairs: number;
  rowsCreated: number;
  rowsReused: number;
  linksRepointed: number;
  /** Resume point: pass as `after` to continue. `null` when the scan finished. */
  lastLinkId: string | null;
  finished: boolean;
}

/** `files.metadata` keys that describe the bytes, and so travel to a sibling row. */
const INTRINSIC_METADATA_KEYS = new Set(['media', 'image', 'video']);

interface CrossOwnerLink {
  linkId: string;
  fileId: string;
  linker: string;
  app: string;
  entityType: string;
  entityId: string;
}

/** One keyset page of links created by someone other than the (live) file's owner. */
async function crossOwnerLinkPage(
  after: string | undefined,
  limit: number,
  app?: string,
): Promise<CrossOwnerLink[]> {
  return getDb()
    .select({
      linkId: fileLinks.id,
      fileId: fileLinks.fileId,
      linker: fileLinks.createdBy,
      app: fileLinks.app,
      entityType: fileLinks.entityType,
      entityId: fileLinks.entityId,
    })
    .from(fileLinks)
    .innerJoin(files, eq(files.id, fileLinks.fileId))
    .where(
      and(
        after === undefined ? undefined : gt(fileLinks.id, after),
        app === undefined ? undefined : eq(fileLinks.app, app),
        ne(files.status, 'deleted'),
        sql`${fileLinks.createdBy} is distinct from ${files.ownerUserId}`,
      ),
    )
    .orderBy(asc(fileLinks.id))
    .limit(limit);
}

/**
 * The linking account's own live row for `source`'s bytes: the one it already
 * holds, or a new one pointing at the same stored object and renditions. Under
 * the content-hash lock, like every path that makes a row use stored bytes, so a
 * purge in progress either finished first or sees this row.
 */
export async function ensureOwnerRowFor(
  source: FileRecord,
  ownerUserId: string,
): Promise<{ file: FileRecord; created: boolean }> {
  const owner = { ownerUserId, systemOwner: null } as const;
  return withContentHashLock(source.sha256, async (tx) => {
    const existing = await findLiveFileBySha256ForOwner(source.sha256, owner, tx);
    if (existing) return { file: existing, created: false };

    return withStorageQuota(tx, [ownerUserId], async () => {
      const intrinsic = Object.fromEntries(
        Object.entries(source.metadata ?? {}).filter(([key]) => INTRINSIC_METADATA_KEYS.has(key)),
      );
      const file = await insertFile(
        {
          sha256: source.sha256,
          size: source.size,
          mime: source.mime,
          ext: source.ext,
          ...owner,
          status: 'active',
          visibility: source.visibility,
          purpose: 'user',
          storageKey: source.storageKey,
          originalName: source.originalName,
          metadata: { ...intrinsic, splitFromFileId: source.id },
        },
        tx,
      );
      if (source.variants.length > 0) {
        await tx.insert(fileVariants).values(
          source.variants.map((variant) => ({
            fileId: file.id,
            type: variant.type,
            key: variant.key,
            width: variant.width,
            height: variant.height,
            readyAt: variant.readyAt,
            size: variant.size,
            metadata: variant.metadata,
          })),
        );
      }
      return { file, created: true };
    });
  });
}

/**
 * Move one account's links from `sourceFileId` to its own row. A link that
 * already exists on the target (same app/entity) is dropped from the source
 * instead — `file_links_file_id_app_entity_key` allows one.
 */
async function repointLinks(linkIds: readonly string[], targetFileId: string): Promise<number> {
  return getDb().transaction(async (tx) => {
    let moved = 0;
    for (const linkId of linkIds) {
      const [link] = await tx
        .select()
        .from(fileLinks)
        .where(eq(fileLinks.id, linkId))
        .for('update');
      if (!link) continue;
      const [clash] = await tx
        .select({ id: fileLinks.id })
        .from(fileLinks)
        .where(
          and(
            eq(fileLinks.fileId, targetFileId),
            eq(fileLinks.app, link.app),
            eq(fileLinks.entityType, link.entityType),
            eq(fileLinks.entityId, link.entityId),
          ),
        );
      if (clash) {
        await tx.delete(fileLinks).where(eq(fileLinks.id, linkId));
      } else {
        await tx.update(fileLinks).set({ fileId: targetFileId }).where(eq(fileLinks.id, linkId));
      }
      moved += 1;
    }
    return moved;
  });
}

export async function runFileOwnerSplit(
  options: FileOwnerSplitOptions,
): Promise<FileOwnerSplitSummary> {
  if (options.mode === 'repoint-links' && !options.app) {
    throw new Error(
      'repoint-links needs --app=<name>: repoint only an application that stores the new ids',
    );
  }
  const summary: FileOwnerSplitSummary = {
    mode: options.mode,
    linksScanned: 0,
    pairs: 0,
    rowsCreated: 0,
    rowsReused: 0,
    linksRepointed: 0,
    lastLinkId: options.after ?? null,
    finished: false,
  };
  let after = options.after;

  for (let batch = 0; options.maxBatches === undefined || batch < options.maxBatches; batch += 1) {
    const page = await crossOwnerLinkPage(after, options.batchSize, options.app);
    if (page.length === 0) {
      summary.finished = true;
      summary.lastLinkId = null;
      return summary;
    }
    summary.linksScanned += page.length;
    after = page[page.length - 1].linkId;
    summary.lastLinkId = after;

    const pairs = new Map<string, CrossOwnerLink[]>();
    for (const link of page) {
      const key = `${link.fileId}\u0000${link.linker}`;
      const bucket = pairs.get(key);
      if (bucket) bucket.push(link);
      else pairs.set(key, [link]);
    }

    for (const links of pairs.values()) {
      const [{ fileId, linker }] = links;
      const source = await findFileById(fileId);
      if (!source || source.status === 'deleted') continue;
      summary.pairs += 1;
      const record: FileOwnerSplitRecord = {
        sourceFileId: source.id,
        sha256: source.sha256,
        sourceOwner: source.ownerUserId ?? `system:${source.systemOwner ?? 'unknown'}`,
        ownerUserId: linker,
        fileId: null,
        created: false,
        links: links.map(({ app, entityType, entityId }) => ({ app, entityType, entityId })),
        linksRepointed: 0,
      };

      if (options.mode !== 'report') {
        const { file, created } = await ensureOwnerRowFor(source, linker);
        record.fileId = file.id;
        record.created = created;
        if (created) summary.rowsCreated += 1;
        else summary.rowsReused += 1;
        if (options.mode === 'repoint-links') {
          record.linksRepointed = await repointLinks(
            links.map((link) => link.linkId),
            file.id,
          );
          summary.linksRepointed += record.linksRepointed;
        }
      }
      options.emit(record);
    }
  }
  return summary;
}

/**
 * Other cross-owner holders Oxy records, counted for the report: mail
 * attachments on a message in a mailbox of someone other than the file's owner.
 * Not split here — a stored message is immutable content, and its attachment
 * keeps the file alive through `heldByOthers` either way.
 */
export async function countCrossOwnerMessageAttachments(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(messageAttachments)
    .innerJoin(files, eq(files.id, messageAttachments.fileId))
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .where(
      and(
        ne(files.status, 'deleted'),
        isNotNull(messages.userId),
        sql`${messages.userId} is distinct from ${files.ownerUserId}`,
      ),
    );
  return row?.count ?? 0;
}
