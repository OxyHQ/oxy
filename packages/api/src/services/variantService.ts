import type { S3Service } from './s3Service';
import { storageKeyForVisibility } from '../config/cdn';
import { logger } from '../utils/logger';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync, spawn } from 'child_process';
import type { VariantConfig } from '../types/variant.types';
import type {
  FileRecord,
  FileVariantRecord,
  FileVisibility,
  NewFileVariant,
} from '../types/file.types';
import { applyCanonicalMediaMetadata, resolveFileMediaMetadata } from '../utils/fileMediaMetadata';
import {
  deleteVariant,
  findFileById,
  findVariantTwin,
  upsertVariantSet,
  updateFile,
  upsertVariant,
} from './fileRepository';

// FFprobe metadata interfaces for type safety
interface FFprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface FFprobeFormat {
  duration?: string;
  bit_rate?: string;
}

interface FFprobeMetadata {
  streams?: FFprobeStream[];
  format?: FFprobeFormat;
}

/** Persisted under `files.metadata.video` or probed from the source via ffprobe. */
type VideoProbeMetadata = {
  duration?: number;
  width?: number;
  height?: number;
  bitrate?: number;
  fps?: number;
  codec?: string;
  audioCodec?: string;
};

// Get FFmpeg and FFprobe paths - use static binaries if available, otherwise fallback to system
function getFfmpegPath(): string {
  try {
    // ffmpeg-static exports the path as a string directly
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStatic = require('ffmpeg-static');
    logger.debug('[VariantService] ffmpeg-static require result', { type: typeof ffmpegStatic, value: ffmpegStatic });
    
    if (ffmpegStatic && typeof ffmpegStatic === 'string') {
      const binaryPath = ffmpegStatic;
      logger.debug('[VariantService] Checking ffmpeg path', { binaryPath });
      
      // Verify the path exists and is a file
      if (fs.existsSync(binaryPath)) {
        const stats = fs.statSync(binaryPath);
        if (stats.isFile()) {
          // Make executable if not already (needed for some platforms)
          try {
            fs.chmodSync(binaryPath, 0o755);
          } catch {
            // Ignore chmod errors
          }
          logger.info('[VariantService] Using ffmpeg-static binary', { binaryPath });
          return binaryPath;
        } else {
          logger.warn('[VariantService] ffmpeg-static path is not a file', { binaryPath });
        }
      } else {
        logger.warn('[VariantService] ffmpeg-static path does not exist', { binaryPath });
      }
    } else {
      logger.warn('[VariantService] ffmpeg-static did not return a string', { type: typeof ffmpegStatic, value: ffmpegStatic });
    }
  } catch (e) {
    const error = e as Error;
    logger.error('[VariantService] Error loading ffmpeg-static', { message: error.message, stack: error.stack });
  }

  // Fallback to system ffmpeg - resolve via PATH so callers that check
  // fs.existsSync() get an absolute path (arm64 Linux has no ffmpeg-static binary,
  // but the Docker image installs system ffmpeg at /usr/bin/ffmpeg).
  try {
    const resolved = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    if (resolved) {
      logger.info('[VariantService] Using system ffmpeg', { binaryPath: resolved });
      return resolved;
    }
  } catch {
    // `which` exits non-zero when ffmpeg is not on PATH
  }

  logger.warn('[VariantService] System ffmpeg not found in PATH - video processing may fail. Install with: apk add ffmpeg (or apt-get install ffmpeg)');
  // Still return the bare command as a last resort - spawn will surface the error.
  return 'ffmpeg';
}

function getFfprobePath(): string {
  try {
    // ffprobe-static exports an object with a path property
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffprobeStatic = require('ffprobe-static');
    logger.debug('[VariantService] ffprobe-static require result', { type: typeof ffprobeStatic, value: ffprobeStatic });
    
    if (ffprobeStatic) {
      const binaryPath = typeof ffprobeStatic === 'string' 
        ? ffprobeStatic 
        : (ffprobeStatic.path || ffprobeStatic.default);
      
      if (binaryPath) {
        logger.debug('[VariantService] Checking ffprobe path', { binaryPath });
        
        // Verify the path exists and is a file
        if (fs.existsSync(binaryPath)) {
          const stats = fs.statSync(binaryPath);
          if (stats.isFile()) {
            // Make executable if not already (needed for some platforms)
            try {
              fs.chmodSync(binaryPath, 0o755);
            } catch {
              // Ignore chmod errors
            }
            logger.info('[VariantService] Using ffprobe-static binary', { binaryPath });
            return binaryPath;
          } else {
            logger.warn('[VariantService] ffprobe-static path is not a file', { binaryPath });
          }
        } else {
          logger.warn('[VariantService] ffprobe-static path does not exist', { binaryPath });
          // Check if this is an unsupported architecture issue
          const arch = os.arch();
          const platform = os.platform();
          if (platform === 'linux' && arch === 'arm64') {
            logger.warn('[VariantService] ffprobe-static does not provide ARM64 Linux binaries', { arch, platform });
          }
        }
      } else {
        logger.warn('[VariantService] ffprobe-static did not provide a path');
      }
    }
  } catch (e) {
    const error = e as Error;
    logger.error('[VariantService] Error loading ffprobe-static', { message: error.message, stack: error.stack });
  }
  
  // Fallback to system ffprobe - resolve via PATH so callers that check
  // fs.existsSync() get an absolute path (arm64 Linux has no ffprobe-static binary,
  // but the Docker image installs system ffprobe at /usr/bin/ffprobe).
  try {
    const resolved = execSync('which ffprobe', { encoding: 'utf8' }).trim();
    if (resolved) {
      logger.info('[VariantService] Using system ffprobe', { binaryPath: resolved });
      return resolved;
    }
  } catch {
    // `which` exits non-zero when ffprobe is not on PATH
  }

  logger.warn('[VariantService] System ffprobe not found in PATH - video metadata extraction may fail. Install with: apk add ffmpeg (or apt-get install ffmpeg)');
  // Still return the bare command as a last resort - spawn will surface the error.
  return 'ffprobe';
}

const ffmpegPath = getFfmpegPath();
const ffprobePath = getFfprobePath();

// Log resolved paths at module load
logger.info('[VariantService] Resolved FFmpeg path', { ffmpegPath });
logger.info('[VariantService] Resolved FFprobe path', { ffprobePath });

// Log final paths being used
try {
  logger.info('FFmpeg/FFprobe paths initialized', {
    ffmpegPath,
    ffprobePath,
    ffmpegExists: fs.existsSync(ffmpegPath),
    ffprobeExists: fs.existsSync(ffprobePath)
  });
} catch {
  // Logger might not be initialized yet, ignore
}

/**
 * Hard wall-clock ceiling for a single poster-frame decode before the ffmpeg
 * process is SIGKILLed.
 *
 * Poster extraction is reachable from the UNAUTHENTICATED public CDN origin
 * (`GET /cdn/:id?variant=…` → `assetService.ensureVariant`), so a stuck or
 * pathological decode must not be able to pin a worker indefinitely. The frame
 * is cached in S3 afterwards, so this cost is paid at most once per file.
 */
const POSTER_FFMPEG_TIMEOUT_MS = 30_000;

/**
 * Cap on the JPEG bytes buffered from ffmpeg's stdout. A single frame is orders
 * of magnitude smaller than this; the cap exists so a crafted input that makes
 * ffmpeg stream unbounded output cannot exhaust the process heap.
 */
const POSTER_MAX_OUTPUT_BYTES = 32 * 1024 * 1024; // 32 MiB

/**
 * The protocols ffmpeg is allowed to open for a poster decode, derived from the
 * input URL's OWN scheme.
 *
 * The input is a presigned object URL we just built, so the exact protocol it
 * needs is known — and `file` is never among them. That matters because the
 * bytes ffmpeg demuxes are USER-UPLOADED: a crafted container (HLS/DASH
 * playlist, or any format carrying an external reference) can name a URL for
 * ffmpeg to open, and the resulting frame is then published at a public CDN
 * key. Without a whitelist, `file:///etc/passwd` is such a reference. Deriving
 * the list rather than hardcoding it keeps a deployment pointed at an
 * `http://` S3-compatible endpoint (local MinIO) working, while a production
 * `https://` endpoint additionally denies cleartext `http` targets.
 */
function posterProtocolWhitelist(inputUrl: string): string {
  return inputUrl.startsWith('http://') ? 'http,tcp' : 'https,tls,tcp';
}

export interface VariantConfigWithType extends VariantConfig {
  type: string;
}

export interface VideoVariantConfig {
  type: string;
  width?: number;
  height?: number;
  bitrate?: string; // e.g., '500k', '1M', '2M'
  videoCodec?: string;
  audioCodec?: string;
  preset?: string; // FFmpeg preset (ultrafast, fast, medium, slow)
}

export class VariantService {
  private readonly imageVariants: VariantConfigWithType[] = [
    { type: 'w96', width: 96, height: 96, quality: 82, format: 'webp' },
    { type: 'w128', width: 128, height: 128, quality: 82, format: 'webp' },
    { type: 'thumb', width: 256, height: 256, quality: 82, format: 'webp' },
    { type: 'w320', width: 320, quality: 82, format: 'webp' },
    { type: 'w640', width: 640, quality: 82, format: 'webp' },
    { type: 'w1280', width: 1280, quality: 82, format: 'webp' },
    { type: 'w2048', width: 2048, quality: 82, format: 'webp' }
  ];

  private readonly videoVariants: VideoVariantConfig[] = [
    { type: '360p', width: 640, height: 360, bitrate: '500k', videoCodec: 'libx264', audioCodec: 'aac', preset: 'fast' },
    { type: '720p', width: 1280, height: 720, bitrate: '1M', videoCodec: 'libx264', audioCodec: 'aac', preset: 'fast' },
    { type: '1080p', width: 1920, height: 1080, bitrate: '2M', videoCodec: 'libx264', audioCodec: 'aac', preset: 'medium' }
  ];

  constructor(private s3Service: S3Service) {}

  /**
   * Persist a file's whole rendition set, together with any intrinsic metadata
   * derived from the SAME decode pass, as ONE transaction.
   *
   * Mongoose wrote both in a single `$set` on one document and wrapped it in a
   * `VersionError` retry loop — optimistic concurrency over `__v`, which merged
   * the two sets by variant type when a racing writer bumped the version. None
   * of that travels: there is no document version to conflict on, and
   * `upsertVariantSet` is a single transaction, so a racing writer either sees
   * the whole previous set or the whole new one. The retry loop, its
   * `VariantCommitRetryOptions`, and the declaration-merged `commitVariants`
   * that carried them are deleted rather than reproduced.
   *
   * The in-memory `file.variants` is merged by type to match what the
   * transaction did — rows of types this batch did not write are preserved, so
   * the record does not appear to have lost variants that are still there.
   */
  private async commitVariants(file: FileRecord, variants: NewFileVariant[]): Promise<void> {
    const rows = await upsertVariantSet(
      file.id,
      variants,
      file.metadata === undefined ? undefined : { metadata: file.metadata }
    );
    const written = new Set(rows.map((row) => row.type));
    file.variants = [...file.variants.filter((v) => !written.has(v.type)), ...rows];
  }

  private async getUsableReadyVariant(
    file: FileRecord,
    variantType: string
  ): Promise<FileVariantRecord | undefined> {
    const existing = file.variants.find(v => v.type === variantType && v.readyAt);
    if (!existing) {
      return undefined;
    }

    if (await this.s3Service.fileExists(existing.key)) {
      return existing;
    }

    logger.warn('Ready variant metadata points to a missing storage object; regenerating', {
      fileId: file.id,
      variantType,
      key: existing.key,
    });
    await deleteVariant(file.id, existing.type, existing.key);
    file.variants = file.variants.filter((v) => v.id !== existing.id);
    return undefined;
  }

  /**
   * Validate and sanitize path/URL for FFmpeg/FFprobe to prevent command injection
   * While spawn() with argument arrays is safer than exec(), we still validate inputs
   */
  private validateMediaPath(mediaPath: string): void {
    if (!mediaPath || typeof mediaPath !== 'string') {
      throw new Error('Invalid media path: must be a non-empty string');
    }

    // Check path length to prevent DoS
    if (mediaPath.length > 2048) {
      throw new Error('Invalid media path: path too long');
    }

    // For local file paths, check for path traversal attempts
    if (!mediaPath.startsWith('http://') && !mediaPath.startsWith('https://')) {
      // Resolve to absolute path and check it doesn't escape
      const resolvedPath = path.resolve(mediaPath);
      if (resolvedPath.includes('..')) {
        throw new Error('Invalid media path: path traversal detected');
      }

      // Verify file exists and is a file (not directory or symlink)
      if (!fs.existsSync(resolvedPath)) {
        throw new Error('Invalid media path: file does not exist');
      }

      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) {
        throw new Error('Invalid media path: not a regular file');
      }
    }

    // For URLs, validate format
    if (mediaPath.startsWith('http://') || mediaPath.startsWith('https://')) {
      try {
        new URL(mediaPath);
      } catch {
        throw new Error('Invalid media path: malformed URL');
      }
    }
  }

  /**
   * Generate variants for a file
   */
  async generateVariants(fileId: string): Promise<void> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        throw new Error('File not found');
      }

      logger.info('Starting variant generation', {
        fileId,
        mime: file.mime,
        size: file.size
      });

      // Check if variants already exist (for content-addressed files)
      const existingFile = await findVariantTwin(file.sha256, file.id);

      if (existingFile && existingFile.variants.length > 0) {
        // Reuse existing variants and intrinsic metadata from the content-address
        // twin. The twin's rows are copied as NEW rows: `id` and `file_id`
        // belong to the twin and must not be carried over.
        if (existingFile.metadata) {
          file.metadata = { ...(file.metadata ?? {}), ...existingFile.metadata };
        }
        await this.commitVariants(
          file,
          existingFile.variants.map((variant) => ({
            type: variant.type,
            key: variant.key,
            width: variant.width,
            height: variant.height,
            readyAt: variant.readyAt,
            size: variant.size,
            metadata: variant.metadata,
          }))
        );

        logger.info('Reused existing variants for duplicate content', {
          fileId,
          sourceFileId: existingFile.id,
          variantCount: existingFile.variants.length
        });
        return;
      }

      // Generate new variants based on file type
      if (file.mime.startsWith('image/')) {
        await this.generateImageVariants(file);
      } else if (file.mime.startsWith('video/')) {
        await this.generateVideoVariants(file);
      } else if (file.mime === 'application/pdf') {
        await this.generatePdfVariants(file);
      }

      logger.info('Variant generation completed', { 
        fileId, 
        variantCount: file.variants.length 
      });
    } catch (error) {
      logger.error('Error generating variants:', error);
      throw error;
    }
  }

  /**
   * Fast metadata-only backfill: persist canonical `metadata.media` when the
   * intrinsic dimensions can already be resolved (from type-specific subdocs or
   * existing variants) WITHOUT regenerating variants. For videos, backfills the
   * duration via a single ffprobe against the S3 object when it's missing.
   *
   * Returns:
   *  - `'needs_variants'` — dimensions cannot be resolved; caller should run
   *    full `generateVariants()`.
   *  - `'skipped'` — canonical `metadata.media` is already complete.
   *  - `'persisted'` — canonical `metadata.media` was written.
   */
  async enrichCanonicalMetadataOnly(
    fileId: string,
  ): Promise<'needs_variants' | 'skipped' | 'persisted'> {
    const file = await findFileById(fileId);
    if (!file) {
      throw new Error('File not found');
    }

    const isVideo = file.mime.startsWith('video/');
    const resolved = resolveFileMediaMetadata(file);
    if (!resolved.width || !resolved.height) {
      return 'needs_variants';
    }

    const media = (file.metadata?.media ?? {}) as {
      width?: number;
      height?: number;
      durationSec?: number;
    };
    const mediaComplete =
      !!media.width &&
      !!media.height &&
      (!isVideo || typeof media.durationSec === 'number');
    if (mediaComplete) {
      return 'skipped';
    }

    let durationSec = resolved.durationSec;
    if (isVideo && durationSec === undefined && file.storageKey) {
      try {
        const videoUrl = await this.s3Service.getPresignedDownloadUrl(file.storageKey, 3600);
        const probed = await this.extractVideoMetadataFromUrl(videoUrl);
        if (typeof probed.duration === 'number' && probed.duration > 0) {
          durationSec = probed.duration;
        }
      } catch (error) {
        logger.warn('enrichCanonicalMetadataOnly: ffprobe duration lookup failed', {
          fileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    applyCanonicalMediaMetadata(file, {
      width: resolved.width,
      height: resolved.height,
      durationSec,
    });
    await updateFile(file.id, { metadata: file.metadata });
    return 'persisted';
  }

  /**
   * Metadata-only backfill: ffprobe/sharp against the canonical S3 object, persist
   * `metadata.media`, skip variant generation. Used by one-shot corpus backfills.
   */
  async extractSourceMetadataOnly(fileId: string): Promise<boolean> {
    const file = await findFileById(fileId);
    if (!file?.storageKey) {
      return false;
    }

    if (file.mime.startsWith('video/')) {
      const videoUrl = await this.s3Service.getPresignedDownloadUrl(file.storageKey, 3600);
      const probed = await this.extractVideoMetadataFromUrl(videoUrl);
      const width = typeof probed.width === 'number' && probed.width > 0 ? probed.width : undefined;
      const height = typeof probed.height === 'number' && probed.height > 0 ? probed.height : undefined;
      if (!width || !height) {
        return false;
      }
      const durationSec =
        typeof probed.duration === 'number' && probed.duration > 0 ? probed.duration : undefined;
      applyCanonicalMediaMetadata(file, { width, height, durationSec });
      await updateFile(file.id, { metadata: file.metadata });
      return true;
    }

    if (file.mime.startsWith('image/')) {
      const originalBuffer = await this.s3Service.downloadBuffer(file.storageKey);
      const meta = await sharp(originalBuffer, { failOn: 'none' }).metadata();
      const width = typeof meta.width === 'number' && meta.width > 0 ? meta.width : undefined;
      const height = typeof meta.height === 'number' && meta.height > 0 ? meta.height : undefined;
      if (!width || !height) {
        return false;
      }
      file.metadata = {
        ...(file.metadata ?? {}),
        image: { width, height },
      };
      applyCanonicalMediaMetadata(file, { width, height });
      await updateFile(file.id, { metadata: file.metadata });
      return true;
    }

    return false;
  }

  /**
   * Generate all standard image variants using Sharp.
   */
  private async generateImageVariants(file: FileRecord): Promise<void> {
    try {
      logger.info('Generating image variants', { fileId: file.id });

      const originalBuffer = await this.s3Service.downloadBuffer(file.storageKey);
      const base = sharp(originalBuffer, { failOn: 'none' });
      const meta = await base.metadata();

      const variants: NewFileVariant[] = [];
      for (const config of this.imageVariants) {
        const variantKey = this.generateVariantKey(file.sha256, config.type, config.format || 'webp', file.visibility);

        const width = config.width || meta.width || 1280;
        const height = config.height; // let sharp maintain aspect by only setting width unless both provided
        let pipeline = sharp(originalBuffer, { failOn: 'none' }).rotate();
        pipeline = pipeline.resize({ width, height, fit: 'inside', withoutEnlargement: true });

        // Set format and quality
        const format = (config.format || 'webp');
  if (format === 'webp') pipeline = pipeline.webp({ quality: config.quality ?? 82 });
  if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: config.quality ?? 82 });
  if (format === 'png') pipeline = pipeline.png();

        const out = await pipeline.toBuffer();
        await this.s3Service.uploadBuffer(variantKey, out, {
          contentType: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
        });

        variants.push({
          type: config.type,
          key: variantKey,
          width,
          height: height || Math.round((meta.height || width) * (width / (meta.width || width))),
          readyAt: new Date(),
          size: out.length,
          metadata: { format, quality: config.quality }
        });

        logger.debug('Generated image variant', { fileId: file.id, type: config.type, key: variantKey });
      }

      if (meta.width && meta.height) {
        file.metadata = {
          ...(file.metadata ?? {}),
          image: { width: meta.width, height: meta.height },
        };
        applyCanonicalMediaMetadata(file, { width: meta.width, height: meta.height });
      }

      await this.commitVariants(file, variants);

      logger.info('Image variants generated', { fileId: file.id, variantCount: variants.length });
    } catch (error) {
      logger.error('Error generating image variants:', error);
      throw error;
    }
  }

  /**
   * Generate video variants with FFmpeg
   * Generates poster frame, multiple bitrate variants, and HLS streams
   */
  private async generateVideoVariants(file: FileRecord): Promise<void> {
    try {
      logger.info('Generating video variants with FFmpeg', { fileId: file.id });

      // Get S3 presigned URL - FFmpeg can read directly from HTTP URLs
      const videoUrl = await this.s3Service.getPresignedDownloadUrl(file.storageKey, 3600);
      
      // Extract video metadata using S3 presigned URL (no download needed)
      const metadata = await this.extractVideoMetadataFromUrl(videoUrl);
      
      const variants: NewFileVariant[] = [];

      // Generate poster frame at 1 second (or 10% of duration, whichever is smaller)
      const posterTime = Math.min(1, (metadata.duration || 60) * 0.1);
      const posterVariant = await this.generatePosterFrame(
        file.storageKey, // Use S3 storage key directly - no temp files
        file.sha256,
        posterTime,
        file.visibility,
        metadata // Pass metadata to preserve exact aspect ratio
      );
      variants.push(posterVariant);

      // Generate multiple bitrate variants.
      //
      // `generateVideoVariant` resolves `null` on an ffmpeg failure rather than
      // rejecting, so ONE rendition failing does not cost the poster and the
      // renditions that did encode. Total loss is a different thing and must not
      // be silent: a video whose every attempted rendition failed used to reach
      // the end of this method, log "generated successfully", and be
      // indistinguishable from a healthy upload from outside (issue #759).
      // Counting attempts separately from successes is what tells the two apart
      // — a source smaller than every target legitimately attempts nothing.
      let renditionsAttempted = 0;
      let renditionsSucceeded = 0;
      for (const config of this.videoVariants) {
        // Skip if source resolution is smaller than target
        if (metadata.width && metadata.height) {
          if (config.width && config.width > metadata.width) {
            logger.debug('Skipping variant larger than source', {
              type: config.type,
              sourceWidth: metadata.width,
              targetWidth: config.width
            });
            continue;
          }
        }

        renditionsAttempted += 1;
        const variant = await this.generateVideoVariant(
          videoUrl, // Use S3 presigned URL directly - no temp files
          file.sha256,
          config,
          file.visibility
        );
        if (variant) {
          renditionsSucceeded += 1;
          variants.push(variant);
        }
      }

      // Generate HLS stream (adaptive streaming)
      const hlsVariants = await this.generateHLSStream(
        videoUrl, // Use S3 presigned URL directly - no temp files
        file.sha256,
        metadata,
        file.visibility
      );
      variants.push(...hlsVariants);

      // Store original video metadata
      file.metadata = {
        ...file.metadata,
        video: {
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          bitrate: metadata.bitrate,
          fps: metadata.fps,
          codec: metadata.codec,
          audioCodec: metadata.audioCodec
        }
      };
      applyCanonicalMediaMetadata(file, {
        width: metadata.width,
        height: metadata.height,
        durationSec: metadata.duration,
      });

      await this.commitVariants(file, variants);

      // Raised AFTER the commit, deliberately. Everything that did encode — the
      // poster above all, which is the one video rendition with real consumers
      // (`ensureVideoPoster`) — is already persisted and is not thrown away by
      // reporting the failure. The throw is what marks the queue job failed so
      // the loss is visible and retried; swallowing it is what made a video with
      // no renditions look exactly like a healthy upload (issue #759).
      if (renditionsAttempted > 0 && renditionsSucceeded === 0) {
        throw new Error(
          `All ${renditionsAttempted} video rendition(s) failed to encode for file ${file.id}`
        );
      }

      if (renditionsAttempted > renditionsSucceeded) {
        logger.warn('Some video mp4 renditions failed to encode', {
          fileId: file.id,
          renditionsAttempted,
          renditionsSucceeded,
          renditionsFailed: renditionsAttempted - renditionsSucceeded,
        });
      }

      logger.info('Video variants generated successfully', {
        fileId: file.id,
        variantCount: variants.length,
        renditionsAttempted,
        renditionsSucceeded,
        metadata
      });
    } catch (error) {
      logger.error('Error generating video variants:', error);
      throw error;
    }
  }

  /**
   * Parse FPS string (e.g., "30/1" -> 30)
   */
  private parseFps(fpsString: string): number {
    const [num, den] = fpsString.split('/').map(Number);
    return den ? num / den : num;
  }

  /**
   * Generate poster frame (thumbnail) from video
   * Maintains the video's exact aspect ratio (vertical videos stay vertical)
   * Uses S3 presigned URL directly with FFmpeg - no temp files, production-ready
   */
  private async generatePosterFrame(
    videoStorageKey: string,
    sha256: string,
    timeSeconds: number,
    visibility: FileVisibility,
    metadata?: { width?: number; height?: number }
  ): Promise<NewFileVariant> {
    const posterKey = this.generateVariantKey(sha256, 'poster', 'jpg', visibility);

    // Get S3 presigned URL for the video (FFmpeg supports HTTP input)
    const videoUrl = await this.s3Service.getPresignedDownloadUrl(videoStorageKey, 3600);
    
    // Extract metadata if not provided (using S3 URL)
    if (!metadata || !metadata.width || !metadata.height) {
      metadata = await this.extractVideoMetadataFromUrl(videoUrl);
    }

    const videoWidth = metadata.width || 1920;
    const videoHeight = metadata.height || 1080;
    const aspectRatio = videoWidth / videoHeight;

    // Use FFmpeg's built-in aspect ratio preservation
    // Scale to max 1920px while maintaining exact aspect ratio (no stretching)
    let scaleFilter: string;
    
    if (videoWidth >= videoHeight) {
      // Landscape or square: constrain width to 1920, let FFmpeg calculate height to preserve aspect ratio
      scaleFilter = 'scale=1920:-1:force_original_aspect_ratio=decrease';
    } else {
      // Vertical/portrait: constrain height to 1920, let FFmpeg calculate width to preserve aspect ratio
      scaleFilter = 'scale=-1:1920:force_original_aspect_ratio=decrease';
    }

    return new Promise((resolve, reject) => {
      // Generate poster with scaling to max 1920px while maintaining exact aspect ratio
      // Stream output directly to stdout (memory) - no temp files
      const args = [
        // Global options must precede `-i`. `-nostdin` so a decode can never
        // block waiting on a stdin that will never be written, and the protocol
        // whitelist so a crafted container cannot make ffmpeg open a local file
        // or an unrelated network target (see `posterProtocolWhitelist`).
        '-loglevel', 'error',
        '-nostdin',
        '-protocol_whitelist', posterProtocolWhitelist(videoUrl),
        '-i', videoUrl, // Use S3 presigned URL directly
        '-ss', timeSeconds.toString(),
        '-vframes', '1',
        '-vf', scaleFilter,
        '-q:v', '2',
        '-f', 'image2pipe', // Output to pipe
        '-vcodec', 'mjpeg', // JPEG format for pipe
        'pipe:1' // Output to stdout
      ];

      // Only verify absolute paths — a bare `ffmpeg` command is resolved via PATH at spawn time.
      if (path.isAbsolute(ffmpegPath) && !fs.existsSync(ffmpegPath)) {
        reject(new Error(`FFmpeg binary not found at path: ${ffmpegPath}. Please install ffmpeg-static or ensure system ffmpeg is available.`));
        return;
      }

      logger.debug('Spawning ffmpeg process for poster from S3', { 
        path: ffmpegPath, 
        videoUrl: videoUrl.substring(0, 50) + '...',
        videoWidth,
        videoHeight,
        aspectRatio,
        scaleFilter
      });
      
      // Node kills the process itself once the wall-clock ceiling elapses; the
      // `close` handler below sees a null exit code and a signal.
      const ffmpegProcess = spawn(ffmpegPath, args, {
        timeout: POSTER_FFMPEG_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });

      let stderr = '';
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let outputOverflowed = false;

      ffmpegProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpegProcess.stdout.on('data', (data: Buffer) => {
        if (outputOverflowed) {
          return;
        }
        stdoutBytes += data.length;
        if (stdoutBytes > POSTER_MAX_OUTPUT_BYTES) {
          // Stop buffering and tear the decode down; `close` reports the reason.
          outputOverflowed = true;
          stdoutChunks.length = 0;
          ffmpegProcess.kill('SIGKILL');
          return;
        }
        stdoutChunks.push(data);
      });

      ffmpegProcess.on('close', async (code, signal) => {
        if (outputOverflowed) {
          logger.error('Poster generation exceeded the output cap', {
            maxOutputBytes: POSTER_MAX_OUTPUT_BYTES,
          });
          reject(new Error('Poster generation aborted: output exceeded the maximum allowed size'));
          return;
        }

        if (code !== 0) {
          logger.error('Poster generation failed', { code, signal, stderr: stderr.substring(0, 500) });
          if (code === null) {
            reject(
              new Error(
                `Poster generation aborted after ${POSTER_FFMPEG_TIMEOUT_MS}ms (signal ${String(signal)})`
              )
            );
            return;
          }
          reject(new Error(`Poster generation failed with code ${code}: ${stderr.substring(0, 200)}`));
          return;
        }

        try {
          // Get poster from stdout (no temp file needed)
          const posterBuffer = Buffer.concat(stdoutChunks);
          
          // Optimize poster with Sharp (no resize, just optimize)
          const optimized = await sharp(posterBuffer)
            .jpeg({ quality: 85 })
            .toBuffer();

          // Upload to S3
          await this.s3Service.uploadBuffer(posterKey, optimized, {
            contentType: 'image/jpeg'
          });

          const imageMetadata = await sharp(optimized).metadata();
          resolve({
            type: 'poster',
            key: posterKey,
            width: imageMetadata.width || videoWidth,
            height: imageMetadata.height || videoHeight,
            readyAt: new Date(),
            size: optimized.length,
            metadata: { 
              type: 'poster', 
              position: `${timeSeconds}s`, 
              format: 'jpg',
              originalAspectRatio: aspectRatio,
              videoWidth,
              videoHeight
            }
          });
        } catch (error) {
          reject(error);
        }
      });

      ffmpegProcess.on('error', (err) => {
        reject(new Error(`Poster generation failed: ${err.message}`));
      });
    });
  }

  /**
   * Extract video metadata from S3 URL (for presigned URLs)
   */
  private async extractVideoMetadataFromUrl(videoUrl: string): Promise<VideoProbeMetadata> {
    try {
      // Validate URL to prevent command injection
      this.validateMediaPath(videoUrl);

      // Use spawn for better cross-platform compatibility
      return new Promise((resolve) => {
        const args = [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format',
          '-show_streams',
          videoUrl
        ];

        const ffprobeProcess = spawn(ffprobePath, args);
        let stdout = '';
        let stderr = '';

        ffprobeProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        ffprobeProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffprobeProcess.on('close', (code) => {
          if (code !== 0) {
            logger.warn('FFprobe failed from URL', { code, stderr });
            resolve({});
            return;
          }

          try {
            const metadata = JSON.parse(stdout) as FFprobeMetadata;

            const videoStream = metadata.streams?.find((s) => s.codec_type === 'video');
            const audioStream = metadata.streams?.find((s) => s.codec_type === 'audio');

            resolve({
              duration: metadata.format?.duration ? Number.parseFloat(metadata.format.duration) : undefined,
              width: videoStream?.width,
              height: videoStream?.height,
              bitrate: metadata.format?.bit_rate ? Number.parseInt(metadata.format.bit_rate) : undefined,
              fps: videoStream?.r_frame_rate ? this.parseFps(videoStream.r_frame_rate) : undefined,
              codec: videoStream?.codec_name,
              audioCodec: audioStream?.codec_name
            });
          } catch (error) {
            logger.warn('Error parsing FFprobe output from URL', { error, stdout });
            resolve({});
          }
        });

        ffprobeProcess.on('error', (err) => {
          logger.warn('FFprobe process error from URL', { error: err });
          resolve({});
        });
      });
    } catch (error) {
      logger.warn('Error extracting video metadata from URL, using defaults', { error });
      return {};
    }
  }

  /**
   * Generate a video variant with specific encoding settings
   * Uses S3 presigned URL directly - streams output to memory, no temp files
   */
  private async generateVideoVariant(
    videoUrl: string,
    sha256: string,
    config: VideoVariantConfig,
    visibility: FileVisibility
  ): Promise<NewFileVariant | null> {
    const variantKey = this.generateVariantKey(sha256, config.type, 'mp4', visibility);

    return new Promise((resolve) => {
      const args = [
        '-i', videoUrl, // Use S3 presigned URL directly
        '-c:v', config.videoCodec || 'libx264',
        '-c:a', config.audioCodec || 'aac',
        '-b:v', config.bitrate || '1M',
        '-movflags', '+faststart', // Enable progressive download
        '-preset', config.preset || 'fast',
        '-crf', '23', // Constant rate factor for quality
        '-pix_fmt', 'yuv420p', // Compatibility
        '-avoid_negative_ts', 'make_zero',
        '-f', 'mp4', // Output format
        'pipe:1' // Output to stdout (memory)
      ];

      // Set resolution if specified
      if (config.width && config.height) {
        args.push('-vf', `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease,pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2`);
      }

      // Only verify absolute paths — a bare `ffmpeg` command is resolved via PATH at spawn time.
      if (path.isAbsolute(ffmpegPath) && !fs.existsSync(ffmpegPath)) {
        logger.error('FFmpeg binary not found', { path: ffmpegPath, variant: config.type });
        resolve(null);
        return;
      }

      logger.debug('FFmpeg command for variant', { 
        variant: config.type,
        videoUrl: videoUrl.substring(0, 50) + '...'
      });

      const ffmpegProcess = spawn(ffmpegPath, args);

      let stderr = '';
      const stdoutChunks: Buffer[] = [];
      let _lastProgress = '';

      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        
        // Parse progress from ffmpeg output
        const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const hours = Number.parseInt(timeMatch[1]);
          const minutes = Number.parseInt(timeMatch[2]);
          const seconds = Number.parseFloat(timeMatch[3]);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          _lastProgress = totalSeconds.toString();
        }
      });

      ffmpegProcess.stdout.on('data', (data) => {
        stdoutChunks.push(data);
      });

      ffmpegProcess.on('close', async (code) => {
        if (code !== 0) {
          logger.error('Video variant generation failed', { 
            variant: config.type, 
            code,
            error: stderr.substring(0, 500)
          });
          resolve(null); // Don't fail entire process if one variant fails
          return;
        }

        try {
          // Get variant from stdout (no temp file needed)
          const variantBuffer = Buffer.concat(stdoutChunks);

          // Upload to S3
          await this.s3Service.uploadBuffer(variantKey, variantBuffer, {
            contentType: 'video/mp4'
          });

          resolve({
            type: config.type,
            key: variantKey,
            width: config.width,
            height: config.height,
            readyAt: new Date(),
            size: variantBuffer.length,
            metadata: {
              bitrate: config.bitrate,
              codec: config.videoCodec,
              audioCodec: config.audioCodec,
              preset: config.preset,
              format: 'mp4'
            }
          });
        } catch (error) {
          logger.error('Error processing video variant', { variant: config.type, error });
          resolve(null);
        }
      });

      ffmpegProcess.on('error', (err) => {
        logger.error('FFmpeg process error', { variant: config.type, error: err });
        resolve(null);
      });
    });
  }

  /**
   * Generate HLS (HTTP Live Streaming) streams with adaptive bitrate
   * Uses S3 presigned URL directly - segments are uploaded to S3 immediately and temp files cleaned up
   * Note: HLS requires temp files for segment generation, but they're deleted immediately after upload to S3
   */
  private async generateHLSStream(
    videoUrl: string,
    sha256: string,
    metadata: { width?: number; height?: number; duration?: number },
    visibility: FileVisibility
  ): Promise<NewFileVariant[]> {
    // Use /tmp for HLS segments (ephemeral, OS cleans up automatically)
    // FFmpeg needs to write multiple segment files for HLS
    const tempDir = path.join('/tmp', 'oxy-hls', sha256.substring(0, 8));
    const hlsDir = path.join(tempDir, 'hls');
    let cleanupTemp = false;

    return new Promise((resolve, reject) => {
      try {
        // Create HLS output directory (temporary, for segment generation)
        fs.mkdirSync(hlsDir, { recursive: true });
        cleanupTemp = true;
      } catch (error) {
        reject(new Error(`Failed to create HLS temp directory: ${error}`));
        return;
      }

      const variants: NewFileVariant[] = [];

      // Generate HLS variants for each quality
      const hlsVariants: Array<{ resolution: string; bitrate: string; playlist: string }> = [];
      const availableVariants = this.videoVariants.filter(v => {
        // Only include variants that are smaller or equal to source
        return !v.width || !metadata.width || v.width <= metadata.width;
      });

      if (availableVariants.length === 0) {
        // Fallback to original resolution
        availableVariants.push({
          type: 'source',
          width: metadata.width,
          height: metadata.height,
          bitrate: '2M',
          videoCodec: 'libx264',
          audioCodec: 'aac',
          preset: 'fast'
        });
      }

      let processedCount = 0;
      const totalVariants = availableVariants.length;

      availableVariants.forEach((config) => {
        const playlistName = `stream_${config.type}.m3u8`;
        const outputPath = path.join(hlsDir, playlistName);
        const segmentPattern = path.join(hlsDir, `segment_${config.type}_%03d.ts`);

        const args = [
          '-i', videoUrl, // Use S3 presigned URL directly
          '-c:v', config.videoCodec || 'libx264',
          '-c:a', config.audioCodec || 'aac',
          '-b:v', config.bitrate || '1M',
          '-f', 'hls',
          '-hls_time', '10', // 10 second segments
          '-hls_list_size', '0', // Keep all segments in playlist
          '-hls_segment_filename', segmentPattern,
          '-hls_flags', 'independent_segments',
          '-preset', config.preset || 'fast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-sc_threshold', '0',
          '-g', '48',
          '-keyint_min', '48'
        ];

        if (config.width && config.height) {
          args.push('-vf', `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease,pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2`);
        }

        args.push('-y', outputPath); // Overwrite output file

        const ffmpegProcess = spawn(ffmpegPath, args);

        let stderr = '';

        ffmpegProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffmpegProcess.on('close', async (code) => {
          if (code !== 0) {
            logger.error('HLS variant generation failed', { 
              variant: config.type, 
              code,
              error: stderr 
            });
            processedCount++;
            if (processedCount === totalVariants) {
              resolve(variants);
            }
            return;
          }

          try {
            // Upload HLS playlist and segments
            const playlistBuffer = fs.readFileSync(outputPath);
            const playlistKey = this.generateVariantKey(sha256, `hls_${config.type}`, 'm3u8', visibility);
            await this.s3Service.uploadBuffer(playlistKey, playlistBuffer, {
              contentType: 'application/vnd.apple.mpegurl'
            });

            // Upload all segment files and delete immediately after upload
            const segments = fs.readdirSync(hlsDir).filter(f => f.startsWith(`segment_${config.type}_`));
            for (const segment of segments) {
              const segmentPath = path.join(hlsDir, segment);
              const segmentBuffer = fs.readFileSync(segmentPath);
              const segmentKey = this.generateVariantKey(sha256, `hls_${config.type}_${segment}`, 'ts', visibility);
              await this.s3Service.uploadBuffer(segmentKey, segmentBuffer, {
                contentType: 'video/mp2t'
              });
              // Delete segment immediately after upload (no temp file accumulation)
              try {
                fs.unlinkSync(segmentPath);
              } catch {
                // Ignore deletion errors
              }
            }

            // Delete playlist file after upload
            try {
              fs.unlinkSync(outputPath);
            } catch {
              // Ignore deletion errors
            }

            hlsVariants.push({
              resolution: config.width && config.height ? `${config.width}x${config.height}` : 'source',
              bitrate: config.bitrate || '1M',
              playlist: playlistKey
            });

            variants.push({
              type: `hls_${config.type}`,
              key: playlistKey,
              width: config.width,
              height: config.height,
              readyAt: new Date(),
              metadata: {
                format: 'hls',
                bitrate: config.bitrate,
                segments: segments.length
              }
            });

            processedCount++;
            if (processedCount === totalVariants) {
              // Generate master playlist
              const masterPlaylist = this.generateMasterPlaylist(hlsVariants);
              const masterKey = this.generateVariantKey(sha256, 'hls_master', 'm3u8', visibility);
              await this.s3Service.uploadBuffer(masterKey, Buffer.from(masterPlaylist), {
                contentType: 'application/vnd.apple.mpegurl'
              });

              variants.push({
                type: 'hls_master',
                key: masterKey,
                readyAt: new Date(),
                metadata: {
                  format: 'hls',
                  variantCount: hlsVariants.length,
                  variants: hlsVariants.map(v => v.resolution)
                }
              });

              // Cleanup temp directory after all uploads (all segments uploaded to S3)
              if (cleanupTemp && fs.existsSync(tempDir)) {
                try {
                  fs.rmSync(tempDir, { recursive: true, force: true });
                  logger.debug('Cleaned up HLS temp directory after uploads', { tempDir });
                } catch (cleanupError) {
                  logger.warn('Error cleaning up HLS temp files', { tempDir, error: cleanupError });
                }
              }

              resolve(variants);
            }
          } catch (error) {
            logger.error('Error processing HLS variant', { variant: config.type, error });
            processedCount++;
            if (processedCount === totalVariants) {
              resolve(variants);
            }
          }
        });

        ffmpegProcess.on('error', (err) => {
          logger.error('FFmpeg process error for HLS', { variant: config.type, error: err });
          processedCount++;
          if (processedCount === totalVariants) {
            resolve(variants);
          }
        });
      });
    });
  }

  /**
   * Generate HLS master playlist
   */
  private generateMasterPlaylist(variants: Array<{ resolution: string; bitrate: string; playlist: string }>): string {
    let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n\n';

    variants.forEach((variant) => {
      const bitrateNumber = this.parseBitrate(variant.bitrate);
      playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${bitrateNumber},RESOLUTION=${variant.resolution}\n`;
      playlist += `${variant.playlist}\n\n`;
    });

    return playlist;
  }

  /**
   * Parse bitrate string to number (e.g., "1M" -> 1000000)
   */
  private parseBitrate(bitrate: string): number {
    const match = bitrate.match(/^(\d+)([kKmM])?$/);
    if (!match) return 1000000;

    const value = Number.parseInt(match[1]);
    const unit = match[2]?.toLowerCase();

    if (unit === 'k') return value * 1000;
    if (unit === 'm') return value * 1000000;
    return value;
  }

  /**
   * Generate PDF variants (first page thumbnail)
   */
  private async generatePdfVariants(file: FileRecord): Promise<void> {
    // This would use pdf2pic or similar to generate thumbnails
    // For now, this is a placeholder
    
    try {
      logger.info('Generating PDF variants (placeholder)', { fileId: file.id });

      const thumbnailKey = this.generateVariantKey(file.sha256, 'thumb', 'jpg', file.visibility);
      
      // Placeholder variant
      const variants: NewFileVariant[] = [{
        type: 'thumb',
        key: thumbnailKey,
        width: 256,
        height: 256,
        readyAt: new Date(),
        metadata: { page: 1 }
      }];

      await this.commitVariants(file, variants);

      logger.info('PDF variants generated (placeholder)', {
        fileId: file.id,
        variantCount: variants.length
      });
    } catch (error) {
      logger.error('Error generating PDF variants:', error);
      throw error;
    }
  }

  /**
   * Generate variant storage key
   */
  private generateVariantKey(
    sha256: string,
    variantType: string,
    format: string,
    visibility: FileVisibility
  ): string {
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const prefix = sha256.substring(0, 2);

    // Variants inherit their parent file's visibility: public variants land
    // under the CDN-reachable `public/` prefix, private/unlisted variants stay
    // private to S3 (served only through the access-gated origin stream route).
    const baseKey = `variants/${year}/${month}/${prefix}/${sha256}/${variantType}.${format}`;
    return storageKeyForVisibility(baseKey, visibility);
  }

  /**
   * Get available variants for a file
   */
  async getVariants(fileId: string): Promise<FileVariantRecord[]> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        throw new Error('File not found');
      }

      return file.variants.filter(variant => variant.readyAt);
    } catch (error) {
      logger.error('Error getting variants:', error);
      throw error;
    }
  }

  /**
   * Check if variant exists and is ready
   */
  async isVariantReady(fileId: string, variantType: string): Promise<boolean> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        return false;
      }

      const variant = file.variants.find(v => v.type === variantType);
      return Boolean(variant?.readyAt);
    } catch (error) {
      logger.error('Error checking variant readiness:', error);
      return false;
    }
  }

  /**
   * Write ONE freshly-produced rendition, replacing any row of the same type,
   * and keep the caller's in-hand record consistent with what was stored.
   *
   * The Mongoose original spliced the variant into the document's array and
   * re-`$set` the WHOLE array, so a concurrent writer's rendition of a DIFFERENT
   * type was silently dropped — which is why both call sites carried a "retry
   * once with a fresh document" block underneath. `upsertVariant` touches only
   * the rows of this type, in a transaction, so there is no whole-array write to
   * lose a neighbour and no retry to write.
   */
  private async storeVariant(
    file: FileRecord,
    variant: NewFileVariant
  ): Promise<FileVariantRecord> {
    const row = await upsertVariant(file.id, variant);
    const idx = file.variants.findIndex(v => v.type === variant.type);
    if (idx >= 0) file.variants[idx] = row;
    else file.variants.push(row);
    return row;
  }

  /** Mp4 bitrate rendition names produced by upload-time `generateVideoVariants`. */
  isVideoMp4Rendition(variantType: string): boolean {
    return this.videoVariants.some(v => v.type === variantType);
  }

  /**
   * Ensure a specific mp4 bitrate rendition exists, generating via FFmpeg if missing.
   *
   * Upload-time `generateVideoVariants` swallows per-rendition failures (`resolve(null)`),
   * so a file can have `poster`/`hls_master` but no `360p`/`720p`/`1080p`. Lazy
   * generation here lets those files self-heal on first request (#759).
   */
  async ensureVideoMp4Rendition(file: FileRecord, variantType: string): Promise<FileVariantRecord> {
    const existing = await this.getUsableReadyVariant(file, variantType);
    if (existing) {
      return existing;
    }

    const config = this.videoVariants.find(v => v.type === variantType);
    if (!config) {
      throw new Error(`Unsupported video mp4 rendition: ${variantType}`);
    }

    const videoUrl = await this.s3Service.getPresignedDownloadUrl(file.storageKey, 3600);
    const storedVideo = file.metadata?.video as VideoProbeMetadata | undefined;
    const hasStoredDimensions =
      typeof storedVideo?.width === 'number' && typeof storedVideo?.height === 'number';
    const probed = hasStoredDimensions
      ? ({} as VideoProbeMetadata)
      : await this.extractVideoMetadataFromUrl(videoUrl);
    const metadata: VideoProbeMetadata = {
      ...probed,
      ...storedVideo,
      width: storedVideo?.width ?? probed.width,
      height: storedVideo?.height ?? probed.height,
    };

    if (metadata.width && config.width && config.width > metadata.width) {
      throw new Error(
        `Variant ${variantType} exceeds source resolution (${metadata.width}px wide)`
      );
    }

    const variant = await this.generateVideoVariant(
      videoUrl,
      file.sha256,
      config,
      file.visibility
    );
    if (!variant) {
      throw new Error(`Failed to generate video rendition: ${variantType}`);
    }

    return await this.storeVariant(file, variant);
  }

  /**
   * Ensure a specific video poster variant exists, generate via FFmpeg if missing.
   */
  async ensureVideoPoster(file: FileRecord): Promise<FileVariantRecord> {
    const existing = await this.getUsableReadyVariant(file, 'poster');
    if (existing) {
      return existing;
    }

    // Generate poster frame directly from S3 - no temp files
    try {
      // Get S3 presigned URL and extract metadata
      const videoUrl = await this.s3Service.getPresignedDownloadUrl(file.storageKey, 3600);
      const metadata = await this.extractVideoMetadataFromUrl(videoUrl);
      const posterTime = Math.min(1, (metadata.duration || 60) * 0.1);

      // Generate poster frame with exact video aspect ratio (streams directly from S3)
      const posterVariant = await this.generatePosterFrame(
        file.storageKey, // Use S3 storage key directly - no temp files
        file.sha256,
        posterTime,
        file.visibility,
        metadata // Pass metadata to preserve exact aspect ratio
      );

      // main's shape returned the in-memory variant; the ported store returns
      // the PERSISTED row, which is the same value plus whatever the write
      // settled (ids, defaults). Callers want the stored one.
      return await this.storeVariant(file, posterVariant);
    } catch (error) {
      logger.error('Error ensuring video poster', { fileId: file.id, error });
      throw error;
    }
  }

  /**
   * Render a sized image variant from an already-in-memory source image and
   * upload it under this file's variant key.
   *
   * Shared by BOTH image-variant paths — the source is the canonical original
   * for an image file, and the extracted poster frame for a video — so the two
   * cannot drift in format, quality or sizing. `rotate()` applies the source's
   * EXIF orientation before resizing; it is a no-op on an ffmpeg-produced
   * poster, which carries none.
   */
  private async renderAndUploadImageVariant(
    file: FileRecord,
    config: VariantConfigWithType,
    sourceBuffer: Buffer
  ): Promise<NewFileVariant> {
    const format = config.format || 'webp';
    let pipeline = sharp(sourceBuffer, { failOn: 'none' })
      .rotate()
      .resize({ width: config.width, height: config.height, fit: 'inside', withoutEnlargement: true });
    if (format === 'webp') pipeline = pipeline.webp({ quality: config.quality ?? 82 });
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: config.quality ?? 82 });
    if (format === 'png') pipeline = pipeline.png();

    const out = await pipeline.toBuffer();
    // The output mime deliberately need not match the source's: the key carries
    // its own `format` and the upload sets `contentType` explicitly, which is
    // what lets a `video/*` file own an `image/webp` variant (the `poster`
    // variant has always relied on the same property).
    const key = this.generateVariantKey(file.sha256, config.type, format, file.visibility);
    await this.s3Service.uploadBuffer(key, out, {
      contentType: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
    });

    const imgMeta = await sharp(out).metadata();
    return {
      type: config.type,
      key,
      width: imgMeta.width || config.width || 0,
      height: imgMeta.height || config.height || 0,
      readyAt: new Date(),
      size: out.length,
      metadata: { format, quality: config.quality }
    };
  }


  /**
   * Ensure a specific image variant exists, generate via Sharp if missing.
   */
  async ensureImageVariant(file: FileRecord, variantType: string): Promise<FileVariantRecord> {
    const existing = await this.getUsableReadyVariant(file, variantType);
    if (existing) {
      return existing;
    }

    // Map variantType to config
    const config = this.imageVariants.find(v => v.type === variantType);
    if (!config) {
      throw new Error(`Unsupported image variant: ${variantType}`);
    }

    const sourceBuffer = await this.s3Service.downloadBuffer(file.storageKey);
    const variant = await this.renderAndUploadImageVariant(file, config, sourceBuffer);
    return await this.storeVariant(file, variant);
  }

  /**
   * Ensure a sized IMAGE variant of a VIDEO — the same `w96`…`w2048`/`thumb`
   * sizes an image file offers, rendered from that video's poster frame.
   *
   * Why this exists: `getFileDownloadUrl(id, variant)` is a synchronous, purely
   * lexical URL builder, so a caller holding a bare file id CANNOT know whether
   * it addresses an image or a video. Before this, a size name was fatal for a
   * video — `assetService.ensureVariant` threw, and the public CDN origin turned
   * that into a 404 carrying no bytes at all, which is why a cached video
   * rendered a placeholder where an image rendered a thumbnail. A size name
   * therefore now means "an image of this asset at that size" for EVERY mime,
   * which for a video is its poster frame.
   *
   * Deriving from the poster rather than re-decoding holds this to ONE ffmpeg
   * pass per file however many sizes are requested: the poster is generated once
   * (or reused when upload-time generation already produced it) and each size is
   * a Sharp resize of those bytes. Generation stays LAZY — the first request for
   * a size materialises it, every later request is served the cached S3 object —
   * so the existing corpus needs no backfill.
   */
  async ensureVideoImageVariant(file: FileRecord, variantType: string): Promise<FileVariantRecord> {
    const existing = await this.getUsableReadyVariant(file, variantType);
    if (existing) {
      return existing;
    }

    const config = this.imageVariants.find(v => v.type === variantType);
    if (!config) {
      throw new Error(`Unsupported video image variant: ${variantType}`);
    }

    const poster = await this.ensureVideoPoster(file);
    const sourceBuffer = await this.s3Service.downloadBuffer(poster.key);
    const variant = await this.renderAndUploadImageVariant(file, config, sourceBuffer);
    return await this.storeVariant(file, variant);
  }
}
