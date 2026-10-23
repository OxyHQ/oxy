import type { FileRecord } from '../types/file.types';

/** Advance when playback compatibility requires regenerating existing renditions. */
export const VIDEO_RENDITION_PROFILE = 'video-v2';
export const VIDEO_SEGMENT_SECONDS = 2;

export interface VideoDimensions {
  width: number;
  height: number;
}

export interface VideoRung extends VideoDimensions {
  type: string;
  bitrate: string;
  preset: string;
}

/** Square-pixel display geometry, after ffmpeg's default autorotation. */
export function videoDisplayDimensions(stream: {
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}): VideoDimensions {
  const { width, height } = stream;
  if (
    !width ||
    !height ||
    width < 0 ||
    height < 0 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    throw new Error('Video has no valid dimensions');
  }
  const [numerator, denominator] = (stream.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  const pixelRatio =
    numerator > 0 && denominator > 0 && Number.isFinite(numerator / denominator)
      ? numerator / denominator
      : 1;
  const rotation =
    stream.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ??
    Number(stream.tags?.rotate ?? 0);
  const quarterTurns = Math.round(rotation / 90);
  if (!Number.isFinite(rotation) || Math.abs(rotation - quarterTurns * 90) > 0.01) {
    throw new Error('Video rotation must be a multiple of 90 degrees');
  }
  return Math.abs(quarterTurns % 2) === 1
    ? { width: height, height: Math.round(width * pixelRatio) }
    : { width: Math.round(width * pixelRatio), height };
}

/** Fit inside an orientation-aware quality box, without padding, cropping or upscaling. */
export function videoRungDimensions(source: VideoDimensions, shortEdge: number): VideoDimensions {
  const portrait = source.height > source.width;
  const maxWidth = portrait ? shortEdge : (shortEdge * 16) / 9;
  const maxHeight = portrait ? (shortEdge * 16) / 9 : shortEdge;
  const scale = Math.min(1, maxWidth / source.width, maxHeight / source.height);
  const width = Math.floor((source.width * scale) / 2) * 2;
  const height = Math.floor((source.height * scale) / 2) * 2;
  if (width < 2 || height < 2) throw new Error('Video is too small for an even-pixel rendition');
  return { width, height };
}

/** Always include a small starter; stop once another tier would add no pixels. */
export function videoRungs(source: VideoDimensions): VideoRung[] {
  const rungs: VideoRung[] = [];
  for (const target of [
    { shortEdge: 360, bitrate: '500k', preset: 'fast' },
    { shortEdge: 720, bitrate: '1M', preset: 'fast' },
    { shortEdge: 1080, bitrate: '2M', preset: 'medium' },
  ]) {
    const dimensions = videoRungDimensions(source, target.shortEdge);
    const previous = rungs.at(-1);
    if (previous?.width === dimensions.width && previous.height === dimensions.height) break;
    rungs.push({
      type: `${target.shortEdge}p`,
      ...dimensions,
      bitrate: target.bitrate,
      preset: target.preset,
    });
  }
  return rungs;
}

export function hasCurrentVideoRenditions(file: Pick<FileRecord, 'variants'>): boolean {
  return file.variants.some(
    (variant) =>
      variant.type === 'hls_master' &&
      variant.readyAt &&
      variant.metadata?.encodingProfile === VIDEO_RENDITION_PROFILE,
  );
}

/** Shared output filter; autorotation happens before this filter. */
export function videoScaleFilter(dimensions: VideoDimensions): string {
  return `scale=${dimensions.width}:${dimensions.height},setsar=1`;
}
