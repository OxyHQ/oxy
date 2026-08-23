/**
 * Publish/admin operations for Oxy Updates: content-addressed asset upload
 * (init/complete), creating updates (channel-on-demand), and the lifecycle
 * operations (rollback, rollback-to-embedded, promote, rollout patch) plus the
 * read models the CLI and console consume.
 *
 * Asset upload mirrors the two-step presigned pattern in `routes/assets.ts`:
 * `initAssets` returns a presigned PUT for every asset not already held (dedup
 * by SHA-256), `completeAssets` HEADs each object and flips it to `uploaded`.
 * Only `uploaded` assets may back a published update.
 *
 * ## Three things this file no longer gets to get wrong
 *
 * - **The rollback directive is ONE statement.** `rollbackToEmbedded` was a
 *   `$pull` followed by a `$push`: an interruption between them left the
 *   directive DELETED, and two concurrent rollbacks left two entries for the
 *   same tuple that the manifest endpoint then resolved arbitrarily. It is now
 *   a single `insert … on conflict (channel_id, runtime_version, platform) do
 *   update`, so the row is never absent and can never be duplicated.
 * - **An update's asset list carries an explicit ordinal.** A published manifest
 *   is signed and a device may fetch any historical update, so its bytes must
 *   be identical forever. The ordinal is the array index at publish time and
 *   every read orders by it — never by insertion order, never by whatever the
 *   planner returns.
 * - **A publish is atomic.** Channel creation, clearing the superseded rollback
 *   directive, the update row and its asset descriptors are one transaction: a
 *   failed publish leaves nothing behind, and the `uploaded` check is made
 *   against the same snapshot the foreign keys are enforced in.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type {
  AssetInitItem,
  AssetInitResponse,
  AssetCompleteResponse,
  Channel,
  CreateUpdateRequest,
  RollbackToEmbeddedEntry,
  Update,
  UpdatePlatform,
  UpdateStatus,
} from '@oxyhq/contracts';
import { s3Service } from '../s3ServiceSingleton';
import { getDb, type Database } from '../../config/postgres';
import {
  appUpdateAssets,
  appUpdates,
  updateAssets,
  updateChannelRollbacks,
  updateChannels,
} from '../../db/schema';
import { updateAssetS3Key } from './assetKeys';
import { BadRequestError, NotFoundError } from '../../utils/error';
import { logger } from '../../utils/logger';

/** Presigned PUT validity — generous enough for a large bundle upload. */
const ASSET_UPLOAD_URL_EXPIRY_SECONDS = 60 * 60; // 1h

/**
 * Cache-Control baked into every asset object. Update assets are content-addressed
 * (the URL contains the sha256), so the bytes at a URL never change — they can be
 * cached forever. This is a SIGNED header on the presigned PUT, so the client
 * replays it verbatim (see `assetUploadTicketSchema.cacheControl`).
 */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * The connection pool, or a transaction opened on it. Every helper below takes
 * one so the same code serves a standalone read and a step inside `createUpdate`
 * / `promote` without a second copy that could drift from it.
 */
type DbHandle = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/* -------------------------------------------------------------------------- */
/*  Serializers (Drizzle row → @oxyhq/contracts wire shape)                   */
/* -------------------------------------------------------------------------- */

/**
 * The `app_updates` columns every update serializer needs, named explicitly:
 * a bare `select()` would also return `extra` and `metadata`, which are the
 * manifest payload and have no place in the admin wire shape.
 */
const updateColumns = {
  id: appUpdates.id,
  updateId: appUpdates.updateId,
  applicationId: appUpdates.applicationId,
  runtimeVersion: appUpdates.runtimeVersion,
  platform: appUpdates.platform,
  status: appUpdates.status,
  rolloutPercent: appUpdates.rolloutPercent,
  launchAssetSha256: appUpdates.launchAssetSha256,
  gitCommit: appUpdates.gitCommit,
  gitBranch: appUpdates.gitBranch,
  message: appUpdates.message,
  promotedFromUpdateId: appUpdates.promotedFromUpdateId,
  createdAt: appUpdates.createdAt,
  updatedAt: appUpdates.updatedAt,
} as const;

/**
 * What `updateColumns` selects. Written out rather than inferred so a column
 * whose type changes (a `Date` becoming a string, a nullable becoming required)
 * fails `tsc` here, at the boundary, instead of somewhere downstream.
 */
interface UpdateRow {
  id: string;
  updateId: string;
  applicationId: string;
  runtimeVersion: string;
  platform: UpdatePlatform;
  status: UpdateStatus;
  rolloutPercent: number;
  launchAssetSha256: string;
  gitCommit: string | null;
  gitBranch: string | null;
  message: string | null;
  promotedFromUpdateId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The `update_channels` columns a channel DTO is built from. */
const channelColumns = {
  id: updateChannels.id,
  applicationId: updateChannels.applicationId,
  name: updateChannels.name,
  createdAt: updateChannels.createdAt,
  updatedAt: updateChannels.updatedAt,
} as const;

/** What `channelColumns` selects — same rationale as {@link UpdateRow}. */
interface ChannelRow {
  id: string;
  applicationId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

function serializeUpdate(
  update: UpdateRow,
  channelName: string,
  assetSha256s: string[]
): Update {
  return {
    id: update.updateId,
    applicationId: update.applicationId,
    channel: channelName,
    runtimeVersion: update.runtimeVersion,
    platform: update.platform,
    status: update.status,
    rolloutPercent: update.rolloutPercent,
    launchAssetSha256: update.launchAssetSha256,
    assetSha256s,
    ...(update.gitCommit ? { gitCommit: update.gitCommit } : {}),
    ...(update.gitBranch ? { gitBranch: update.gitBranch } : {}),
    ...(update.message ? { message: update.message } : {}),
    ...(update.promotedFromUpdateId
      ? { promotedFromUpdateId: update.promotedFromUpdateId }
      : {}),
    createdAt: update.createdAt.toISOString(),
    updatedAt: update.updatedAt.toISOString(),
  };
}

function serializeChannel(
  channel: ChannelRow,
  rollbacksToEmbedded: RollbackToEmbeddedEntry[]
): Channel {
  return {
    id: channel.id,
    applicationId: channel.applicationId,
    name: channel.name,
    rollbacksToEmbedded,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

/**
 * The sha256s of each update's manifest assets, IN PUBLISHED ORDER.
 *
 * `order by ordinal` is the contract, not a nicety: the manifest an update
 * produces is signed, so a reordered asset list is an invalid signature on a
 * device that may fetch this update at any point in the future.
 */
async function loadAssetSha256s(
  db: DbHandle,
  appUpdateIds: string[]
): Promise<Map<string, string[]>> {
  const byUpdate = new Map<string, string[]>(appUpdateIds.map((id) => [id, []]));
  if (appUpdateIds.length === 0) {
    return byUpdate;
  }

  const rows = await db
    .select({ appUpdateId: appUpdateAssets.appUpdateId, sha256: appUpdateAssets.sha256 })
    .from(appUpdateAssets)
    .where(inArray(appUpdateAssets.appUpdateId, appUpdateIds))
    .orderBy(asc(appUpdateAssets.appUpdateId), asc(appUpdateAssets.ordinal));

  for (const row of rows) {
    byUpdate.get(row.appUpdateId)?.push(row.sha256);
  }
  return byUpdate;
}

/** The active rollback-to-embedded directives of each channel. */
async function loadRollbacks(
  db: DbHandle,
  channelIds: string[]
): Promise<Map<string, RollbackToEmbeddedEntry[]>> {
  const byChannel = new Map<string, RollbackToEmbeddedEntry[]>(
    channelIds.map((id) => [id, []])
  );
  if (channelIds.length === 0) {
    return byChannel;
  }

  const rows = await db
    .select({
      channelId: updateChannelRollbacks.channelId,
      runtimeVersion: updateChannelRollbacks.runtimeVersion,
      platform: updateChannelRollbacks.platform,
      commitTime: updateChannelRollbacks.commitTime,
    })
    .from(updateChannelRollbacks)
    .where(inArray(updateChannelRollbacks.channelId, channelIds))
    .orderBy(
      asc(updateChannelRollbacks.runtimeVersion),
      asc(updateChannelRollbacks.platform)
    );

  for (const row of rows) {
    byChannel.get(row.channelId)?.push({
      runtimeVersion: row.runtimeVersion,
      platform: row.platform,
      commitTime: row.commitTime.toISOString(),
    });
  }
  return byChannel;
}

/* -------------------------------------------------------------------------- */
/*  Assets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * For each declared asset, return a presigned PUT when we do not already hold the
 * content (`uploaded`), or list it as `existing`. A `pending` record is
 * (re)created for every missing asset so `completeAssets` can find it.
 */
export async function initAssets(
  applicationId: string,
  assets: AssetInitItem[]
): Promise<AssetInitResponse> {
  const db = getDb();
  const missing: AssetInitResponse['missing'] = [];
  const existing: string[] = [];

  // Collapse duplicate sha256s in the request so we never presign the same key
  // twice or double-count.
  const bySha = new Map<string, AssetInitItem>();
  for (const asset of assets) {
    if (!bySha.has(asset.sha256)) {
      bySha.set(asset.sha256, asset);
    }
  }

  // One read for the whole request rather than one per asset — a publish
  // declares every asset of the bundle, which for a real app is hundreds.
  const held = await db
    .select({ sha256: updateAssets.sha256, status: updateAssets.status })
    .from(updateAssets)
    .where(inArray(updateAssets.sha256, [...bySha.keys()]));
  const uploaded = new Set(
    held.filter((asset) => asset.status === 'uploaded').map((asset) => asset.sha256)
  );

  for (const asset of bySha.values()) {
    if (uploaded.has(asset.sha256)) {
      existing.push(asset.sha256);
      continue;
    }

    // Create the pending record, or refresh the declared metadata of one that is
    // still pending — ONE statement, so a concurrent init of the same content
    // cannot fail on the unique content address. `setWhere` is what keeps it
    // honest: an asset that became `uploaded` between the read above and this
    // write holds its TRUE size (from S3 `HeadObject`), which a client-declared
    // size must never overwrite.
    await db
      .insert(updateAssets)
      .values({
        sha256: asset.sha256,
        contentType: asset.contentType,
        size: asset.size,
        status: 'pending',
      })
      .onConflictDoUpdate({
        target: updateAssets.sha256,
        set: { contentType: asset.contentType, size: asset.size },
        setWhere: eq(updateAssets.status, 'pending'),
      });

    const s3Key = updateAssetS3Key(asset.sha256);
    const checksumSHA256 = Buffer.from(asset.sha256, 'hex').toString('base64');
    const uploadUrl = await s3Service.getPresignedUploadUrl(s3Key, {
      contentType: asset.contentType,
      cacheControl: ASSET_CACHE_CONTROL,
      checksumSHA256,
      expiresIn: ASSET_UPLOAD_URL_EXPIRY_SECONDS,
    });
    missing.push({
      sha256: asset.sha256,
      uploadUrl,
      storageKey: s3Key,
      contentType: asset.contentType,
      cacheControl: ASSET_CACHE_CONTROL,
      checksumSHA256,
    });
  }

  logger.info('Oxy Updates assets init', {
    applicationId,
    requested: bySha.size,
    missing: missing.length,
    existing: existing.length,
  });

  return { missing, existing };
}

/**
 * Verify each claimed-complete asset's bytes and flip it to `uploaded`. Because
 * assets are globally deduplicated by their content address, trusting only S3
 * metadata here would let one publisher poison an asset used by every app.
 */
export async function completeAssets(
  applicationId: string,
  sha256s: string[]
): Promise<AssetCompleteResponse> {
  const db = getDb();
  const results: AssetCompleteResponse['assets'] = [];
  const unique = Array.from(new Set(sha256s));

  const held = await db
    .select({
      sha256: updateAssets.sha256,
      s3Key: updateAssets.s3Key,
      size: updateAssets.size,
      status: updateAssets.status,
    })
    .from(updateAssets)
    .where(inArray(updateAssets.sha256, unique));
  const bySha = new Map(held.map((asset) => [asset.sha256, asset]));

  for (const sha256 of unique) {
    const asset = bySha.get(sha256);
    if (!asset) {
      throw new BadRequestError(`Asset ${sha256} was never initialised`);
    }

    if (asset.status === 'uploaded') {
      results.push({ sha256, status: 'uploaded', size: asset.size });
      continue;
    }

    const head = await s3Service.headObject(asset.s3Key);
    if (!head || head.size <= 0 || head.size !== asset.size) {
      logger.warn('Oxy Updates asset complete: object missing or size mismatch', {
        applicationId,
        sha256,
        s3Key: asset.s3Key,
        expectedSize: asset.size,
        actualSize: head?.size ?? 0,
      });
      results.push({ sha256, status: 'pending', size: 0 });
      continue;
    }

    const bytes = await s3Service.downloadBuffer(asset.s3Key);
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== asset.size || actualSha256 !== sha256) {
      logger.warn('Oxy Updates asset complete: content verification failed', {
        applicationId,
        sha256,
        actualSha256,
        expectedSize: asset.size,
        actualSize: bytes.length,
        s3Key: asset.s3Key,
      });
      results.push({ sha256, status: 'pending', size: 0 });
      continue;
    }

    await db
      .update(updateAssets)
      .set({ status: 'uploaded' })
      .where(eq(updateAssets.sha256, sha256));
    results.push({ sha256, status: 'uploaded', size: asset.size });
  }

  return { assets: results };
}

/* -------------------------------------------------------------------------- */
/*  Channels                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Find or create a channel by name for an application (CI-friendly for `pr-<n>`).
 *
 * ONE statement: the `(application_id, name)` unique constraint makes the insert
 * an upsert, and the no-op `set` is what lets `returning` hand back the existing
 * row on conflict — `onConflictDoNothing` returns nothing at all.
 */
async function ensureChannel(
  db: DbHandle,
  applicationId: string,
  name: string
): Promise<ChannelRow> {
  // Mongoose stored this trimmed (`trim: true`), which Postgres has no
  // counterpart for. `channelNameSchema` already refuses whitespace on every
  // write path, so this only keeps the stored value's shape stated where it is
  // written rather than assumed.
  const trimmed = name.trim();
  const [channel] = await db
    .insert(updateChannels)
    .values({ applicationId, name: trimmed })
    .onConflictDoUpdate({
      target: [updateChannels.applicationId, updateChannels.name],
      set: { name: trimmed },
    })
    .returning(channelColumns);
  return channel;
}

async function resolveChannel(
  db: DbHandle,
  applicationId: string,
  name: string
): Promise<ChannelRow> {
  const [channel] = await db
    .select(channelColumns)
    .from(updateChannels)
    .where(and(eq(updateChannels.applicationId, applicationId), eq(updateChannels.name, name)));
  if (!channel) {
    throw new NotFoundError(`Channel '${name}' not found`);
  }
  return channel;
}

/** Remove any active rollback-to-embedded entry for a runtime+platform (a fresh publish clears it). */
async function clearRollbackToEmbedded(
  db: DbHandle,
  channelId: string,
  runtimeVersion: string,
  platform: UpdatePlatform
): Promise<void> {
  await db
    .delete(updateChannelRollbacks)
    .where(
      and(
        eq(updateChannelRollbacks.channelId, channelId),
        eq(updateChannelRollbacks.runtimeVersion, runtimeVersion),
        eq(updateChannelRollbacks.platform, platform)
      )
    );
}

/* -------------------------------------------------------------------------- */
/*  Create update                                                              */
/* -------------------------------------------------------------------------- */

/** Assert every referenced asset is present and `uploaded`; otherwise 400. */
async function assertAssetsUploaded(db: DbHandle, shas: string[]): Promise<void> {
  const unique = Array.from(new Set(shas));
  const uploaded = await db
    .select({ sha256: updateAssets.sha256 })
    .from(updateAssets)
    .where(and(inArray(updateAssets.sha256, unique), eq(updateAssets.status, 'uploaded')));
  const have = new Set(uploaded.map((asset) => asset.sha256));
  const notUploaded = unique.filter((sha) => !have.has(sha));
  if (notUploaded.length > 0) {
    throw new BadRequestError(
      `Cannot publish: ${notUploaded.length} asset(s) not uploaded (${notUploaded
        .slice(0, 3)
        .join(', ')}${notUploaded.length > 3 ? ', …' : ''})`
    );
  }
}

export async function createUpdate(input: CreateUpdateRequest): Promise<Update> {
  const referenced = [input.launchAsset.sha256, ...input.assets.map((a) => a.sha256)];

  const published = await getDb().transaction(async (tx) => {
    await assertAssetsUploaded(tx, referenced);

    const channel = await ensureChannel(tx, input.applicationId, input.channel);
    // A fresh publish supersedes any active rollback-to-embedded for this tuple.
    await clearRollbackToEmbedded(tx, channel.id, input.runtimeVersion, input.platform);

    const [update] = await tx
      .insert(appUpdates)
      .values({
        applicationId: input.applicationId,
        channelId: channel.id,
        runtimeVersion: input.runtimeVersion,
        platform: input.platform,
        status: 'published',
        launchAssetSha256: input.launchAsset.sha256,
        launchAssetKey: input.launchAsset.key,
        launchAssetContentType: input.launchAsset.contentType,
        launchAssetFileExtension: input.launchAsset.fileExtension,
        extra: input.extra,
        metadata: input.metadata ?? {},
        rolloutPercent: input.rolloutPercent ?? 100,
        gitCommit: input.gitCommit,
        gitBranch: input.gitBranch,
        message: input.message,
      })
      .returning(updateColumns);

    if (input.assets.length > 0) {
      // The array index IS the ordinal — the published order, recorded rather
      // than left to insertion order.
      await tx.insert(appUpdateAssets).values(
        input.assets.map((asset, ordinal) => ({
          appUpdateId: update.id,
          ordinal,
          sha256: asset.sha256,
          key: asset.key,
          contentType: asset.contentType,
          fileExtension: asset.fileExtension,
        }))
      );
    }

    return { update, channelName: channel.name };
  });

  logger.info('Oxy Update published', {
    applicationId: input.applicationId,
    channel: input.channel,
    runtimeVersion: input.runtimeVersion,
    platform: input.platform,
    updateId: published.update.updateId,
    rolloutPercent: published.update.rolloutPercent,
  });

  return serializeUpdate(
    published.update,
    published.channelName,
    input.assets.map((asset) => asset.sha256)
  );
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle: rollback / rollback-to-embedded / promote / rollout            */
/* -------------------------------------------------------------------------- */

/**
 * Find the current head (newest published) for a channel + runtime + platform.
 *
 * `order by created_at desc` matches `app_updates_head_idx` exactly, so the
 * limit is served from the index rather than by sorting the track's history.
 * `lock` takes a row lock so a rollback cannot lose a race to a concurrent one
 * and mark the same head twice.
 */
async function findHead(
  db: DbHandle,
  applicationId: string,
  channelId: string,
  runtimeVersion: string,
  platform: UpdatePlatform,
  options: { lock?: boolean } = {}
): Promise<UpdateRow | undefined> {
  const query = db
    .select(updateColumns)
    .from(appUpdates)
    .where(
      and(
        eq(appUpdates.applicationId, applicationId),
        eq(appUpdates.channelId, channelId),
        eq(appUpdates.runtimeVersion, runtimeVersion),
        eq(appUpdates.platform, platform),
        eq(appUpdates.status, 'published')
      )
    )
    .orderBy(desc(appUpdates.createdAt))
    .limit(1);

  const [head] = options.lock ? await query.for('update') : await query;
  return head;
}

/**
 * Mark the current head `rolled_back` so the previous published update becomes
 * head again. Nothing is deleted. Returns the rolled-back update and the new head.
 */
export async function rollback(
  applicationId: string,
  channelName: string,
  runtimeVersion: string,
  platform: UpdatePlatform
): Promise<{ rolledBack: Update; head: Update | null }> {
  const result = await getDb().transaction(async (tx) => {
    const channel = await resolveChannel(tx, applicationId, channelName);
    // Locked: two rollbacks issued at once must retire two different heads, not
    // the same one twice.
    const head = await findHead(tx, applicationId, channel.id, runtimeVersion, platform, {
      lock: true,
    });
    if (!head) {
      throw new NotFoundError('No published update to roll back for this runtime/platform');
    }

    const [rolledBack] = await tx
      .update(appUpdates)
      .set({ status: 'rolled_back' })
      .where(eq(appUpdates.id, head.id))
      .returning(updateColumns);

    const newHead = await findHead(tx, applicationId, channel.id, runtimeVersion, platform);

    const assets = await loadAssetSha256s(
      tx,
      newHead ? [rolledBack.id, newHead.id] : [rolledBack.id]
    );
    return { channel, rolledBack, newHead, assets };
  });

  logger.info('Oxy Update rolled back', {
    applicationId,
    channel: channelName,
    runtimeVersion,
    platform,
    rolledBackUpdateId: result.rolledBack.updateId,
    newHeadUpdateId: result.newHead?.updateId ?? null,
  });

  return {
    rolledBack: serializeUpdate(
      result.rolledBack,
      result.channel.name,
      result.assets.get(result.rolledBack.id) ?? []
    ),
    head: result.newHead
      ? serializeUpdate(
          result.newHead,
          result.channel.name,
          result.assets.get(result.newHead.id) ?? []
        )
      : null,
  };
}

/**
 * Record a `rollBackToEmbedded` directive for a runtime+platform so clients fall
 * back to the update embedded in their binary. Replaces any existing directive
 * for the same tuple; `commitTime` is set to now.
 *
 * ONE idempotent statement, and that is the whole point. The Mongo shape —
 * `$pull` the old entry, then `$push` the new one — left a window in which the
 * directive did not exist at all: a device polling the manifest endpoint inside
 * it is handed the very update it was just rolled back from. It also let two
 * concurrent rollbacks leave two entries for the same tuple. Neither is
 * representable here: the `(channel_id, runtime_version, platform)` primary key
 * is the target of the conflict clause, so the row is updated in place and is
 * never absent.
 */
export async function rollbackToEmbedded(
  applicationId: string,
  channelName: string,
  runtimeVersion: string,
  platform: UpdatePlatform
): Promise<Channel> {
  const db = getDb();
  const channel = await resolveChannel(db, applicationId, channelName);
  const commitTime = new Date();

  await db
    .insert(updateChannelRollbacks)
    .values({ channelId: channel.id, runtimeVersion, platform, commitTime })
    .onConflictDoUpdate({
      target: [
        updateChannelRollbacks.channelId,
        updateChannelRollbacks.runtimeVersion,
        updateChannelRollbacks.platform,
      ],
      set: { commitTime },
    });

  logger.info('Oxy Update rollback-to-embedded set', {
    applicationId,
    channel: channelName,
    runtimeVersion,
    platform,
    commitTime: commitTime.toISOString(),
  });

  const rollbacks = await loadRollbacks(db, [channel.id]);
  return serializeChannel(channel, rollbacks.get(channel.id) ?? []);
}

/**
 * Promote an existing update into a channel by creating a NEW update (new UUID)
 * pointing at the SAME assets. Creates the target channel on demand.
 */
export async function promote(
  applicationId: string,
  fromUpdateId: string,
  toChannelName: string,
  rolloutPercent?: number
): Promise<Update> {
  const db = getDb();

  const [source] = await db
    .select({
      ...updateColumns,
      launchAssetKey: appUpdates.launchAssetKey,
      launchAssetContentType: appUpdates.launchAssetContentType,
      launchAssetFileExtension: appUpdates.launchAssetFileExtension,
      extra: appUpdates.extra,
      metadata: appUpdates.metadata,
    })
    .from(appUpdates)
    .where(
      and(eq(appUpdates.applicationId, applicationId), eq(appUpdates.updateId, fromUpdateId))
    );
  if (!source) {
    throw new NotFoundError(`Update ${fromUpdateId} not found`);
  }

  // The source's descriptors AND their positions: a promotion serves the same
  // asset list in the same order, so the ordinals are copied, not recomputed.
  const sourceAssets = await db
    .select({
      ordinal: appUpdateAssets.ordinal,
      sha256: appUpdateAssets.sha256,
      key: appUpdateAssets.key,
      contentType: appUpdateAssets.contentType,
      fileExtension: appUpdateAssets.fileExtension,
    })
    .from(appUpdateAssets)
    .where(eq(appUpdateAssets.appUpdateId, source.id))
    .orderBy(asc(appUpdateAssets.ordinal));

  const published = await getDb().transaction(async (tx) => {
    const channel = await ensureChannel(tx, applicationId, toChannelName);
    await clearRollbackToEmbedded(tx, channel.id, source.runtimeVersion, source.platform);

    const [update] = await tx
      .insert(appUpdates)
      .values({
        applicationId: source.applicationId,
        channelId: channel.id,
        runtimeVersion: source.runtimeVersion,
        platform: source.platform,
        status: 'published',
        launchAssetSha256: source.launchAssetSha256,
        launchAssetKey: source.launchAssetKey,
        launchAssetContentType: source.launchAssetContentType,
        launchAssetFileExtension: source.launchAssetFileExtension,
        extra: source.extra,
        metadata: source.metadata,
        rolloutPercent: rolloutPercent ?? 100,
        gitCommit: source.gitCommit,
        gitBranch: source.gitBranch,
        message: source.message,
        promotedFromUpdateId: source.updateId,
      })
      .returning(updateColumns);

    if (sourceAssets.length > 0) {
      await tx
        .insert(appUpdateAssets)
        .values(sourceAssets.map((asset) => ({ ...asset, appUpdateId: update.id })));
    }

    return { update, channelName: channel.name };
  });

  logger.info('Oxy Update promoted', {
    applicationId,
    fromUpdateId,
    toChannel: toChannelName,
    newUpdateId: published.update.updateId,
    rolloutPercent: published.update.rolloutPercent,
  });

  return serializeUpdate(
    published.update,
    published.channelName,
    sourceAssets.map((asset) => asset.sha256)
  );
}

/** Adjust an update's rollout percentage in place. */
export async function setRollout(
  applicationId: string,
  updateId: string,
  rolloutPercent: number
): Promise<Update> {
  const db = getDb();

  // The UPDATE's own result decides whether the update existed — never a row
  // read beforehand.
  const [update] = await db
    .update(appUpdates)
    .set({ rolloutPercent })
    .where(and(eq(appUpdates.applicationId, applicationId), eq(appUpdates.updateId, updateId)))
    .returning({ ...updateColumns, channelId: appUpdates.channelId });
  if (!update) {
    throw new NotFoundError(`Update ${updateId} not found`);
  }

  // `channel_id` is NOT NULL with a foreign key, so this row exists.
  const [channel] = await db
    .select({ name: updateChannels.name })
    .from(updateChannels)
    .where(eq(updateChannels.id, update.channelId));
  const assets = await loadAssetSha256s(db, [update.id]);

  logger.info('Oxy Update rollout adjusted', { applicationId, updateId, rolloutPercent });

  return serializeUpdate(update, channel.name, assets.get(update.id) ?? []);
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function listChannels(applicationId: string): Promise<Channel[]> {
  const db = getDb();
  const channels = await db
    .select(channelColumns)
    .from(updateChannels)
    .where(eq(updateChannels.applicationId, applicationId))
    .orderBy(asc(updateChannels.name));

  const rollbacks = await loadRollbacks(
    db,
    channels.map((channel) => channel.id)
  );
  return channels.map((channel) =>
    serializeChannel(channel, rollbacks.get(channel.id) ?? [])
  );
}

export async function listUpdates(
  applicationId: string,
  channelName?: string,
  runtimeVersion?: string,
  platform?: UpdatePlatform,
  limit = 50
): Promise<Update[]> {
  const db = getDb();

  const filters = [eq(appUpdates.applicationId, applicationId)];
  if (channelName) filters.push(eq(updateChannels.name, channelName));
  if (runtimeVersion) filters.push(eq(appUpdates.runtimeVersion, runtimeVersion));
  if (platform) filters.push(eq(appUpdates.platform, platform));

  // The channel name comes back on the join rather than from a second pass over
  // the results — the Mongo version had to resolve it separately because the
  // channel was a bare id with nothing to join to.
  const rows = await db
    .select({ ...updateColumns, channelName: updateChannels.name })
    .from(appUpdates)
    .innerJoin(updateChannels, eq(appUpdates.channelId, updateChannels.id))
    .where(and(...filters))
    .orderBy(desc(appUpdates.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));

  const assets = await loadAssetSha256s(
    db,
    rows.map((row) => row.id)
  );
  return rows.map((row) =>
    serializeUpdate(row, row.channelName, assets.get(row.id) ?? [])
  );
}
