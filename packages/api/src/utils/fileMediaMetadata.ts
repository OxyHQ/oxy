import type { FileRecord, FileVariantRecord } from '../types/file.types';

export type MediaOrientation = 'portrait' | 'landscape' | 'square';

export interface ResolvedFileMediaMetadata {
  width?: number;
  height?: number;
  durationSec?: number;
  orientation?: MediaOrientation;
  aspectRatio?: number;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n > 0 ? n : undefined;
}

function positiveDuration(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value > 0 ? value : undefined;
}

export function computeOrientation(width: number, height: number): MediaOrientation {
  const ratio = height / width;
  if (ratio >= 1.1) return 'portrait';
  if (ratio <= 0.9) return 'landscape';
  return 'square';
}

export function computeAspectRatio(width: number, height: number): number {
  return width / height;
}

function largestVariantDimensions(
  variants: FileVariantRecord[]
): { width?: number; height?: number } {
  let best: { width: number; height: number; area: number } | undefined;
  for (const variant of variants) {
    const width = positiveInt(variant.width);
    const height = positiveInt(variant.height);
    if (!width || !height) continue;
    const area = width * height;
    if (!best || area > best.area) {
      best = { width, height, area };
    }
  }
  if (!best) return {};
  return { width: best.width, height: best.height };
}

/**
 * Resolve intrinsic media dimensions for service metadata responses.
 * Prefers persisted `metadata.media`, then type-specific subdocs, then variants.
 */
export function resolveFileMediaMetadata(
  file: Pick<FileRecord, 'metadata' | 'variants'>
): ResolvedFileMediaMetadata {
  const root = file.metadata ?? {};
  const canonical = root.media as Partial<ResolvedFileMediaMetadata> | undefined;

  let width = positiveInt(canonical?.width);
  let height = positiveInt(canonical?.height);
  let durationSec = positiveDuration(canonical?.durationSec);

  const video = root.video as { width?: number; height?: number; duration?: number } | undefined;
  if (video) {
    width = width ?? positiveInt(video.width);
    height = height ?? positiveInt(video.height);
    durationSec = durationSec ?? positiveDuration(video.duration);
  }

  const image = root.image as { width?: number; height?: number } | undefined;
  if (image) {
    width = width ?? positiveInt(image.width);
    height = height ?? positiveInt(image.height);
  }

  if (!width || !height) {
    const fromVariants = largestVariantDimensions(file.variants ?? []);
    width = width ?? fromVariants.width;
    height = height ?? fromVariants.height;
  }

  const out: ResolvedFileMediaMetadata = {};
  if (width) out.width = width;
  if (height) out.height = height;
  if (durationSec !== undefined) out.durationSec = durationSec;

  if (width && height) {
    out.orientation = computeOrientation(width, height);
    out.aspectRatio = computeAspectRatio(width, height);
  } else if (
    canonical?.orientation === 'portrait'
    || canonical?.orientation === 'landscape'
    || canonical?.orientation === 'square'
  ) {
    out.orientation = canonical.orientation;
  }
  if (typeof canonical?.aspectRatio === 'number' && Number.isFinite(canonical.aspectRatio)) {
    out.aspectRatio = canonical.aspectRatio;
  }

  return out;
}

/**
 * Stage the canonical media summary on `metadata.media` (single write
 * chokepoint). The caller persists `file.metadata` afterwards — the two are
 * written together so a rendition set and the dimensions derived from the same
 * decode pass can never be stored apart (`fileRepository.upsertVariantSet`).
 */
export function applyCanonicalMediaMetadata(
  file: Pick<FileRecord, 'metadata'>,
  dims: { width?: number; height?: number; durationSec?: number },
): void {
  const width = positiveInt(dims.width);
  const height = positiveInt(dims.height);
  const durationSec = positiveDuration(dims.durationSec);

  const media: Record<string, number | string> = {};
  if (width) media.width = width;
  if (height) media.height = height;
  if (durationSec !== undefined) media.durationSec = durationSec;
  if (width && height) {
    media.orientation = computeOrientation(width, height);
    media.aspectRatio = computeAspectRatio(width, height);
  }

  file.metadata = {
    ...(file.metadata ?? {}),
    media,
  };
}
