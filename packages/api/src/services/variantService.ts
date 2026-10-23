import {
  IMAGE_VARIANTS,
  IMAGE_VARIANT_FORMAT,
  IMAGE_VARIANT_QUALITY,
  type ImageVariantName,
} from '@oxy.so/utils/image';
import {
  assertPhysicalStoragePathSupported,
  meteredOwnerId,
  uploadAdmittedVariant,
} from './storageQuota.service';
import type { S3Service } from './s3Service';
import {
  isServedPublicly,
  storageKeyForVisibility,
  HLS_MASTER_PLAYLIST_CACHE_CONTROL,
  IMMUTABLE_ASSET_CACHE_CONTROL,
} from '../config/cdn';
import { logger } from '../utils/logger';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
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
  findSameSpellingTwins,
  findVariantTwin,
  upsertVariantSet,
  rememberVideoStorageRoot,
  updateFile,
  upsertVariant,
} from './fileRepository';
import { playlistSiblingKey } from './hlsPlaylist';
import { isSvgType } from '../utils/svgSanitizer';
import { isIconContainer, largestIconFrame } from '../utils/icoImage';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { variantStorageRoot, videoStorageRoots } from '../utils/variant-storage-roots';
import { getCdnInvalidationQueue } from './cdnInvalidation';
import {
  hasCurrentVideoRenditions,
  videoDisplayDimensions,
  videoRungs,
  videoScaleFilter,
  VIDEO_RENDITION_PROFILE,
  VIDEO_SEGMENT_SECONDS,
  type VideoRung,
} from './video-renditions';
import {
  audioFfmpegTimeoutMs,
  audioMasterPlaylist,
  audioProfileOf,
  audioProfileSegment,
  audioProtocolWhitelist,
  AUDIO_HLS_SEGMENT_SECONDS,
  AUDIO_PREVIEW_FADE_SECONDS,
  AUDIO_SAMPLE_RATE,
  LOUDNORM_FILTER,
  measureBandwidth,
  mediaPlaylistSegments,
  previewStem,
  previewWindow,
  runFfmpeg,
  sameAudioProfile,
  selectAudioRungs,
  WaveformAccumulator,
  WAVEFORM_SAMPLE_RATE,
  type AudioProbe,
  type AudioProfile,
  type AudioRung,
} from './audioRenditions';

/**
 * `files.metadata` keys that describe the BYTES (written by generation from the
 * decode pass), as opposed to what an uploader or application said about its
 * row. Only these travel between rows for the same content.
 */
const INTRINSIC_METADATA_KEYS: ReadonlySet<string> = new Set(['media', 'image', 'video', 'audio']);

/** Cap on a preview clip's bytes buffered from ffmpeg (30 s of AAC is ~0.5 MiB). */
const AUDIO_PREVIEW_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const VIDEO_TRANSCODE_TIMEOUT_MS = 60 * 60_000;

/** Reuse only the current video encoder profile, or the same requested audio profile. */
function sameRenditionProfile(file: FileRecord, twin: FileRecord): boolean {
  if (file.mime.startsWith('video/')) return hasCurrentVideoRenditions(twin);
  if (!file.mime.startsWith('audio/')) return true;
  return sameAudioProfile(audioProfileOf(file), audioProfileOf(twin));
}

// FFprobe metadata interfaces for type safety
interface FFprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  sample_aspect_ratio?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
  channels?: number;
  bit_rate?: string;
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

// Get FFmpeg and FFprobe paths from the image first, then optional bundled binaries.
function getFfmpegPath(): string {
  try {
    const resolved = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    if (resolved) {
      logger.info('[VariantService] Using system ffmpeg', { binaryPath: resolved });
      return resolved;
    }
  } catch (error) {
    logger.debug('[VariantService] System ffmpeg is unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    // ffmpeg-static exports the path as a string directly
    // biome-ignore lint/style/noCommonJs: ffmpeg-static exports the path as a string directly
    const ffmpegStatic = require('ffmpeg-static');
    logger.debug('[VariantService] ffmpeg-static require result', {
      type: typeof ffmpegStatic,
      value: ffmpegStatic,
    });

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
      logger.warn('[VariantService] ffmpeg-static did not return a string', {
        type: typeof ffmpegStatic,
        value: ffmpegStatic,
      });
    }
  } catch (error) {
    logger.debug('[VariantService] ffmpeg-static is unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  logger.warn(
    '[VariantService] System ffmpeg not found in PATH - video processing may fail. Install with: apk add ffmpeg (or apt-get install ffmpeg)',
  );
  // Still return the bare command as a last resort - spawn will surface the error.
  return 'ffmpeg';
}

function getFfprobePath(): string {
  try {
    const resolved = execSync('which ffprobe', { encoding: 'utf8' }).trim();
    if (resolved) {
      logger.info('[VariantService] Using system ffprobe', { binaryPath: resolved });
      return resolved;
    }
  } catch (error) {
    logger.debug('[VariantService] System ffprobe is unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    // ffprobe-static exports an object with a path property
    // biome-ignore lint/style/noCommonJs: ffprobe-static exports an object with a path property
    const ffprobeStatic = require('ffprobe-static');
    logger.debug('[VariantService] ffprobe-static require result', {
      type: typeof ffprobeStatic,
      value: ffprobeStatic,
    });

    if (ffprobeStatic) {
      const binaryPath =
        typeof ffprobeStatic === 'string'
          ? ffprobeStatic
          : ffprobeStatic.path || ffprobeStatic.default;

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
        }
      } else {
        logger.warn('[VariantService] ffprobe-static did not provide a path');
      }
    }
  } catch (error) {
    logger.debug('[VariantService] ffprobe-static is unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  logger.warn(
    '[VariantService] System ffprobe not found in PATH - video metadata extraction may fail. Install with: apk add ffmpeg (or apt-get install ffmpeg)',
  );
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
    ffprobeExists: fs.existsSync(ffprobePath),
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
 * The largest image whose renditions are made. Sharp reads the original into
 * memory, so a large upload of a huge image (ADR 0043 stage 4b allows 8 GiB)
 * would take the task down; such an image is stored and served as it is, with
 * no renditions (and a size request for it falls back like any missing one).
 */
/**
 * How long ffmpeg/ffprobe may read a source through its presigned URL. They
 * stream it — the file is never downloaded whole — and reopen the URL with a
 * new Range whenever they seek, so the URL must outlive the longest transcode of
 * an 8 GiB upload, not just its start. Six hours: within what any signing
 * credential the worker may hold allows (a task role's session lasts six).
 */
export const MEDIA_SOURCE_URL_TTL_SECONDS = 6 * 60 * 60;

export const IMAGE_VARIANT_MAX_SOURCE_BYTES = 100 * 1024 * 1024;

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

/**
 * The spelling a file's renditions are written in: under `public/` only while
 * the file is SERVED publicly (public AND `active`, `config/cdn.isServedPublicly`),
 * exactly as its original's key is. A public file in trash or blocked (ADR
 * 0043 D5, D10) is not on the CDN, and a rendition generated for it must not
 * put it back there.
 */
/** The most pixels an SVG is rendered to, whatever its declared size (a sanitized SVG is still a decompression bomb candidate). */
const SVG_RENDER_PIXEL_LIMIT = 64_000_000;
/** librsvg's density bounds (dpi); 72 renders an SVG at its intrinsic size. */
const SVG_BASE_DENSITY = 72;
const SVG_MAX_DENSITY = 2400;

/**
 * Sharp's input options for a stored image. An SVG (always a sanitized one,
 * ADR 0043 stage 4c — it references nothing outside itself, and librsvg loads
 * nothing for an in-memory buffer) is a vector: given the rendition's
 * `targetWidth` it is rasterized at the density that draws it at that width,
 * so a 24-pixel icon renders a crisp 2048-pixel rendition rather than an
 * upscaled blur; the pixels rendered are bounded either way.
 */
function imageInputOptions(
  mime: string,
  render: { intrinsicWidth?: number; targetWidth?: number } = {},
): sharp.SharpOptions {
  if (!isSvgType(mime)) return { failOn: 'none' };
  const { intrinsicWidth, targetWidth } = render;
  const density =
    intrinsicWidth && targetWidth
      ? Math.min(SVG_MAX_DENSITY, Math.max(1, (SVG_BASE_DENSITY * targetWidth) / intrinsicWidth))
      : SVG_BASE_DENSITY;
  return { failOn: 'none', density, limitInputPixels: SVG_RENDER_PIXEL_LIMIT };
}

/**
 * A stored image no rendition can be made from: sharp cannot read it (an
 * unsupported or corrupt format, an icon with no usable frame). It is a fact
 * about the BYTES, so retrying never helps: the file is served as stored, like
 * an image over the rendition size bound, and a rendition asked of it resolves
 * to the original (`assetService.getPublicCdnUrl`).
 */
export class ImageNotRenderableError extends Error {
  constructor(
    readonly fileId: string,
    reason: string,
  ) {
    super(`Image cannot be rendered: ${reason}`);
    this.name = 'ImageNotRenderableError';
  }
}

/**
 * The image sharp renders for a stored original, and its metadata. An ICO/CUR
 * container (which libvips cannot read) is its largest frame
 * (`utils/icoImage.ts`); anything else is the stored bytes. A source sharp
 * cannot read is {@link ImageNotRenderableError}.
 */
async function renderableImageSource(
  file: Pick<FileRecord, 'id' | 'mime'>,
  stored: Buffer,
): Promise<{ source: Buffer; meta: sharp.Metadata }> {
  let source = stored;
  try {
    if (isIconContainer(stored)) {
      const frame = largestIconFrame(stored);
      source =
        frame.kind === 'png'
          ? frame.data
          : await sharp(frame.data, {
              raw: { width: frame.width, height: frame.height, channels: 4 },
            })
              .png()
              .toBuffer();
    }
    const meta = await sharp(source, imageInputOptions(file.mime)).metadata();
    return { source, meta };
  } catch (error) {
    // Both steps read only the bytes in hand: whatever they throw (an icon
    // with no usable frame, a format libvips has no loader for, a corrupt
    // header) is the same on every attempt.
    throw new ImageNotRenderableError(
      file.id,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function spellingOf(file: Pick<FileRecord, 'visibility' | 'status'>): FileVisibility {
  return isServedPublicly(file) ? 'public' : 'private';
}

export class VariantService {
  /**
   * The image ladder is `@oxy.so/utils/image`'s — the one every consumer asks
   * for by name (`?variant=`) — so the sizes rendered here cannot drift from
   * the names the apps and Clarity request.
   */
  private readonly imageVariants: VariantConfigWithType[] = (
    Object.keys(IMAGE_VARIANTS) as ImageVariantName[]
  ).map((type) => ({
    type,
    ...IMAGE_VARIANTS[type],
    quality: IMAGE_VARIANT_QUALITY,
    format: IMAGE_VARIANT_FORMAT,
  }));

  constructor(private s3Service: S3Service) {}

  /**
   * Persist a file's whole rendition set, together with any intrinsic metadata
   * derived from the SAME decode pass, as ONE transaction.
   *
   * There is no document version to conflict on and no retry loop:
   * `upsertVariantSet` is a single transaction, so a racing writer either sees
   * the whole previous set or the whole new one.
   *
   * The in-memory `file.variants` is merged by type to match what the
   * transaction did. A complete video replacement retires obsolete video tiers;
   * unrelated lazy image renditions remain available.
   */
  private async commitVariants(
    file: FileRecord,
    variants: NewFileVariant[],
    replaceVideoSet = false,
  ): Promise<void> {
    const rows = await upsertVariantSet(
      file.id,
      variants,
      file.metadata === undefined ? undefined : { metadata: file.metadata },
      { replaceVideoSet },
    );
    const written = new Set(rows.map((row) => row.type));
    file.variants = [
      ...file.variants.filter(
        (v) =>
          !written.has(v.type) &&
          !(
            replaceVideoSet &&
            (v.type.startsWith('hls_') || /^(360p|720p|1080p|source)$/.test(v.type))
          ),
      ),
      ...rows,
    ];
    if (replaceVideoSet && isServedPublicly(file))
      getCdnInvalidationQueue().enqueuePath(`/${file.id}`);
  }

  private async getUsableReadyVariant(
    file: FileRecord,
    variantType: string,
  ): Promise<FileVariantRecord | undefined> {
    const existing = file.variants.find((v) => v.type === variantType && v.readyAt);
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
   * Generate variants for a file.
   *
   * `reencode` encodes from the original even when a twin already has a set,
   * and then gives the new set to every live same-spelling twin. It is the
   * repair for renditions whose objects were lost: the twins name the same
   * content-addressed objects, so copying from one would copy the loss.
   */
  async generateVariants(
    fileId: string,
    { reencode = false }: { reencode?: boolean } = {},
  ): Promise<void> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        throw new Error('File not found');
      }

      const isVideo = file.mime.startsWith('video/');
      if (isVideo && file.status !== 'active') return;
      if (isVideo && !reencode && hasCurrentVideoRenditions(file)) {
        await this.shareVariantsWithTwins(file, { variantless: false, outdatedVideosOnly: true });
        return;
      }

      logger.info('Starting variant generation', {
        fileId,
        mime: file.mime,
        size: file.size,
      });

      // Rows are per owner and share content-addressed storage: another live
      // row with these bytes whose renditions are already the spelling this
      // row's visibility needs gives them to this row without re-encoding.
      const existingFile = reencode
        ? null
        : await findVariantTwin(
            file.sha256,
            file.id,
            spellingOf(file),
            isVideo ? VIDEO_RENDITION_PROFILE : undefined,
          );

      if (
        existingFile &&
        existingFile.variants.length > 0 &&
        // An audio twin processed differently (loudness, preview start) has a
        // different set: this row renders its own (`audioRenditions.ts`).
        sameRenditionProfile(file, existingFile)
      ) {
        await this.copyVariantSet(existingFile, file);
        if (isVideo)
          await this.shareVariantsWithTwins(file, { variantless: false, outdatedVideosOnly: true });
        logger.info('Reused existing variants for duplicate content', {
          fileId,
          sourceFileId: existingFile.id,
          variantCount: existingFile.variants.length,
        });
        return;
      }

      // Generate new variants based on file type
      if (file.mime.startsWith('image/')) {
        if (file.size <= IMAGE_VARIANT_MAX_SOURCE_BYTES) {
          try {
            await this.generateImageVariants(file);
          } catch (error) {
            // Not a failure to retry: the bytes cannot be rendered, now or on
            // any attempt, so the job completes and the file is served as stored.
            if (!(error instanceof ImageNotRenderableError)) throw error;
            logger.info('Image cannot be rendered; served as stored', {
              fileId,
              mime: file.mime,
              reason: error.message,
            });
            return;
          }
        } else
          logger.info('Image too large for renditions; served as stored', {
            fileId,
            size: file.size,
          });
      } else if (file.mime.startsWith('video/')) {
        await this.generateVideoVariants(file);
      } else if (file.mime.startsWith('audio/')) {
        await this.generateAudioVariants(file);
      } else if (file.mime === 'application/pdf') {
        await this.generatePdfVariants(file);
      }

      logger.info('Variant generation completed', {
        fileId,
        variantCount: file.variants.length,
      });

      await this.shareVariantsWithTwins(file, {
        variantless: !reencode && !isVideo,
        outdatedVideosOnly: isVideo && !reencode,
      });
    } catch (error) {
      logger.error('Error generating variants:', error);
      throw error;
    }
  }

  /**
   * Point `target` at `source`'s renditions. The rows are copied as NEW rows —
   * `id` and `file_id` belong to the source — and name the SAME objects, so no
   * byte is encoded twice; INTRINSIC metadata (dimensions, duration) comes
   * along, since it describes the same bytes.
   *
   * Only intrinsic metadata: the source is usually ANOTHER owner's row, and its
   * application metadata (`source`, `serviceAppId`, …) is what the federated
   * delete route authorizes by — copying it would hand a different application
   * delete authority over this row.
   */
  private async copyVariantSet(source: FileRecord, target: FileRecord): Promise<void> {
    const storageRoots = source.mime.startsWith('video/')
      ? [
          ...new Set([
            ...videoStorageRoots(
              source,
              source.variants.map((variant) => variant.key),
            ),
            ...videoStorageRoots(
              target,
              target.variants.map((variant) => variant.key),
            ),
          ]),
        ]
      : [];
    const intrinsic = Object.fromEntries(
      Object.entries(source.metadata ?? {}).filter(([key]) => INTRINSIC_METADATA_KEYS.has(key)),
    );
    if (Object.keys(intrinsic).length > 0) {
      target.metadata = { ...(target.metadata ?? {}), ...intrinsic };
      if (storageRoots.length > 0)
        target.metadata.video = {
          ...(source.metadata?.video as Record<string, unknown>),
          storageRoots,
        };
    }
    await this.commitVariants(
      target,
      source.variants.map((variant) => ({
        type: variant.type,
        key: variant.key,
        width: variant.width,
        height: variant.height,
        readyAt: variant.readyAt,
        size: variant.size,
        metadata: variant.metadata,
      })),
      source.mime.startsWith('video/') && hasCurrentVideoRenditions(source),
    );
  }

  /**
   * Hand a freshly generated rendition set to the other live rows for the same
   * bytes that need the same spelling. After an upload (`variantless`) that is
   * the owners who uploaded the same content while this generation was running
   * and have none yet, whose own queued jobs then find the set already there.
   * Video jobs also upgrade legacy twins; current twins remain untouched unless
   * an explicit re-encode replaces every such twin (see `generateVariants`).
   * Best-effort: a twin that misses out generates (or copies) on its own job.
   */
  private async shareVariantsWithTwins(
    file: FileRecord,
    twins: { variantless: boolean; outdatedVideosOnly?: boolean },
  ): Promise<void> {
    if (file.variants.length === 0) return;
    try {
      for (const twin of await findSameSpellingTwins(
        file.sha256,
        file.id,
        spellingOf(file),
        twins,
      )) {
        if (!sameRenditionProfile(twin, file)) continue;
        if (twins.outdatedVideosOnly && hasCurrentVideoRenditions(twin)) continue;
        await this.copyVariantSet(file, twin);
      }
    } catch (error) {
      logger.warn('Could not share generated variants with content twins', {
        fileId: file.id,
        error: error instanceof Error ? error.message : String(error),
      });
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
      !!media.width && !!media.height && (!isVideo || typeof media.durationSec === 'number');
    if (mediaComplete) {
      return 'skipped';
    }

    let durationSec = resolved.durationSec;
    if (isVideo && durationSec === undefined && file.storageKey) {
      try {
        const videoUrl = await this.s3Service.getPresignedDownloadUrl(
          file.storageKey,
          MEDIA_SOURCE_URL_TTL_SECONDS,
        );
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
      const videoUrl = await this.s3Service.getPresignedDownloadUrl(
        file.storageKey,
        MEDIA_SOURCE_URL_TTL_SECONDS,
      );
      const probed = await this.extractVideoMetadataFromUrl(videoUrl);
      const width = typeof probed.width === 'number' && probed.width > 0 ? probed.width : undefined;
      const height =
        typeof probed.height === 'number' && probed.height > 0 ? probed.height : undefined;
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
      if (file.size > IMAGE_VARIANT_MAX_SOURCE_BYTES) return false;
      const originalBuffer = await this.s3Service.downloadBuffer(file.storageKey);
      let meta: sharp.Metadata;
      try {
        ({ meta } = await renderableImageSource(file, originalBuffer));
      } catch (error) {
        if (error instanceof ImageNotRenderableError) return false;
        throw error;
      }
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

      const { source: originalBuffer, meta } = await renderableImageSource(
        file,
        await this.s3Service.downloadBuffer(file.storageKey),
      );

      // Only renditions generated by THIS run are committed; a reused ready row
      // keeps its id instead of being deleted and reinserted.
      const variants: NewFileVariant[] = [];
      let reused = 0;
      for (const config of this.imageVariants) {
        const existing = await this.getUsableReadyVariant(file, config.type);
        if (existing) {
          reused++;
          continue;
        }
        const variantKey = this.generateVariantKey(
          file.sha256,
          config.type,
          config.format || 'webp',
          spellingOf(file),
        );

        const width = config.width || meta.width || 1280;
        const height = config.height; // let sharp maintain aspect by only setting width unless both provided
        let pipeline = sharp(
          originalBuffer,
          imageInputOptions(file.mime, { intrinsicWidth: meta.width, targetWidth: width }),
        ).rotate();
        pipeline = pipeline.resize({ width, height, fit: 'inside', withoutEnlargement: true });

        // Set format and quality
        const format = config.format || 'webp';
        if (format === 'webp') pipeline = pipeline.webp({ quality: config.quality ?? 82 });
        if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: config.quality ?? 82 });
        if (format === 'png') pipeline = pipeline.png();

        const out = await pipeline.toBuffer();
        const variant = await uploadAdmittedVariant(
          file,
          {
            type: config.type,
            key: variantKey,
            width,
            height: height || Math.round((meta.height || width) * (width / (meta.width || width))),
            readyAt: new Date(),
            size: out.length,
            metadata: { format, quality: config.quality },
          },
          (key) =>
            this.s3Service.uploadBuffer(key, out, {
              contentType: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
              cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
            }),
          (key) => this.s3Service.deleteFile(key),
        );
        variants.push(variant);

        logger.debug('Generated image variant', {
          fileId: file.id,
          type: config.type,
          key: variantKey,
        });
      }

      if (meta.width && meta.height) {
        file.metadata = {
          ...(file.metadata ?? {}),
          image: { width: meta.width, height: meta.height },
        };
        applyCanonicalMediaMetadata(file, { width: meta.width, height: meta.height });
      }

      await this.commitVariants(file, variants);

      logger.info('Image variants generated', {
        fileId: file.id,
        variantCount: variants.length,
        reused,
      });
    } catch (error) {
      if (!(error instanceof ImageNotRenderableError)) {
        logger.error('Error generating image variants:', error);
      }
      throw error;
    }
  }

  /**
   * Generate video variants with FFmpeg
   * Generates poster frame, multiple bitrate variants, and HLS streams
   */
  private async generateVideoVariants(file: FileRecord): Promise<void> {
    await assertPhysicalStoragePathSupported(await meteredOwnerId(file), 'generateVideoVariants');
    const videoUrl = await this.s3Service.getPresignedDownloadUrl(
      file.storageKey,
      MEDIA_SOURCE_URL_TTL_SECONDS,
    );
    const metadata = await this.extractVideoMetadataFromUrl(videoUrl);
    if (!metadata.width || !metadata.height) throw new Error(`Cannot probe video ${file.id}`);
    const rungs = videoRungs({ width: metadata.width, height: metadata.height });
    // A generation never overwrites playable objects, even when a retry fails halfway.
    const profile = `${VIDEO_RENDITION_PROFILE}/${randomUUID()}`;
    const storageRoots = videoStorageRoots(
      file,
      file.variants.map((variant) => variant.key),
    );
    const root =
      storageRoots[0] ??
      variantStorageRoot(
        this.generateVariantKey(file.sha256, 'hls_master', 'm3u8', spellingOf(file), profile),
        file.sha256,
      );
    if (!root) throw new Error(`Cannot resolve video storage root for ${file.id}`);
    if (storageRoots.length === 0) {
      // Even an upload that fails before publication must follow deletion/visibility policy.
      await rememberVideoStorageRoot(file.id, root);
      storageRoots.push(root);
    }
    const variants: NewFileVariant[] = [];
    const posterTime = Math.min(1, (metadata.duration || 60) * 0.1);
    variants.push(
      await this.generatePosterFrame(
        file.storageKey,
        file.sha256,
        posterTime,
        spellingOf(file),
        metadata,
        profile,
        root,
      ),
    );
    variants.push(
      ...(await this.generateVideoRenditions(
        videoUrl,
        file.sha256,
        rungs,
        spellingOf(file),
        profile,
        root,
      )),
    );
    file.metadata = {
      ...file.metadata,
      video: {
        ...metadata,
        storageRoots: videoStorageRoots(file, [
          ...storageRoots,
          ...variants.map((variant) => variant.key),
        ]),
      },
    };
    applyCanonicalMediaMetadata(file, {
      width: metadata.width,
      height: metadata.height,
      durationSec: metadata.duration,
    });
    // Nothing is visible until every rendition, segment and playlist is uploaded.
    await this.commitVariants(file, variants, true);
    logger.info('Video rendition set generated', {
      fileId: file.id,
      profile,
      variantCount: variants.length,
    });
  }

  /**
   * Audio renditions (ADR 0043 stage 4c, `audioRenditions.ts`): an audio-only
   * AAC HLS ladder (`hls_a64` always, `hls_a128`/`hls_a256` when the source
   * carries that much), its `hls_master`, a `waveform` of peaks and a 30-second
   * `preview` clip — loudness-normalized (EBU R128) when the owner asked for it
   * (`files.metadata.audioOptions.normalizeLoudness`), in a key directory of
   * its own so it never overwrites a plain ladder of the same bytes.
   *
   * Like video (issue #759): one rung failing does not lose the others, what
   * did encode is committed, and the job fails AFTER the commit when every
   * rung failed, so the loss is visible and retried. A waveform or preview
   * failure is logged and does not fail a job whose ladder encoded.
   */
  private async generateAudioVariants(file: FileRecord): Promise<void> {
    await assertPhysicalStoragePathSupported(await meteredOwnerId(file), 'generateAudioVariants');
    logger.info('Generating audio variants with FFmpeg', { fileId: file.id });

    const probe = await this.probeAudio(
      await this.s3Service.getPresignedDownloadUrl(file.storageKey, MEDIA_SOURCE_URL_TTL_SECONDS),
    );
    if (!probe) {
      throw new Error(`No audio stream could be read from file ${file.id}`);
    }

    const profile = audioProfileOf(file);
    const visibility = spellingOf(file);
    const segment = audioProfileSegment(profile);
    const rungs = selectAudioRungs(probe);
    const variants: NewFileVariant[] = [];
    const renditions: Array<{ playlistKey: string; bandwidth: number; averageBandwidth: number }> =
      [];
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oxy-audio-'));
    try {
      for (const rung of rungs) {
        try {
          const produced = await this.encodeAudioRung(file, rung, probe, profile, tempDir);
          if (produced) {
            variants.push(produced.variant);
            renditions.push(produced.rendition);
          }
        } catch (error) {
          logger.error('Audio HLS rendition failed', {
            fileId: file.id,
            variant: rung.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (renditions.length > 0) {
        const masterKey = this.generateVariantKey(
          file.sha256,
          'hls_master',
          'm3u8',
          visibility,
          segment,
        );
        await this.s3Service.uploadBuffer(masterKey, Buffer.from(audioMasterPlaylist(renditions)), {
          contentType: 'application/vnd.apple.mpegurl',
          cacheControl: HLS_MASTER_PLAYLIST_CACHE_CONTROL,
        });
        variants.push({
          type: 'hls_master',
          key: masterKey,
          readyAt: new Date(),
          metadata: {
            format: 'hls',
            kind: 'audio',
            codecs: 'mp4a.40.2',
            variantCount: renditions.length,
            variants: variants.filter((v) => v.type.startsWith('hls_a')).map((v) => v.type),
            loudnessNormalized: profile.normalizeLoudness,
          },
        });
      }

      try {
        variants.push(await this.generateWaveform(file, probe, profile));
      } catch (error) {
        logger.warn('Audio waveform failed', {
          fileId: file.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        variants.push(await this.generateAudioPreview(file, probe, profile));
      } catch (error) {
        logger.warn('Audio preview failed', {
          fileId: file.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }

    file.metadata = {
      ...(file.metadata ?? {}),
      audio: {
        ...(probe.duration !== undefined ? { duration: probe.duration } : {}),
        ...(probe.codec ? { codec: probe.codec } : {}),
        ...(probe.sampleRate ? { sampleRate: probe.sampleRate } : {}),
        ...(probe.channels ? { channels: probe.channels } : {}),
        ...(probe.bitrate ? { bitrate: probe.bitrate } : {}),
      },
    };
    applyCanonicalMediaMetadata(file, { durationSec: probe.duration });

    await this.commitVariants(file, variants);

    if (renditions.length === 0) {
      throw new Error(
        `All ${rungs.length} audio HLS rendition(s) failed to encode for file ${file.id}`,
      );
    }
    logger.info('Audio variants generated', {
      fileId: file.id,
      rungs: renditions.length,
      variantCount: variants.length,
      loudnessNormalized: profile.normalizeLoudness,
    });
  }

  /** ffprobe the source's first audio stream; `null` when it has none or cannot be read. */
  private async probeAudio(audioUrl: string): Promise<AudioProbe | null> {
    this.validateMediaPath(audioUrl);
    let stdout = '';
    const result = await new Promise<number | null>((resolve) => {
      const child = spawn(
        ffprobePath,
        [
          '-v',
          'quiet',
          '-protocol_whitelist',
          audioProtocolWhitelist(audioUrl),
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          audioUrl,
        ],
        { timeout: 60_000, killSignal: 'SIGKILL' },
      );
      child.stdout.on('data', (data: Buffer) => {
        if (stdout.length < 1024 * 1024) stdout += data.toString();
      });
      child.on('close', (code) => resolve(code));
      child.on('error', () => resolve(-1));
    });
    if (result !== 0) {
      logger.warn('FFprobe failed for audio', { code: result });
      return null;
    }
    try {
      const metadata = JSON.parse(stdout) as FFprobeMetadata;
      const stream = metadata.streams?.find((s) => s.codec_type === 'audio');
      if (!stream) return null;
      const positive = (value: string | number | undefined) => {
        const parsed = typeof value === 'number' ? value : Number.parseFloat(value ?? '');
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      };
      const duration = positive(metadata.format?.duration);
      const streamBitrate = positive(stream.bit_rate);
      // The container's rate counts cover art too: only when the stream says nothing.
      const bitrate = streamBitrate ?? positive(metadata.format?.bit_rate);
      return {
        ...(duration !== undefined ? { duration } : {}),
        ...(stream.codec_name ? { codec: stream.codec_name } : {}),
        ...(positive(stream.sample_rate) ? { sampleRate: positive(stream.sample_rate) } : {}),
        ...(positive(stream.channels) ? { channels: positive(stream.channels) } : {}),
        ...(bitrate !== undefined ? { bitrate: Math.round(bitrate) } : {}),
      };
    } catch (error) {
      logger.warn('Error parsing FFprobe output for audio', { error });
      return null;
    }
  }

  /** The ffmpeg audio-output options every audio rendition shares. */
  private audioOutputArgs(probe: AudioProbe, filters: string[]): string[] {
    const channels = probe.channels ? Math.min(probe.channels, 2) : 2;
    return [
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-c:a',
      'aac',
      '-ac',
      String(channels),
      '-ar',
      String(AUDIO_SAMPLE_RATE),
      ...(filters.length > 0 ? ['-af', filters.join(',')] : []),
    ];
  }

  /** The ffmpeg input options: a fresh presigned URL, protocols restricted to its own scheme. */
  private async audioInputArgs(file: FileRecord, seekSeconds = 0): Promise<string[]> {
    const url = await this.s3Service.getPresignedDownloadUrl(
      file.storageKey,
      MEDIA_SOURCE_URL_TTL_SECONDS,
    );
    this.validateMediaPath(url);
    return [
      '-loglevel',
      'error',
      '-nostdin',
      '-protocol_whitelist',
      audioProtocolWhitelist(url),
      ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
      '-i',
      url,
    ];
  }

  /**
   * Encode one rung of the audio ladder into `tempDir`, then upload its
   * segments (each next to its playlist, under the name the playlist lists)
   * and the playlist last, so a stored playlist never lists a missing segment.
   * `null` when ffmpeg fails.
   */
  private async encodeAudioRung(
    file: FileRecord,
    rung: AudioRung,
    probe: AudioProbe,
    profile: AudioProfile,
    tempDir: string,
  ): Promise<{
    variant: NewFileVariant;
    rendition: { playlistKey: string; bandwidth: number; averageBandwidth: number };
  } | null> {
    const rungDir = path.join(tempDir, rung.type);
    await fs.promises.mkdir(rungDir, { recursive: true });
    const playlistPath = path.join(rungDir, 'stream.m3u8');
    const run = await runFfmpeg(
      ffmpegPath,
      [
        ...(await this.audioInputArgs(file)),
        ...this.audioOutputArgs(probe, profile.normalizeLoudness ? [LOUDNORM_FILTER] : []),
        '-profile:a',
        'aac_low',
        '-b:a',
        rung.bitrate,
        '-f',
        'hls',
        '-hls_time',
        String(AUDIO_HLS_SEGMENT_SECONDS),
        '-hls_playlist_type',
        'vod',
        '-hls_list_size',
        '0',
        '-hls_segment_type',
        'mpegts',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_filename',
        path.join(rungDir, `${rung.segmentStem}_%03d.ts`),
        '-y',
        playlistPath,
      ],
      { timeoutMs: audioFfmpegTimeoutMs(probe.duration) },
    );
    if (run.code !== 0) {
      logger.error('Audio HLS rendition failed to encode', {
        fileId: file.id,
        variant: rung.type,
        code: run.code,
        signal: run.signal,
        timedOut: run.timedOut,
        error: run.stderrTail.slice(-500),
      });
      return null;
    }

    const visibility = spellingOf(file);
    const playlistKey = this.generateVariantKey(
      file.sha256,
      rung.type,
      'm3u8',
      visibility,
      audioProfileSegment(profile),
    );
    // URIs as basenames: a segment is its playlist's sibling (RFC 8216 §4.3.4.2).
    const playlist = (await fs.promises.readFile(playlistPath, 'utf8'))
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('#') ? path.basename(trimmed) : line;
      })
      .join('\n');
    const segments = mediaPlaylistSegments(playlist);
    if (segments.length === 0) {
      logger.error('Audio HLS rendition produced no segments', {
        fileId: file.id,
        variant: rung.type,
      });
      return null;
    }
    const measured: Array<{ duration: number; bytes: number }> = [];
    for (const segment of segments) {
      const bytes = await fs.promises.readFile(path.join(rungDir, segment.uri));
      await this.s3Service.uploadBuffer(playlistSiblingKey(playlistKey, segment.uri), bytes, {
        contentType: 'video/mp2t',
        cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
      });
      measured.push({ duration: segment.duration, bytes: bytes.length });
      await fs.promises.unlink(path.join(rungDir, segment.uri)).catch(() => undefined);
    }
    await this.s3Service.uploadBuffer(playlistKey, Buffer.from(playlist), {
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });
    const bandwidth = measureBandwidth(measured, rung.bitsPerSecond);
    return {
      variant: {
        type: rung.type,
        key: playlistKey,
        readyAt: new Date(),
        metadata: {
          format: 'hls',
          kind: 'audio',
          bitrate: rung.bitrate,
          bandwidth: bandwidth.peak,
          averageBandwidth: bandwidth.average,
          codec: 'aac',
          codecs: 'mp4a.40.2',
          segments: segments.length,
          loudnessNormalized: profile.normalizeLoudness,
        },
      },
      rendition: {
        playlistKey,
        bandwidth: bandwidth.peak,
        averageBandwidth: bandwidth.average,
      },
    };
  }

  /**
   * The `waveform` variant: audiowaveform-format JSON peaks, decoded to mono
   * 8 kHz PCM through a pipe and folded into buckets as it arrives — the PCM
   * is never held whole.
   */
  private async generateWaveform(
    file: FileRecord,
    probe: AudioProbe,
    profile: AudioProfile,
  ): Promise<NewFileVariant> {
    const accumulator = new WaveformAccumulator(probe.duration);
    const run = await runFfmpeg(
      ffmpegPath,
      [
        ...(await this.audioInputArgs(file)),
        '-map',
        '0:a:0',
        '-vn',
        ...(profile.normalizeLoudness ? ['-af', LOUDNORM_FILTER] : []),
        '-ac',
        '1',
        '-ar',
        String(WAVEFORM_SAMPLE_RATE),
        '-acodec',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1',
      ],
      {
        timeoutMs: audioFfmpegTimeoutMs(probe.duration),
        onStdout: (chunk) => accumulator.push(chunk),
      },
    );
    if (run.code !== 0) {
      throw new Error(`Waveform decode failed (code ${run.code}): ${run.stderrTail.slice(-200)}`);
    }
    const waveform = accumulator.finish();
    if (waveform.length === 0) throw new Error('Waveform decode produced no samples');
    const body = Buffer.from(JSON.stringify(waveform));
    const key = this.generateVariantKey(
      file.sha256,
      'waveform',
      'json',
      spellingOf(file),
      audioProfileSegment(profile),
    );
    await this.s3Service.uploadBuffer(key, body, {
      contentType: 'application/json',
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });
    return {
      type: 'waveform',
      key,
      readyAt: new Date(),
      size: body.length,
      metadata: {
        format: 'json',
        peaks: waveform.length,
        samplesPerPeak: waveform.samplesPerPeak,
        sampleRate: WAVEFORM_SAMPLE_RATE,
        loudnessNormalized: profile.normalizeLoudness,
      },
    };
  }

  /**
   * The `preview` variant: 30 seconds of AAC 128 kb/s in fragmented mp4 from
   * `audioOptions.previewStartSeconds` (clamped so a whole clip fits; the whole
   * file when shorter), fading out over its last 2 s when it cuts the audio.
   */
  private async generateAudioPreview(
    file: FileRecord,
    probe: AudioProbe,
    profile: AudioProfile,
  ): Promise<NewFileVariant> {
    const window = previewWindow(probe.duration, profile.previewStartSeconds);
    const filters = [
      ...(profile.normalizeLoudness ? [LOUDNORM_FILTER] : []),
      ...(window.truncated
        ? [
            `afade=t=out:st=${Math.max(0, window.durationSeconds - AUDIO_PREVIEW_FADE_SECONDS)}:d=${AUDIO_PREVIEW_FADE_SECONDS}`,
          ]
        : []),
    ];
    const chunks: Buffer[] = [];
    const run = await runFfmpeg(
      ffmpegPath,
      [
        ...(await this.audioInputArgs(file, window.startSeconds)),
        '-t',
        String(window.durationSeconds),
        ...this.audioOutputArgs(probe, filters),
        '-b:a',
        '128k',
        '-movflags',
        'frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ],
      {
        timeoutMs: audioFfmpegTimeoutMs(probe.duration),
        maxStdoutBytes: AUDIO_PREVIEW_MAX_OUTPUT_BYTES,
        onStdout: (chunk) => chunks.push(chunk),
      },
    );
    if (run.overflowed) throw new Error('Preview output exceeded the maximum allowed size');
    if (run.code !== 0) {
      throw new Error(`Preview encode failed (code ${run.code}): ${run.stderrTail.slice(-200)}`);
    }
    const body = Buffer.concat(chunks);
    if (body.length === 0) throw new Error('Preview encode produced no bytes');
    const key = this.generateVariantKey(
      file.sha256,
      previewStem(window.startSeconds),
      'm4a',
      spellingOf(file),
      audioProfileSegment(profile),
    );
    await this.s3Service.uploadBuffer(key, body, {
      contentType: 'audio/mp4',
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });
    return {
      type: 'preview',
      key,
      readyAt: new Date(),
      size: body.length,
      metadata: {
        format: 'm4a',
        codec: 'aac',
        bitrate: '128k',
        startSeconds: window.startSeconds,
        durationSeconds: window.durationSeconds,
        loudnessNormalized: profile.normalizeLoudness,
      },
    };
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
    metadata?: { width?: number; height?: number },
    profile?: string,
    root?: string,
  ): Promise<NewFileVariant> {
    const posterKey = this.generateVariantKey(sha256, 'poster', 'jpg', visibility, profile, root);

    // Get S3 presigned URL for the video (FFmpeg supports HTTP input)
    const videoUrl = await this.s3Service.getPresignedDownloadUrl(
      videoStorageKey,
      MEDIA_SOURCE_URL_TTL_SECONDS,
    );

    // Extract metadata if not provided (using S3 URL)
    if (!metadata?.width || !metadata.height) {
      metadata = await this.extractVideoMetadataFromUrl(videoUrl);
    }

    const videoWidth = metadata.width || 1920;
    const videoHeight = metadata.height || 1080;
    const aspectRatio = videoWidth / videoHeight;
    const scale = Math.min(1, 1920 / videoWidth, 1920 / videoHeight);
    const scaleFilter = videoScaleFilter({
      width: Math.max(1, Math.round(videoWidth * scale)),
      height: Math.max(1, Math.round(videoHeight * scale)),
    });

    return new Promise((resolve, reject) => {
      // Generate poster with scaling to max 1920px while maintaining exact aspect ratio
      // Stream output directly to stdout (memory) - no temp files
      const args = [
        // Global options must precede `-i`. `-nostdin` so a decode can never
        // block waiting on a stdin that will never be written, and the protocol
        // whitelist so a crafted container cannot make ffmpeg open a local file
        // or an unrelated network target (see `posterProtocolWhitelist`).
        '-loglevel',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        posterProtocolWhitelist(videoUrl),
        '-i',
        videoUrl, // Use S3 presigned URL directly
        '-ss',
        timeSeconds.toString(),
        '-vframes',
        '1',
        '-vf',
        scaleFilter,
        '-q:v',
        '2',
        '-f',
        'image2pipe', // Output to pipe
        '-vcodec',
        'mjpeg', // JPEG format for pipe
        'pipe:1', // Output to stdout
      ];

      // Only verify absolute paths — a bare `ffmpeg` command is resolved via PATH at spawn time.
      if (path.isAbsolute(ffmpegPath) && !fs.existsSync(ffmpegPath)) {
        reject(
          new Error(
            `FFmpeg binary not found at path: ${ffmpegPath}. Please install ffmpeg-static or ensure system ffmpeg is available.`,
          ),
        );
        return;
      }

      logger.debug('Spawning ffmpeg process for poster from S3', {
        path: ffmpegPath,
        videoUrl: videoUrl.substring(0, 50) + '...',
        videoWidth,
        videoHeight,
        aspectRatio,
        scaleFilter,
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
          // The LAST bytes, not the first: ffmpeg's fixed version/build-config
          // banner alone fills 500 characters, so `.substring(0, N)` always
          // logged the banner and never the fatal error that follows it.
          logger.error('Poster generation failed', { code, signal, stderr: stderr.slice(-500) });
          if (code === null) {
            reject(
              new Error(
                `Poster generation aborted after ${POSTER_FFMPEG_TIMEOUT_MS}ms (signal ${String(signal)})`,
              ),
            );
            return;
          }
          reject(new Error(`Poster generation failed with code ${code}: ${stderr.slice(-200)}`));
          return;
        }

        try {
          // Get poster from stdout (no temp file needed)
          const posterBuffer = Buffer.concat(stdoutChunks);

          // Optimize poster with Sharp (no resize, just optimize)
          const optimized = await sharp(posterBuffer).jpeg({ quality: 85 }).toBuffer();

          // Upload to S3
          await this.s3Service.uploadBuffer(posterKey, optimized, {
            contentType: 'image/jpeg',
            cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
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
              videoHeight,
            },
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
          '-v',
          'quiet',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          videoUrl,
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
            logger.warn('FFprobe failed from URL', {
              code,
              stderr: stderr.replaceAll(videoUrl, '[source]'),
            });
            resolve({});
            return;
          }

          try {
            const metadata = JSON.parse(stdout) as FFprobeMetadata;

            const videoStream = metadata.streams?.find((s) => s.codec_type === 'video');
            const audioStream = metadata.streams?.find((s) => s.codec_type === 'audio');

            resolve({
              duration: metadata.format?.duration
                ? Number.parseFloat(metadata.format.duration)
                : undefined,
              ...videoDisplayDimensions(videoStream ?? {}),
              bitrate: metadata.format?.bit_rate
                ? Number.parseInt(metadata.format.bit_rate)
                : undefined,
              fps: videoStream?.r_frame_rate ? this.parseFps(videoStream.r_frame_rate) : undefined,
              codec: videoStream?.codec_name,
              audioCodec: audioStream?.codec_name,
            });
          } catch (error) {
            logger.warn('Error parsing FFprobe output from URL', { error });
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
   * Writes a seekable temporary MP4 so faststart can place its index first, then streams the upload.
   */
  private async generateVideoVariant(
    videoUrl: string,
    sha256: string,
    rung: VideoRung,
    visibility: FileVisibility,
    profile: string,
    root?: string,
  ): Promise<NewFileVariant> {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oxy-video-'));
    try {
      return await this.encodeAndUploadVideoVariant(
        videoUrl,
        path.join(tempDir, 'video.mp4'),
        sha256,
        rung,
        visibility,
        profile,
        root,
      );
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  /** Encode once; the caller owns the local MP4 until HLS remuxing or upload completes. */
  private async encodeAndUploadVideoVariant(
    videoUrl: string,
    outputPath: string,
    sha256: string,
    rung: VideoRung,
    visibility: FileVisibility,
    profile: string,
    root?: string,
  ): Promise<NewFileVariant> {
    const run = await runFfmpeg(
      ffmpegPath,
      [
        '-i',
        videoUrl,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-b:v',
        rung.bitrate,
        '-preset',
        rung.preset,
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        videoScaleFilter(rung),
        '-sc_threshold',
        '0',
        '-flags',
        '+cgop',
        '-force_key_frames',
        `expr:gte(t,n_forced*${VIDEO_SEGMENT_SECONDS})`,
        '-movflags',
        '+faststart',
        '-avoid_negative_ts',
        'make_zero',
        '-y',
        outputPath,
      ],
      { timeoutMs: VIDEO_TRANSCODE_TIMEOUT_MS },
    );
    if (run.code !== 0)
      throw new Error(
        `Video ${rung.type} failed: ${run.stderrTail.replaceAll(videoUrl, '[source]')}`,
      );
    const key = this.generateVariantKey(sha256, rung.type, 'mp4', visibility, profile, root);
    await this.s3Service.uploadFile(key, outputPath, {
      contentType: 'video/mp4',
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });
    const stat = await fs.promises.stat(outputPath);
    return {
      type: rung.type,
      key,
      width: rung.width,
      height: rung.height,
      readyAt: new Date(),
      size: stat.size,
      metadata: {
        bitrate: rung.bitrate,
        format: 'mp4',
        encodingProfile: VIDEO_RENDITION_PROFILE,
      },
    };
  }

  /** Encode each rung once, remux its MP4 to HLS, and publish the master last. */
  private async generateVideoRenditions(
    videoUrl: string,
    sha256: string,
    rungs: VideoRung[],
    visibility: FileVisibility,
    profile: string,
    root?: string,
  ): Promise<NewFileVariant[]> {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oxy-hls-'));
    const variants: NewFileVariant[] = [];
    const masterRenditions: Array<{ resolution: string; bitrate: string; playlist: string }> = [];
    try {
      for (const rung of rungs) {
        const encodedPath = path.join(tempDir, `video_${rung.type}.mp4`);
        variants.push(
          await this.encodeAndUploadVideoVariant(
            videoUrl,
            encodedPath,
            sha256,
            rung,
            visibility,
            profile,
            root,
          ),
        );
        const outputPath = path.join(tempDir, `stream_${rung.type}.m3u8`);
        const run = await runFfmpeg(
          ffmpegPath,
          [
            '-i',
            encodedPath,
            '-map',
            '0:v:0',
            '-map',
            '0:a:0?',
            '-c',
            'copy',
            '-f',
            'hls',
            '-hls_time',
            String(VIDEO_SEGMENT_SECONDS),
            '-hls_playlist_type',
            'vod',
            '-hls_list_size',
            '0',
            '-hls_flags',
            'independent_segments',
            '-hls_segment_filename',
            path.join(tempDir, `segment_${rung.type}_%03d.ts`),
            '-y',
            outputPath,
          ],
          { timeoutMs: VIDEO_TRANSCODE_TIMEOUT_MS },
        );
        if (run.code !== 0) throw new Error(`Video HLS ${rung.type} failed: ${run.stderrTail}`);
        await fs.promises.unlink(encodedPath);
        const playlist = await fs.promises.readFile(outputPath);
        const key = this.generateVariantKey(
          sha256,
          `hls_${rung.type}`,
          'm3u8',
          visibility,
          profile,
          root,
        );
        const segments = mediaPlaylistSegments(playlist.toString());
        if (segments.length === 0) throw new Error(`Video HLS ${rung.type} has no segments`);
        const segmentMetrics: Array<{ duration: number; bytes: number }> = [];
        for (const segment of segments) {
          const segmentPath = path.join(tempDir, segment.uri);
          const stat = await fs.promises.stat(segmentPath);
          segmentMetrics.push({ duration: segment.duration, bytes: stat.size });
          await this.s3Service.uploadFile(playlistSiblingKey(key, segment.uri), segmentPath, {
            contentType: 'video/mp2t',
            cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
          });
          await fs.promises.unlink(segmentPath);
        }
        await this.s3Service.uploadBuffer(key, playlist, {
          contentType: 'application/vnd.apple.mpegurl',
          cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
        });
        variants.push({
          type: `hls_${rung.type}`,
          key,
          width: rung.width,
          height: rung.height,
          readyAt: new Date(),
          metadata: {
            format: 'hls',
            bitrate: rung.bitrate,
            segments: segments.length,
            encodingProfile: VIDEO_RENDITION_PROFILE,
          },
        });
        const bandwidth = measureBandwidth(segmentMetrics, this.parseBitrate(rung.bitrate));
        masterRenditions.push({
          resolution: `${rung.width}x${rung.height}`,
          bitrate: String(bandwidth.peak),
          playlist: key,
        });
      }
      const key = this.generateVariantKey(sha256, 'hls_master', 'm3u8', visibility, profile, root);
      await this.s3Service.uploadBuffer(
        key,
        Buffer.from(this.generateMasterPlaylist(masterRenditions)),
        {
          contentType: 'application/vnd.apple.mpegurl',
          cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
        },
      );
      variants.push({
        type: 'hls_master',
        key,
        readyAt: new Date(),
        metadata: {
          format: 'hls',
          variantCount: rungs.length,
          encodingProfile: VIDEO_RENDITION_PROFILE,
        },
      });
      return variants;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Generate HLS master playlist.
   *
   * The rendition URIs are BASENAMES, and that is the whole content of this
   * function's correctness. A master playlist's URIs resolve relative to the
   * MASTER's own URL (RFC 8216 §4.3.4.2), and `generateVariantKey` puts the
   * master and every rendition in one directory —
   * `variants/<year>/<month>/<prefix>/<sha256>/<type>.m3u8` — so a sibling is
   * named by its file name alone.
   *
   * It used to emit `variant.playlist`, which is the S3 STORAGE KEY. Measured
   * against production before this change:
   *
   *   master   cloud.oxy.so/variants/2026/09/e8/<sha>/hls_master.m3u8      200
   *   its URI  public/variants/2026/09/e8/<sha>/hls_360p.m3u8
   *   resolves cloud.oxy.so/variants/2026/09/e8/<sha>/public/variants/…    403
   *   correct  cloud.oxy.so/variants/2026/09/e8/<sha>/hls_360p.m3u8        200
   *
   * So every ladder this service has produced is unplayable: a player fetches
   * the master, then 403s on every rendition it lists. The failure is invisible
   * from the server — the master is served, S3 has all the objects, and the only
   * broken thing is a string inside a text file.
   */
  private generateMasterPlaylist(
    variants: Array<{ resolution: string; bitrate: string; playlist: string }>,
  ): string {
    let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n\n';

    variants.forEach((variant) => {
      const bitrateNumber = this.parseBitrate(variant.bitrate);
      playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${bitrateNumber},RESOLUTION=${variant.resolution}\n`;
      const uri = variant.playlist.slice(variant.playlist.lastIndexOf('/') + 1);
      playlist += `${uri}\n\n`;
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
    await assertPhysicalStoragePathSupported(await meteredOwnerId(file), 'generatePdfVariants');
    // This would use pdf2pic or similar to generate thumbnails
    // For now, this is a placeholder

    try {
      logger.info('Generating PDF variants (placeholder)', { fileId: file.id });

      const thumbnailKey = this.generateVariantKey(file.sha256, 'thumb', 'jpg', spellingOf(file));

      // Placeholder variant
      const variants: NewFileVariant[] = [
        {
          type: 'thumb',
          key: thumbnailKey,
          width: 256,
          height: 256,
          readyAt: new Date(),
          metadata: { page: 1 },
        },
      ];

      await this.commitVariants(file, variants);

      logger.info('PDF variants generated (placeholder)', {
        fileId: file.id,
        variantCount: variants.length,
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
    visibility: FileVisibility,
    profile?: string,
    root?: string,
  ): string {
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const prefix = sha256.substring(0, 2);

    // Variants inherit their parent file's visibility: public variants land
    // under the CDN-reachable `public/` prefix, private/unlisted variants stay
    // private to S3 (served only through the access-gated origin stream route).
    // A processing `profile` (an audio ladder normalized for loudness) gets a
    // directory of its own, so two differently processed sets of the same
    // bytes never overwrite each other.
    const directory = profile ? `${sha256}/${profile}` : sha256;
    const baseKey =
      root && profile
        ? `${root}${profile}/${variantType}.${format}`
        : `variants/${year}/${month}/${prefix}/${directory}/${variantType}.${format}`;
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

      return file.variants.filter((variant) => variant.readyAt);
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

      const variant = file.variants.find((v) => v.type === variantType);
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
   * Rewriting the WHOLE rendition set would silently drop a concurrent
   * writer's rendition of a DIFFERENT type. `upsertVariant` touches only
   * the rows of this type, in a transaction, so there is no whole-array write to
   * lose a neighbour and no retry to write.
   */
  private async storeVariant(
    file: FileRecord,
    variant: NewFileVariant,
  ): Promise<FileVariantRecord> {
    const row = await upsertVariant(file.id, variant);
    const idx = file.variants.findIndex((v) => v.type === variant.type);
    if (idx >= 0) file.variants[idx] = row;
    else file.variants.push(row);
    return row;
  }

  /** Mp4 bitrate rendition names produced by upload-time `generateVideoVariants`. */
  isVideoMp4Rendition(variantType: string): boolean {
    return /^(360p|720p|1080p)$/.test(variantType);
  }

  /**
   * Ensure a specific mp4 bitrate rendition exists, generating via FFmpeg if missing.
   *
   * This explicit worker-side operation repairs a missing tier. Public media
   * reads reject unavailable tiers rather than encoding on the request path.
   */
  async ensureVideoMp4Rendition(file: FileRecord, variantType: string): Promise<FileVariantRecord> {
    const existing = await this.getUsableReadyVariant(file, variantType);
    if (existing) {
      return existing;
    }

    await assertPhysicalStoragePathSupported(await meteredOwnerId(file), 'video/HLS generation');

    if (!this.isVideoMp4Rendition(variantType))
      throw new Error(`Unsupported video mp4 rendition: ${variantType}`);
    const videoUrl = await this.s3Service.getPresignedDownloadUrl(
      file.storageKey,
      MEDIA_SOURCE_URL_TTL_SECONDS,
    );
    const metadata = await this.extractVideoMetadataFromUrl(videoUrl);
    if (!metadata.width || !metadata.height) throw new Error(`Cannot probe video ${file.id}`);
    const rung = videoRungs({ width: metadata.width, height: metadata.height }).find(
      (candidate) => candidate.type === variantType,
    );
    if (!rung) throw new Error(`Variant ${variantType} exceeds source resolution`);
    const variant = await this.generateVideoVariant(
      videoUrl,
      file.sha256,
      rung,
      spellingOf(file),
      `${VIDEO_RENDITION_PROFILE}/${randomUUID()}`,
    );
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

    await assertPhysicalStoragePathSupported(await meteredOwnerId(file), 'video/HLS generation');

    // Generate poster frame directly from S3 - no temp files
    try {
      // Get S3 presigned URL and extract metadata
      const videoUrl = await this.s3Service.getPresignedDownloadUrl(
        file.storageKey,
        MEDIA_SOURCE_URL_TTL_SECONDS,
      );
      const metadata = await this.extractVideoMetadataFromUrl(videoUrl);
      const posterTime = Math.min(1, (metadata.duration || 60) * 0.1);

      // Generate poster frame with exact video aspect ratio (streams directly from S3)
      const posterVariant = await this.generatePosterFrame(
        file.storageKey, // Use S3 storage key directly - no temp files
        file.sha256,
        posterTime,
        spellingOf(file),
        metadata, // Pass metadata to preserve exact aspect ratio
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
    sourceBuffer: Buffer,
  ): Promise<NewFileVariant> {
    const format = config.format || 'webp';
    // A vector source is rendered AT the rendition's size, not scaled up from
    // its intrinsic one (`imageInputOptions`).
    const intrinsicWidth = isSvgType(file.mime)
      ? (await sharp(sourceBuffer, imageInputOptions(file.mime)).metadata()).width
      : undefined;
    let pipeline = sharp(
      sourceBuffer,
      imageInputOptions(file.mime, { intrinsicWidth, targetWidth: config.width }),
    )
      .rotate()
      .resize({
        width: config.width,
        height: config.height,
        fit: 'inside',
        withoutEnlargement: true,
      });
    if (format === 'webp') pipeline = pipeline.webp({ quality: config.quality ?? 82 });
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: config.quality ?? 82 });
    if (format === 'png') pipeline = pipeline.png();

    const out = await pipeline.toBuffer();
    // The output mime deliberately need not match the source's: the key carries
    // its own `format` and the upload sets `contentType` explicitly, which is
    // what lets a `video/*` file own an `image/webp` variant (the `poster`
    // variant has always relied on the same property).
    const key = this.generateVariantKey(file.sha256, config.type, format, spellingOf(file));
    const imgMeta = await sharp(out).metadata();
    return uploadAdmittedVariant(
      file,
      {
        type: config.type,
        key,
        width: imgMeta.width || config.width || 0,
        height: imgMeta.height || config.height || 0,
        readyAt: new Date(),
        size: out.length,
        metadata: { format, quality: config.quality },
      },
      (admittedKey) =>
        this.s3Service.uploadBuffer(admittedKey, out, {
          contentType: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
          cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
        }),
      (admittedKey) => this.s3Service.deleteFile(admittedKey),
    );
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
    const config = this.imageVariants.find((v) => v.type === variantType);
    if (!config) {
      throw new Error(`Unsupported image variant: ${variantType}`);
    }
    if (file.size > IMAGE_VARIANT_MAX_SOURCE_BYTES) {
      throw new Error(`Image too large for renditions: ${file.size} bytes`);
    }

    const { source } = await renderableImageSource(
      file,
      await this.s3Service.downloadBuffer(file.storageKey),
    );
    const variant = await this.renderAndUploadImageVariant(file, config, source);
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

    const config = this.imageVariants.find((v) => v.type === variantType);
    if (!config) {
      throw new Error(`Unsupported video image variant: ${variantType}`);
    }

    const poster = await this.ensureVideoPoster(file);
    const sourceBuffer = await this.s3Service.downloadBuffer(poster.key);
    const variant = await this.renderAndUploadImageVariant(file, config, sourceBuffer);
    return await this.storeVariant(file, variant);
  }
}
