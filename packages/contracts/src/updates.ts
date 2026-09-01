/**
 * Oxy Updates (self-hosted expo-updates protocol) — publish/admin API contracts.
 *
 * SINGLE SOURCE OF TRUTH for the wire shape of the AUTHENTICATED publish/admin
 * surface that the `oxy-ship` CLI and the console Updates tab call. The PUBLIC
 * manifest endpoint (`GET /updates/v1/apps/:clientId/manifest`) speaks the
 * expo-updates v1 protocol verbatim (multipart/mixed, signed) and is therefore
 * NOT modelled here — its shape is dictated by the Expo spec, not by us.
 *
 * The API validates its OUTPUT against these schemas; every consumer (the ship
 * CLI, the console hook) validates its INPUT against the same definitions, so
 * producer and consumers cannot drift.
 *
 * Domain model (mirrors the Mongoose models in `@oxyhq/api`):
 *  - A `channel` (e.g. `production`, `preview`, `pr-123`) is a named release
 *    track for one application.
 *  - An `update` is one published bundle for a single `(channel, runtimeVersion,
 *    platform)`. Its `updateId` is a UUIDv4 (the client parses it as a UUID).
 *    The HEAD of a track is the newest `published` update for that tuple.
 *  - An `asset` is content-addressed by its `sha256`; assets are shared across
 *    updates and applications (an unchanged JS bundle is uploaded once).
 *
 * Platform-agnostic — zod only, no react/react-native/expo. ESM-safe (no
 * `require()`).
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Shared primitives                                                         */
/* -------------------------------------------------------------------------- */

/** The two platforms the expo-updates protocol addresses. */
export const updatePlatformSchema = z.enum(['ios', 'android']);
export type UpdatePlatform = z.infer<typeof updatePlatformSchema>;

/** Lifecycle of a single published update row. */
export const updateStatusSchema = z.enum(['published', 'superseded', 'rolled_back']);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** Upload lifecycle of a content-addressed asset. */
export const updateAssetStatusSchema = z.enum(['pending', 'uploaded']);
export type UpdateAssetStatus = z.infer<typeof updateAssetStatusSchema>;

/** Lowercase-hex SHA-256 content hash (64 hex chars). */
export const sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters');

/**
 * A channel name. Constrained to a URL/path-safe slug so it can appear in the
 * `expo-channel-name` header and be used CI-friendly for `pr-<n>` tracks. No
 * colon (BullMQ/id safety) and no slash (path safety).
 */
export const channelNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'channel name must be a URL-safe slug');

/** A runtime version string (expo-updates `runtimeVersion`, e.g. an appVersion). */
export const runtimeVersionSchema = z.string().min(1).max(255);

/** A rollout percentage: 0 rolls out to nobody, 100 to everybody. */
export const rolloutPercentSchema = z.number().int().min(0).max(100);

/* -------------------------------------------------------------------------- */
/*  Assets: init + complete                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One asset the client intends to upload as part of an update. `sha256` is the
 * content hash (dedup key); `contentType` and `size` describe the object the
 * server will accept at the presigned URL.
 */
export const assetInitItemSchema = z.object({
  sha256: sha256HexSchema,
  contentType: z.string().min(1).max(255),
  size: z.number().int().positive(),
});
export type AssetInitItem = z.infer<typeof assetInitItemSchema>;

/**
 * `POST /updates/v1/assets/init` request. Declares the full asset set of an
 * update; the server replies with a presigned PUT for every asset it does NOT
 * already hold (content-addressed dedup — unchanged assets are never re-uploaded).
 */
export const assetInitRequestSchema = z.object({
  applicationId: z.string().min(1),
  assets: z.array(assetInitItemSchema).min(1).max(2000),
});
export type AssetInitRequest = z.infer<typeof assetInitRequestSchema>;

/** One presigned upload the client must PUT its bytes to before completing. */
export const assetUploadTicketSchema = z.object({
  sha256: sha256HexSchema,
  /** Presigned S3 PUT URL. The client PUTs the exact bytes here. */
  uploadUrl: z.string(),
  /** The S3 key the object will live at (`public/updates/assets/<sha256>`). */
  storageKey: z.string(),
  /** The Content-Type the presigned URL was signed for; echo it on the PUT. */
  contentType: z.string(),
  /**
   * The Cache-Control the presigned URL was signed for; the client MUST send it
   * verbatim on the PUT so the SigV4 signature matches and the stored object
   * carries the long immutable cache header (assets are content-addressed).
   */
  cacheControl: z.string(),
  /** Base64 SHA-256 value required in the presigned PUT's checksum header. */
  checksumSHA256: z.string(),
});
export type AssetUploadTicket = z.infer<typeof assetUploadTicketSchema>;

/**
 * `POST /updates/v1/assets/init` response. `missing` holds a presigned upload
 * for each asset the server does not yet have; `existing` lists the sha256s it
 * already holds (the client skips those).
 */
export const assetInitResponseSchema = z.object({
  missing: z.array(assetUploadTicketSchema),
  existing: z.array(sha256HexSchema),
});
export type AssetInitResponse = z.infer<typeof assetInitResponseSchema>;

/**
 * `POST /updates/v1/assets/complete` request. Sent after the client has PUT
 * every `missing` asset. The server HEADs each object and flips it to
 * `uploaded`; an object that is absent or size-mismatched is rejected.
 */
export const assetCompleteRequestSchema = z.object({
  applicationId: z.string().min(1),
  sha256s: z.array(sha256HexSchema).min(1).max(2000),
});
export type AssetCompleteRequest = z.infer<typeof assetCompleteRequestSchema>;

/** Per-asset verification outcome from `assets/complete`. */
export const assetCompleteResultItemSchema = z.object({
  sha256: sha256HexSchema,
  status: updateAssetStatusSchema,
  size: z.number().int().nonnegative(),
});
export type AssetCompleteResultItem = z.infer<typeof assetCompleteResultItemSchema>;

export const assetCompleteResponseSchema = z.object({
  assets: z.array(assetCompleteResultItemSchema),
});
export type AssetCompleteResponse = z.infer<typeof assetCompleteResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  Create update                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A single asset reference inside a create-update request. `key` is the
 * expo-export asset key (the md5-basename the client uses to look the asset up
 * and skip embedded ones); `fileExtension` is the suggested on-disk extension.
 */
export const updateAssetRefSchema = z.object({
  sha256: sha256HexSchema,
  /** expo-export asset key (md5 basename) — how app code references the asset. */
  key: z.string().min(1),
  contentType: z.string().min(1),
  /** Suggested file extension including the leading dot (e.g. `.js`, `.png`). */
  fileExtension: z.string().optional(),
});
export type UpdateAssetRef = z.infer<typeof updateAssetRefSchema>;

/**
 * `POST /updates/v1/updates` request. Publishes one bundle for one platform to a
 * channel (the channel is created on demand — CI-friendly for `pr-<n>`). All
 * referenced assets MUST already be `uploaded` (via init/complete). `extra`
 * MUST carry `expoClient` so `Constants.expoConfig` works after an OTA update.
 */
export const createUpdateRequestSchema = z.object({
  applicationId: z.string().min(1),
  channel: channelNameSchema,
  runtimeVersion: runtimeVersionSchema,
  platform: updatePlatformSchema,
  /** The launch (entry-point) asset — its `fileExtension` is ignored by clients. */
  launchAsset: updateAssetRefSchema,
  assets: z.array(updateAssetRefSchema),
  /**
   * Opaque `extra` blob embedded verbatim in the signed manifest. MUST contain
   * `expoClient` (the public expo config) so `Constants.expoConfig` resolves
   * after an OTA update; MAY carry other third-party config.
   */
  extra: z
    .object({ expoClient: z.record(z.string(), z.unknown()) })
    .catchall(z.unknown()),
  /** String→string metadata dict; filtered client-side via manifest filters. */
  metadata: z.record(z.string(), z.string()).optional(),
  /** Initial rollout percentage (default 100 — full rollout). */
  rolloutPercent: rolloutPercentSchema.optional(),
  /** Git commit the bundle was built from (audit / console display). */
  gitCommit: z.string().max(100).optional(),
  /** Git branch the bundle was built from (audit / console display). */
  gitBranch: z.string().max(200).optional(),
  /** Human-readable publish message (console display). */
  message: z.string().max(500).optional(),
});
export type CreateUpdateRequest = z.infer<typeof createUpdateRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Update / channel read models                                             */
/* -------------------------------------------------------------------------- */

/**
 * A published update as returned by the read/admin endpoints. `id` is the
 * update's UUIDv4 (the manifest `id`). Declared as an explicit interface (schema
 * annotated `z.ZodType<Update>`) so the nested shape survives a consumer's
 * `moduleResolution: "node"`, matching the convention in the other contracts.
 */
export interface Update {
  id: string;
  applicationId: string;
  channel: string;
  runtimeVersion: string;
  platform: UpdatePlatform;
  status: UpdateStatus;
  rolloutPercent: number;
  launchAssetSha256: string;
  assetSha256s: string[];
  gitCommit?: string;
  gitBranch?: string;
  message?: string;
  /** The updateId this update was promoted from, when it is a promotion. */
  promotedFromUpdateId?: string;
  createdAt: string;
  updatedAt: string;
}

export const updateSchema: z.ZodType<Update> = z.object({
  id: z.string(),
  applicationId: z.string(),
  channel: z.string(),
  runtimeVersion: z.string(),
  platform: updatePlatformSchema,
  status: updateStatusSchema,
  rolloutPercent: rolloutPercentSchema,
  launchAssetSha256: sha256HexSchema,
  assetSha256s: z.array(sha256HexSchema),
  gitCommit: z.string().optional(),
  gitBranch: z.string().optional(),
  message: z.string().optional(),
  promotedFromUpdateId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createUpdateResponseSchema = z.object({
  update: updateSchema,
});
export type CreateUpdateResponse = z.infer<typeof createUpdateResponseSchema>;

/** One `rollBackToEmbedded` directive currently active on a channel. */
export interface RollbackToEmbeddedEntry {
  runtimeVersion: string;
  platform: UpdatePlatform;
  /** ISO 8601 datetime; the client rolls back updates created before this. */
  commitTime: string;
}

export const rollbackToEmbeddedEntrySchema: z.ZodType<RollbackToEmbeddedEntry> = z.object({
  runtimeVersion: z.string(),
  platform: updatePlatformSchema,
  commitTime: z.string(),
});

/** A release channel with its currently-active rollback-to-embedded directives. */
export interface Channel {
  id: string;
  applicationId: string;
  name: string;
  rollbacksToEmbedded: RollbackToEmbeddedEntry[];
  createdAt: string;
  updatedAt: string;
}

export const channelSchema: z.ZodType<Channel> = z.object({
  id: z.string(),
  applicationId: z.string(),
  name: z.string(),
  rollbacksToEmbedded: z.array(rollbackToEmbeddedEntrySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const channelListResponseSchema = z.object({
  channels: z.array(channelSchema),
});
export type ChannelListResponse = z.infer<typeof channelListResponseSchema>;

export const updateListResponseSchema = z.object({
  updates: z.array(updateSchema),
});
export type UpdateListResponse = z.infer<typeof updateListResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  Rollback / rollback-to-embedded / promote / rollout                       */
/* -------------------------------------------------------------------------- */

/**
 * `POST /updates/v1/channels/:channel/rollback` request. Marks the current head
 * for `(runtimeVersion, platform)` `rolled_back` so the previous published
 * update (if any) becomes head again. Nothing is deleted.
 */
export const rollbackRequestSchema = z.object({
  applicationId: z.string().min(1),
  runtimeVersion: runtimeVersionSchema,
  platform: updatePlatformSchema,
});
export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

/**
 * `POST /updates/v1/channels/:channel/rollback-to-embedded` request. Records a
 * `rollBackToEmbedded` directive so clients on this `(runtimeVersion, platform)`
 * fall back to the update embedded in their binary.
 */
export const rollbackToEmbeddedRequestSchema = z.object({
  applicationId: z.string().min(1),
  runtimeVersion: runtimeVersionSchema,
  platform: updatePlatformSchema,
});
export type RollbackToEmbeddedRequest = z.infer<typeof rollbackToEmbeddedRequestSchema>;

/**
 * `POST /updates/v1/channels/:channel/promote` request. Promotes an existing
 * update (by `updateId`) into the target channel by creating a NEW update (new
 * UUID) pointing at the SAME assets. `toChannel` defaults to the path channel.
 */
export const promoteRequestSchema = z.object({
  applicationId: z.string().min(1),
  updateId: z.string().min(1),
  /** Target channel to promote into. Defaults to the path `:channel`. */
  toChannel: channelNameSchema.optional(),
  /** Rollout percentage for the promoted update (default 100). */
  rolloutPercent: rolloutPercentSchema.optional(),
});
export type PromoteRequest = z.infer<typeof promoteRequestSchema>;

/** `PATCH /updates/v1/updates/:updateId` request — adjust a rollout in place. */
export const updateRolloutPatchSchema = z.object({
  applicationId: z.string().min(1),
  rolloutPercent: rolloutPercentSchema,
});
export type UpdateRolloutPatch = z.infer<typeof updateRolloutPatchSchema>;
