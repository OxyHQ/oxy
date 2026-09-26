import { useCallback } from 'react';
import { useAssetStore } from '../stores/assetStore';
import type { OxyServices } from '@oxy.so/core';
import type { Asset, AssetMetadata, AssetRecord, AssetVariant, UploadedAsset } from '@oxy.so/core';

// Create a singleton instance for the hook
let oxyInstance: OxyServices | null = null;

export const setOxyAssetInstance = (instance: OxyServices) => {
  oxyInstance = instance;
};

/**
 * Hook for managing assets with Zustand store integration
 */
export const useAssets = () => {
  const {
    assets,
    uploadProgress,
    loading,
    errors,
    mergeAsset,
    setAssets,
    removeAsset,
    setUploadProgress,
    removeUploadProgress,
    addLink,
    removeLink,
    setUploading,
    setLinking,
    setDeleting,
    setUploadError,
    setLinkError,
    setDeleteError,
    clearErrors,
    getAssetsByApp,
    getAssetsByEntity,
    getAssetUsageCount,
    isAssetLinked,
    reset
  } = useAssetStore();

  // Upload asset with progress tracking
  const upload = useCallback(async (
    file: File,
    metadata?: AssetMetadata
  ): Promise<UploadedAsset | null> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }

    try {
      clearErrors();
      setUploading(true);
      
      const result = await oxyInstance.assets.upload(file, { metadata });

      // Update progress with final status
      if (result?.file) {
        const fileId = result.file.id;
        setUploadProgress(fileId, {
          fileId,
          uploaded: file.size,
          total: file.size,
          percentage: 100,
          status: 'complete'
        });
        
        // Remove progress after a short delay
        setTimeout(() => {
          removeUploadProgress(fileId);
        }, 2000);
      }

      // Add asset to store
      if (result.file) {
        mergeAsset(result.file);
        return result.file;
      }
      
      return null;
    } catch (error: unknown) {
      setUploadError((error instanceof Error ? error.message : null) || 'Upload failed');
      throw error;
    } finally {
      setUploading(false);
    }
  }, [
    clearErrors, 
    setUploading, 
    setUploadProgress, 
    removeUploadProgress, 
    mergeAsset, 
    setUploadError
  ]);

  // Link asset to entity
  const link = useCallback(async (
    assetId: string, 
    app: string, 
    entityType: string, 
    entityId: string
  ): Promise<void> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }

    try {
      clearErrors();
      setLinking(true);
      
      // Auto-detect visibility for avatars and profile banners
      const visibility = (entityType === 'avatar' || entityType === 'profile-banner') 
        ? 'public' as const
        : undefined;
      
      const result = await oxyInstance.assets.link(assetId, { app, entityType, entityId }, { visibility });
      
      if (result.file) {
        mergeAsset(result.file);
      } else {
        // If API doesn't return full file, update store optimistically
        addLink(assetId, {
          app,
          entityType,
          entityId,
          createdBy: '', // Will be filled by server
          createdAt: new Date().toISOString()
        });
      }
    } catch (error: unknown) {
      setLinkError((error instanceof Error ? error.message : null) || 'Link failed');
      throw error;
    } finally {
      setLinking(false);
    }
  }, [clearErrors, setLinking, mergeAsset, addLink, setLinkError]);

  // Unlink asset from entity
  const unlink = useCallback(async (
    assetId: string, 
    app: string, 
    entityType: string, 
    entityId: string
  ): Promise<void> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }

    try {
      clearErrors();
      setLinking(true);
      
      const result = await oxyInstance.assets.unlink(assetId, { app, entityType, entityId });
      
      if (result.file) {
        mergeAsset(result.file);
      } else {
        // Update store optimistically
        removeLink(assetId, app, entityType, entityId);
      }
    } catch (error: unknown) {
      setLinkError((error instanceof Error ? error.message : null) || 'Unlink failed');
      throw error;
    } finally {
      setLinking(false);
    }
  }, [clearErrors, setLinking, mergeAsset, removeLink, setLinkError]);

  // Get asset URL
  const getUrl = useCallback(async (
    assetId: string, 
    variant?: string, 
    expiresIn?: number
  ): Promise<string> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }
      return oxyInstance.assets.url(assetId, variant, expiresIn);
  }, []);

  // Get asset metadata
  const getAsset = useCallback(async (assetId: string): Promise<AssetRecord> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }
      const result = await oxyInstance.assets.get(assetId);
      if (result.file) {
        mergeAsset(result.file);
        return result.file;
      }
      throw new Error('Asset not found');
  }, [mergeAsset]);

  // Delete asset
  const deleteAsset = useCallback(async (
    assetId: string, 
    force = false
  ): Promise<void> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }

    try {
      clearErrors();
      setDeleting(true);
      
      await oxyInstance.assets.delete(assetId, { force });
      removeAsset(assetId);
    } catch (error: unknown) {
      setDeleteError((error instanceof Error ? error.message : null) || 'Delete failed');
      throw error;
    } finally {
      setDeleting(false);
    }
  }, [clearErrors, setDeleting, removeAsset, setDeleteError]);

  // Restore asset from trash
  const restore = useCallback(async (assetId: string): Promise<void> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }
      const result = await oxyInstance.assets.restore(assetId);
      if (result.file) {
        mergeAsset(result.file);
      }
  }, [mergeAsset]);

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
    assets: Object.values(assets),
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
    reset
  };
};