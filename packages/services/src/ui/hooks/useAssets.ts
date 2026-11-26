import { useCallback, useMemo } from 'react';
import { useEntities, useListState, useModel, useStore, withStore } from '@oxy.so/bloom-data';
import type { OxyServices } from '@oxy.so/core';
import type { Asset, AssetMetadata, AssetRecord, AssetVariant, UploadedAsset } from '@oxy.so/core';
import {
  Asset as HeldAsset,
  AssetActivity,
  addAssetLink,
  assetsByApp,
  assetsByEntity,
  clearAssetErrors,
  HELD_ASSETS_KEY,
  HeldAssets,
  IDLE_ASSET_ACTIVITY,
  isAssetLinkedTo,
  mergeAsset,
  removeAsset,
  removeAssetLink,
  removeUploadProgress,
  resetAssets,
  setAssetError,
  setAssetLoading,
  setUploadProgress,
} from '../data/assets';

const NO_IDS: readonly string[] = [];

// Create a singleton instance for the hook
let oxyInstance: OxyServices | null = null;

export const setOxyAssetInstance = (instance: OxyServices) => {
  oxyInstance = instance;
};

/**
 * Hook for managing assets, held in the signed-in account's store
 * (`data/assets.ts`).
 */
export const useAssets = () => {
  const store = useStore();
  const held = useListState(HeldAssets, HELD_ASSETS_KEY);
  const records = useEntities(HeldAsset, held?.ids ?? NO_IDS);
  const assets = useMemo(
    () => records.filter((asset): asset is Asset => asset !== undefined),
    [records],
  );
  const activity = useModel(AssetActivity) ?? IDLE_ASSET_ACTIVITY;
  const { uploadProgress, loading, errors } = activity;

  const clearErrors = useCallback(() => withStore(store, clearAssetErrors), [store]);
  const reset = useCallback(() => withStore(store, resetAssets), [store]);
  const getAssetsByApp = useCallback((app: string) => assetsByApp(assets, app), [assets]);
  const getAssetsByEntity = useCallback(
    (app: string, entityType: string, entityId: string) =>
      assetsByEntity(assets, app, entityType, entityId),
    [assets],
  );
  const getAssetUsageCount = useCallback(
    (assetId: string) => assets.find((asset) => asset.id === assetId)?.usageCount ?? 0,
    [assets],
  );
  const isAssetLinked = useCallback(
    (assetId: string, app: string, entityType: string, entityId: string) =>
      isAssetLinkedTo(
        assets.find((asset) => asset.id === assetId),
        app,
        entityType,
        entityId,
      ),
    [assets],
  );

  // Upload asset with progress tracking
  const upload = useCallback(
    async (file: File, metadata?: AssetMetadata): Promise<UploadedAsset | null> => {
      if (!oxyInstance) {
        throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
      }

      try {
        withStore(store, () => {
          clearAssetErrors();
          setAssetLoading('uploading', true);
        });

        const result = await oxyInstance.assets.upload(file, { metadata });

        // Update progress with final status
        if (result?.file) {
          const fileId = result.file.id;
          withStore(store, () =>
            setUploadProgress(fileId, {
              fileId,
              uploaded: file.size,
              total: file.size,
              percentage: 100,
              status: 'complete',
            }),
          );

          // Remove progress after a short delay
          setTimeout(() => {
            withStore(store, () => removeUploadProgress(fileId));
          }, 2000);
        }

        // Hold the asset
        if (result.file) {
          const uploaded = result.file;
          withStore(store, () => mergeAsset(uploaded));
          return uploaded;
        }

        return null;
      } catch (error: unknown) {
        withStore(store, () =>
          setAssetError(
            'upload',
            (error instanceof Error ? error.message : null) || 'Upload failed',
          ),
        );
        throw error;
      } finally {
        withStore(store, () => setAssetLoading('uploading', false));
      }
    },
    [store],
  );

  // Link asset to entity
  const link = useCallback(
    async (assetId: string, app: string, entityType: string, entityId: string): Promise<void> => {
      if (!oxyInstance) {
        throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
      }

      try {
        withStore(store, () => {
          clearAssetErrors();
          setAssetLoading('linking', true);
        });

        // Auto-detect visibility for avatars and profile banners
        const visibility =
          entityType === 'avatar' || entityType === 'profile-banner'
            ? ('public' as const)
            : undefined;

        const result = await oxyInstance.assets.link(
          assetId,
          { app, entityType, entityId },
          { visibility },
        );

        withStore(store, () => {
          if (result.file) {
            mergeAsset(result.file);
          } else {
            // The API did not return the file: record the link it accepted.
            addAssetLink(assetId, {
              app,
              entityType,
              entityId,
              createdBy: '', // Will be filled by server
              createdAt: new Date().toISOString(),
            });
          }
        });
      } catch (error: unknown) {
        withStore(store, () =>
          setAssetError('link', (error instanceof Error ? error.message : null) || 'Link failed'),
        );
        throw error;
      } finally {
        withStore(store, () => setAssetLoading('linking', false));
      }
    },
    [store],
  );

  // Unlink asset from entity
  const unlink = useCallback(
    async (assetId: string, app: string, entityType: string, entityId: string): Promise<void> => {
      if (!oxyInstance) {
        throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
      }

      try {
        withStore(store, () => {
          clearAssetErrors();
          setAssetLoading('linking', true);
        });

        const result = await oxyInstance.assets.unlink(assetId, { app, entityType, entityId });

        withStore(store, () => {
          if (result.file) {
            mergeAsset(result.file);
          } else {
            // The API did not return the file: drop the link it removed.
            removeAssetLink(assetId, app, entityType, entityId);
          }
        });
      } catch (error: unknown) {
        withStore(store, () =>
          setAssetError('link', (error instanceof Error ? error.message : null) || 'Unlink failed'),
        );
        throw error;
      } finally {
        withStore(store, () => setAssetLoading('linking', false));
      }
    },
    [store],
  );

  // Get asset URL
  const getUrl = useCallback(
    async (assetId: string, variant?: string, expiresIn?: number): Promise<string> => {
      if (!oxyInstance) {
        throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
      }
      return oxyInstance.assets.url(assetId, variant, expiresIn);
    },
    [],
  );

  // Get asset metadata
  const getAsset = useCallback(
    async (assetId: string): Promise<AssetRecord> => {
      if (!oxyInstance) {
        throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
      }
      const result = await oxyInstance.assets.get(assetId);
      if (result.file) {
        const file = result.file;
        withStore(store, () => mergeAsset(file));
        return file;
      }
      throw new Error('Asset not found');
    },
    [store],
  );

  // Delete asset
  const deleteAsset = useCallback(
    async (assetId: string, force = false): Promise<void> => {
      if (!oxyInstance) {
        throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
      }

      try {
        withStore(store, () => {
          clearAssetErrors();
          setAssetLoading('deleting', true);
        });

        await oxyInstance.assets.delete(assetId, { force });
        withStore(store, () => removeAsset(assetId));
      } catch (error: unknown) {
        withStore(store, () =>
          setAssetError(
            'delete',
            (error instanceof Error ? error.message : null) || 'Delete failed',
          ),
        );
        throw error;
      } finally {
        withStore(store, () => setAssetLoading('deleting', false));
      }
    },
    [store],
  );

  // Restore asset from trash
  const restore = useCallback(
    async (assetId: string): Promise<void> => {
      if (!oxyInstance) {
        throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
      }
      const result = await oxyInstance.assets.restore(assetId);
      if (result.file) {
        const file = result.file;
        withStore(store, () => mergeAsset(file));
      }
    },
    [store],
  );

  // Get variants
  const getVariants = useCallback(async (assetId: string): Promise<AssetVariant[]> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }
    const { file } = await oxyInstance.assets.get(assetId);
    return file?.variants ?? [];
  }, []);

  return {
    // State
    assets,
    uploadProgress,
    loading,
    errors,

    // Actions
    upload,
    link,
    unlink,
    getUrl,
    getAsset,
    deleteAsset,
    restore,
    getVariants,

    // Utility methods
    getAssetsByApp,
    getAssetsByEntity,
    getAssetUsageCount,
    isAssetLinked,

    // Store management
    clearErrors,
    reset,
  };
};
