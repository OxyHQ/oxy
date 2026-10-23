import { VIDEO_RENDITION_PROFILE } from '../services/video-renditions';
import type { FileRecord } from '../types/file.types';
import { readyVariantRevision } from './assetRenditionRevision';

interface Dimensions {
  width: number;
  height: number;
}

function dimensions(value: unknown): Dimensions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { width, height } = value as Record<string, unknown>;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    return undefined;
  return { width, height };
}

/**
 * A missing ladder and a rejected generation are different facts. Rejection
 * names the exact ready generation so a consumer can clear that stamp without
 * erasing a newer, concurrently published ladder. Storage and CDN URLs remain
 * unchanged: an HLS URL must never redirect to progressive video bytes.
 */
export function resolveVideoHlsReadiness(
  file: Pick<FileRecord, 'mime' | 'metadata' | 'variants'>,
): { hlsReadyAt?: string; hlsRejectedReadyAt?: string } {
  const hlsReadyAt = readyVariantRevision(file, 'hls_master');
  if (!hlsReadyAt) return {};
  const ready = { hlsReadyAt };
  const master = file.variants.find((variant) => variant.type === 'hls_master' && variant.readyAt);
  if (master?.metadata?.encodingProfile === VIDEO_RENDITION_PROFILE) return ready;

  // MIME is not codec evidence. Unknown/non-MP4 originals retain the existing
  // playable transcode until repair; do not trade bad framing for no decoder.
  // A missing audioCodec is not affirmative evidence of a silent source.
  const mime = file.mime.split(';', 1)[0].trim().toLowerCase();
  const video = file.metadata?.video as Record<string, unknown> | undefined;
  if (
    (mime !== 'video/mp4' && mime !== 'video/x-m4v') ||
    video?.codec !== 'h264' ||
    video.audioCodec !== 'aac'
  )
    return ready;

  // Never use resolveFileMediaMetadata's variant-derived dimensions here:
  // those would compare a malformed rendition with itself. These summaries
  // describe the owned original, whose identity does not change on repair.
  const original = dimensions(file.metadata?.media) ?? dimensions(video);
  if (!original) return ready;
  const incompatible = file.variants.some((variant) => {
    if (!variant.readyAt || !/^hls_\d+p$/.test(variant.type)) return false;
    const rung = dimensions(variant);
    if (!rung) return false;
    // Each axis may lose up to two pixels when scaled to even dimensions.
    // Compare against that bound rather than an arbitrary aspect percentage.
    return (
      Math.abs(original.width * rung.height - original.height * rung.width) >
      2 * (original.width + original.height)
    );
  });
  return incompatible ? { hlsRejectedReadyAt: hlsReadyAt } : ready;
}
