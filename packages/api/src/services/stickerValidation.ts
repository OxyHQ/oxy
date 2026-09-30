/**
 * What a sticker's files must be before they enter the catalogue, and the
 * normalization every animation goes through on the way in.
 *
 * A sticker is drawn in chat bubbles, pickers and empty states on phones,
 * sometimes dozens at once, so the limits are about what a renderer can afford:
 * a square canvas, a bounded loop and frame rate, and a bounded stored size.
 * They live in `@oxy.so/contracts` so a pack author's tooling can check the
 * same numbers before uploading.
 *
 * ## Normalized, not rejected
 *
 * Animations exported from After Effects arrive pretty-printed, at full float
 * precision, and sometimes with expressions. The first two are pure weight —
 * a 2 MB export is typically under 200 KB once minified with coordinates
 * rounded to a thousandth of a pixel — so the API strips them rather than
 * sending the author back to re-export.
 *
 * Expressions (`x` on a property: JavaScript the player evaluates) are REMOVED
 * rather than refused. The native Lottie players, which are what Allo and
 * Mention's apps draw with, already ignore them and fall back to the
 * property's keyframed value; removing them makes the web player draw the same
 * thing, so a sticker looks alike everywhere and no shared asset carries code.
 *
 * ## Refused outright
 *
 * Embedded or linked images. A Lottie asset can carry a base64 bitmap or a URL
 * to one: either makes the vector animation a carrier for arbitrary raster
 * content, and a URL makes every renderer fetch from wherever the author
 * pointed it.
 */

import sharp from 'sharp';
import {
  STICKER_CANVAS_SIZES,
  STICKER_FALLBACK_SIZE,
  STICKER_MAX_ANIMATION_BYTES,
  STICKER_MAX_DURATION_MS,
  STICKER_MAX_FALLBACK_BYTES,
  STICKER_MAX_FRAME_RATE,
  STICKER_MAX_UPLOAD_BYTES,
} from '@oxy.so/contracts';
import { BadRequestError } from '../utils/error';

/** The static fallback's accepted types. */
export const STICKER_FALLBACK_MIME_TYPES = ['image/webp', 'image/png'] as const;

/** Decimal places kept on every non-integer number: a thousandth of a pixel, of a second, of an opacity. */
const PRECISION = 1000;

export interface NormalizedStickerAnimation {
  /** The minified JSON that is stored and served. */
  json: Buffer;
  size: number;
  durationMs: number;
  /** How many expressions were removed — reported so an uploader can check the result. */
  removedExpressions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A numeric top-level field of the Lottie document, by its Lottie name. */
function finiteNumber(document: Record<string, unknown>, field: 'w' | 'h' | 'fr' | 'ip' | 'op'): number {
  const value = document[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestError(`Lottie animation is missing a numeric "${field}"`);
  }
  return value;
}

/**
 * Image assets are the entries of `assets` with a path (`p`); precompositions
 * carry `layers` instead. Any image asset is refused, embedded (`e: 1`, a data
 * URI) or linked alike.
 */
function hasImageAsset(assets: unknown): boolean {
  if (!Array.isArray(assets)) return false;
  return assets.some((asset) => isRecord(asset) && typeof asset.p === 'string');
}

/**
 * Deletes every expression in place and counts them. Iterative so a deeply
 * nested file cannot exhaust the stack.
 */
function removeExpressions(root: unknown): number {
  let removed = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    if (typeof node.x === 'string') {
      delete node.x;
      removed += 1;
    }
    stack.push(...Object.values(node));
  }
  return removed;
}

function roundNumbers(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isInteger(value)
    ? Math.round(value * PRECISION) / PRECISION
    : value;
}

export function normalizeStickerAnimation(buffer: Buffer): NormalizedStickerAnimation {
  if (buffer.length > STICKER_MAX_UPLOAD_BYTES) {
    throw new BadRequestError(
      `Lottie animation is ${buffer.length} bytes; the upload limit is ${STICKER_MAX_UPLOAD_BYTES}`
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new BadRequestError('Lottie animation is not valid JSON');
  }
  if (!isRecord(document) || !Array.isArray(document.layers)) {
    throw new BadRequestError('File is not a Lottie animation');
  }

  const width = finiteNumber(document, 'w');
  const height = finiteNumber(document, 'h');
  const size = STICKER_CANVAS_SIZES.find((allowed) => allowed === width && allowed === height);
  if (size === undefined) {
    throw new BadRequestError(
      `Sticker canvas is ${width}×${height}; it must be square, one of ${STICKER_CANVAS_SIZES.join(', ')}`
    );
  }

  const frameRate = finiteNumber(document, 'fr');
  if (frameRate <= 0 || frameRate > STICKER_MAX_FRAME_RATE) {
    throw new BadRequestError(
      `Sticker frame rate is ${frameRate}; it must be above 0 and at most ${STICKER_MAX_FRAME_RATE}`
    );
  }

  // Lottie's in and out points: the loop's first and last frame.
  const inPoint = finiteNumber(document, 'ip');
  const outPoint = finiteNumber(document, 'op');
  const durationMs = Math.round(((outPoint - inPoint) / frameRate) * 1000);
  if (durationMs <= 0 || durationMs > STICKER_MAX_DURATION_MS) {
    throw new BadRequestError(
      `Sticker loop is ${durationMs}ms; it must be above 0 and at most ${STICKER_MAX_DURATION_MS}ms`
    );
  }

  if (hasImageAsset(document.assets)) {
    throw new BadRequestError('Stickers may not embed or link images');
  }

  const removedExpressions = removeExpressions(document);
  const json = Buffer.from(JSON.stringify(document, roundNumbers));
  if (json.length > STICKER_MAX_ANIMATION_BYTES) {
    throw new BadRequestError(
      `Lottie animation is ${json.length} bytes after normalization; the limit is ${STICKER_MAX_ANIMATION_BYTES}`
    );
  }

  return { json, size, durationMs, removedExpressions };
}

/**
 * A supplied fallback is checked by decoding it, not by trusting the declared
 * type: `sharp` reads the real format and dimensions from the bytes.
 */
export async function validateStickerFallback(buffer: Buffer, declaredMime: string): Promise<string> {
  if (buffer.length > STICKER_MAX_FALLBACK_BYTES) {
    throw new BadRequestError(
      `Fallback image is ${buffer.length} bytes; the limit is ${STICKER_MAX_FALLBACK_BYTES}`
    );
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new BadRequestError('Fallback is not a readable image');
  }

  const mime = metadata.format === 'webp' ? 'image/webp' : metadata.format === 'png' ? 'image/png' : null;
  if (!mime || mime !== declaredMime) {
    throw new BadRequestError(`Fallback must be one of ${STICKER_FALLBACK_MIME_TYPES.join(', ')}`);
  }
  if (metadata.width !== STICKER_FALLBACK_SIZE || metadata.height !== STICKER_FALLBACK_SIZE) {
    throw new BadRequestError(
      `Fallback is ${metadata.width}×${metadata.height}; it must be ${STICKER_FALLBACK_SIZE}×${STICKER_FALLBACK_SIZE}`
    );
  }
  return mime;
}
