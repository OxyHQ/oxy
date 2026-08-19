/**
 * S3 Service Types
 * 
 * Centralized type definitions for S3 storage operations.
 */

export interface S3Config {
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  region: string;
  endpointUrl?: string;
}

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  acl?: 'private' | 'public-read';
}

export interface FileInfo {
  key: string;
  size: number;
  lastModified?: Date;
  contentType?: string;
  metadata?: Record<string, string>;
  url?: string;
  bucket?: string; // Optional - service knows bucket from config
  etag?: string;
  location?: string;
}

export interface PresignedUrlOptions {
  expiresIn?: number;
  contentType?: string;
  metadata?: Record<string, string>;
  /**
   * Cache-Control to bake into the presigned PUT. When set it is a SIGNED header,
   * so the client MUST replay it verbatim on the PUT or S3 rejects with
   * SignatureDoesNotMatch. Used for immutable content-addressed assets.
   */
  cacheControl?: string;
  /** Base64 SHA-256 checksum that S3 must validate before accepting the PUT. */
  checksumSHA256?: string;
}
