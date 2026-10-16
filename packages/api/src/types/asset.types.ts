/**
 * Asset Types
 *
 * Centralized type definitions for asset-related operations.
 */

import type { FileVisibility } from './file.types';

export interface AssetInitResponse {
  /** Replay these headers on PUT; Content-Length is supplied by the transport. */
  requiredHeaders?: Record<string, string>;
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

/**
 * One application's use of a file (`file_references`, ADR 0041 D4). It says
 * nothing about visibility: only the file's owner changes that.
 */
export interface AssetLinkRequest {
  /** The using application's id — never free text. */
  applicationId: string;
  entityType: string;
  entityId: string;
  /** The person who made the reference, or `null` for an application's service token. */
  createdByUserId: string | null;
}

export interface AssetDeleteSummary {
  fileId: string;
  wouldDelete: boolean;
  /** The ids of the applications that reference the file. */
  affectedApps: string[];
  remainingLinks: number;
  variants: string[];
}
