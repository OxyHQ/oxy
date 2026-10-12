/**
 * Oxy's image variant ladder — the renditions an image is served at.
 *
 * Oxy's CDN renders an uploaded image as these variants (`?variant=<name>`,
 * `variantService` in `@oxy.so/api`), and every surface that shows an image
 * asks for one of them instead of the original. The NAMES are the contract:
 * before this module oxy, Mention and Syra each spelled them out by hand, and a
 * fourth service (Clarity, for link-preview images) needs the same ladder so a
 * card asks for its image exactly the way a post asks for its media.
 *
 * Pure data and string helpers only. Rendering stays with each service — Oxy
 * renders with sharp (it must decode HEIC uploads), Clarity with `Bun.Image` —
 * because the engine is a deployment decision; the sizes, format and quality
 * are not.
 */

/** Every variant renders to WebP. */
export const IMAGE_VARIANT_FORMAT = 'webp' as const;

/** WebP quality (1–100) every variant is encoded at. */
export const IMAGE_VARIANT_QUALITY = 82;

/**
 * The ladder. `width`/`height` are a bounding box: the image is fitted INSIDE
 * it, keeping its aspect ratio, and never enlarged. Square boxes (`w96`, `w128`,
 * `thumb`) are for avatars and other fixed slots; the width-only rungs are for
 * content images.
 */
export const IMAGE_VARIANTS = {
  w96: { width: 96, height: 96 },
  w128: { width: 128, height: 128 },
  thumb: { width: 256, height: 256 },
  w320: { width: 320 },
  w640: { width: 640 },
  w1280: { width: 1280 },
  w2048: { width: 2048 },
} as const satisfies Record<string, { width: number; height?: number }>;

export type ImageVariantName = keyof typeof IMAGE_VARIANTS;

/** The width-only rungs, smallest first — what a content image picks from. */
export const CONTENT_IMAGE_VARIANTS = ['w320', 'w640', 'w1280', 'w2048'] as const satisfies
  readonly ImageVariantName[];

export type ContentImageVariantName = (typeof CONTENT_IMAGE_VARIANTS)[number];

/** Whether `value` names a variant on the ladder. */
export function isImageVariantName(value: unknown): value is ImageVariantName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(IMAGE_VARIANTS, value);
}

/**
 * The smallest content rung at least `pixels` wide, or the largest rung when
 * nothing is. `pixels` is a PHYSICAL width — multiply a layout width by the
 * device pixel ratio before asking.
 */
export function contentImageVariantForWidth(pixels: number): ContentImageVariantName {
  for (const name of CONTENT_IMAGE_VARIANTS) {
    if (IMAGE_VARIANTS[name].width >= pixels) return name;
  }
  return CONTENT_IMAGE_VARIANTS[CONTENT_IMAGE_VARIANTS.length - 1];
}

/**
 * `url` asking for `variant`: its `variant` query parameter set (replacing one
 * already there), every other part kept. A URL that does not parse is returned
 * unchanged — the caller then gets the image as it was, never a broken one.
 */
export function withImageVariant(url: string, variant: ImageVariantName): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.searchParams.set('variant', variant);
  return parsed.toString();
}

/** One candidate an image component can choose from, by width. */
export interface ImageVariantSource {
  uri: string;
  width: number;
}

/**
 * `url` as one candidate per content rung up to `largest`, smallest first — the
 * shape `expo-image` (and a web `srcset`) picks from by the rendered size, so a
 * surface gets the right rendition without measuring itself.
 */
export function contentImageSources(
  url: string,
  largest: ContentImageVariantName = 'w2048',
): ImageVariantSource[] {
  const sources: ImageVariantSource[] = [];
  for (const name of CONTENT_IMAGE_VARIANTS) {
    sources.push({ uri: withImageVariant(url, name), width: IMAGE_VARIANTS[name].width });
    if (name === largest) break;
  }
  return sources;
}
