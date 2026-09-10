import { create } from 'zustand';
import type { Asset, AssetUploadProgress, AssetLink } from '@oxy.so/core';

interface AssetState {
  // Asset data
  assets: Record<string, Asset>;
  uploadProgress: Record<string, AssetUploadProgress>;
  
  // Loading states
  loading: {
    uploading: boolean;
    linking: boolean;
    deleting: boolean;
  };
  
  // Error states
  errors: {
    upload?: string;
    link?: string;
    delete?: string;
  };
  
  // Actions
  setAsset: (asset: Asset) => void;
  setAssets: (assets: Asset[]) => void;
  removeAsset: (assetId: string) => void;
  
  // Upload progress actions
  setUploadProgress: (fileId: string, progress: AssetUploadProgress) => void;
  removeUploadProgress: (fileId: string) => void;
  
  // Link management
  addLink: (assetId: string, link: AssetLink) => void;
  removeLink: (assetId: string, app: string, entityType: string, entityId: string) => void;
  
  // Loading states
  setUploading: (uploading: boolean) => void;
  setLinking: (linking: boolean) => void;
  setDeleting: (deleting: boolean) => void;
  
  // Error management
  setUploadError: (error?: string) => void;
  setLinkError: (error?: string) => void;
  setDeleteError: (error?: string) => void;
  clearErrors: () => void;
  
  // Utility methods
  getAssetsByApp: (app: string) => Asset[];
  getAssetsByEntity: (app: string, entityType: string, entityId: string) => Asset[];
  getAssetUsageCount: (assetId: string) => number;
  isAssetLinked: (assetId: string, app: string, entityType: string, entityId: string) => boolean;
  
  // Reset store
  reset: () => void;
}

const initialState = {
  assets: {},
  uploadProgress: {},
  loading: {
    uploading: false,
    linking: false,
    deleting: false,
  },
  errors: {},
};

export const useAssetStore = create<AssetState>((set, get) => ({
    ...initialState,
    
    // Asset management
    setAsset: (asset: Asset) => {
      set((state) => ({
        assets: {
          ...state.assets,
          [asset.id]: asset,
        },
      }));
    },
    
    setAssets: (assets: Asset[]) => {
      set((state) => {
        const assetMap = assets.reduce((acc, asset) => {
          acc[asset.id] = asset;
          return acc;
        }, {} as Record<string, Asset>);
        
        return {
          assets: {
            ...state.assets,
            ...assetMap,
          },
        };
      });
    },
    
    removeAsset: (assetId: string) => {
      set((state) => {
        const { [assetId]: removed, ...rest } = state.assets;
        return { assets: rest };
      });
    },
    
    // Upload progress
    setUploadProgress: (fileId: string, progress: AssetUploadProgress) => {
      set((state) => ({
        uploadProgress: {
          ...state.uploadProgress,
          [fileId]: progress,
        },
      }));
    },
    
    removeUploadProgress: (fileId: string) => {
      set((state) => {
        const { [fileId]: removed, ...rest } = state.uploadProgress;
        return { uploadProgress: rest };
      });
    },
    
    // Link management
    addLink: (assetId: string, link: AssetLink) => {
      set((state) => {
        const asset = state.assets[assetId];
        if (!asset) return state;
        
        // Check if link already exists
        const existingLink = asset.links.find(
          (l: AssetLink) => l.app === link.app && 
                 l.entityType === link.entityType && 
                 l.entityId === link.entityId
        );
        
        if (existingLink) return state;
        
        const updatedAsset = {
          ...asset,
          links: [...asset.links, link],
          usageCount: asset.links.length + 1,
        };
        
        return {
          assets: {
            ...state.assets,
            [assetId]: updatedAsset,
          },
        };
      });
    },
    
    removeLink: (assetId: string, app: string, entityType: string, entityId: string) => {
      set((state) => {
        const asset = state.assets[assetId];
        if (!asset) return state;
        
        const filteredLinks = asset.links.filter(
          (link: AssetLink) => !(link.app === app && 
                     link.entityType === entityType && 
                     link.entityId === entityId)
        );
        
        const updatedAsset = {
          ...asset,
          links: filteredLinks,
          usageCount: filteredLinks.length,
          status: filteredLinks.length === 0 ? 'trash' as const : asset.status,
        };
        
        return {
          assets: {
            ...state.assets,
            [assetId]: updatedAsset,
          },
        };
      });
    },
    
    // Loading states
    setUploading: (uploading: boolean) => {
      set((state) => ({
        loading: { ...state.loading, uploading },
      }));
    },
    
    setLinking: (linking: boolean) => {
      set((state) => ({
        loading: { ...state.loading, linking },
      }));
    },
    
    setDeleting: (deleting: boolean) => {
      set((state) => ({
        loading: { ...state.loading, deleting },
      }));
    },
    
    // Error management
    setUploadError: (error?: string) => {
      set((state) => ({
        errors: { ...state.errors, upload: error },
      }));
    },
    
    setLinkError: (error?: string) => {
      set((state) => ({
        errors: { ...state.errors, link: error },
      }));
    },
    
    setDeleteError: (error?: string) => {
      set((state) => ({
        errors: { ...state.errors, delete: error },
      }));
    },
    
    clearErrors: () => {
      set({ errors: {} });
    },
    
    // Utility methods
    getAssetsByApp: (app: string) => {
      const { assets } = get();
      return Object.values(assets).filter((asset) =>
        asset.links.some((link: AssetLink) => link.app === app)
      );
    },
    
    getAssetsByEntity: (app: string, entityType: string, entityId: string) => {
      const { assets } = get();
      return Object.values(assets).filter((asset) =>
        asset.links.some(
          (link: AssetLink) => link.app === app && 
                   link.entityType === entityType && 
                   link.entityId === entityId
        )
      );
    },
    
    getAssetUsageCount: (assetId: string) => {
      const { assets } = get();
      const asset = assets[assetId];
      return asset ? asset.usageCount : 0;
    },
    
    isAssetLinked: (assetId: string, app: string, entityType: string, entityId: string) => {
      const { assets } = get();
      const asset = assets[assetId];
      if (!asset) return false;
      
      return asset.links.some(
        (link: AssetLink) => link.app === app && 
                 link.entityType === entityType && 
                 link.entityId === entityId
      );
    },
    
    // Reset store
    reset: () => {
      set(initialState);
    },
}));

// Selector hooks for convenience
export const useAssets = () => useAssetStore((state) => Object.values(state.assets));
export const useAsset = (assetId: string) => useAssetStore((state) => state.assets[assetId]);
export const useUploadProgress = () => useAssetStore((state) => state.uploadProgress);
export const useAssetLoading = () => useAssetStore((state) => state.loading);
export const useAssetErrors = () => useAssetStore((state) => state.errors);

// Typed selectors for specific use cases
export const useAssetsByApp = (app: string) => 
  useAssetStore((state) => state.getAssetsByApp(app));

export const useAssetsByEntity = (app: string, entityType: string, entityId: string) =>
  useAssetStore((state) => state.getAssetsByEntity(app, entityType, entityId));

export const useAssetUsageCount = (assetId: string) =>
  useAssetStore((state) => state.getAssetUsageCount(assetId));

export const useIsAssetLinked = (assetId: string, app: string, entityType: string, entityId: string) =>
  useAssetStore((state) => state.isAssetLinked(assetId, app, entityType, entityId));