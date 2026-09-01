import { useCallback } from 'react';
import { useAssetStore } from '../stores/assetStore';
import type { OxyServices } from '@oxyhq/core';
import {
  type Asset,
  AssetLinkRequest,
  AssetUnlinkRequest,
  AssetUploadProgress
} from '@oxyhq/core';

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
    setAsset,
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
    metadata?: Record<string, unknown>
  ): Promise<Asset | null> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }

    try {
      clearErrors();
      setUploading(true);
      
      const result = await oxyInstance.assetUpload(file, undefined, metadata);

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
        setAsset(result.file);
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
    setAsset, 
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
      
      const result = await oxyInstance.assetLink(assetId, app, entityType, entityId, visibility);
      
      if (result.file) {
        setAsset(result.file);
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
  }, [clearErrors, setLinking, setAsset, addLink, setLinkError]);

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
      
      const result = await oxyInstance.assetUnlink(assetId, app, entityType, entityId);
      
      if (result.file) {
        setAsset(result.file);
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
  }, [clearErrors, setLinking, setAsset, removeLink, setLinkError]);

  // Get asset URL
  const getUrl = useCallback(async (
    assetId: string, 
    variant?: string, 
    expiresIn?: number
  ): Promise<string> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }
      const result = await oxyInstance.assetGetUrl(assetId, variant, expiresIn);
      return result.url;
  }, []);

  // Get asset metadata
  const getAsset = useCallback(async (assetId: string): Promise<Asset> => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }
      const result = await oxyInstance.assetGet(assetId);
      if (result.file) {
        setAsset(result.file);
        return result.file;
      }
      throw new Error('Asset not found');
  }, [setAsset]);

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
      
      await oxyInstance.assetDelete(assetId, force);
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
      const result = await oxyInstance.assetRestore(assetId);
      if (result.file) {
        setAsset(result.file);
      }
  }, [setAsset]);

  // Get variants
  const getVariants = useCallback(async (assetId: string) => {
    if (!oxyInstance) {
      throw new Error('OxyServices instance not configured. Call setOxyAssetInstance first.');
    }
      return await oxyInstance.assetGetVariants(assetId);
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