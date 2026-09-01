/**
 * Manifest resolution + multipart assembly for the public Oxy Updates endpoint.
 *
 * This is the hot, unauthenticated path (`GET /updates/v1/apps/:clientId/manifest`).
 * It resolves what a given device should receive for its `(channel,
 * runtimeVersion, platform)` and assembles the exact `multipart/mixed` bytes the
 * expo-updates v1 protocol requires, signing the manifest/directive part when
 * the client requested code signing.
 *
 * Decision precedence (matches the plan tree + Expo's reference server):
 *   1. Active `rollBackToEmbedded` directive for this runtime+platform → serve it
 *      (unless the client is already on its embedded update — avoids a loop).
 *   2. Otherwise resolve the rollout-aware HEAD update. If none, or the client is
 *      already running it → `noUpdateAvailable`.
 *   3. Otherwise serve the signed manifest for the head.
 *
 * On protocol version 0 (which predates directives) a directive decision degrades
 * to an empty `204` no-op; a real manifest is still served normally.
 *
 * ## The two reads this path makes, and why they are the shape they are
 *
 * The channel and its rollback directive come back together on a LEFT JOIN whose
 * condition is the rollback table's whole primary key — so it contributes at most
 * one row, and step 1 costs no extra round trip on a path every installed device
 * polls. The manifest's asset list is a second read ordered BY ORDINAL: the
 * manifest is signed and a device may fetch any historical update, so serving its
 * assets in a different order than they were published invalidates the signature.
 */

import crypto from 'crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { UpdatePlatform } from '@oxyhq/contracts';
import { getDb } from '../../config/postgres';
import { appUpdateAssets, appUpdates, updateChannelRollbacks, updateChannels } from '../../db/schema';
import { updateAssetCdnUrl, sha256HexToBase64Url } from './assetKeys';
import { signPartBytes } from './signing.service';

/** Parsed, validated inputs for a manifest resolution. */
export interface ManifestRequest {
  /** Resolved Application id. */
  applicationId: string;
  platform: UpdatePlatform;
  runtimeVersion: string;
  /** `expo-channel-name`; absent/unknown → noUpdateAvailable. */
  channelName?: string;
  /** `expo-current-update-id` — the update the client is currently running. */
  currentUpdateId?: string;
  /** `expo-embedded-update-id` — the update embedded in the client binary. */
  embeddedUpdateId?: string;
  /** Negotiated protocol version (0 or 1). */
  protocolVersion: 0 | 1;
  /** True when the client sent `expo-expect-signature` (wants a signed response). */
  expectSignature: boolean;
  /** Rollout device key from `expo-extra-params` `oxy-device-id`; absent → out of any partial rollout. */
  deviceKey?: string;
}

/** A fully-assembled HTTP response the route writes verbatim. */
export interface ManifestResponse {
  status: number;
  headers: Record<string, string>;
  body?: Buffer;
}

/**
 * One asset descriptor of a manifest. `fileExtension` is absent for an asset
 * that has none — and always for the launch asset, whose extension clients
 * ignore.
 */
interface ManifestAssetRef {
  sha256: string;
  key: string;
  contentType: string;
  fileExtension?: string | null;
}

/** Everything the manifest for one published update is built from. */
export interface PublishedUpdate {
  updateId: string;
  createdAt: Date;
  runtimeVersion: string;
  launchAsset: ManifestAssetRef;
  /** In PUBLISHED order — see the header. */
  assets: ManifestAssetRef[];
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

type ManifestDecision =
  | { kind: 'manifest'; update: PublishedUpdate }
  | { kind: 'noUpdate' }
  | { kind: 'rollBackToEmbedded'; commitTime: Date };

/** How many newest published updates to consider when walking a partial rollout. */
const ROLLOUT_LOOKBACK = 25;

/**
 * Deterministic rollout membership: `sha256(updateId + ':' + deviceKey) % 10000 <
 * pct * 100`. A device without a key is out of any partial (<100) rollout. The
 * bucket is stable per (update, device), so a device's inclusion never flaps as
 * the percentage is raised.
 */
export function isInRollout(
  updateId: string,
  rolloutPercent: number,
  deviceKey: string | undefined
): boolean {
  if (rolloutPercent >= 100) return true;
  if (rolloutPercent <= 0) return false;
  if (!deviceKey) return false;
  const digest = crypto.createHash('sha256').update(`${updateId}:${deviceKey}`).digest();
  // Top 32 bits as an unsigned int → uniform bucket in [0, 10000).
  const bucket = digest.readUInt32BE(0) % 10000;
  return bucket < rolloutPercent * 100;
}

/**
 * The head update's own row. Its asset list is deliberately NOT part of this —
 * most polls end in `noUpdateAvailable`, and that decision is made from
 * `updateId` alone, so the ordered asset read only happens for a request that
 * really is receiving a manifest.
 */
interface HeadRow {
  id: string;
  updateId: string;
  createdAt: Date;
  runtimeVersion: string;
  rolloutPercent: number;
  launchAssetSha256: string;
  launchAssetKey: string;
  launchAssetContentType: string;
  launchAssetFileExtension: string | null;
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

/** Resolve the rollout-aware head update, or undefined when none applies to this device. */
async function resolveHead(
  input: ManifestRequest,
  channelId: string
): Promise<HeadRow | undefined> {
  // `order by created_at desc` matches `app_updates_head_idx` exactly, so the
  // lookback is served from the index rather than by sorting the track.
  const candidates = await getDb()
    .select({
      id: appUpdates.id,
      updateId: appUpdates.updateId,
      createdAt: appUpdates.createdAt,
      runtimeVersion: appUpdates.runtimeVersion,
      rolloutPercent: appUpdates.rolloutPercent,
      launchAssetSha256: appUpdates.launchAssetSha256,
      launchAssetKey: appUpdates.launchAssetKey,
      launchAssetContentType: appUpdates.launchAssetContentType,
      launchAssetFileExtension: appUpdates.launchAssetFileExtension,
      metadata: appUpdates.metadata,
      extra: appUpdates.extra,
    })
    .from(appUpdates)
    .where(
      and(
        eq(appUpdates.applicationId, input.applicationId),
        eq(appUpdates.channelId, channelId),
        eq(appUpdates.runtimeVersion, input.runtimeVersion),
        eq(appUpdates.platform, input.platform),
        eq(appUpdates.status, 'published')
      )
    )
    .orderBy(desc(appUpdates.createdAt))
    .limit(ROLLOUT_LOOKBACK);

  return candidates.find((candidate) =>
    isInRollout(candidate.updateId, candidate.rolloutPercent, input.deviceKey)
  );
}

/**
 * Read the head's asset descriptors and assemble the manifest source.
 *
 * `order by ordinal` is the whole reason `app_update_assets` carries one: the
 * manifest is signed, a device may fetch this update at any point in the future,
 * and a reordered `assets` array is a different set of bytes under the same
 * signature.
 */
async function loadPublishedUpdate(head: HeadRow): Promise<PublishedUpdate> {
  const assets = await getDb()
    .select({
      sha256: appUpdateAssets.sha256,
      key: appUpdateAssets.key,
      contentType: appUpdateAssets.contentType,
      fileExtension: appUpdateAssets.fileExtension,
    })
    .from(appUpdateAssets)
    .where(eq(appUpdateAssets.appUpdateId, head.id))
    .orderBy(asc(appUpdateAssets.ordinal));

  return {
    updateId: head.updateId,
    createdAt: head.createdAt,
    runtimeVersion: head.runtimeVersion,
    launchAsset: {
      sha256: head.launchAssetSha256,
      key: head.launchAssetKey,
      contentType: head.launchAssetContentType,
      fileExtension: head.launchAssetFileExtension,
    },
    assets,
    metadata: head.metadata,
    extra: head.extra,
  };
}

/** Run the decision tree for a manifest request. */
async function decide(input: ManifestRequest): Promise<ManifestDecision> {
  if (!input.channelName) {
    return { kind: 'noUpdate' };
  }

  // One round trip for both step 1 and the channel id step 2 needs. The join
  // condition is the rollback table's full primary key, so it matches at most
  // one row and this can never fan the channel out.
  const [channel] = await getDb()
    .select({
      id: updateChannels.id,
      rollbackCommitTime: updateChannelRollbacks.commitTime,
    })
    .from(updateChannels)
    .leftJoin(
      updateChannelRollbacks,
      and(
        eq(updateChannelRollbacks.channelId, updateChannels.id),
        eq(updateChannelRollbacks.runtimeVersion, input.runtimeVersion),
        eq(updateChannelRollbacks.platform, input.platform)
      )
    )
    .where(
      and(
        eq(updateChannels.applicationId, input.applicationId),
        eq(updateChannels.name, input.channelName)
      )
    );
  if (!channel) {
    return { kind: 'noUpdate' };
  }

  if (channel.rollbackCommitTime) {
    // The client is already on its embedded bundle — don't roll it back again.
    if (
      input.currentUpdateId &&
      input.embeddedUpdateId &&
      input.currentUpdateId === input.embeddedUpdateId
    ) {
      return { kind: 'noUpdate' };
    }
    return { kind: 'rollBackToEmbedded', commitTime: channel.rollbackCommitTime };
  }

  const head = await resolveHead(input, channel.id);
  if (!head) {
    return { kind: 'noUpdate' };
  }
  if (head.updateId === input.currentUpdateId) {
    return { kind: 'noUpdate' };
  }
  return { kind: 'manifest', update: await loadPublishedUpdate(head) };
}

/** Build a single expo manifest asset object from a stored descriptor. */
function assetToManifest(
  ref: ManifestAssetRef,
  isLaunchAsset: boolean
): Record<string, unknown> {
  const asset: Record<string, unknown> = {
    hash: sha256HexToBase64Url(ref.sha256),
    key: ref.key,
    contentType: ref.contentType,
    url: updateAssetCdnUrl(ref.sha256),
  };
  // The launch asset's fileExtension is ignored by clients and SHOULD be omitted.
  if (!isLaunchAsset && ref.fileExtension) {
    asset.fileExtension = ref.fileExtension;
  }
  return asset;
}

/** Build the manifest JSON object for a published update. */
export function buildManifestObject(update: PublishedUpdate): Record<string, unknown> {
  return {
    id: update.updateId,
    createdAt: update.createdAt.toISOString(),
    runtimeVersion: update.runtimeVersion,
    launchAsset: assetToManifest(update.launchAsset, true),
    assets: update.assets.map((asset) => assetToManifest(asset, false)),
    metadata: update.metadata,
    extra: update.extra,
  };
}

interface MultipartPart {
  name: 'manifest' | 'directive' | 'extensions';
  contentType: string;
  body: Buffer;
  signature?: string;
}

/** Assemble a `multipart/mixed` body with exact bytes (no dependency on form-data). */
function assembleMultipart(parts: MultipartPart[]): { boundary: string; body: Buffer } {
  const boundary = `oxy-updates-${crypto.randomBytes(16).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="${part.name}"\r\n`;
    header += `Content-Type: ${part.contentType}\r\n`;
    if (part.signature) {
      header += `expo-signature: ${part.signature}\r\n`;
    }
    header += '\r\n';
    chunks.push(Buffer.from(header, 'utf8'), part.body, Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

/** Common expo-updates response headers for a multipart body. */
function multipartHeaders(boundary: string): Record<string, string> {
  return {
    'expo-protocol-version': '1',
    'expo-sfv-version': '0',
    'cache-control': 'private, max-age=0',
    'content-type': `multipart/mixed; boundary=${boundary}`,
  };
}

/** Wrap one signable JSON part (manifest or directive) into a full multipart response. */
function jsonPartResponse(
  name: 'manifest' | 'directive',
  json: Record<string, unknown>,
  expectSignature: boolean,
  extraParts: MultipartPart[] = []
): ManifestResponse {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  // signPartBytes throws CodeSigningNotConfiguredError when a signature is
  // required but no key is configured — the route maps that to a 500.
  const signature = expectSignature ? signPartBytes(body) : undefined;
  const part: MultipartPart = {
    name,
    contentType: 'application/json; charset=utf-8',
    body,
    signature,
  };
  const { boundary, body: multipart } = assembleMultipart([part, ...extraParts]);
  return { status: 200, headers: multipartHeaders(boundary), body: multipart };
}

/** Empty `204 No Content` response — a valid multipart no-op for protocol 0 directives. */
function noContentResponse(): ManifestResponse {
  return {
    status: 204,
    headers: { 'expo-protocol-version': '1', 'expo-sfv-version': '0' },
  };
}

/**
 * Resolve a manifest request into a fully-formed HTTP response (status, headers,
 * body). Pure of Express — the route adapts it. May throw
 * `CodeSigningNotConfiguredError` when a signature is required but unconfigured.
 */
export async function buildManifestResponse(input: ManifestRequest): Promise<ManifestResponse> {
  const decision = await decide(input);

  if (decision.kind === 'manifest') {
    const manifest = buildManifestObject(decision.update);
    // The (unsigned) extensions part carries asset request headers — empty here
    // because Oxy Update assets are public CDN objects needing no auth headers.
    const extensions: MultipartPart = {
      name: 'extensions',
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ assetRequestHeaders: {} }), 'utf8'),
    };
    return jsonPartResponse('manifest', manifest, input.expectSignature, [extensions]);
  }

  // Directives are unavailable on protocol 0 → empty 204 no-op.
  if (input.protocolVersion === 0) {
    return noContentResponse();
  }

  if (decision.kind === 'rollBackToEmbedded') {
    return jsonPartResponse(
      'directive',
      {
        type: 'rollBackToEmbedded',
        parameters: { commitTime: decision.commitTime.toISOString() },
      },
      input.expectSignature
    );
  }

  return jsonPartResponse('directive', { type: 'noUpdateAvailable' }, input.expectSignature);
}
