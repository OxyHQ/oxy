import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { randomUUID } from 'node:crypto';
import path from 'path';
import type {
  S3Config,
  UploadOptions as S3UploadOptions,
  FileInfo,
  PresignedUrlOptions,
} from '../types/s3.types';
import { logger } from '../utils/logger';

// Extend UploadOptions with service-specific fields
export interface UploadOptions extends S3UploadOptions {
  publicRead?: boolean;
  folder?: string;
  /**
   * Optional abort signal. When it fires, the in-flight multipart `Upload` is
   * aborted (any uploaded parts are discarded by S3) and `uploadStream`
   * rejects. Used by the cache stream-upload to cancel cleanly when the client
   * disconnects or the request times out.
   */
  abortSignal?: AbortSignal;
}

/** Told about every successful object delete, so the CDN can forget the object too. */
export interface DeletedObjectListener {
  enqueueDeletedKey(key: string): void;
}

/** The most one `CopyObject` copies; larger objects are copied by parts. */
export const SINGLE_COPY_MAX_BYTES = 5 * 1024 ** 3;
/** Part size of a multipart copy (S3 allows 5 MiB – 5 GiB per part). */
const COPY_PART_BYTES = 512 * 1024 ** 2;
const COPY_CONCURRENCY = 4;

function s3ErrorName(error: unknown): string {
  const record = error as { name?: string; Code?: string; code?: string } | null;
  return record?.name || record?.Code || record?.code || '';
}

function isCopySourceTooLarge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    s3ErrorName(error) === 'InvalidRequest' &&
    /larger than the maximum allowable size|maximum allowable size for a copy/i.test(message)
  );
}

function isNoSuchUpload(error: unknown): boolean {
  return s3ErrorName(error) === 'NoSuchUpload';
}

function isMissingObject(error: unknown): boolean {
  const name = s3ErrorName(error);
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

export class S3Service {
  private s3Client: S3Client;
  private bucketName: string;
  private endpointUrl?: string;
  private region: string;
  private readonly deletedObjectListener?: DeletedObjectListener;
  /**
   * The store being migrated FROM, while a migration is in progress (ADR 0047).
   * Nothing is written to it. A delete is repeated there — a copy left behind
   * would be copied back by R2's on-read migration (Sippy) or served by the
   * old CDN — listings include it, and a copy whose source has not been
   * migrated yet takes the source from it first.
   */
  private readonly legacy?: S3Service;

  constructor(config: S3Config, deletedObjectListener?: DeletedObjectListener, legacy?: S3Service) {
    this.deletedObjectListener = deletedObjectListener;
    this.legacy = legacy;
    // Explicit keys only when both are configured (R2, local dev); otherwise
    // the default provider chain resolves the ECS task role.
    const { accessKeyId, secretAccessKey } = config;
    const clientConfig: any = {
      region: config.region,
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      // Checksums only where an operation requires one, or where WE ask for one
      // (the declared SHA-256 of a presigned PUT). The SDK's default since
      // 3.729 adds a CRC32 to every request — to a presigned URL, the CRC32 of
      // the EMPTY body it was signed with, which a store that checks it must
      // refuse, and R2 is free to start checking.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };

    // Add a custom endpoint for non-AWS S3-compatible services.
    if (config.endpointUrl) {
      clientConfig.endpoint = config.endpointUrl;
      clientConfig.forcePathStyle =
        config.endpointUrl.includes('localhost') || config.endpointUrl.includes('127.0.0.1');
      clientConfig.useAccelerateEndpoint = false;
      clientConfig.useArnRegion = false;
    }

    logger.debug('S3Client Configuration', {
      region: clientConfig.region,
      endpoint: clientConfig.endpoint,
      forcePathStyle: clientConfig.forcePathStyle,
    });

    this.s3Client = new S3Client(clientConfig);
    this.bucketName = config.bucketName;
    this.endpointUrl = config.endpointUrl;
    this.region = config.region;
  }

  /**
   * Upload a file to S3
   */
  async uploadFile(
    key: string,
    filePath: string | Buffer,
    options: UploadOptions = {},
  ): Promise<FileInfo> {
    try {
      let body: Buffer | Readable;
      let contentType = options.contentType;

      if (typeof filePath === 'string') {
        body = createReadStream(filePath);
        contentType = contentType || this.getContentTypeFromPath(filePath);
      } else {
        body = filePath;
        contentType = contentType || 'application/octet-stream';
      }

      const { finalKey, metadata, acl, cacheControl } = this.prepareObjectOptions(key, options);

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: finalKey,
        // `Buffer | Readable` are both members of the AWS SDK's node-runtime
        // `StreamingBlobPayloadInputTypes`, so no cast is needed.
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
        Metadata: metadata,
        ACL: acl,
      });

      const response = await this.s3Client.send(command);

      return {
        key: finalKey,
        size: 0, // Will be updated below
        lastModified: new Date(),
        contentType,
        metadata: metadata || {},
        url: options.publicRead ? this.generatePublicUrl(finalKey) : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to upload file to S3: ${error}`);
    }
  }

  /**
   * Upload file from buffer
   */
  async uploadBuffer(key: string, buffer: Buffer, options: UploadOptions = {}): Promise<FileInfo> {
    try {
      const contentType = options.contentType || 'application/octet-stream';
      const { finalKey, metadata, acl, cacheControl } = this.prepareObjectOptions(key, options);

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: finalKey,
        Body: buffer,
        ContentType: contentType,
        CacheControl: cacheControl,
        Metadata: metadata,
        ACL: acl,
      });

      await this.s3Client.send(command);

      return {
        key: finalKey,
        size: buffer.length,
        lastModified: new Date(),
        contentType,
        metadata: metadata || {},
        url: options.publicRead ? this.generatePublicUrl(finalKey) : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to upload buffer to S3: ${error}`);
    }
  }

  /**
   * Upload a file to S3 from a readable stream using the AWS SDK multipart
   * `Upload` manager. Unlike `uploadBuffer`, this never materialises the whole
   * object in memory — the stream is chunked and uploaded as it arrives, so a
   * multi-hundred-megabyte video stays bounded by the configured part size.
   *
   * Used by the federation media-cache path where backend services stream
   * remote media straight through to S3.
   */
  async uploadStream(key: string, body: Readable, options: UploadOptions = {}): Promise<FileInfo> {
    const contentType = options.contentType || 'application/octet-stream';
    const { finalKey, metadata, acl, cacheControl } = this.prepareObjectOptions(key, options);

    try {
      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.bucketName,
          Key: finalKey,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
          Metadata: metadata,
          ACL: acl,
        },
      });

      // Cancel the in-flight multipart upload if the caller aborts (client
      // disconnect / request timeout). `upload.abort()` rejects `done()`.
      const { abortSignal } = options;
      if (abortSignal) {
        if (abortSignal.aborted) {
          await upload.abort();
        } else {
          abortSignal.addEventListener(
            'abort',
            () => {
              upload.abort().catch((abortError) => {
                logger.warn('Failed to abort in-flight S3 upload', {
                  key: finalKey,
                  error: abortError instanceof Error ? abortError.message : String(abortError),
                });
              });
            },
            { once: true },
          );
        }
      }

      await upload.done();

      return {
        key: finalKey,
        size: 0,
        lastModified: new Date(),
        contentType,
        metadata: metadata || {},
        url: options.publicRead ? this.generatePublicUrl(finalKey) : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to upload stream to S3: ${error}`);
    }
  }

  /**
   * Download a file from S3 to local path
   */
  async downloadFile(key: string, localPath: string): Promise<void> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error('File not found or empty');
      }

      const writeStream = createWriteStream(localPath);
      // In the Node runtime the S3 GetObject `Body` is a `Readable`; pipe it
      // straight to disk (narrowing the streaming-output union to `Readable`).
      await pipeline(response.Body as Readable, writeStream);
    } catch (error) {
      throw new Error(`Failed to download file from S3: ${error}`);
    }
  }

  /**
   * Download a file from S3 as buffer
   */
  async downloadBuffer(key: string): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error('File not found or empty');
      }

      const chunks: Uint8Array[] = [];
      const reader = response.Body.transformToWebStream().getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      throw new Error(`Failed to download buffer from S3: ${error}`);
    }
  }

  /**
   * Get an object (or a byte range of it) as a stream, for proxying bytes
   * through our own origin. When `range` is provided it is passed through as the
   * S3 `Range` header and the response reports `ContentRange`/`AcceptRanges` so
   * the route can answer HTTP 206 Partial Content (required for video seeking).
   */
  async getObjectStreamRange(
    key: string,
    range?: string,
  ): Promise<{
    body: NodeJS.ReadableStream;
    contentType?: string;
    contentLength?: number;
    contentRange?: string;
    acceptRanges?: string;
    lastModified?: Date;
    etag?: string;
    statusCode: number;
  }> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Range: range,
    });
    const response = await this.s3Client.send(command);
    if (!response.Body) {
      throw new Error('File not found or empty');
    }

    const responseBody = response.Body as unknown as {
      pipe?: unknown;
      transformToWebStream?: () => NodeJS.ReadableStream;
    };
    const body: NodeJS.ReadableStream =
      typeof responseBody.pipe === 'function'
        ? (response.Body as unknown as NodeJS.ReadableStream)
        : (responseBody.transformToWebStream as () => NodeJS.ReadableStream)();

    return {
      body,
      contentType: response.ContentType,
      contentLength: response.ContentLength != null ? Number(response.ContentLength) : undefined,
      contentRange: response.ContentRange,
      acceptRanges: response.AcceptRanges,
      lastModified: response.LastModified,
      etag: response.ETag,
      statusCode: response.ContentRange ? 206 : 200,
    };
  }

  /**
   * Delete a file from S3
   */
  async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.s3Client.send(command);
      // Both stores, or the delete is not done: an object left in the store
      // being migrated from is copied back on the next read (ADR 0047).
      await this.legacy?.deleteFile(key);
    } catch (error) {
      throw new Error(`Failed to delete file from S3: ${error}`);
    }
    // After the delete succeeded, and outside its try: a public object is still
    // cached at the CDN edge for up to a year, and every delete path in the API
    // ends here. The listener is synchronous and never throws.
    this.deletedObjectListener?.enqueueDeletedKey(key);
  }

  /**
   * Generate a presigned URL for file upload
   */
  async getPresignedUploadUrl(key: string, options: PresignedUrlOptions = {}): Promise<string> {
    try {
      const {
        expiresIn = 3600,
        contentType = 'application/octet-stream',
        metadata,
        cacheControl,
        checksumSHA256,
        contentLength,
        ifNoneMatch,
      } = options;

      // Sanitize metadata to ensure all values are strings
      const sanitizedMetadata: Record<string, string> = {};
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          if (value !== null && value !== undefined) {
            sanitizedMetadata[key] = String(value);
          }
        }
      }

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
        IfNoneMatch: ifNoneMatch,
        CacheControl: cacheControl,
        ChecksumSHA256: checksumSHA256,
        Metadata: Object.keys(sanitizedMetadata).length > 0 ? sanitizedMetadata : undefined,
      });

      return getSignedUrl(this.s3Client, command, {
        expiresIn,
        signableHeaders: new Set(['content-length', 'if-none-match']),
        // The declared SHA-256 travels as a SIGNED HEADER, never in the query
        // string. Measured on R2 (ADR 0047): a query-string
        // `x-amz-checksum-sha256` is ignored and bytes that do not hash to it
        // are stored, while the signed header is enforced (400 BadDigest). The
        // uploader must send it — `PRESIGNED_UPLOAD_HEADERS` in the SDK and the
        // `ship` CLI both do, from `requiredHeaders` / `checksumSHA256`.
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      });
    } catch (error) {
      throw new Error(`Failed to generate presigned upload URL: ${error}`);
    }
  }

  /**
   * Generate a presigned URL for file download
   */
  async getPresignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      return getSignedUrl(this.s3Client, command, { expiresIn });
    } catch (error) {
      throw new Error(`Failed to generate presigned download URL: ${error}`);
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(prefix = '', maxKeys = 1000): Promise<FileInfo[]> {
    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        MaxKeys: maxKeys,
      });

      const response = await this.s3Client.send(command);

      const listed: FileInfo[] = (response.Contents ?? []).map((item) => ({
        key: item.Key!,
        size: item.Size || 0,
        lastModified: item.LastModified!,
        bucket: this.bucketName,
      }));
      if (!this.legacy) return listed;
      // A key only the store being migrated from holds still has to be found:
      // the deletion worker lists a prefix to delete everything under it.
      const seen = new Set(listed.map((item) => item.key));
      for (const item of await this.legacy.listFiles(prefix, maxKeys)) {
        if (!seen.has(item.key)) listed.push(item);
      }
      return listed;
    } catch (error) {
      throw new Error(`Failed to list files from S3: ${error}`);
    }
  }

  /**
   * Bring `key` over from the store being migrated from, keeping its
   * Content-Type, Content-Disposition, Cache-Control and metadata. For a
   * server-side copy whose source has not been migrated yet: R2 serves a GET
   * of such an object from S3 (Sippy) but a CopyObject from it is NoSuchKey.
   * Returns false when there is no store to migrate from or it lacks the key.
   */
  private async adoptFromLegacy(key: string): Promise<boolean> {
    if (!this.legacy) return false;
    const source = await this.legacy.getObjectWithMetadata(key);
    if (!source) return false;
    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: this.bucketName,
        Key: key,
        Body: source.body,
        ContentType: source.contentType,
        ContentDisposition: source.contentDisposition,
        CacheControl: source.cacheControl,
        Metadata: source.metadata,
      },
    });
    await upload.done();
    logger.info('Object adopted from the legacy store before a copy', { key });
    return true;
  }

  /** GET with the HTTP metadata a copy must keep; null when the key does not exist. */
  async getObjectWithMetadata(key: string): Promise<{
    body: Readable;
    contentType?: string;
    contentDisposition?: string;
    cacheControl?: string;
    metadata?: Record<string, string>;
  } | null> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      if (!response.Body) return null;
      return {
        body: response.Body as Readable,
        contentType: response.ContentType,
        contentDisposition: response.ContentDisposition,
        cacheControl: response.CacheControl,
        metadata: response.Metadata,
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  /**
   * Check if a file exists
   */
  async fileExists(key: string): Promise<boolean> {
    try {
      // Prefer HEAD to check existence without downloading
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      await this.s3Client.send(command);
      return true;
    } catch (error: any) {
      const name = error?.name || error?.Code || error?.code;
      const status = error?.$metadata?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) {
        return false;
      }
      // Some S3-compatible services return 404 via code property
      if (String(status).startsWith('4')) {
        return false;
      }
      return false;
    }
  }

  /**
   * HEAD an object to read its size + content type without downloading it.
   * Returns null when the object does not exist. Unlike `getFileMetadata` (which
   * issues a GET and streams the whole body), this is a cheap metadata-only probe
   * suitable for verifying a large just-uploaded asset.
   */
  async headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      const response = await this.s3Client.send(command);
      return {
        size: Number.parseInt(response.ContentLength?.toString() || '0', 10),
        contentType: response.ContentType,
      };
    } catch (error: any) {
      const name = error?.name || error?.Code || error?.code;
      const status = error?.$metadata?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get file metadata
   */
  async getFileMetadata(key: string): Promise<FileInfo | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      return {
        key,
        size: Number.parseInt(response.ContentLength?.toString() || '0'),
        lastModified: response.LastModified!,
        contentType: response.ContentType,
        metadata: response.Metadata,
        bucket: this.bucketName,
      };
    } catch (error: any) {
      if (error.name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Copy file from one key to another
   */
  async copyFile(
    sourceKey: string,
    destinationKey: string,
    options: { sizeHint?: number } = {},
  ): Promise<void> {
    // `CopyObject` copies at most 5 GiB in one request; a larger object (a large
    // upload, ADR 0043 stage 4b) is copied part by part. The size is known to
    // most callers (the file row); one that does not know it learns it from
    // S3's refusal and retries the multipart way.
    if (options.sizeHint !== undefined && options.sizeHint > SINGLE_COPY_MAX_BYTES) {
      await this.copyLargeObject(sourceKey, destinationKey, options.sizeHint);
      return;
    }
    try {
      try {
        await this.copyObject(sourceKey, destinationKey);
      } catch (error) {
        // A source still only in the store being migrated from (ADR 0047).
        if (!isMissingObject(error) || !(await this.adoptFromLegacy(sourceKey))) throw error;
        await this.copyObject(sourceKey, destinationKey);
      }
    } catch (error) {
      if (isCopySourceTooLarge(error)) {
        const head = await this.headObject(sourceKey);
        if (head && head.size > SINGLE_COPY_MAX_BYTES) {
          await this.copyLargeObject(sourceKey, destinationKey, head.size);
          return;
        }
      }
      throw new Error(`Failed to copy file in S3: ${error}`);
    }
  }

  /**
   * Server-side copy of an object larger than one `CopyObject` allows, by
   * `UploadPartCopy` ranges. The destination keeps the source's Content-Type,
   * Content-Disposition and Cache-Control (what `MetadataDirective: COPY`
   * gives a single copy). An interrupted copy is aborted, leaving nothing.
   */
  /** Whether THIS store holds `key` itself (a listing never falls through to a migration source). */
  private async isStoredHere(key: string): Promise<boolean> {
    const listed = await this.s3Client.send(
      new ListObjectsV2Command({ Bucket: this.bucketName, Prefix: key, MaxKeys: 1 }),
    );
    return listed.Contents?.[0]?.Key === key;
  }

  private async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        Key: destinationKey,
        CopySource: `${this.bucketName}/${sourceKey}`,
      }),
    );
  }

  private async copyLargeObject(
    sourceKey: string,
    destinationKey: string,
    size: number,
  ): Promise<void> {
    // `UploadPartCopy` reads the source from THIS store; one still only in the
    // store being migrated from is brought over first (ADR 0047). Asked by a
    // LISTING, not a HEAD: R2 answers a HEAD of a not-yet-migrated object from
    // the old store (Sippy), and a part copy of it would still be NoSuchKey.
    if (this.legacy && !(await this.isStoredHere(sourceKey))) {
      if (!(await this.adoptFromLegacy(sourceKey))) {
        throw new Error(`Failed to copy a large file in S3: ${sourceKey} does not exist`);
      }
    }
    const head = await this.s3Client.send(
      new HeadObjectCommand({ Bucket: this.bucketName, Key: sourceKey }),
    );
    const created = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: destinationKey,
        ContentType: head.ContentType,
        ContentDisposition: head.ContentDisposition,
        CacheControl: head.CacheControl,
        Metadata: head.Metadata,
      }),
    );
    const uploadId = created.UploadId;
    if (!uploadId) throw new Error('S3 returned no UploadId for a multipart copy');
    const partSize = Math.max(COPY_PART_BYTES, Math.ceil(size / 10_000));
    const partCount = Math.ceil(size / partSize);
    try {
      const parts: { PartNumber: number; ETag: string }[] = new Array(partCount);
      let next = 0;
      const work = async () => {
        while (next < partCount) {
          const index = next++;
          const start = index * partSize;
          const end = Math.min(size, start + partSize) - 1;
          const copied = await this.s3Client.send(
            new UploadPartCopyCommand({
              Bucket: this.bucketName,
              Key: destinationKey,
              UploadId: uploadId,
              PartNumber: index + 1,
              CopySource: `${this.bucketName}/${sourceKey}`,
              CopySourceRange: `bytes=${start}-${end}`,
            }),
          );
          const etag = copied.CopyPartResult?.ETag;
          if (!etag) throw new Error(`S3 returned no ETag for copied part ${index + 1}`);
          parts[index] = { PartNumber: index + 1, ETag: etag };
        }
      };
      await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, partCount) }, work));
      await this.s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucketName,
          Key: destinationKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (error) {
      await this.abortMultipartUpload(destinationKey, uploadId).catch(() => undefined);
      throw new Error(`Failed to copy a large file in S3: ${error}`);
    }
  }

  /**
   * Open a multipart upload the client fills through presigned part URLs
   * (ADR 0043 stage 4b). Content-Type, Content-Disposition and Cache-Control
   * are set HERE, by the server, so they are not the client's to choose.
   */
  async createMultipartUpload(
    key: string,
    options: { contentType: string; contentDisposition?: string; cacheControl?: string },
  ): Promise<string> {
    const created = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: options.contentType,
        ContentDisposition: options.contentDisposition,
        CacheControl: options.cacheControl,
      }),
    );
    if (!created.UploadId) throw new Error('S3 returned no UploadId');
    return created.UploadId;
  }

  /**
   * A presigned `UploadPart` URL. `contentLength` is signed, so a part of any
   * other size is refused by S3 itself.
   */
  async getPresignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    options: { expiresIn: number; contentLength: number },
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucketName,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: options.contentLength,
    });
    return getSignedUrl(this.s3Client, command, {
      expiresIn: options.expiresIn,
      signableHeaders: new Set(['content-length']),
    });
  }

  /**
   * Upload one part of a multipart upload FROM the API (a recording target's
   * S3-compatible ingest, ADR 0043 stage 4c): `body` is streamed, never
   * buffered, and must be exactly `contentLength` bytes. Returns S3's ETag.
   */
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
    contentLength: number,
  ): Promise<{ etag: string }> {
    const result = await this.s3Client.send(
      new UploadPartCommand({
        Bucket: this.bucketName,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
        Body: body,
      }),
    );
    if (!result.ETag) throw new Error('S3 returned no ETag for the part');
    return { etag: result.ETag };
  }

  /** Every part S3 holds for an open multipart upload, in part order; `null` if the upload is gone. */
  async listParts(
    key: string,
    uploadId: string,
  ): Promise<{ partNumber: number; size: number; etag: string }[] | null> {
    const parts: { partNumber: number; size: number; etag: string }[] = [];
    let marker: string | undefined;
    try {
      for (;;) {
        const page = await this.s3Client.send(
          new ListPartsCommand({
            Bucket: this.bucketName,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          if (part.PartNumber === undefined || !part.ETag) continue;
          parts.push({
            partNumber: part.PartNumber,
            size: Number(part.Size ?? 0),
            etag: part.ETag,
          });
        }
        if (!page.IsTruncated) break;
        marker = page.NextPartNumberMarker;
        if (!marker) break;
      }
    } catch (error) {
      if (isNoSuchUpload(error)) return null;
      throw error;
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    await this.s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  /** Discard an open multipart upload and every part it holds. An upload already gone is not an error. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3Client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucketName, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      if (isNoSuchUpload(error)) return;
      throw error;
    }
  }

  /**
   * Move file (copy + delete)
   */
  async moveFile(sourceKey: string, destinationKey: string): Promise<void> {
    try {
      await this.copyFile(sourceKey, destinationKey);
      await this.deleteFile(sourceKey);
    } catch (error) {
      throw new Error(`Failed to move file in S3: ${error}`);
    }
  }

  /**
   * Upload multiple files
   */
  async uploadMultipleFiles(
    files: Array<{ key: string; filePath: string | Buffer; options?: UploadOptions }>,
  ): Promise<FileInfo[]> {
    const uploadPromises = files.map(({ key, filePath, options }) =>
      typeof filePath === 'string'
        ? this.uploadFile(key, filePath, options)
        : this.uploadBuffer(key, filePath, options),
    );

    return Promise.all(uploadPromises);
  }

  /**
   * Delete multiple files
   */
  async deleteMultipleFiles(keys: string[]): Promise<void> {
    const deletePromises = keys.map((key) => this.deleteFile(key));
    await Promise.all(deletePromises);
  }

  /**
   * Generate a unique file key
   */
  generateUniqueKey(originalName: string, folder?: string): string {
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    const uniqueId = randomUUID();
    const key = `${baseName}-${uniqueId}${extension}`;

    return folder ? `${folder}/${key}` : key;
  }

  /**
   * Get content type from file path
   */
  private getContentTypeFromPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.csv': 'text/csv',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.zip': 'application/zip',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Get public URL for a file (if bucket is public)
   */
  getPublicUrl(key: string): string {
    if (this.endpointUrl) {
      // For non-AWS S3-compatible services.
      const baseUrl = this.endpointUrl.replace('https://', '');
      return `https://${this.bucketName}.${baseUrl}/${key}`;
    } else {
      // For AWS S3
      return `https://${this.bucketName}.s3.amazonaws.com/${key}`;
    }
  }

  /**
   * Generate URL for public read files
   */
  private generatePublicUrl(key: string): string {
    if (this.endpointUrl) {
      // For non-AWS S3-compatible services.
      const baseUrl = this.endpointUrl.replace('https://', '');
      return `https://${this.bucketName}.${baseUrl}/${key}`;
    } else {
      // For AWS S3
      return `https://${this.bucketName}.s3.amazonaws.com/${key}`;
    }
  }

  /**
   * Validate file size
   */
  validateFileSize(size: number, maxSize: number): boolean {
    return size <= maxSize;
  }

  /**
   * Validate file type
   */
  validateFileType(filename: string, allowedTypes: string[]): boolean {
    const ext = path.extname(filename).toLowerCase();
    return allowedTypes.includes(ext);
  }

  private prepareObjectOptions(key: string, options: UploadOptions) {
    return {
      finalKey: this.buildFinalKey(key, options.folder),
      metadata: this.sanitizeMetadata(options.metadata),
      acl: options.publicRead ? ('public-read' as const) : ('private' as const),
      cacheControl: options.cacheControl,
    };
  }

  private buildFinalKey(key: string, folder?: string) {
    return folder ? `${folder}/${key}` : key;
  }

  private sanitizeMetadata(metadata?: Record<string, unknown>) {
    if (!metadata) return undefined;

    const sanitized: Record<string, string> = {};
    for (const [metaKey, value] of Object.entries(metadata)) {
      if (value === null || value === undefined) continue;
      sanitized[metaKey] = String(value);
    }

    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }
}

// Export a factory function for easier configuration
export function createS3Service(
  config: S3Config,
  deletedObjectListener?: DeletedObjectListener,
  legacy?: S3Service,
): S3Service {
  return new S3Service(config, deletedObjectListener, legacy);
}

// No additional type exports needed - interfaces are already exported
