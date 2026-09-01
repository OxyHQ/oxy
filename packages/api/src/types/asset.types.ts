/**
 * Asset Types
 * 
 * Centralized type definitions for asset-related operations.
 */

import type { FileVisibility } from './file.types';

export interface AssetInitResponse {
  uploadUrl: string;
  fileId: string;
  sha256: string;
}

export interface AssetCompleteRequest {
  fileId: string;
  originalName: string;
  size: number;
  mime: string;
  visibility?: FileVisibility;
  metadata?: Record<string, unknown>;
}

export interface AssetLinkRequest {
  app: string;
  entityType: string;
  entityId: string;
  createdBy: string;
  visibility?: FileVisibility;
  webhookUrl?: string;
}

export interface AssetDeleteSummary {
  fileId: string;
  wouldDelete: boolean;
  affectedApps: string[];
  remainingLinks: number;
  variants: string[];
}

