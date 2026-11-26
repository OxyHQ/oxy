/**
 * The assets `useAssets` has uploaded, linked or read in this session
 * (`@oxy.so/bloom-data`), held per account in memory only.
 *
 * - `Asset`: each asset by id; `HeldAssets` lists the ones held, in the order
 *   they arrived.
 * - `AssetActivity`: what `useAssets` is doing (upload progress, which writes
 *   are running, why the last of each failed).
 */
import { entity, list, model, type ListState } from '@oxy.so/bloom-data';
import type { Asset as AssetRecord, AssetLink, AssetUploadProgress } from '@oxy.so/core';

export const Asset = entity<AssetRecord>('asset', { id: (asset) => asset.id });

/** The key of the one `HeldAssets` list. */
export const HELD_ASSETS_KEY = 'held';

export const HeldAssets = list('heldAssets', { of: Asset });

export interface AssetActivityState {
  uploadProgress: Record<string, AssetUploadProgress>;
  loading: { uploading: boolean; linking: boolean; deleting: boolean };
  errors: { upload?: string; link?: string; delete?: string };
}

export const IDLE_ASSET_ACTIVITY: AssetActivityState = {
  uploadProgress: {},
  loading: { uploading: false, linking: false, deleting: false },
  errors: {},
};

export const AssetActivity = model<AssetActivityState>('assetActivity');

function changeActivity(change: (current: AssetActivityState) => AssetActivityState): void {
  AssetActivity.set((current) => change(current ?? IDLE_ASSET_ACTIVITY));
}

/**
 * Whether a link is the given application's use. The Oxy API names the using
 * application by ID (`applicationId`, mirrored in `app` since ADR 0043 D4);
 * a link added locally before the server answered may still carry the name
 * the caller passed in `app`. Either matches.
 */
function linkIsApp(link: AssetLink, app: string): boolean {
  return (link.applicationId ?? link.app) === app || link.app === app;
}

function sameLink(link: AssetLink, app: string, entityType: string, entityId: string): boolean {
  return linkIsApp(link, app) && link.entityType === entityType && link.entityId === entityId;
}

const EMPTY_HELD: ListState = {
  ids: [],
  extra: undefined,
  next: undefined,
  hasMore: false,
  visited: [],
  updatedAt: 0,
  origin: 'local',
};

function hold(assetId: string): void {
  HeldAssets.set(HELD_ASSETS_KEY, (held = EMPTY_HELD) =>
    held.ids.includes(assetId) ? held : { ...held, ids: [...held.ids, assetId] },
  );
}

/**
 * Merges what an API call returned about an asset (an upload, a link change,
 * a restore — each returns only part of the record) into what is held. A
 * partial record stays partial until a full read replaces it.
 */
export function mergeAsset(patch: Partial<AssetRecord> & { id: string }): void {
  if (!Asset.update(patch.id, (held) => ({ ...held, ...patch }))) {
    Asset.put(patch as AssetRecord);
  }
  hold(patch.id);
}

export function removeAsset(assetId: string): void {
  Asset.remove(assetId);
}

/** Records a link the server did not echo back (the asset is now in use). */
export function addAssetLink(assetId: string, link: AssetLink): void {
  Asset.update(assetId, (asset) => {
    const exists = asset.links.some(
      (held) =>
        sameLink(held, link.applicationId ?? link.app, link.entityType, link.entityId) ||
        sameLink(held, link.app, link.entityType, link.entityId),
    );
    if (exists) return undefined;
    return {
      ...asset,
      links: [...asset.links, link],
      usageCount: asset.links.length + 1,
      inUse: true,
    };
  });
}

/**
 * Drops a link the server did not echo back. The last link going never trashes
 * the file (ADR 0043 D5): it stays where it is and is only no longer in use.
 */
export function removeAssetLink(
  assetId: string,
  app: string,
  entityType: string,
  entityId: string,
): void {
  Asset.update(assetId, (asset) => {
    const links = asset.links.filter((link) => !sameLink(link, app, entityType, entityId));
    return { ...asset, links, usageCount: links.length, inUse: links.length > 0 };
  });
}

export function setUploadProgress(fileId: string, progress: AssetUploadProgress): void {
  changeActivity((activity) => ({
    ...activity,
    uploadProgress: { ...activity.uploadProgress, [fileId]: progress },
  }));
}

export function removeUploadProgress(fileId: string): void {
  changeActivity((activity) => {
    const { [fileId]: _removed, ...uploadProgress } = activity.uploadProgress;
    return { ...activity, uploadProgress };
  });
}

export function setAssetLoading(
  write: keyof AssetActivityState['loading'],
  running: boolean,
): void {
  changeActivity((activity) => ({
    ...activity,
    loading: { ...activity.loading, [write]: running },
  }));
}

export function setAssetError(write: keyof AssetActivityState['errors'], error?: string): void {
  changeActivity((activity) => ({ ...activity, errors: { ...activity.errors, [write]: error } }));
}

export function clearAssetErrors(): void {
  changeActivity((activity) => ({ ...activity, errors: {} }));
}

/** Forgets every held asset and all activity. */
export function resetAssets(): void {
  for (const assetId of HeldAssets.get(HELD_ASSETS_KEY)?.ids ?? []) Asset.remove(assetId);
  HeldAssets.set(HELD_ASSETS_KEY, () => undefined);
  AssetActivity.clear();
}

/** The held assets some application uses. */
export function assetsByApp(assets: readonly AssetRecord[], app: string): AssetRecord[] {
  return assets.filter((asset) => asset.links.some((link) => linkIsApp(link, app)));
}

/** The held assets one entity of one application uses. */
export function assetsByEntity(
  assets: readonly AssetRecord[],
  app: string,
  entityType: string,
  entityId: string,
): AssetRecord[] {
  return assets.filter((asset) =>
    asset.links.some((link) => sameLink(link, app, entityType, entityId)),
  );
}

export function isAssetLinkedTo(
  asset: AssetRecord | undefined,
  app: string,
  entityType: string,
  entityId: string,
): boolean {
  return asset?.links.some((link) => sameLink(link, app, entityType, entityId)) ?? false;
}
