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
import { Transform, type Readable } from 'stream';
import { rm, statfs } from 'node:fs/promises';
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

export interface DownloadFileOptions {
  /** Free filesystem headroom retained while acquiring a temporary source. */
  minFreeBytes?: number;
  maxBytes?: number;
  timeoutMs?: number;
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

export class S3Service {
  private s3Client: S3Client;
  private bucketName: string;
  private endpointUrl?: string;
  private region: string;
  private readonly deletedObjectListener?: DeletedObjectListener;
  constructor(config: S3Config, deletedObjectListener?: DeletedObjectListener) {
    this.deletedObjectListener = deletedObjectListener;
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
      // Bound stalled connections, including multipart requests that Upload's
      // abort() cannot interrupt until the SDK request settles. This is socket
      // inactivity, not a total deadline for a large, progressing transfer.
      requestHandler: { connectionTimeout: 10_000, socketTimeout: 120_000 },
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
    if (Buffer.isBuffer(filePath)) return this.uploadBuffer(key, filePath, options);
    const body = createReadStream(filePath);
    try {
      // Upload buffers bounded parts, so SDK retries can replay the exact bytes.
      return await this.uploadStream(key, body, {
        ...options,
        contentType: options.contentType || this.getContentTypeFromPath(filePath),
      });
    } finally {
      body.destroy();
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

    const upload = new Upload({
      client: this.s3Client,
      leavePartsOnError: false,
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
    const abort = () => {
      body.destroy(new Error('S3 upload aborted'));
      upload.abort().catch(() => undefined);
    };
    const { abortSignal } = options;
    abortSignal?.addEventListener('abort', abort, { once: true });
    try {
      if (abortSignal?.aborted) throw new Error('S3 upload aborted');
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
      throw new Error(`Failed to upload stream to S3: ${error}`, { cause: error });
    } finally {
      abortSignal?.removeEventListener('abort', abort);
      body.destroy();
    }
  }

  /**
   * Download a file from S3 to local path
   */
  async downloadFile(
    key: string,
    localPath: string,
    options: DownloadFileOptions = {},
  ): Promise<void> {
    const deadline = new AbortController();
    const signal = options.abortSignal
      ? AbortSignal.any([deadline.signal, options.abortSignal])
      : deadline.signal;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => deadline.abort(new Error('S3 download deadline exceeded')),
            options.timeoutMs,
          );
    timer?.unref();
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const diskCheckInterval = 1024 * 1024;
    const checkDisk = async (pendingBytes = 0) => {
      if (options.minFreeBytes === undefined) return;
      const space = await statfs(path.dirname(localPath));
      if (space.bavail * space.bsize < options.minFreeBytes + diskCheckInterval + pendingBytes) {
        throw Object.assign(new Error('Insufficient temporary disk space for video source'), {
          code: 'ENOSPC',
        });
      }
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await checkDisk();
        // Header/status retries belong to the SDK. Only an interrupted body is
        // restarted here, once, under the same byte cap and overall deadline.
        const response = await this.s3Client.send(
          new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
          { abortSignal: signal },
        );
        const body = response.Body as Readable | undefined;
        if (!body) throw new Error('S3 download has no body');
        let received = 0;
        let diskCheckedAt = -diskCheckInterval;
        let overLimit = false;
        try {
          if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
            overLimit = true;
            throw new Error('S3 download exceeds maximum source size');
          }
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              received += chunk.length;
              if (received > maxBytes) {
                overLimit = true;
                callback(new Error('S3 download exceeds maximum source size'));
              } else if (
                options.minFreeBytes !== undefined &&
                received - diskCheckedAt >= diskCheckInterval
              ) {
                diskCheckedAt = received;
                checkDisk(chunk.length).then(() => callback(null, chunk), callback);
              } else callback(null, chunk);
            },
          });
          // createWriteStream truncates a previous partial attempt.
          await pipeline(body, meter, createWriteStream(localPath), { signal });
          if (response.ContentLength !== undefined && received !== response.ContentLength) {
            throw Object.assign(new Error('Incomplete S3 download'), {
              code: 'ERR_STREAM_PREMATURE_CLOSE',
            });
          }
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const interrupted = [
            'ECONNRESET',
            'ETIMEDOUT',
            'EPIPE',
            'ERR_STREAM_PREMATURE_CLOSE',
          ].includes(code ?? '');
          if (attempt > 0 || signal.aborted || overLimit || !interrupted) throw error;
        } finally {
          body.destroy();
        }
      }
    } catch (error) {
      await rm(localPath, { force: true });
      throw new Error(`Failed to download file from S3: ${error}`, { cause: error });
    } finally {
      if (timer) clearTimeout(timer);
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

      return (response.Contents ?? []).map((item) => ({
        key: item.Key!,
        size: item.Size || 0,
        lastModified: item.LastModified!,
        bucket: this.bucketName,
      }));
    } catch (error) {
      throw new Error(`Failed to list files from S3: ${error}`);
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
      await this.copyObject(sourceKey, destinationKey);
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
): S3Service {
  return new S3Service(config, deletedObjectListener);
}

// No additional type exports needed - interfaces are already exported
